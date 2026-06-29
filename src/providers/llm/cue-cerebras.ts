import { pathToFileURL } from "node:url";
import { cueDecisionSchema, type CueDecision } from "../../types";
import type { DecisionInput, DecisionLLM, DecisionOutput } from "../types";
import { cueCoreEntrypoint, cueSourceBuildAvailable } from "../../cue/source";

export const CUE_CEREBRAS_DECISION_POLICY = "cue-cerebras-decision.v0";
const PROPOSE_TOOL = "propose_idea";

// A buildable-idea verdict, the shape the decision mapping consumes.
export interface IdeaProposal {
  act: boolean;
  quality: number;
  pitch: string;
  questions: string[];
}

// Judge a transcript and (maybe) propose a buildable idea. Injectable so the
// decision-mapping is unit-testable without loading Cue or hitting Cerebras.
export type IdeaProposer = (transcript: string) => Promise<IdeaProposal | null>;

export interface CueCerebrasDecisionLLMOptions {
  policy?: string;
  proposer?: IdeaProposer;
  apiKey?: string;
  model?: string;
}

/**
 * A DecisionLLM that does the idea inference through **Cue's** CerebrasLLMProvider
 * (the architecture's intended fast hot-loop path) — Cue tool-calling decides
 * whether the room is expressing a concrete buildable idea. The Cue/Cerebras
 * wiring lives in the default proposer (exercised live); the decision mapping is
 * pure and tested with an injected proposer. Any failure resolves to PASS so a
 * bad call never wedges the ambient loop.
 */
export class CueCerebrasDecisionLLM implements DecisionLLM {
  readonly #policy: string;
  readonly #proposer: IdeaProposer;

  constructor(options: CueCerebrasDecisionLLMOptions = {}) {
    this.#policy = options.policy ?? CUE_CEREBRAS_DECISION_POLICY;
    this.#proposer = options.proposer ?? createCueCerebrasProposer({ apiKey: options.apiKey, model: options.model });
  }

  async decide(input: DecisionInput): Promise<DecisionOutput> {
    if (input.temperature !== undefined && input.temperature !== 0) {
      throw new Error("CueCerebrasDecisionLLM only supports temperature 0.");
    }
    const decisionId = decisionIdFrom(input);
    const transcript = extractTranscript(input);
    if (transcript.length === 0) {
      return this.#pass(input, decisionId, 0);
    }

    let proposal: IdeaProposal | null = null;
    try {
      proposal = await this.#proposer(transcript);
    } catch {
      proposal = null;
    }
    if (proposal === null || !proposal.act || proposal.pitch.trim().length === 0) {
      return this.#pass(input, decisionId, proposal?.quality ?? 0);
    }

    const decision: CueDecision = {
      kind: "action",
      action: {
        type: "spawn",
        targetUPID: null,
        correlationId: input.correlationId,
        payload: { quality: proposal.quality, pitch: proposal.pitch, mcqs: proposal.questions, answers: [] },
      },
      policy: this.#policy,
      decisionId,
      correlationId: input.correlationId,
      meta: { quality: proposal.quality, pitch: proposal.pitch, mcqs: proposal.questions },
    };
    return {
      id: `decision-${input.correlationId}`,
      model: input.model,
      temperature: 0,
      decision: cueDecisionSchema.parse(decision),
      raw: { cueCerebras: true, transcript, proposal },
    };
  }

  #pass(input: DecisionInput, decisionId: string, quality: number): DecisionOutput {
    const decision: CueDecision = {
      kind: "pass",
      addressed: false,
      reason: "ambient",
      policy: this.#policy,
      decisionId,
      correlationId: input.correlationId,
      meta: { quality },
    };
    return { id: `decision-${input.correlationId}`, model: input.model, temperature: 0, decision: cueDecisionSchema.parse(decision) };
  }
}

const SYSTEM_PROMPT =
  "You are the suggestion gate for an ambient room assistant. Using genuine judgment about MEANING and INTENT " +
  "(not keyword matching), decide whether the room is expressing a concrete, buildable software/automation idea " +
  "worth proposing — even if phrased implicitly. If there is a real buildable idea, call propose_idea and you MUST " +
  "fill its arguments: pitch (a <=12 word imperative summary of WHAT to build), quality (0..1 confidence), and up to " +
  "two short yes/no questions. If there is no concrete buildable idea — ambient chatter, logistics, personal talk, " +
  "or vague musing — call observe.pass instead.";

// Cue's CerebrasLLMProvider takes a buildUserPrompt; give it the transcript plus
// an explicit instruction to fill the pitch so tool arguments aren't left empty.
function buildIdeaUserPrompt(args: { observation?: { payload?: { text?: unknown } } }): string {
  const transcript = String(args.observation?.payload?.text ?? "").trim();
  return [
    `Room transcript: ${transcript}`,
    "",
    "If this expresses a concrete buildable idea, call propose_idea with a filled-in pitch describing what to build. Otherwise call observe.pass.",
  ].join("\n");
}

const PROPOSE_TOOL_SPEC = {
  name: PROPOSE_TOOL,
  description: "Propose a concrete buildable idea the room is expressing (even implicitly).",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      pitch: { type: "string", description: "<=12 word imperative pitch" },
      quality: { type: "number", description: "confidence 0..1" },
      questions: { type: "array", items: { type: "string" }, description: "up to 2 short yes/no questions" },
    },
    required: ["pitch"],
  },
} as const;

const PASS_TOOL_SPEC = {
  name: "observe.pass",
  description: "Take no action — the room is not expressing a buildable idea.",
  parameters: { type: "object", additionalProperties: false, properties: {} },
} as const;

// Default proposer: load Cue's built core, construct its CerebrasLLMProvider once,
// and judge each transcript through Cue tool-calling. Returns null (→ pass) if the
// Cue build is absent or anything goes wrong.
export function createCueCerebrasProposer(options: { apiKey?: string; model?: string } = {}): IdeaProposer {
  let providerPromise: Promise<{ provider: CueInferProvider; core: CueCoreExtras } | null> | null = null;

  const load = async (): Promise<{ provider: CueInferProvider; core: CueCoreExtras } | null> => {
    if (!cueSourceBuildAvailable()) {
      return null;
    }
    const core = (await import(pathToFileURL(cueCoreEntrypoint()).href)) as CueCoreExtras;
    const provider = new core.CerebrasLLMProvider({
      // A solid native-tool-calling model. The default reasoning model
      // (zai-glm-4.7) errors under tool_choice=required, so prefer llama-3.3-70b
      // with "auto" choice; the provider falls back to a structured decision if no
      // tool call is produced.
      apiKey: options.apiKey ?? process.env.CEREBRAS_API_KEY,
      model: options.model ?? process.env.CEREBRAS_MODEL ?? "gpt-oss-120b",
      system: SYSTEM_PROMPT,
      buildUserPrompt: buildIdeaUserPrompt,
      maxCompletionTokens: 200,
      toolChoice: "auto",
      missingToolCallStrategy: "structured_decision",
      maxRetries: 1,
    }) as CueInferProvider;
    return { provider, core };
  };

  return async (transcript: string): Promise<IdeaProposal | null> => {
    let loaded: { provider: CueInferProvider; core: CueCoreExtras } | null;
    try {
      loaded = await (providerPromise ??= load());
    } catch {
      providerPromise = null;
      return null;
    }
    if (loaded === null) {
      return null;
    }
    const { provider, core } = loaded;
    const outputs = await provider.infer({
      sessionId: "vibersyn-idea",
      programName: "vibersyn-idea",
      state: new core.ConversationState(),
      cue: MINIMAL_HEARTBEAT,
      heartbeat: MINIMAL_HEARTBEAT,
      observation: core.transcriptObservation(transcript),
      tools: [PROPOSE_TOOL_SPEC, PASS_TOOL_SPEC],
    });
    return mapOutputs(outputs);
  };
}

const MINIMAL_HEARTBEAT = { kind: "manual", name: "idea-scan", reason: "scan" } as unknown;

// Map Cue ModelOutput[] (tool calls) to an idea proposal. A Cue ToolCallInput is
// shaped `{ id, tool, arguments, reason }` — the selected tool is `tool`.
function mapOutputs(outputs: unknown): IdeaProposal | null {
  if (!Array.isArray(outputs)) {
    return null;
  }
  for (const output of outputs) {
    if (!isRecord(output)) {
      continue;
    }
    const tool = typeof output.tool === "string" ? output.tool : typeof output.name === "string" ? output.name : "";
    if (tool !== PROPOSE_TOOL) {
      continue; // observe.pass or anything else → no proposal
    }
    const args = isRecord(output.arguments) ? output.arguments : {};
    const pitch = typeof args.pitch === "string" ? args.pitch.trim() : "";
    if (pitch.length === 0) {
      // Selected propose_idea but gave no pitch — treat as "no concrete idea yet".
      return { act: false, quality: 0, pitch: "", questions: [] };
    }
    const quality = typeof args.quality === "number" ? clamp01(args.quality) : 0.8;
    const questions = Array.isArray(args.questions)
      ? args.questions.filter((q): q is string => typeof q === "string").slice(0, 2)
      : [];
    return { act: true, quality, pitch, questions };
  }
  return { act: false, quality: 0, pitch: "", questions: [] };
}

interface CueInferProvider {
  infer(args: unknown): Promise<unknown>;
}
interface CueCoreExtras {
  CerebrasLLMProvider: new (options: unknown) => unknown;
  ConversationState: new () => unknown;
  transcriptObservation: (text: string, options?: unknown) => unknown;
}

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
