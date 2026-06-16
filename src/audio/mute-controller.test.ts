import { describe, expect, test } from "bun:test";
import { ReplayASRProvider } from "../providers/asr/replay";
import { runReplayObservations, type DecisionInput, type DecisionLLM } from "../replay/harness";
import type { LogEvent, OutputDecision, TranscriptObservation } from "../types";
import { MUTE_ENGAGE_BUDGET_MS, MuteController } from "./mute-controller";

interface SuggestionOutput {
  route: "observe.pass" | "suggestion.fire";
  utteranceId: string;
  text: string;
}

describe("mute controller", () => {
  test("Cue mute hard-closes cloud/suggestion flow within 500ms and emits the required outputs plus heartbeat", async () => {
    const clock = new ManualClock(1_000);
    const timers = new ManualTimers(clock);
    const trace: LogEvent[] = [];
    const outputs: OutputDecision[] = [];
    const controller = new MuteController({
      sessionId: "session-mute",
      now: clock.now,
      idFactory: sequenceIds("mute"),
      heartbeatIntervalMs: 250,
      setIntervalFn: timers.setInterval,
      clearIntervalFn: timers.clearInterval,
      onTrace: (event) => trace.push(event),
      onOutput: (decision) => {
        outputs.push(decision);
      },
    });

    const observations = transcriptFixture();
    const accepted: TranscriptObservation[] = [];
    accepted.push(nonNull(controller.acceptPipelineObservation(observations[0])));

    clock.advance(20);
    const engaged = await controller.handleCueKeyword("mute", {
      correlationId: "corr-mute-word",
      startedAtMs: clock.now() - 120,
    });
    expect(engaged.changed).toBe(true);
    expect(engaged.latencyMs).toBeLessThanOrEqual(MUTE_ENGAGE_BUDGET_MS);
    expect(engaged.streamingToCloud).toBe(false);
    expect(engaged.persistentTone).toBe("mute-tone");
    expect(outputs).toEqual([
      { channel: "earcon", id: "mute-tone" },
      { channel: "tts", text: "Muted", wordCount: 1, summarized: false },
    ]);

    expect(controller.acceptPipelineObservation(observations[1])).toBeNull();
    expect(controller.acceptPipelineObservation(observations[2])).toBeNull();
    timers.advance(750);

    await controller.handleCueKeyword("unmute", {
      correlationId: "corr-unmute-word",
      startedAtMs: clock.now() - 40,
    });
    accepted.push(nonNull(controller.acceptPipelineObservation(observations[3])));

    const replay = await runReplayObservations(accepted, deterministicSuggestionLlm());
    expect(replay.records.map((record) => record.observation.utteranceId)).toEqual(["utt-before", "utt-after"]);
    expect(replay.records).toHaveLength(2);
    expect(controller.suppressedObservations()).toBe(2);

    const engagedEvent = nonNull(trace.find((event) => event.event === "mute.engaged"));
    expect(engagedEvent).toEqual(
      expect.objectContaining({
        event: "mute.engaged",
        correlationId: "corr-mute-word",
        latencyMs: 120,
        meta: expect.objectContaining({
          streamingToCloud: false,
          persistentTone: "mute-tone",
          withinBudget: true,
        }),
      }),
    );

    const heartbeats = trace.filter((event) => event.event === "mute.heartbeat");
    expect(heartbeats).toHaveLength(3);
    expect(heartbeats.every((event) => event.meta.streamingToCloud === false)).toBe(true);

    const releasedEvent = nonNull(trace.find((event) => event.event === "mute.released"));
    expect(releasedEvent).toEqual(
      expect.objectContaining({
        event: "mute.released",
        correlationId: "corr-unmute-word",
        latencyMs: 40,
        meta: expect.objectContaining({
          trigger: "unmute-word",
          streamingToCloud: true,
          restoredEarcon: "E2",
          suppressedObservations: 2,
        }),
      }),
    );
    expect(outputs.at(-1)).toEqual({ channel: "earcon", id: "E2" });
  });

  test("the on-screen unmute button reopens the pipeline and stops heartbeat emission", async () => {
    const clock = new ManualClock(5_000);
    const timers = new ManualTimers(clock);
    const trace: LogEvent[] = [];
    const outputs: OutputDecision[] = [];
    const controller = new MuteController({
      sessionId: "session-button",
      now: clock.now,
      heartbeatIntervalMs: 100,
      setIntervalFn: timers.setInterval,
      clearIntervalFn: timers.clearInterval,
      onTrace: (event) => trace.push(event),
      onOutput: (decision) => {
        outputs.push(decision);
      },
    });

    await controller.handleCueKeyword("mute", { correlationId: "corr-button-mute" });
    timers.advance(250);
    await controller.releaseFromButton({ correlationId: "corr-button-release", startedAtMs: clock.now() - 15 });
    timers.advance(500);

    expect(controller.isMuted()).toBe(false);
    expect(controller.isStreamingToCloud()).toBe(true);
    expect(trace.filter((event) => event.event === "mute.heartbeat")).toHaveLength(2);
    expect(trace.find((event) => event.event === "mute.released")).toEqual(
      expect.objectContaining({
        correlationId: "corr-button-release",
        latencyMs: 15,
        meta: expect.objectContaining({ trigger: "unmute-button" }),
      }),
    );
    expect(outputs).toEqual([
      { channel: "earcon", id: "mute-tone" },
      { channel: "tts", text: "Muted", wordCount: 1, summarized: false },
      { channel: "earcon", id: "E2" },
    ]);
  });

  test("protected cloud ASR is not called while muted and resumes after unmute", async () => {
    const provider = new ReplayASRProvider(transcriptFixture().slice(1, 3));
    const controller = new MuteController({ sessionId: "session-asr", now: () => 100 });
    const protectedProvider = controller.protectCloudAsr(provider);
    const audio = emptyAudioStream();

    await controller.handleCueKeyword("mute", { correlationId: "corr-asr-mute" });
    expect(await collect(protectedProvider.stream(audio))).toEqual([]);
    expect(provider.streamCalls).toHaveLength(0);
    expect(controller.isStreamingToCloud()).toBe(false);

    await controller.releaseFromButton({ correlationId: "corr-asr-unmute" });
    const reopened = await collect(protectedProvider.stream(emptyAudioStream()));

    expect(reopened.map((observation) => observation.utteranceId)).toEqual(["utt-muted-1", "utt-muted-2"]);
    expect(provider.streamCalls).toHaveLength(1);
    expect(controller.isStreamingToCloud()).toBe(true);
  });
});

function deterministicSuggestionLlm(): DecisionLLM<SuggestionOutput> {
  return {
    decide(input: DecisionInput): SuggestionOutput {
      return {
        route: input.observation.text.split(/\s+/u).length >= 6 ? "suggestion.fire" : "observe.pass",
        utteranceId: input.observation.utteranceId,
        text: input.observation.text,
      };
    },
  };
}

function transcriptFixture(): TranscriptObservation[] {
  return [
    observation("utt-before", "ambient work before the room asks for privacy"),
    observation("utt-muted-1", "private design details that must not route while muted"),
    observation("utt-muted-2", "more ambient private material during the mute interval"),
    observation("utt-after", "ambient work after the Cue unmute word opens the pipeline"),
  ];
}

function observation(utteranceId: string, text: string): TranscriptObservation {
  return {
    text,
    isFinal: true,
    speaker: "speaker-0",
    sessionId: "session-mute",
    latencyMs: 25,
    utteranceId,
  };
}

function emptyAudioStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const item of items) {
    collected.push(item);
  }
  return collected;
}

function nonNull<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("Expected value to be present.");
  }
  return value;
}

function sequenceIds(prefix: string): () => string {
  let index = 0;
  return () => `${prefix}-${++index}`;
}

class ManualClock {
  #now: number;

  constructor(now: number) {
    this.#now = now;
  }

  readonly now = (): number => this.#now;

  advance(ms: number): void {
    this.#now += ms;
  }
}

class ManualTimers {
  #nextId = 0;
  readonly #timers = new Map<number, { at: number; every: number; fn: () => void }>();

  constructor(private readonly clock: ManualClock) {}

  readonly setInterval = (fn: () => void, delay?: number): ReturnType<typeof setInterval> => {
    const id = ++this.#nextId;
    const every = delay ?? 0;
    this.#timers.set(id, { at: this.clock.now() + every, every, fn });
    return id as unknown as ReturnType<typeof setInterval>;
  };

  readonly clearInterval = (handle: ReturnType<typeof setInterval>): void => {
    this.#timers.delete(handle as unknown as number);
  };

  advance(ms: number): void {
    const target = this.clock.now() + ms;
    while (true) {
      const next = [...this.#timers.entries()].sort((left, right) => left[1].at - right[1].at)[0];
      if (next === undefined || next[1].at > target) {
        break;
      }

      const [, timer] = next;
      this.clock.advance(timer.at - this.clock.now());
      timer.at += timer.every;
      timer.fn();
    }
    this.clock.advance(target - this.clock.now());
  }
}
