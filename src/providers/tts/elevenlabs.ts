import { credentialSourceSchema, type CredentialSource } from "../../types";
import { createAudioCredentialSource } from "../credentials";
import type { AudioReadableStream, TTSOptions, TTSProvider } from "../types";

const ELEVENLABS_API_BASE = "https://api.elevenlabs.io";
const DEFAULT_MODEL = "eleven_flash_v2_5";
// Rachel — ElevenLabs' public default voice id; callers override via TTSOptions.voice.
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";
const DEFAULT_OUTPUT_FORMAT = "mp3_44100_128";
const DEFAULT_CREDENTIAL_VARIABLE = "ELEVENLABS_API_KEY";
// 0-4: trades a touch of quality for time-to-first-byte. 3 keeps first audio chunk early.
const DEFAULT_OPTIMIZE_STREAMING_LATENCY = 3;

/**
 * A single synthesis request handed to the transport seam. The transport is the
 * only thing that touches the network, so unit tests inject a stub that streams
 * synthetic bytes offline while still asserting on the request shape.
 */
export interface TTSTransportRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

export type TTSTransport = (request: TTSTransportRequest) => Promise<AudioReadableStream>;

export interface ElevenLabsFlashTTSOptions {
  /**
   * The credential environment. The API key is resolved from `env[variable]` and
   * routed through {@link createAudioCredentialSource}; there is deliberately no
   * raw inline `apiKey` field so a key cannot bypass the sanctioned seam.
   */
  env?: Record<string, string | undefined>;
  variable?: string;
  transport?: TTSTransport;
  model?: string;
  voiceId?: string;
  outputFormat?: string;
  optimizeStreamingLatency?: number;
}

export interface ElevenLabsEnvTTS {
  provider: ElevenLabsFlashTTSProvider | null;
  credentialSource: CredentialSource;
  skippedReason: string | null;
}

export class ElevenLabsFlashTTSProvider implements TTSProvider {
  readonly credentialSource: CredentialSource;
  readonly #apiKey: string;
  readonly #transport: TTSTransport;
  readonly #model: string;
  readonly #voiceId: string;
  readonly #outputFormat: string;
  readonly #optimizeStreamingLatency: number;

  constructor(options: ElevenLabsFlashTTSOptions = {}) {
    const variable = options.variable ?? DEFAULT_CREDENTIAL_VARIABLE;
    // createAudioCredentialSource is the only sanctioned way in: it rejects
    // ambiguous/non-token values and yields a redacted environment descriptor.
    this.credentialSource = credentialSourceSchema.parse(
      createAudioCredentialSource({ provider: "tts", variable, env: options.env }),
    );

    const apiKey = options.env?.[variable];
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error(
        `ElevenLabsFlashTTSProvider requires ${variable} to be supplied through the audio credential source.`,
      );
    }

    this.#apiKey = apiKey;
    this.#transport = options.transport ?? fetchTransport;
    this.#model = options.model ?? DEFAULT_MODEL;
    this.#voiceId = options.voiceId ?? DEFAULT_VOICE_ID;
    this.#outputFormat = options.outputFormat ?? DEFAULT_OUTPUT_FORMAT;
    this.#optimizeStreamingLatency = options.optimizeStreamingLatency ?? DEFAULT_OPTIMIZE_STREAMING_LATENCY;
  }

  requestUrl(voiceId: string): string {
    const url = new URL(`/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`, ELEVENLABS_API_BASE);
    url.searchParams.set("output_format", this.#outputFormat);
    url.searchParams.set("optimize_streaming_latency", String(this.#optimizeStreamingLatency));
    return url.toString();
  }

  async speak(text: string, opts?: TTSOptions): Promise<AudioReadableStream> {
    if (text.trim().length === 0) {
      throw new Error("ElevenLabsFlashTTSProvider.speak requires non-empty text.");
    }

    const voiceId = opts?.voice ?? this.#voiceId;
    const body = JSON.stringify({
      text,
      model_id: this.#model,
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    });

    // The transport resolves as soon as response headers arrive, returning a
    // stream whose first chunk is available before synthesis completes.
    return this.#transport({
      url: this.requestUrl(voiceId),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
        "xi-api-key": this.#apiKey,
      },
      body,
    });
  }
}

export function createElevenLabsFlashTTSFromEnv(
  env: Record<string, string | undefined> = process.env,
  transport?: TTSTransport,
): ElevenLabsEnvTTS {
  const variable = DEFAULT_CREDENTIAL_VARIABLE;
  const credentialSource = createAudioCredentialSource({ provider: "tts", variable, env });
  const apiKey = env[variable];

  if (apiKey === undefined || apiKey.length === 0) {
    return {
      provider: null,
      credentialSource,
      skippedReason: `live ElevenLabs Flash TTS validation SKIPPED - requires ${variable}`,
    };
  }

  return {
    provider: new ElevenLabsFlashTTSProvider({ env, variable, transport }),
    credentialSource,
    skippedReason: null,
  };
}

async function fetchTransport(request: TTSTransportRequest): Promise<AudioReadableStream> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
  });

  if (!response.ok || response.body === null) {
    await response.body?.cancel().catch(() => {});
    const detail = response.body === null ? "missing response body" : `status ${response.status}`;
    throw new Error(`ElevenLabs streaming TTS request failed: ${detail}`);
  }

  return response.body;
}
