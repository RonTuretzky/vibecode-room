import { describe, expect, test } from "bun:test";
import { DeepgramNova3ASRProvider } from "./deepgram";
import { ReplayASRProvider } from "./replay";
import {
  MIC_CLOSE_TIMEOUT_MS,
  selectAsrProvider,
  type AsrSelectionEnv,
  type AsrSelectionOptions,
} from "./registry";
import { VoxTermASRProvider } from "./voxterm";

// Deepgram-shaped token so createAudioCredentialSource accepts it as a real
// provider key (see src/security/secrets.ts deepgram-key pattern).
const DEEPGRAM_KEY = "dg_test_0123456789abcdef0123456789";
const baseOptions: AsrSelectionOptions = { sessionId: "registry-session" };

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
