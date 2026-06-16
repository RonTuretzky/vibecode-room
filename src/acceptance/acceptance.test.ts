import { describe, expect, test } from "bun:test";
import { ProcessRegistry } from "../process/registry";
import { MemorySmithersClient } from "../process/test-helpers";
import { runReplayObservations, type DecisionInput, type DecisionLLM } from "../replay/harness";
import type { DispatchedAction, OutputDecision, PendingSuggestion, TranscriptObservation } from "../types";
import { AcceptanceClassifier } from "./classifier";
import { PendingSuggestionOwner } from "./pending";
import {
  AcceptanceController,
  AcceptanceSpawner,
  createProcessRegistryAcceptanceSeam,
  type AcceptanceSpawnDispatchResult,
  type AcceptanceSpawnSeam,
} from "./spawn";

describe("acceptance spawn flow", () => {
  test("accept spawns seed across the seam, selects the new planning process, opens steering, and speaks callsign", async () => {
    const runtime = createAcceptanceRuntime();
    runtime.controller.acceptSuggestion(suggestion());

    const answer = await runtime.controller.observe({ observation: observation("Replay trace fixture", "utt-answer"), correlationId: "corr-answer" });
    const accepted = await runtime.controller.observe({ observation: observation("yes", "utt-accept"), correlationId: "corr-accept" });

    expect(answer.kind).toBe("mcq-answer");
    expect(accepted.kind).toBe("spawned");
    expect(runtime.seam.actions).toEqual([
      {
        type: "spawn",
        targetUPID: null,
        payload: {
          pitch: "Build replay coverage",
          mcqs: ["Which fixture?"],
          answers: ["Replay trace fixture"],
        },
        correlationId: "corr-accept",
      },
    ]);
    expect(runtime.registry.records()).toEqual([
      expect.objectContaining({ callsign: "virellium", selected: true, state: "planning" }),
    ]);
    expect(runtime.opened).toEqual([expect.objectContaining({ callsign: "virellium", state: "planning" })]);
    expect(runtime.output).toContainEqual({ channel: "earcon", id: "E3" });
    expect(runtime.output).toContainEqual(
      expect.objectContaining({ channel: "tts", text: "virellium spawned.", wordCount: 2 }),
    );
    expect(accepted.kind === "spawned" ? accepted.spawn.accepted : false).toBe(true);
    expect(accepted.kind === "spawned" && accepted.spawn.accepted ? accepted.spawn.withinBudget : false).toBe(true);
    expect(runtime.pending.pending()).toBeNull();
  });

  test("adversative yes is routed through the intent gate and cannot spawn", async () => {
    const runtime = createAcceptanceRuntime();
    runtime.controller.acceptSuggestion(suggestion());

    const result = await runtime.controller.observe({
      observation: observation("yes, but do not start it yet", "utt-yes-but"),
      correlationId: "corr-yes-but",
    });

    expect(result).toEqual(
      expect.objectContaining({
        kind: "ignored",
        classification: expect.objectContaining({
          reason: "intent-gate",
          gate: expect.objectContaining({ accepted: false, source: "fail-closed" }),
        }),
      }),
    );
    expect(runtime.seam.actions).toEqual([]);
    expect(runtime.registry.records()).toEqual([]);
    expect(runtime.pending.pending()).toEqual(expect.objectContaining({ suggestionId: "suggestion-acceptance" }));
  });

  test("decline clears the pending suggestion without touching the seam or registry", async () => {
    const runtime = createAcceptanceRuntime();
    runtime.controller.acceptSuggestion(suggestion());

    const result = await runtime.controller.observe({
      observation: observation("skip", "utt-skip"),
      correlationId: "corr-skip",
    });

    expect(result.kind).toBe("declined");
    expect(runtime.seam.actions).toEqual([]);
    expect(runtime.registry.records()).toEqual([]);
    expect(runtime.pending.pending()).toBeNull();
  });

  test("no-answer expiry requeues once and then discards as a no-op", () => {
    const runtime = createAcceptanceRuntime();
    runtime.controller.acceptSuggestion(suggestion());
    const before = runtime.registry.records();

    runtime.clock.advance(5_000);
    const requeued = runtime.controller.checkExpiry();
    runtime.clock.advance(5_000);
    const discarded = runtime.controller.checkExpiry();

    expect(requeued).toEqual(expect.objectContaining({ kind: "requeued" }));
    expect(discarded).toEqual(expect.objectContaining({ kind: "discarded" }));
    expect(runtime.registry.records()).toEqual(before);
    expect(runtime.seam.actions).toEqual([]);
    expect(runtime.pending.pending()).toBeNull();
  });

  test("record-replay transcript deterministically accumulates MCQ answers before accept", async () => {
    const observations = [
      observation("Replay fixture", "utt-replay-answer"),
      observation("accept", "utt-replay-accept"),
    ];
    const first = await runReplayObservations(observations, acceptanceReplayDecision());
    const second = await runReplayObservations(observations, acceptanceReplayDecision());

    expect(second.jsonl).toBe(first.jsonl);
    expect(first.records).toHaveLength(2);
    expect(first.records.every((record) => record.input.temperature === 0)).toBe(true);
    expect(first.records.map((record) => record.output)).toEqual([
      { route: "mcq-answer", answers: ["Replay fixture"], spawned: false },
      { route: "spawned", answers: ["Replay fixture"], spawned: true, callsign: "virellium", state: "planning" },
    ]);
  });
});

interface Runtime {
  clock: ReturnType<typeof adjustableClock>;
  registry: ProcessRegistry;
  pending: PendingSuggestionOwner;
  seam: RecordingSeam;
  controller: AcceptanceController;
  output: OutputDecision[];
  opened: unknown[];
}

class RecordingSeam implements AcceptanceSpawnSeam {
  readonly actions: DispatchedAction[] = [];

  constructor(private readonly inner: AcceptanceSpawnSeam) {}

  async dispatch(action: DispatchedAction): Promise<AcceptanceSpawnDispatchResult> {
    this.actions.push({ ...action, payload: clone(action.payload) });
    return this.inner.dispatch(action);
  }
}

function createAcceptanceRuntime(): Runtime {
  const clock = adjustableClock(1_000);
  const registry = new ProcessRegistry({
    client: new MemorySmithersClient(),
    sessionId: "acceptance-test",
    now: clock.now,
  });
  const pending = new PendingSuggestionOwner({ clock: clock.now });
  const seam = new RecordingSeam(createProcessRegistryAcceptanceSeam(registry));
  const output: OutputDecision[] = [];
  const opened: unknown[] = [];
  const classifier = new AcceptanceClassifier({ pending, idFactory: sequenceIds("accept") });
  const spawner = new AcceptanceSpawner({
    seam,
    sessionId: "acceptance-test",
    clock: clock.now,
    activeProcessCount: () => registry.activeRecords().length,
    onOutput: (decision) => output.push(decision),
    openSteeringWindow: (process) => opened.push(process),
  });
  const controller = new AcceptanceController({ pending, classifier, spawner });
  return { clock, registry, pending, seam, controller, output, opened };
}

function acceptanceReplayDecision(): DecisionLLM<Record<string, unknown>> {
  const runtime = createAcceptanceRuntime();
  runtime.controller.acceptSuggestion(suggestion());

  return {
    async decide(input: DecisionInput): Promise<Record<string, unknown>> {
      const result = await runtime.controller.observe({
        observation: input.observation,
        correlationId: `corr-replay-${input.observation.utteranceId}`,
      });
      const pending = runtime.pending.pending();
      const answers = pending?.answers ?? [];
      if (result.kind === "spawned" && result.spawn.accepted) {
        return {
          route: "spawned",
          answers: result.spawn.seed.answers,
          spawned: true,
          callsign: result.spawn.process.callsign,
          state: result.spawn.process.state,
        };
      }
      return { route: result.kind, answers, spawned: false };
    },
  };
}

function suggestion(): PendingSuggestion {
  return {
    suggestionId: "suggestion-acceptance",
    pitch: "Build replay coverage",
    mcqs: ["Which fixture?"],
    answers: ["LLM default ignored"],
    correlationId: "corr-suggestion",
    expiresAt: 99_000,
  };
}

function observation(text: string, utteranceId: string): TranscriptObservation {
  return {
    text,
    isFinal: true,
    speaker: "speaker-acceptance",
    sessionId: "acceptance-test",
    latencyMs: 25,
    utteranceId,
  };
}

function adjustableClock(startMs: number) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

function sequenceIds(prefix: string): () => string {
  let index = 0;
  return () => `${prefix}-${String(++index).padStart(3, "0")}`;
}

function clone(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}
