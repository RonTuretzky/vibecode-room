import { describe, expect, test } from "bun:test";
import { NoopTTSProvider } from "../providers/tts/noop";
import type { AckId } from "../types";
import {
  FIXED_STATE_PHRASES,
  WorkingAckScheduler,
  countWords,
  decideOutput,
  meetsSilenceTarget,
  precacheFixedStatePhrases,
  readOutputPolicyConfig,
  silenceRatio,
  stripNeverRecite,
  ttsDecision,
  type HotLoopSummaryLLM,
  type OutputPlan,
  type OutputTriggerClass,
} from "./output-policy";

describe("output policy", () => {
  test("triage defaults to silence and keeps ignored ambient observe.pass/route.pass silent", async () => {
    await expect(decideOutput({ trigger: "unknown" })).resolves.toEqual(silent("unknown"));
    await expect(decideOutput({ trigger: "ignored-ambient" })).resolves.toEqual(silent("ignored-ambient"));
    await expect(decideOutput({ trigger: "observe.pass", addressed: false })).resolves.toEqual(silent("observe.pass"));
    await expect(decideOutput({ trigger: "route.pass", addressed: false })).resolves.toEqual(silent("route.pass"));
  });

  test("Layer B route acks are emitted only for addressed or explicit routes", async () => {
    await expect(decideOutput({ trigger: "route.suggestion", addressed: true })).resolves.toEqual(
      expect.objectContaining({ decisions: [{ channel: "ack", id: "route-suggestion" }] }),
    );
    await expect(decideOutput({ trigger: "route.steer", explicit: true })).resolves.toEqual(
      expect.objectContaining({ decisions: [{ channel: "ack", id: "route-steer" }] }),
    );
    await expect(decideOutput({ trigger: "route.declined", addressed: true })).resolves.toEqual(
      expect.objectContaining({ decisions: [{ channel: "ack", id: "route-declined" }] }),
    );
    await expect(decideOutput({ trigger: "route.suggestion", addressed: false, explicit: false })).resolves.toEqual(
      silent("route.suggestion"),
    );
  });

  test("mute and halt use the required compound outputs with guarded TTS", async () => {
    await expect(decideOutput({ trigger: "mute" })).resolves.toEqual(
      expect.objectContaining({
        decisions: [
          { channel: "earcon", id: "mute-tone" },
          { channel: "tts", text: "Muted", wordCount: 1, summarized: false },
        ],
      }),
    );

    const halt = await decideOutput({
      trigger: "halt",
      text: "Halted after the operator requested an immediate stop for the selected process and listening session before more changes landed",
    });

    expect(halt.decisions[0]).toEqual({ channel: "earcon", id: "E5" });
    expect(halt.decisions[1]).toEqual(
      expect.objectContaining({
        channel: "tts",
        summarized: true,
      }),
    );
    expect(halt.decisions[1].channel === "tts" ? halt.decisions[1].wordCount : 99).toBeLessThanOrEqual(15);
  });

  test("15-word hard guard strips never-recite material and uses the hot-loop summarizer over the limit", async () => {
    const summarizer = new RecordingSummarizer("Build failed; tests need a fixture update before retry");
    const decision = await ttsDecision(
      [
        "diff --git a/src/file.ts b/src/file.ts",
        "+++ b/src/file.ts",
        "+const secret = 'do not read';",
        "TypeError: Cannot read property",
        "    at run (/tmp/app/src/file.ts:12:3)",
        "The build failed because the replay fixture needs a focused update before another verification retry can pass",
      ].join("\n"),
      { summarizer },
    );

    expect(summarizer.calls).toHaveLength(1);
    expect(decision).toEqual({
      channel: "tts",
      text: "Build failed; tests need a fixture update before retry",
      wordCount: 9,
      summarized: true,
    });
    expect(decision.text).not.toMatch(/https?:|diff --git|src\/file|^\+/u);
    expect(countWords(decision.text)).toBeLessThanOrEqual(15);
  });

  test("overlong summarizer output is still clamped to the hard maximum", async () => {
    const decision = await ttsDecision("one two three four five six", {
      config: { maxWords: 3 },
      summarizer: new RecordingSummarizer("alpha beta gamma delta epsilon"),
    });

    expect(decision).toEqual({ channel: "tts", text: "alpha beta gamma", wordCount: 3, summarized: true });
  });

  test("fixed state phrases are pre-cached through the TTS provider double", async () => {
    const tts = new NoopTTSProvider();

    await precacheFixedStatePhrases(tts);

    expect(tts.calls.map((call) => call.text)).toEqual([...FIXED_STATE_PHRASES]);
  });

  test("silence accounting supports the 90 percent target", async () => {
    const plans: OutputPlan[] = [];
    for (let index = 0; index < 9; index += 1) {
      plans.push(await decideOutput({ trigger: "ignored-ambient" }));
    }
    plans.push(await decideOutput({ trigger: "cue.text" }));

    expect(silenceRatio(plans)).toBe(0.9);
    expect(meetsSilenceTarget(plans, 0.9)).toBe(true);
  });

  test("working ack pulses after budget and repeats until a substantive ack arrives", () => {
    const timers = new ManualTimers();
    const emitted: AckId[] = [];
    const scheduler = new WorkingAckScheduler({
      onAck: (id) => {
        emitted.push(id);
      },
      budgetMs: 1_500,
      repeatMs: 500,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      setIntervalFn: timers.setInterval,
      clearIntervalFn: timers.clearInterval,
    });

    scheduler.start({ correlationId: "corr-working" });
    timers.advance(1_499);
    expect(emitted).toEqual([]);
    timers.advance(1);
    expect(emitted).toEqual(["working"]);
    timers.advance(1_000);
    expect(emitted).toEqual(["working", "working", "working"]);
    scheduler.substantiveAckArrived();
    timers.advance(2_000);
    expect(emitted).toEqual(["working", "working", "working"]);
  });

  test("env tunables have documented defaults and accept overrides", () => {
    expect(readOutputPolicyConfig({})).toEqual({
      maxWords: 15,
      roundTripBudgetMs: 1_500,
      workingAckRepeatMs: 1_500,
      silenceTarget: 0.9,
      summaryModel: "hot-loop-cheap-fast",
    });
    expect(
      readOutputPolicyConfig({
        PANOP_OUTPUT_MAX_WORDS: "9",
        PANOP_OUTPUT_ROUND_TRIP_BUDGET_MS: "750",
        PANOP_OUTPUT_WORKING_ACK_REPEAT_MS: "250",
        PANOP_OUTPUT_SILENCE_TARGET: "0.95",
        PANOP_OUTPUT_SUMMARY_MODEL: "cheap-test-model",
      }),
    ).toEqual({
      maxWords: 9,
      roundTripBudgetMs: 750,
      workingAckRepeatMs: 250,
      silenceTarget: 0.95,
      summaryModel: "cheap-test-model",
    });
  });

  test("never-recite cleaner removes URLs, file paths, stack frames, and diff lines", () => {
    const cleaned = stripNeverRecite("See https://x.test/a\nat run (/tmp/src/app.ts:1:2)\n- old line\nsrc/audio/output-policy.ts");

    expect(cleaned).toBe("See");
  });
});

class RecordingSummarizer implements HotLoopSummaryLLM {
  readonly calls: unknown[] = [];

  constructor(private readonly response: string) {}

  summarize(input: unknown): string {
    this.calls.push(input);
    return this.response;
  }
}

class ManualTimers {
  #now = 0;
  #nextId = 0;
  readonly #timers = new Map<number, { at: number; every?: number; fn: () => void }>();

  readonly setTimeout = (fn: () => void, delay?: number): ReturnType<typeof setTimeout> => {
    const id = ++this.#nextId;
    this.#timers.set(id, { at: this.#now + (delay ?? 0), fn });
    return id as unknown as ReturnType<typeof setTimeout>;
  };

  readonly clearTimeout = (handle: ReturnType<typeof setTimeout>): void => {
    this.#timers.delete(handle as unknown as number);
  };

  readonly setInterval = (fn: () => void, delay?: number): ReturnType<typeof setInterval> => {
    const id = ++this.#nextId;
    this.#timers.set(id, { at: this.#now + (delay ?? 0), every: delay ?? 0, fn });
    return id as unknown as ReturnType<typeof setInterval>;
  };

  readonly clearInterval = (handle: ReturnType<typeof setInterval>): void => {
    this.#timers.delete(handle as unknown as number);
  };

  advance(ms: number): void {
    const target = this.#now + ms;
    while (true) {
      const next = [...this.#timers.entries()].sort((left, right) => left[1].at - right[1].at)[0];
      if (next === undefined || next[1].at > target) {
        break;
      }

      const [id, timer] = next;
      this.#now = timer.at;
      if (timer.every === undefined) {
        this.#timers.delete(id);
      } else {
        timer.at += timer.every;
      }
      timer.fn();
    }
    this.#now = target;
  }
}

function silent(trigger: OutputTriggerClass): OutputPlan {
  return {
    trigger,
    decisions: [{ channel: "silent" }],
    primaryChannel: "silent",
  };
}
