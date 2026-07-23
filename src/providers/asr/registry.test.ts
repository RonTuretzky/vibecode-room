import { describe, expect, test } from "bun:test";
import { DeepgramNova3ASRProvider } from "./deepgram";
import { ReplayASRProvider } from "./replay";
import {
  MIC_CLOSE_TIMEOUT_MS,
  resolveVoxTermSource,
  selectAsrProvider,
  type AsrSelectionEnv,
  type AsrSelectionOptions,
} from "./registry";
import { arraySegmentSource, VoxTermASRProvider, type VoxTermSegment } from "./voxterm";
import { VoxTermSpawnSource } from "./voxterm-source";
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

describe("selectAsrProvider — explicit VIBERSYN_ASR_PROVIDER mapping (unit)", () => {
  test("maps 'deepgram' to DeepgramNova3ASRProvider", () => {
    const selection = selectAsrProvider({ VIBERSYN_ASR_PROVIDER: "deepgram", DEEPGRAM_API_KEY: DEEPGRAM_KEY }, baseOptions);

    expect(selection.mode).toBe("deepgram");
    expect(selection.provider).toBeInstanceOf(DeepgramNova3ASRProvider);
  });

  test("maps 'voxterm' to VoxTermASRProvider", () => {
    const selection = selectAsrProvider({ VIBERSYN_ASR_PROVIDER: "voxterm" }, baseOptions);

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
      { VIBERSYN_ASR_PROVIDER: "voxterm" },
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

  test("binds the production spawn-backed source by default (no injected source)", () => {
    // GAP-002: without an injected source the registry binds the production
    // VoxTermSpawnSource. It spawns lazily, so selection alone opens no
    // mic/process — only iterating its stream would.
    const source = resolveVoxTermSource(baseOptions);
    expect(source).toBeInstanceOf(VoxTermSpawnSource);

    // And the selected provider is the VoxTerm provider regardless.
    const selection = selectAsrProvider({ VIBERSYN_ASR_PROVIDER: "voxterm" }, baseOptions);
    expect(selection.mode).toBe("voxterm");
    expect(selection.provider).toBeInstanceOf(VoxTermASRProvider);
  });

  test("binds the injected source only when one is explicitly provided", () => {
    const injected = arraySegmentSource([]);
    expect(resolveVoxTermSource({ ...baseOptions, voxtermSource: injected })).toBe(injected);
    // Absent the injection it falls back to the production source, not the injected one.
    expect(resolveVoxTermSource(baseOptions)).not.toBe(injected);
    expect(resolveVoxTermSource(baseOptions)).toBeInstanceOf(VoxTermSpawnSource);
  });

  test("maps 'replay' to ReplayASRProvider", () => {
    const selection = selectAsrProvider({ VIBERSYN_ASR_PROVIDER: "replay" }, baseOptions);

    expect(selection.mode).toBe("replay");
    expect(selection.provider).toBeInstanceOf(ReplayASRProvider);
  });

  test("is case/whitespace tolerant for the explicit value", () => {
    const selection = selectAsrProvider({ VIBERSYN_ASR_PROVIDER: "  VoxTerm  " }, baseOptions);

    expect(selection.mode).toBe("voxterm");
    expect(selection.provider).toBeInstanceOf(VoxTermASRProvider);
  });

  test("rejects an unknown VIBERSYN_ASR_PROVIDER value", () => {
    expect(() => selectAsrProvider({ VIBERSYN_ASR_PROVIDER: "whisper" }, baseOptions)).toThrow(
      /Unknown VIBERSYN_ASR_PROVIDER/u,
    );
  });

  test("explicit deepgram without a key is a hard error", () => {
    expect(() => selectAsrProvider({ VIBERSYN_ASR_PROVIDER: "deepgram" }, baseOptions)).toThrow(
      /requires DEEPGRAM_API_KEY/u,
    );
  });
});

describe("selectAsrProvider — micProfile close-timer cap (unit)", () => {
  test("micProfile:true lifts the Deepgram close timeout to the live-mic cap", () => {
    const selection = selectAsrProvider(
      { VIBERSYN_ASR_PROVIDER: "deepgram", DEEPGRAM_API_KEY: DEEPGRAM_KEY },
      { ...baseOptions, micProfile: true },
    );

    expect(selection.provider).toBeInstanceOf(DeepgramNova3ASRProvider);
    expect((selection.provider as DeepgramNova3ASRProvider).closeTimeoutMs).toBe(MIC_CLOSE_TIMEOUT_MS);
  });

  test("non-mic selection leaves the provider's default close timeout in place", () => {
    const selection = selectAsrProvider(
      { VIBERSYN_ASR_PROVIDER: "deepgram", DEEPGRAM_API_KEY: DEEPGRAM_KEY },
      baseOptions,
    );

    expect((selection.provider as DeepgramNova3ASRProvider).closeTimeoutMs).not.toBe(MIC_CLOSE_TIMEOUT_MS);
    // Provider default is 10s; well under the 6h live-mic cap.
    expect((selection.provider as DeepgramNova3ASRProvider).closeTimeoutMs).toBe(10_000);
  });

  test("MIC_CLOSE_TIMEOUT_MS env overrides the mic cap when valid", () => {
    const env: AsrSelectionEnv = {
      VIBERSYN_ASR_PROVIDER: "deepgram",
      DEEPGRAM_API_KEY: DEEPGRAM_KEY,
      MIC_CLOSE_TIMEOUT_MS: "1234",
    };
    const selection = selectAsrProvider(env, { ...baseOptions, micProfile: true });

    expect((selection.provider as DeepgramNova3ASRProvider).closeTimeoutMs).toBe(1234);
  });

  test("an invalid MIC_CLOSE_TIMEOUT_MS env falls back to the default cap", () => {
    const env: AsrSelectionEnv = {
      VIBERSYN_ASR_PROVIDER: "deepgram",
      DEEPGRAM_API_KEY: DEEPGRAM_KEY,
      MIC_CLOSE_TIMEOUT_MS: "not-a-number",
    };
    const selection = selectAsrProvider(env, { ...baseOptions, micProfile: true });

    expect((selection.provider as DeepgramNova3ASRProvider).closeTimeoutMs).toBe(MIC_CLOSE_TIMEOUT_MS);
  });
});

describe("selectAsrProvider — default by key presence (integration)", () => {
  test("no VIBERSYN_ASR_PROVIDER + DEEPGRAM_API_KEY present -> deepgram", () => {
    const selection = selectAsrProvider({ DEEPGRAM_API_KEY: DEEPGRAM_KEY }, baseOptions);

    expect(selection.mode).toBe("deepgram");
    expect(selection.provider).toBeInstanceOf(DeepgramNova3ASRProvider);
  });

  test("no VIBERSYN_ASR_PROVIDER + DEEPGRAM_API_KEY absent -> replay", () => {
    const selection = selectAsrProvider({}, baseOptions);

    expect(selection.mode).toBe("replay");
    expect(selection.provider).toBeInstanceOf(ReplayASRProvider);
  });

  test("an empty DEEPGRAM_API_KEY counts as absent -> replay", () => {
    const selection = selectAsrProvider({ DEEPGRAM_API_KEY: "" }, baseOptions);

    expect(selection.mode).toBe("replay");
    expect(selection.provider).toBeInstanceOf(ReplayASRProvider);
  });

  test("explicit value overrides key presence: key present but VIBERSYN_ASR_PROVIDER=replay -> replay", () => {
    const selection = selectAsrProvider(
      { VIBERSYN_ASR_PROVIDER: "replay", DEEPGRAM_API_KEY: DEEPGRAM_KEY },
      baseOptions,
    );

    expect(selection.mode).toBe("replay");
    expect(selection.provider).toBeInstanceOf(ReplayASRProvider);
  });

  test("explicit value overrides key absence: no key but VIBERSYN_ASR_PROVIDER=voxterm -> voxterm", () => {
    const selection = selectAsrProvider({ VIBERSYN_ASR_PROVIDER: "voxterm" }, baseOptions);

    expect(selection.mode).toBe("voxterm");
    expect(selection.provider).toBeInstanceOf(VoxTermASRProvider);
  });
});

describe("Deepgram endpointing — onboarding first-run VAD grace seam", () => {
  test("a thunk endpointingMs is re-resolved per connection URL (time-varying policy)", () => {
    let endpointing = 450;
    const provider = new DeepgramNova3ASRProvider({
      apiKey: DEEPGRAM_KEY,
      sessionId: "vad-session",
      endpointingMs: () => endpointing,
    });
    expect(provider.connectionUrl()).toContain("endpointing=450");
    endpointing = 300;
    expect(provider.connectionUrl()).toContain("endpointing=300");
  });

  test("selectAsrProvider forwards endpointingMs to the deepgram backend", () => {
    const selection = selectAsrProvider(
      { DEEPGRAM_API_KEY: DEEPGRAM_KEY },
      { ...baseOptions, endpointingMs: () => 450 },
    );
    expect(selection.mode).toBe("deepgram");
    expect((selection.provider as DeepgramNova3ASRProvider).connectionUrl()).toContain("endpointing=450");
  });
});
