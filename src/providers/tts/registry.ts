// TTS provider registry / factory (ISSUE-0007).
//
// `selectTtsProvider(env, opts)` is the single seam that maps PANOP_TTS_PROVIDER
// onto a concrete TTS provider. It lives inside src/providers so it may import
// the concrete classes directly (the provider boundary lint only forbids that
// outside src/providers — see providers/boundary.test.ts).
//
// Selection precedence mirrors the ASR registry (Deepgram on key) and the
// DecisionLLM registry (Claude on credential): an explicit PANOP_TTS_PROVIDER
// always wins; with it unset the registry AUTO-SELECTS the real ElevenLabs
// provider when an ElevenLabs credential resolves, so a credentialled runtime
// actually speaks by default. With no credential it falls back to the Noop
// provider — a no-key, silent-but-recorded backend so offline/replay runs stay
// quiet (never reaching for the network or an audio device) while still
// recording every phrase that would have been spoken.
//
//   noop       -> NoopTTSProvider            (no-credential default; silent, records calls)
//   elevenlabs -> ElevenLabsFlashTTSProvider (explicit, or auto when ELEVENLABS_API_KEY resolves)
//
//   explicit env  >  credential auto-select  >  noop default

import {
  ElevenLabsFlashTTSProvider,
  type TTSTransport,
} from "./elevenlabs";
import { NoopTTSProvider } from "./noop";
import type { TTSProvider } from "../types";

export type TtsProviderMode = "noop" | "elevenlabs";

// The real streaming provider resolves its key from this environment variable
// through the sanctioned audio credential seam (see providers/credentials.ts).
export const DEFAULT_TTS_CREDENTIAL_VARIABLE = "ELEVENLABS_API_KEY";

export interface TtsSelectionEnv {
  PANOP_TTS_PROVIDER?: string;
  ELEVENLABS_API_KEY?: string;
  [key: string]: string | undefined;
}

export interface TtsSelectionOptions {
  /** Override the audio credential variable for the real provider. */
  credentialVariable?: string;
  /** Injectable streaming transport (tests/e2e substitute a stub for no network). */
  transport?: TTSTransport;
  /** Synthesis model id for the real provider. */
  model?: string;
  /** Default voice id for the real provider (callers still override per call). */
  voiceId?: string;
  /** Output container/format for the real provider. */
  outputFormat?: string;
  /** Time-to-first-byte latency trade for the real provider. */
  optimizeStreamingLatency?: number;
}

export interface TtsSelection {
  mode: TtsProviderMode;
  provider: TTSProvider;
}

export function selectTtsProvider(
  env: TtsSelectionEnv,
  options: TtsSelectionOptions = {},
): TtsSelection {
  const variable = options.credentialVariable ?? DEFAULT_TTS_CREDENTIAL_VARIABLE;
  const mode = resolveTtsMode(env, variable);
  switch (mode) {
    case "noop":
      return { mode, provider: new NoopTTSProvider() };
    case "elevenlabs":
      return { mode, provider: createElevenLabsProvider(env, options) };
  }
}

function resolveTtsMode(env: TtsSelectionEnv, variable: string): TtsProviderMode {
  const explicit = env.PANOP_TTS_PROVIDER?.trim().toLowerCase();
  if (explicit !== undefined && explicit.length > 0) {
    if (explicit === "noop" || explicit === "elevenlabs") {
      return explicit;
    }
    throw new Error(
      `Unknown PANOP_TTS_PROVIDER "${env.PANOP_TTS_PROVIDER}". Expected one of: noop, elevenlabs.`,
    );
  }

  // Unset: auto-select the real ElevenLabs provider when its credential resolves
  // so a credentialled runtime speaks by default (mirroring the ASR/Deepgram and
  // DecisionLLM/Claude auto-selects); otherwise Noop — silent-but-recorded, no
  // key, no network, no audio device.
  return hasResolvableTtsCredential(env, variable) ? "elevenlabs" : "noop";
}

function hasResolvableTtsCredential(env: TtsSelectionEnv, variable: string): boolean {
  const value = env[variable];
  return typeof value === "string" && value.length > 0;
}

function createElevenLabsProvider(
  env: TtsSelectionEnv,
  options: TtsSelectionOptions,
): ElevenLabsFlashTTSProvider {
  const variable = options.credentialVariable ?? DEFAULT_TTS_CREDENTIAL_VARIABLE;
  const apiKey = env[variable];
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error(
      `PANOP_TTS_PROVIDER=elevenlabs requires ${variable} to be set. ` +
        "Set it, or use PANOP_TTS_PROVIDER=noop for the silent-but-recorded default.",
    );
  }

  // The key is read only to gate selection; the provider itself resolves it
  // through the sanctioned audio credential source, which redacts the value.
  return new ElevenLabsFlashTTSProvider({
    env,
    variable,
    transport: options.transport,
    model: options.model,
    voiceId: options.voiceId,
    outputFormat: options.outputFormat,
    optimizeStreamingLatency: options.optimizeStreamingLatency,
  });
}
