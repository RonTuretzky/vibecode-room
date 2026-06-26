import { describe, expect, test } from "bun:test";
import { ElevenLabsFlashTTSProvider, type TTSTransport } from "./elevenlabs";
import { NoopTTSProvider } from "./noop";
import {
  DEFAULT_TTS_CREDENTIAL_VARIABLE,
  selectTtsProvider,
  type TtsSelectionEnv,
} from "./registry";
// Barrel reachability (AC4): the real provider + the registry must be
// constructible only through the providers barrel, like every other provider.
import * as providers from "../index";

// A stub transport so the real provider can be constructed without a network.
const stubTransport: TTSTransport = async () => streamOf([Uint8Array.from([1, 2, 3, 4])]);

describe("selectTtsProvider — explicit PANOP_TTS_PROVIDER mapping (unit)", () => {
  test("maps 'noop' to NoopTTSProvider", () => {
    const selection = selectTtsProvider({ PANOP_TTS_PROVIDER: "noop" });

    expect(selection.mode).toBe("noop");
    expect(selection.provider).toBeInstanceOf(NoopTTSProvider);
  });

  test("maps 'elevenlabs' to ElevenLabsFlashTTSProvider when a key resolves", () => {
    const selection = selectTtsProvider(
      { PANOP_TTS_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: fakeElevenLabsKey() },
      { transport: stubTransport },
    );

    expect(selection.mode).toBe("elevenlabs");
    expect(selection.provider).toBeInstanceOf(ElevenLabsFlashTTSProvider);
    // The credential source records provenance only — never the raw key value.
    expect((selection.provider as ElevenLabsFlashTTSProvider).credentialSource).toEqual({
      kind: "environment",
      provider: "tts",
      variable: "ELEVENLABS_API_KEY",
      redacted: true,
    });
  });

  test("is case/whitespace tolerant for the explicit value", () => {
    const selection = selectTtsProvider({ PANOP_TTS_PROVIDER: "  Noop  " });

    expect(selection.mode).toBe("noop");
    expect(selection.provider).toBeInstanceOf(NoopTTSProvider);
  });

  test("rejects an unknown PANOP_TTS_PROVIDER value", () => {
    expect(() => selectTtsProvider({ PANOP_TTS_PROVIDER: "openai" })).toThrow(
      /Unknown PANOP_TTS_PROVIDER/u,
    );
  });
});

describe("selectTtsProvider — default + credential gating (integration)", () => {
  test("no PANOP_TTS_PROVIDER -> Noop (silent, no key, no network)", () => {
    const selection = selectTtsProvider({});

    expect(selection.mode).toBe("noop");
    expect(selection.provider).toBeInstanceOf(NoopTTSProvider);
  });

  test("an empty PANOP_TTS_PROVIDER falls back to the Noop default", () => {
    const selection = selectTtsProvider({ PANOP_TTS_PROVIDER: "" });

    expect(selection.mode).toBe("noop");
    expect(selection.provider).toBeInstanceOf(NoopTTSProvider);
  });

  test("'elevenlabs' without a credential surfaces a clear error", () => {
    expect(() => selectTtsProvider({ PANOP_TTS_PROVIDER: "elevenlabs" })).toThrow(
      /requires ELEVENLABS_API_KEY to be set/u,
    );
  });

  test("an empty ELEVENLABS_API_KEY counts as unresolvable for 'elevenlabs'", () => {
    const env: TtsSelectionEnv = { PANOP_TTS_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: "" };

    expect(() => selectTtsProvider(env)).toThrow(/requires ELEVENLABS_API_KEY to be set/u);
  });

  test("explicit value overrides the default: PANOP_TTS_PROVIDER=elevenlabs selects the real provider", () => {
    const selection = selectTtsProvider(
      { PANOP_TTS_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: fakeElevenLabsKey() },
      { transport: stubTransport },
    );

    expect(selection.mode).toBe("elevenlabs");
    expect(selection.provider).toBeInstanceOf(ElevenLabsFlashTTSProvider);
  });

  test("DEFAULT_TTS_CREDENTIAL_VARIABLE names the audio credential the real provider gates on", () => {
    expect(DEFAULT_TTS_CREDENTIAL_VARIABLE).toBe("ELEVENLABS_API_KEY");
  });
});

describe("tts registry is reachable through the providers barrel (AC4)", () => {
  test("the real provider and selectTtsProvider are exported from the barrel", () => {
    expect(typeof providers.selectTtsProvider).toBe("function");
    expect(providers.NoopTTSProvider).toBe(NoopTTSProvider);
    expect(providers.ElevenLabsFlashTTSProvider).toBe(ElevenLabsFlashTTSProvider);

    const selection = providers.selectTtsProvider({});
    expect(selection.mode).toBe("noop");
    expect(selection.provider).toBeInstanceOf(providers.NoopTTSProvider);
  });
});

function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

// Built at runtime (never a literal) so the source tree stays free of key-shaped strings.
function fakeElevenLabsKey(): string {
  return ["xi", `${"a".repeat(18)}1${"b".repeat(18)}`].join("-");
}
