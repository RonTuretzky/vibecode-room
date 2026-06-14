import path from "node:path";
import type { Artifact } from "../types.ts";
import { uid } from "../util.ts";
import { MockBrain } from "./mock.ts";
import {
  boolValue,
  firstJsonObject,
  parseQuestions,
  stringArray,
  unwrapSmithersOutput,
  visualizerKind,
} from "./smithers-parse.ts";
import type { Brain, StepRequest, StepResult, SuggestRequest, SuggestionDraft } from "./types.ts";

const SMITHERS_TIMEOUT_MS = 120_000;

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
