import { describe, expect, test } from "bun:test";
import { CONSENT_ANNOUNCEMENT } from "../onboarding/consent";
import type { AudioDispatchMeta, AudioOutput, PcmClip } from "../audio/earcons";
import type { LogEvent, OutputDecision, TranscriptObservation } from "../types";
import { OnboardingGlue, TRANSCRIPT_PERSISTENCE_TARGET, consentTranscriptLine } from "./onboarding-glue";

interface Harness {
  glue: OnboardingGlue;
  outputs: OutputDecision[];
  traces: LogEvent[];
  played: AudioDispatchMeta[];
}

function makeHarness(): Harness {
  const outputs: OutputDecision[] = [];
  const traces: LogEvent[] = [];
  const played: AudioDispatchMeta[] = [];
  const output: AudioOutput = {
    playPcm: (_clip: PcmClip, meta?: AudioDispatchMeta) => {
      played.push(meta ?? {});
    },
  };
  const glue = new OnboardingGlue({
    sessionId: "sess-glue",
    provider: "replay",
    output,
    clock: () => 1_000,
    onOutput: (decision) => {
      outputs.push(decision);
    },
    onTrace: (event) => {
      traces.push(event);
    },
  });
  return { glue, outputs, traces, played };
}

function observation(text: string, overrides: Partial<TranscriptObservation> = {}): TranscriptObservation {
  return {
    text,
    isFinal: true,
    speaker: "Room",
    sessionId: "sess-glue",
    latencyMs: 0,
    utteranceId: "utt-1",
    ...overrides,
  };
}

describe("OnboardingGlue consent (REQ-1)", () => {
  test("boot speaks the exact disclosure once, traces session.start, and yields a vibersyn transcript line", async () => {
    const { glue, outputs, traces } = makeHarness();
    expect(glue.consentSpoken()).toBe(false);

    const { result, line } = await glue.announceConsent();

    expect(result.spoken).toBe(true);
    expect(result.text).toBe(CONSENT_ANNOUNCEMENT);
    expect(outputs).toEqual([
      { channel: "tts", text: CONSENT_ANNOUNCEMENT, wordCount: expect.any(Number), summarized: false },
    ]);
    expect(traces).toHaveLength(1);
    expect(traces[0]?.event).toBe("session.start");
    expect(traces[0]?.meta).toMatchObject({ provider: "replay", consentSpoken: true, transcriptOnlyStated: true });
    expect(line.kind).toBe("vibersyn");
    expect(line.speaker).toBe("Vibersyn");
    expect(line.text).toBe(CONSENT_ANNOUNCEMENT);
    expect(glue.consentSpoken()).toBe(true);
  });

  test("announceConsent is idempotent — a second call returns the first result and emits nothing new", async () => {
    const { glue, outputs, traces } = makeHarness();
    const first = await glue.announceConsent();
    const second = await glue.announceConsent();

    expect(second.result).toBe(first.result);
    expect(outputs).toHaveLength(1);
    expect(traces).toHaveLength(1);
  });

  test("consentTranscriptLine formats HH:MM:SS wall time", () => {
    const line = consentTranscriptLine(
      { spoken: true, text: CONSENT_ANNOUNCEMENT, firedAtMs: 0, latencyMs: 0, event: {} as LogEvent },
      new Date("2026-07-22T09:15:30.000Z"),
    );
    expect(line.time).toBe("09:15:30");
  });
});

describe("OnboardingGlue listening indicator (authoritative mic state)", () => {
  test("not listening until a mic stream opens; open plays E2 exactly once and flips listening", async () => {
    const { glue, played } = makeHarness();
    expect(glue.listening()).toBe(false);
    expect(glue.listeningState()).toMatchObject({ authoritative: true, source: "mic-stream", earconId: null });

    const emission = await glue.micOpened("corr-mic-1");
    expect(emission?.id).toBe("E2");
    expect(glue.listening()).toBe(true);
    expect(glue.listeningState().earconId).toBe("E2");
    expect(played).toHaveLength(1);

    // A second open while already streaming is not a new transition — no double earcon.
    expect(await glue.micOpened("corr-mic-1")).toBeNull();
    expect(played).toHaveLength(1);
  });

  test("close flips listening off; reopen is a fresh transition (E2 again)", async () => {
    const { glue, played } = makeHarness();
    await glue.micOpened("corr-mic-1");
    await glue.micClosed("corr-mic-1");
    expect(glue.listening()).toBe(false);

    await glue.micOpened("corr-mic-2");
    expect(glue.listening()).toBe(true);
    expect(played).toHaveLength(2);
  });
});

describe("OnboardingGlue persistence guard (transcripts only, never raw audio)", () => {
  test("a plain transcript observation passes with the whole-session invariant", () => {
    const { glue } = makeHarness();
    const decision = glue.guardTranscript(observation("build a kanban board"));
    expect(decision).toEqual({ ok: true, sessionId: "sess-glue", invariant: "whole-session-transcript-only" });
  });

  test("a payload smuggling raw audio throws and blocks the write", () => {
    const { glue } = makeHarness();
    const smuggled = { ...observation("hello"), extras: { pcm: new Uint8Array([1, 2, 3]) } } as unknown as TranscriptObservation;
    expect(() => glue.guardTranscript(smuggled)).toThrow(/raw-audio|audio buffer/iu);
  });

  test("persistTranscript runs the writer only after the guard passes, against the canonical target", async () => {
    const { glue } = makeHarness();
    const targets: string[] = [];
    const written = await glue.persistTranscript(observation("ship it"), (attempt) => {
      targets.push(attempt.target);
      return "written";
    });
    expect(written).toBe("written");
    expect(targets).toEqual([TRANSCRIPT_PERSISTENCE_TARGET]);

    let ran = false;
    const smuggled = { ...observation("x"), audioBuffer: new ArrayBuffer(4) } as unknown as TranscriptObservation;
    await expect(
      glue.persistTranscript(smuggled, () => {
        ran = true;
      }),
    ).rejects.toThrow(/Only transcripts may be written/u);
    expect(ran).toBe(false);
  });
});
