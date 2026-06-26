import { cueDecisionSchema, type CueDecision } from "../../types";
import type { DecisionInput, DecisionLLM, DecisionOutput } from "../types";

export const HOST_CLAUDE_DECISION_POLICY = "host-claude-decision.v0";

// Default to a fast model — this runs in the ambient loop, so latency matters
// more than depth for the act/pass call.
const DEFAULT_MODEL = "haiku";
const DEFAULT_TIMEOUT_MS = 12_000;
// At most one real model call per interval; intervening observations return a
// throttled pass. Keeps a chatty room from spawning a claude process per final.
const DEFAULT_MIN_INTERVAL_MS = 6_000;

// Injectable runner so tests never shell out. Returns the model's raw text reply
// (the inner answer, with the CLI envelope already unwrapped).
export type ClaudeCliRunner = (prompt: string, opts: { model: string; timeoutMs: number }) => Promise<string>;

export interface HostClaudeDecisionLLMOptions {
  policy?: string;
  model?: string;
  timeoutMs?: number;
  minIntervalMs?: number;
  runner?: ClaudeCliRunner;
  now?: () => number;
}

/**
 * A DecisionLLM that judges buildable intent with genuine inference via the
 * host's logged-in `claude` CLI (no API key) — not keyword matching. It asks the
 * model to decide act/pass over the transcript and parses a small JSON verdict.
 * Every failure mode (timeout, spawn error, unparseable reply, model declines)
 * resolves to a PASS so a bad call never wedges the ambient loop.
 */
export class HostClaudeDecisionLLM implements DecisionLLM {
  readonly #policy: string;
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #minIntervalMs: number;
  readonly #runner: ClaudeCliRunner;
  readonly #now: () => number;
  #lastCallAtMs = Number.NEGATIVE_INFINITY;

  constructor(options: HostClaudeDecisionLLMOptions = {}) {
    this.#policy = options.policy ?? HOST_CLAUDE_DECISION_POLICY;
    this.#model = options.model ?? DEFAULT_MODEL;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.#runner = options.runner ?? defaultClaudeCliRunner;
    this.#now = options.now ?? (() => Date.now());
  }

  async decide(input: DecisionInput): Promise<DecisionOutput> {
    if (input.temperature !== undefined && input.temperature !== 0) {
      throw new Error("HostClaudeDecisionLLM only supports temperature 0.");
    }
    const decisionId = decisionIdFrom(input);
    const transcript = extractTranscript(input);

    // Throttle: don't spawn a model call for every final in a chatty room.
    const now = this.#now();
    if (transcript.length === 0 || now - this.#lastCallAtMs < this.#minIntervalMs) {
      return this.#pass(input, decisionId, "throttled-or-empty");
    }
    this.#lastCallAtMs = now;

    let verdict: ClaudeVerdict | null = null;
    try {
      const reply = await this.#runner(buildPrompt(transcript), { model: this.#model, timeoutMs: this.#timeoutMs });
      verdict = parseVerdict(reply);
    } catch {
      verdict = null; // any runner failure → pass
    }

    if (verdict === null || !verdict.act) {
      return this.#pass(input, decisionId, "model-pass", verdict?.quality ?? 0);
    }

    const decision: CueDecision = {
      kind: "action",
      action: {
        type: "spawn",
        targetUPID: null,
        correlationId: input.correlationId,
        payload: { quality: verdict.quality, pitch: verdict.pitch, mcqs: verdict.questions, answers: [] },
      },
      policy: this.#policy,
      decisionId,
      correlationId: input.correlationId,
      meta: { quality: verdict.quality, pitch: verdict.pitch, mcqs: verdict.questions },
    };
    return {
      id: `decision-${input.correlationId}`,
      model: input.model,
      temperature: 0,
      decision: cueDecisionSchema.parse(decision),
      raw: { hostClaude: true, transcript, verdict },
    };
  }

  #pass(input: DecisionInput, decisionId: string, reason: string, quality = 0): DecisionOutput {
    const decision: CueDecision = {
      kind: "pass",
      addressed: false,
      reason: "ambient",
      policy: this.#policy,
      decisionId,
      correlationId: input.correlationId,
      meta: { quality, note: reason },
    };
    return {
      id: `decision-${input.correlationId}`,
      model: input.model,
      temperature: 0,
      decision: cueDecisionSchema.parse(decision),
      raw: { hostClaude: true, reason },
    };
  }
}

interface ClaudeVerdict {
  act: boolean;
  quality: number;
  pitch: string;
  questions: string[];
}

function buildPrompt(transcript: string): string {
  return [
    "You are the suggestion gate for an ambient room assistant. Using genuine judgment about MEANING and INTENT (not keyword matching), decide whether the room is expressing a concrete, buildable software/automation idea worth proposing — even if phrased implicitly (e.g. \"we could wrap those into one thing\").",
    "ACT only for a real buildable idea. PASS for ambient chatter, logistics, personal talk, status updates, or vague musing.",
    "Reply with ONLY a JSON object, no prose, no code fences:",
    '{"act": boolean, "quality": number between 0 and 1, "pitch": "<=12 word imperative pitch", "questions": ["<=2 short yes/no questions"]}',
    "",
    "Transcript:",
    transcript,
  ].join("\n");
}

// Tolerant parse: accept a bare JSON object or one embedded in prose/fences.
function parseVerdict(reply: string): ClaudeVerdict | null {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!isRecord(raw) || typeof raw.act !== "boolean") {
    return null;
  }
  const quality = typeof raw.quality === "number" ? clamp01(raw.quality) : raw.act ? 0.8 : 0;
  const pitch = typeof raw.pitch === "string" ? raw.pitch.trim() : "";
  const questions = Array.isArray(raw.questions)
    ? raw.questions.filter((q): q is string => typeof q === "string").slice(0, 2)
    : [];
  return { act: raw.act && pitch.length > 0, quality, pitch, questions };
}

// Default runner: spawn the host `claude` CLI in print mode and unwrap its JSON
// envelope to the model's text reply.
const defaultClaudeCliRunner: ClaudeCliRunner = async (prompt, { model, timeoutMs }) => {
  const proc = Bun.spawn(
    ["claude", "-p", prompt, "--model", model, "--output-format", "json", "--dangerously-skip-permissions"],
    { stdout: "pipe", stderr: "ignore", stdin: "ignore" },
  );
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const out = await new Response(proc.stdout).text();
    const envelope: unknown = JSON.parse(out);
    if (isRecord(envelope) && typeof envelope.result === "string") {
      return envelope.result;
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
};

function extractTranscript(input: DecisionInput): string {
  const parts: string[] = [];
  for (const message of input.messages) {
    if (message.role !== "user") {
      continue;
    }
    parts.push(transcriptFromContent(message.content));
  }
  return parts.join(" ").replace(/\s+/gu, " ").trim();
}

function transcriptFromContent(content: string): string {
  try {
    const parsed: unknown = JSON.parse(content);
    if (isRecord(parsed) && typeof parsed.transcript === "string") {
      return parsed.transcript;
    }
  } catch {
    // plain text
  }
  return content;
}

function decisionIdFrom(input: DecisionInput): string {
  const fromMeta = input.metadata?.decisionId;
  if (typeof fromMeta === "string" && fromMeta.trim().length > 0) {
    return fromMeta;
  }
  return `decision-${input.correlationId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
