import WebSocket, { type RawData } from "ws";
import { transcriptObservationSchema, type CredentialSource, type TranscriptObservation } from "../../types";
import { createAudioCredentialSource } from "../credentials";
import type { ASRProvider, AudioReadableStream } from "../types";

export interface DeepgramNova3ASROptions {
  apiKey: string;
  sessionId: string;
  model?: string;
  language?: string;
  sampleRate?: number;
  channels?: number;
  // End-of-utterance silence threshold forwarded as Deepgram's `endpointing`
  // param. A thunk is resolved at stream-connect time, so a caller can apply a
  // time-varying policy (e.g. the onboarding first-run +50% grace) per session.
  endpointingMs?: number | (() => number);
  diarizeModel?: "latest" | "v1";
  openTimeoutMs?: number;
  closeTimeoutMs?: number;
  clock?: () => number;
  utteranceIdFactory?: (input: DeepgramUtteranceIdInput) => string;
}

export interface DeepgramEnvASR {
  provider: DeepgramNova3ASRProvider | null;
  credentialSource: CredentialSource;
  skippedReason: string | null;
}

export interface DeepgramUtteranceIdInput {
  requestId: string;
  sequence: number;
  segmentIndex: number;
}

export interface DeepgramNormalizeOptions {
  sessionId: string;
  receivedAtMs: number;
  streamStartedAtMs: number;
  sequence: number;
  utteranceIdFactory?: (input: DeepgramUtteranceIdInput) => string;
}

interface DeepgramWord {
  word?: unknown;
  punctuated_word?: unknown;
  speaker?: unknown;
  start?: unknown;
  end?: unknown;
}

interface DeepgramAlternative {
  transcript?: unknown;
  words?: unknown;
}

interface DeepgramResult {
  type?: unknown;
  request_id?: unknown;
  is_final?: unknown;
  speech_final?: unknown;
  channel?: {
    alternatives?: unknown;
  };
}

interface SpeakerSegment {
  speaker: string | null;
  words: DeepgramWord[];
}

const DEEPGRAM_LISTEN_URL = "wss://api.deepgram.com/v1/listen";
const DEFAULT_OPEN_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 10_000;

export class DeepgramNova3ASRProvider implements ASRProvider {
  readonly credentialSource: CredentialSource;
  readonly #apiKey: string;
  readonly #sessionId: string;
  readonly #model: string;
  readonly #language: string;
  readonly #sampleRate: number;
  readonly #channels: number;
  readonly #endpointingMs: number | (() => number);
  readonly #diarizeModel: "latest" | "v1";
  readonly #openTimeoutMs: number;
  // Public so the ASR registry/factory can assert the lifted live-mic cap
  // (micProfile) without reaching into private state.
  readonly closeTimeoutMs: number;
  readonly #clock: () => number;
  readonly #utteranceIdFactory: (input: DeepgramUtteranceIdInput) => string;

  constructor(options: DeepgramNova3ASROptions) {
    if (options.apiKey.length === 0) {
      throw new Error("DeepgramNova3ASRProvider requires a non-empty API key.");
    }

    this.#apiKey = options.apiKey;
    this.#sessionId = options.sessionId;
    this.#model = options.model ?? "nova-3";
    this.#language = options.language ?? "en-US";
    this.#sampleRate = options.sampleRate ?? 16_000;
    this.#channels = options.channels ?? 1;
    this.#endpointingMs = options.endpointingMs ?? 300;
    this.#diarizeModel = options.diarizeModel ?? "v1";
    this.#openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
    this.closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.#clock = options.clock ?? (() => performance.now());
    this.#utteranceIdFactory = options.utteranceIdFactory ?? defaultUtteranceId;
    this.credentialSource = createAudioCredentialSource({
      provider: "deepgram",
      variable: "DEEPGRAM_API_KEY",
      env: { DEEPGRAM_API_KEY: options.apiKey },
    });
  }

  connectionUrl(): string {
    const url = new URL(DEEPGRAM_LISTEN_URL);
    url.searchParams.set("model", this.#model);
    url.searchParams.set("language", this.#language);
    url.searchParams.set("encoding", "linear16");
    url.searchParams.set("sample_rate", String(this.#sampleRate));
    url.searchParams.set("channels", String(this.#channels));
    url.searchParams.set("interim_results", "true");
    url.searchParams.set(
      "endpointing",
      String(typeof this.#endpointingMs === "function" ? this.#endpointingMs() : this.#endpointingMs),
    );
    url.searchParams.set("diarize_model", this.#diarizeModel);
    return url.toString();
  }

  async *stream(audio: AudioReadableStream): AsyncIterable<TranscriptObservation> {
    const ws = new WebSocket(this.connectionUrl(), {
      headers: { Authorization: `Token ${this.#apiKey}` },
    });
    const queue = new AsyncObservationQueue();
    const streamStartedAtMs = this.#clock();
    let sequence = 0;

    ws.on("message", (data) => {
      try {
        const message = parseDeepgramMessage(data);
        const observations = normalizeDeepgramMessage(message, {
          sessionId: this.#sessionId,
          receivedAtMs: this.#clock(),
          streamStartedAtMs,
          sequence: sequence++,
          utteranceIdFactory: this.#utteranceIdFactory,
        });
        queue.pushMany(observations);
      } catch (error) {
        queue.fail(error);
      }
    });
    ws.on("error", (error) => queue.fail(error));
    ws.on("close", (code, reason) => {
      if (code >= 4000) {
        queue.fail(new Error(`Deepgram WebSocket closed with code ${code}: ${reason.toString("utf8")}`));
      } else {
        queue.close();
      }
    });

    await waitForOpen(ws, this.#openTimeoutMs);
    void sendAudioAndClose(ws, audio).catch((error) => queue.fail(error));

    const closeTimer = setTimeout(() => {
      if (ws.readyState !== WebSocket.CLOSED) {
        ws.close();
      }
      queue.close();
    }, this.closeTimeoutMs);

    try {
      for await (const observation of queue) {
        yield observation;
      }
    } finally {
      clearTimeout(closeTimer);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
  }
}

export function createDeepgramNova3ASRFromEnv(env: Record<string, string | undefined> = process.env): DeepgramEnvASR {
  const credentialSource = createAudioCredentialSource({
    provider: "deepgram",
    variable: "DEEPGRAM_API_KEY",
    env,
  });
  const apiKey = env.DEEPGRAM_API_KEY;

  if (apiKey === undefined || apiKey.length === 0) {
    return {
      provider: null,
      credentialSource,
      skippedReason: "live Deepgram validation SKIPPED - requires DEEPGRAM_API_KEY",
    };
  }

  return {
    provider: new DeepgramNova3ASRProvider({
      apiKey,
      sessionId: env.VIBERSYN_ASR_DEEPGRAM_SESSION_ID ?? "probe-asr-deepgram-live",
    }),
    credentialSource,
    skippedReason: null,
  };
}

export function normalizeDeepgramMessage(
  message: unknown,
  options: DeepgramNormalizeOptions,
): TranscriptObservation[] {
  const result = parseResult(message);
  if (result === null) {
    return [];
  }

  if (typeof result.is_final !== "boolean") {
    throw new Error("Deepgram result is missing boolean is_final.");
  }

  const alternatives = Array.isArray(result.channel?.alternatives) ? result.channel.alternatives : [];
  const alternative = alternatives.find(isAlternative) ?? null;
  if (alternative === null) {
    return [];
  }

  const transcript = stringValue(alternative.transcript);
  const words = Array.isArray(alternative.words) ? alternative.words.filter(isWord) : [];
  if (transcript.length === 0 && words.length === 0) {
    return [];
  }

  const requestId = sanitizeIdentifier(stringValue(result.request_id) || "deepgram");
  const segments = segmentWords(words, transcript);

  return segments.map((segment, segmentIndex) =>
    transcriptObservationSchema.parse({
      text: segmentText(segment, transcript),
      isFinal: result.is_final,
      speaker: segment.speaker,
      sessionId: options.sessionId,
      latencyMs: measuredWordFinalLatencyMs(segment.words, options),
      utteranceId: (options.utteranceIdFactory ?? defaultUtteranceId)({
        requestId,
        sequence: options.sequence,
        segmentIndex,
      }),
    }),
  );
}

function parseResult(message: unknown): DeepgramResult | null {
  if (!isRecord(message)) {
    throw new Error("Deepgram message must be an object.");
  }

  if (message.type !== undefined && message.type !== "Results") {
    return null;
  }

  return message as DeepgramResult;
}

function isAlternative(value: unknown): value is DeepgramAlternative {
  return isRecord(value);
}

function isWord(value: unknown): value is DeepgramWord {
  return isRecord(value);
}

function segmentWords(words: DeepgramWord[], transcript: string): SpeakerSegment[] {
  if (words.length === 0) {
    return [{ speaker: null, words: [] }];
  }

  const segments: SpeakerSegment[] = [];
  for (const word of words) {
    const speaker = formatSpeakerLabel(word.speaker);
    const prior = segments.at(-1);
    if (prior !== undefined && prior.speaker === speaker) {
      prior.words.push(word);
    } else {
      segments.push({ speaker, words: [word] });
    }
  }

  if (segments.length === 1 && segmentText(segments[0], transcript).length === 0) {
    return [{ speaker: segments[0].speaker, words }];
  }
  return segments;
}

function segmentText(segment: SpeakerSegment, transcript: string): string {
  if (segment.words.length === 0) {
    return transcript;
  }

  return segment.words.map(wordText).filter((word) => word.length > 0).join(" ");
}

function wordText(word: DeepgramWord): string {
  return stringValue(word.punctuated_word) || stringValue(word.word);
}

function measuredWordFinalLatencyMs(words: DeepgramWord[], options: DeepgramNormalizeOptions): number {
  const maxEndSeconds = words.reduce<number | null>((max, word) => {
    const end = numberValue(word.end);
    if (end === null) {
      return max;
    }
    return max === null ? end : Math.max(max, end);
  }, null);

  if (maxEndSeconds === null) {
    return 0;
  }

  const wordFinalAtMs = options.streamStartedAtMs + maxEndSeconds * 1000;
  return Math.max(0, Math.round(options.receivedAtMs - wordFinalAtMs));
}

function formatSpeakerLabel(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return `speaker_${value}`;
  }

  if (typeof value === "string") {
    const numeric = /^speaker[_-]?(\d+)$/u.exec(value.trim());
    if (numeric !== null) {
      return `speaker_${numeric[1]}`;
    }
  }

  return null;
}

function parseDeepgramMessage(data: RawData): unknown {
  const text = typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString("utf8");
  return JSON.parse(text) as unknown;
}

async function waitForOpen(ws: WebSocket, timeoutMs: number): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out opening Deepgram WebSocket.")), timeoutMs);
    ws.on("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function sendAudioAndClose(ws: WebSocket, audio: AudioReadableStream): Promise<void> {
  const reader = audio.getReader();
  try {
    while (true) {
      const read = await reader.read();
      if (read.done) {
        break;
      }
      if (read.value.byteLength > 0 && ws.readyState === WebSocket.OPEN) {
        ws.send(read.value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "CloseStream" }));
  }
}

class AsyncObservationQueue implements AsyncIterable<TranscriptObservation> {
  readonly #items: TranscriptObservation[] = [];
  #resolve: (() => void) | null = null;
  #closed = false;
  #error: unknown = null;

  pushMany(items: TranscriptObservation[]): void {
    this.#items.push(...items);
    this.#wake();
  }

  close(): void {
    this.#closed = true;
    this.#wake();
  }

  fail(error: unknown): void {
    this.#error = error;
    this.#closed = true;
    this.#wake();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<TranscriptObservation> {
    while (true) {
      if (this.#items.length > 0) {
        yield this.#items.shift()!;
        continue;
      }

      if (this.#error !== null) {
        throw this.#error;
      }

      if (this.#closed) {
        return;
      }

      await new Promise<void>((resolve) => {
        this.#resolve = resolve;
      });
    }
  }

  #wake(): void {
    const resolve = this.#resolve;
    this.#resolve = null;
    resolve?.();
  }
}

function defaultUtteranceId(input: DeepgramUtteranceIdInput): string {
  return `asr-${input.requestId}-${input.sequence}-${input.segmentIndex}`;
}

function sanitizeIdentifier(value: string): string {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9_-]+/gu, "-").replace(/^-|-$/gu, "");
  return sanitized || "deepgram";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
