import { describe, expect, test } from "bun:test";
import { DeepgramNova3ASRProvider } from "./deepgram";
import { ReplayASRProvider } from "./replay";
import {
  MIC_CLOSE_TIMEOUT_MS,
  selectAsrProvider,
  type AsrSelectionEnv,
  type AsrSelectionOptions,
} from "./registry";
import { arraySegmentSource, VoxTermASRProvider, type VoxTermSegment } from "./voxterm";
import { transcriptObservationSchema, type TranscriptObservation } from "../../types";

// Deepgram-shaped token so createAudioCredentialSource accepts it as a real
// provider key (see src/security/secrets.ts deepgram-key pattern).
const DEEPGRAM_KEY = "dg_test_0123456789abcdef0123456789";
const baseOptions: AsrSelectionOptions = { sessionId: "registry-session" };

function emptyAudioStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

describe("selectAsrProvider — explicit PANOP_ASR_PROVIDER mapping (unit)", () => {
  test("maps 'deepgram' to DeepgramNova3ASRProvider", () => {
    const selection = selectAsrProvider({ PANOP_ASR_PROVIDER: "deepgram", DEEPGRAM_API_KEY: DEEPGRAM_KEY }, baseOptions);

    expect(selection.mode).toBe("deepgram");
    expect(selection.provider).toBeInstanceOf(DeepgramNova3ASRProvider);
  });

  test("maps 'voxterm' to VoxTermASRProvider", () => {
    const selection = selectAsrProvider({ PANOP_ASR_PROVIDER: "voxterm" }, baseOptions);

    expect(selection.mode).toBe("voxterm");
    expect(selection.provider).toBeInstanceOf(VoxTermASRProvider);
  });

  test("the selected voxterm provider is driven by the injected segment source", async () => {
    // An interim revision then the committed final of one utterance, plus a second
    // utterance — the injected source is the only thing that can produce these.
    const segments: VoxTermSegment[] = [
      { utteranceId: 9, text: "open the", final: false, speaker: 0, emittedAtMs: 100 },
      { utteranceId: 9, text: "open the build dashboard", final: true, speaker: 0, emittedAtMs: 260 },
      { utteranceId: 10, text: "and ship it", final: true, speaker: 1, emittedAtMs: 600 },
    ];
    const selection = selectAsrProvider(
      { PANOP_ASR_PROVIDER: "voxterm" },
      { sessionId: "registry-voxterm", voxtermSource: arraySegmentSource(segments) },
    );

    expect(selection.mode).toBe("voxterm");
    expect(selection.provider).toBeInstanceOf(VoxTermASRProvider);

    const observations: TranscriptObservation[] = [];
    for await (const observation of selection.provider.stream(emptyAudioStream())) {
      expect(transcriptObservationSchema.parse(observation)).toEqual(observation);
      observations.push(observation);
    }

    // The injected frames — and only those — surfaced, in order, stamped with the
    // selection's sessionId and the stable per-utterance ids.
    expect(observations.map((o) => o.text)).toEqual([
      "open the",
      "open the build dashboard",
      "and ship it",
    ]);
    expect(observations.map((o) => o.isFinal)).toEqual([false, true, true]);
    expect(observations.map((o) => o.utteranceId)).toEqual(["vox-9", "vox-9", "vox-10"]);
    expect(observations.every((o) => o.sessionId === "registry-voxterm")).toBe(true);
  });

  test("voxterm without an injected source streams nothing (no mic/process opened)", async () => {
    const selection = selectAsrProvider({ PANOP_ASR_PROVIDER: "voxterm" }, baseOptions);

    const observations: TranscriptObservation[] = [];
    for await (const observation of selection.provider.stream(emptyAudioStream())) {
      observations.push(observation);
    }
    expect(observations).toEqual([]);
  });

  test("maps 'replay' to ReplayASRProvider", () => {
    const selection = selectAsrProvider({ PANOP_ASR_PROVIDER: "replay" }, baseOptions);

    expect(selection.mode).toBe("replay");
    expect(selection.provider).toBeInstanceOf(ReplayASRProvider);
  });

  test("is case/whitespace tolerant for the explicit value", () => {
    const selection = selectAsrProvider({ PANOP_ASR_PROVIDER: "  VoxTerm  " }, baseOptions);

    expect(selection.mode).toBe("voxterm");
    expect(selection.provider).toBeInstanceOf(VoxTermASRProvider);
  });

  test("rejects an unknown PANOP_ASR_PROVIDER value", () => {
    expect(() => selectAsrProvider({ PANOP_ASR_PROVIDER: "whisper" }, baseOptions)).toThrow(
      /Unknown PANOP_ASR_PROVIDER/u,
    );
  });

  test("explicit deepgram without a key is a hard error", () => {
    expect(() => selectAsrProvider({ PANOP_ASR_PROVIDER: "deepgram" }, baseOptions)).toThrow(
      /requires DEEPGRAM_API_KEY/u,
    );
  });
});

describe("selectAsrProvider — micProfile close-timer cap (unit)", () => {
  test("micProfile:true lifts the Deepgram close timeout to the live-mic cap", () => {
    const selection = selectAsrProvider(
      { PANOP_ASR_PROVIDER: "deepgram", DEEPGRAM_API_KEY: DEEPGRAM_KEY },
      { ...baseOptions, micProfile: true },
    );

    expect(selection.provider).toBeInstanceOf(DeepgramNova3ASRProvider);
    expect((selection.provider as DeepgramNova3ASRProvider).closeTimeoutMs).toBe(MIC_CLOSE_TIMEOUT_MS);
  });

  test("non-mic selection leaves the provider's default close timeout in place", () => {
    const selection = selectAsrProvider(
      { PANOP_ASR_PROVIDER: "deepgram", DEEPGRAM_API_KEY: DEEPGRAM_KEY },
      baseOptions,
    );

    expect((selection.provider as DeepgramNova3ASRProvider).closeTimeoutMs).not.toBe(MIC_CLOSE_TIMEOUT_MS);
    // Provider default is 10s; well under the 6h live-mic cap.
    expect((selection.provider as DeepgramNova3ASRProvider).closeTimeoutMs).toBe(10_000);
  });

  test("MIC_CLOSE_TIMEOUT_MS env overrides the mic cap when valid", () => {
    const env: AsrSelectionEnv = {
      PANOP_ASR_PROVIDER: "deepgram",
      DEEPGRAM_API_KEY: DEEPGRAM_KEY,
      MIC_CLOSE_TIMEOUT_MS: "1234",
    };
    const selection = selectAsrProvider(env, { ...baseOptions, micProfile: true });

    expect((selection.provider as DeepgramNova3ASRProvider).closeTimeoutMs).toBe(1234);
  });

  test("an invalid MIC_CLOSE_TIMEOUT_MS env falls back to the default cap", () => {
    const env: AsrSelectionEnv = {
      PANOP_ASR_PROVIDER: "deepgram",
      DEEPGRAM_API_KEY: DEEPGRAM_KEY,
      MIC_CLOSE_TIMEOUT_MS: "not-a-number",
    };
    const selection = selectAsrProvider(env, { ...baseOptions, micProfile: true });

    expect((selection.provider as DeepgramNova3ASRProvider).closeTimeoutMs).toBe(MIC_CLOSE_TIMEOUT_MS);
  });
});

describe("selectAsrProvider — default by key presence (integration)", () => {
  test("no PANOP_ASR_PROVIDER + DEEPGRAM_API_KEY present -> deepgram", () => {
    const selection = selectAsrProvider({ DEEPGRAM_API_KEY: DEEPGRAM_KEY }, baseOptions);

    expect(selection.mode).toBe("deepgram");
    expect(selection.provider).toBeInstanceOf(DeepgramNova3ASRProvider);
  });

  test("no PANOP_ASR_PROVIDER + DEEPGRAM_API_KEY absent -> replay", () => {
    const selection = selectAsrProvider({}, baseOptions);

    expect(selection.mode).toBe("replay");
    expect(selection.provider).toBeInstanceOf(ReplayASRProvider);
  });

  test("an empty DEEPGRAM_API_KEY counts as absent -> replay", () => {
    const selection = selectAsrProvider({ DEEPGRAM_API_KEY: "" }, baseOptions);

    expect(selection.mode).toBe("replay");
    expect(selection.provider).toBeInstanceOf(ReplayASRProvider);
  });

  test("explicit value overrides key presence: key present but PANOP_ASR_PROVIDER=replay -> replay", () => {
    const selection = selectAsrProvider(
      { PANOP_ASR_PROVIDER: "replay", DEEPGRAM_API_KEY: DEEPGRAM_KEY },
      baseOptions,
    );

    expect(selection.mode).toBe("replay");
    expect(selection.provider).toBeInstanceOf(ReplayASRProvider);
  });

  test("explicit value overrides key absence: no key but PANOP_ASR_PROVIDER=voxterm -> voxterm", () => {
    const selection = selectAsrProvider({ PANOP_ASR_PROVIDER: "voxterm" }, baseOptions);

    expect(selection.mode).toBe("voxterm");
    expect(selection.provider).toBeInstanceOf(VoxTermASRProvider);
  });
});
