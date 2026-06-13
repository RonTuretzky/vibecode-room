import path from "node:path";
import type { Artifact, VisualizerKind } from "../types.ts";
import { uid } from "../util.ts";
import { MockBrain } from "./mock.ts";
import type { Brain, StepRequest, StepResult, SuggestRequest, SuggestionDraft } from "./types.ts";

const SMITHERS_TIMEOUT_MS = 120_000;
const VISUALIZERS = new Set<VisualizerKind>(["web", "code", "art", "book", "text", "data"]);

type SpawnResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

type SuggestOutput = {
  suggest?: boolean | string;
  title?: string;
  rationale?: string;
  visualizer?: string;
  sourcePhrases?: string;
  source_phrases?: string;
  questions?: string | unknown[];
  html?: string;
};

type StepOutput = {
  reply?: string;
  note?: string;
  done?: boolean | string;
  html?: string;
};

type SmithersOutputEnvelope = {
  output?: unknown;
  value?: unknown;
  result?: unknown;
};

function smithersBin(): string {
  return path.join(process.cwd(), "node_modules", ".bin", "smithers");
}

async function spawnWithTimeout(args: string[], timeoutMs: number): Promise<SpawnResult> {
  const proc = Bun.spawn([smithersBin(), ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

function assertOk(result: SpawnResult, label: string): void {
  if (result.exitCode !== 0) {
    throw new Error(`${label} exited ${result.exitCode}: ${result.stderr || result.stdout}`);
  }
}

function firstJsonObject(raw: string): unknown {
  const start = raw.indexOf("{");
  if (start === -1) throw new Error("no json object on stdout");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") inString = true;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(raw.slice(start, i + 1));
    }
  }
  throw new Error("unterminated json object on stdout");
}

function boolValue(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  // `smithers output` serialization coerces booleans to numbers (true->1, false->0).
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    return v === "true" || v === "1";
  }
  return false;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    // Fall through to comma splitting.
  }
  return trimmed.split(",").map((p) => p.trim()).filter(Boolean);
}

function visualizerKind(value: unknown): VisualizerKind {
  const kind = typeof value === "string" ? value : "web";
  return VISUALIZERS.has(kind as VisualizerKind) ? (kind as VisualizerKind) : "web";
}

function parseQuestions(value: unknown): { prompt: string; choices: string[] }[] {
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? JSON.parse(value || "[]") : value;
  } catch {
    parsed = [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((q) => {
    if (!q || typeof q !== "object") return [];
    const prompt = "prompt" in q && typeof q.prompt === "string" ? q.prompt : "";
    const choices = "choices" in q ? stringArray(q.choices) : [];
    return prompt && choices.length ? [{ prompt, choices }] : [];
  });
}

function unwrapSmithersOutput<T extends object>(value: unknown): T {
  if (!value || typeof value !== "object") {
    throw new Error("smithers output was not an object");
  }
  const envelope = value as SmithersOutputEnvelope;
  const nested = envelope.output ?? envelope.value ?? envelope.result;
  if (nested && typeof nested === "object") return nested as T;
  return value as T;
}

async function runTask<T extends object>(
  nodeId: "suggest" | "step",
  workflowFile: string,
  input: Record<string, unknown>,
): Promise<T> {
  const runId = `${nodeId}-${uid("run")}`;
  const up = await spawnWithTimeout(
    ["up", workflowFile, "--input", JSON.stringify(input), "--run-id", runId],
    SMITHERS_TIMEOUT_MS,
  );
  assertOk(up, `smithers up ${nodeId}`);
  const output = await spawnWithTimeout(["output", runId, nodeId, "--json"], SMITHERS_TIMEOUT_MS);
  assertOk(output, `smithers output ${nodeId}`);
  return unwrapSmithersOutput<T>(firstJsonObject(output.stdout));
}

export class SmithersBrain implements Brain {
  readonly name = "smithers";
  private fallback = new MockBrain();

  async suggest(req: SuggestRequest): Promise<SuggestionDraft | null> {
    try {
      const workflow = path.join(process.cwd(), "src", "core", "workflows", "suggest.tsx");
      const j = await runTask<SuggestOutput>("suggest", workflow, {
        transcript: req.transcript,
        existing: req.existing.map((e) => e.title).join(", "),
        modelInitiated: req.modelInitiated,
      });
      if (!boolValue(j.suggest) || !j.title) return null;
      const kind = visualizerKind(j.visualizer);
      const html = j.html || `<h1>${j.title}</h1>`;
      const demo: Artifact = { kind, title: j.title, html };
      return {
        title: j.title,
        rationale: j.rationale ?? "",
        visualizer: kind,
        demo,
        sourcePhrases: stringArray(j.sourcePhrases ?? j.source_phrases),
        questions: parseQuestions(j.questions).map((q) => ({ id: uid("q"), ...q })),
      };
    } catch (err) {
      console.error("[smithers.suggest] falling back to mock:", (err as Error).message);
      return this.fallback.suggest(req);
    }
  }

  async step(req: StepRequest): Promise<StepResult> {
    if (req.autonomous) return { note: "idle tick" };
    try {
      const workflow = path.join(process.cwd(), "src", "core", "workflows", "step.tsx");
      const history = req.history.map((h) => `${h.role}: ${h.text}`).join("\n");
      const j = await runTask<StepOutput>("step", workflow, {
        processTitle: req.process.title,
        visualizer: req.process.visualizer,
        model: req.process.model,
        prompt: req.prompt,
        history,
      });
      const artifact: Artifact | undefined = j.html
        ? { kind: req.process.visualizer, title: req.process.title, html: j.html }
        : undefined;
      return {
        reply: j.reply || undefined,
        note: j.note ?? "stepped",
        done: boolValue(j.done),
        artifact,
      };
    } catch (err) {
      console.error("[smithers.step] falling back to mock:", (err as Error).message);
      return this.fallback.step(req);
    }
  }
}
