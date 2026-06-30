import { readFile } from "node:fs/promises";
import WebSocket, { type RawData } from "ws";
import { DeepgramNova3ASRProvider, type ASRProvider, type AudioReadableStream } from "../providers";
import { readTranscriptObservationJsonl } from "../replay/jsonl";
import { transcriptObservationSchema, type LogEvent, type TranscriptObservation } from "../types";

export const LIVE_CAPTURE_SKIPPED_MARKER = "live capture skipped — needs DEEPGRAM_API_KEY";

export interface PcmAudioFrame {
  data: Uint8Array;
  timestampMs?: number;
  sampleRateHz?: number;
  channels?: number;
}

export interface AudioCapture {
  open(): AudioReadableStream | Promise<AudioReadableStream>;
}

export interface MuteGate {
  isMuted(): boolean;
  acceptPipelineObservation?(observation: TranscriptObservation): TranscriptObservation | null;
}

export interface CueTranscriptEvent {
  type: "qwen_asr.transcript";
  transcript: string;
  text: string;
  isFinal: boolean;
  speaker: string | null;
  rawInferenceMs: number;
  sentAtMs: number;
  sessionId: string;
  utteranceId: string;
  correlationId: string;
}

export interface CueTranscriptionIngressResult {
  event: CueTranscriptEvent;
  response?: unknown;
}

export interface CueTranscriptionIngress {
  send(event: CueTranscriptEvent): Promise<CueTranscriptionIngressResult>;
  close?(): void | Promise<void>;
}

export interface AudioCaptureAsrBridgeOptions {
  sessionId: string;
  capture: AudioCapture;
  asr: ASRProvider;
  ingress: CueTranscriptionIngress;
  mode?: "live" | "record-replay";
  marker?: string | null;
  mute?: MuteGate;
  clock?: () => number;
  idFactory?: () => string;
  onTrace?: (event: LogEvent) => void;
}

export interface AudioCaptureAsrBridgeRunResult {
  mode: "live" | "record-replay" | "muted-skip";
  marker: string | null;
  framesRead: number;
  framesForwarded: number;
  bytesRead: number;
  bytesForwarded: number;
  observations: number;
  ingressEvents: number;
  correlationIds: string[];
}

export interface CueWebSocketTranscriptionIngressOptions {
  baseUrl: string;
  sessionId: string;
  readyTimeoutMs?: number;
  responseTimeoutMs?: number;
}

export interface EnergyVadTurn {
  startFrame: number;
  endFrame: number;
  peakRms: number;
  speaker: null;
}

export interface EnergyVadReplayASROptions {
  transcriptSource: string | readonly TranscriptObservation[];
  thresholdRms?: number;
  minSpeechFrames?: number;
}

interface AudioCounters {
  framesRead: number;
  framesForwarded: number;
  bytesRead: number;
  bytesForwarded: number;
}

const DEFAULT_READY_TIMEOUT_MS = 3_000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 5_000;
const DEFAULT_VAD_THRESHOLD_RMS = 0.015;
const DEFAULT_MIN_SPEECH_FRAMES = 1;
const RAW_AUDIO_KEYS = new Set(["audio", "audioframe", "audioframes", "pcm", "rawaudio", "rawpcm", "framebytes"]);

export class AudioCaptureAsrBridge {
  readonly #sessionId: string;
  readonly #capture: AudioCapture;
  readonly #asr: ASRProvider;
  readonly #ingress: CueTranscriptionIngress;
  readonly #mode: "live" | "record-replay";
  readonly #marker: string | null;
  readonly #mute?: MuteGate;
  readonly #clock: () => number;
  readonly #idFactory: () => string;
  readonly #onTrace?: (event: LogEvent) => void;

  constructor(options: AudioCaptureAsrBridgeOptions) {
    this.#sessionId = options.sessionId;
    this.#capture = options.capture;
    this.#asr = options.asr;
    this.#ingress = options.ingress;
    this.#mode = options.mode ?? "live";
    this.#marker = options.marker ?? null;
    this.#mute = options.mute;
    this.#clock = options.clock ?? (() => performance.now());
    this.#idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.#onTrace = options.onTrace;
  }

  async run(): Promise<AudioCaptureAsrBridgeRunResult> {
    if (this.#mute?.isMuted() === true) {
      const correlationId = this.#correlationId();
      this.#trace("observe.muted", correlationId, 0, { streamingToCloud: false, reason: "muted-at-start" });
      return {
        mode: "muted-skip",
        marker: "capture skipped - muted",
        framesRead: 0,
        framesForwarded: 0,
        bytesRead: 0,
        bytesForwarded: 0,
        observations: 0,
        ingressEvents: 0,
        correlationIds: [correlationId],
      };
    }

    const counters: AudioCounters = {
      framesRead: 0,
      framesForwarded: 0,
      bytesRead: 0,
      bytesForwarded: 0,
    };
    const audio = muteGuardAudioStream(await this.#capture.open(), counters, () => this.#mute?.isMuted() !== true);
    const correlationIds: string[] = [];
    let observations = 0;
    let ingressEvents = 0;

    for await (const rawObservation of this.#asr.stream(audio)) {
      const parsed = transcriptObservationSchema.parse({
        ...rawObservation,
        sessionId: rawObservation.sessionId || this.#sessionId,
      });
      const mutedObservation = this.#mute?.acceptPipelineObservation?.(parsed);
      const accepted = mutedObservation === undefined ? parsed : mutedObservation;
      if (accepted === null) {
        continue;
      }

      const correlationId = this.#correlationId();
      const event = transcriptObservationToCueEvent(accepted, {
        correlationId,
        sentAtMs: Math.round(this.#clock()),
      });
      assertTranscriptOnlyCueEvent(event);
      await this.#ingress.send(event);
      observations += 1;
      ingressEvents += 1;
      correlationIds.push(correlationId);
      this.#trace("observe.final", correlationId, accepted.latencyMs, {
        utteranceId: accepted.utteranceId,
        isFinal: accepted.isFinal,
        speaker: accepted.speaker,
        bridgeMode: this.#mode,
      });
    }

    return {
      mode: this.#mode,
      marker: this.#marker,
      ...counters,
      observations,
      ingressEvents,
      correlationIds,
    };
  }

  #correlationId(): string {
    return `corr-asr-bridge-${this.#idFactory()}`;
  }

  #trace(event: LogEvent["event"], correlationId: string, latencyMs: number, meta: Record<string, unknown>): void {
    this.#onTrace?.({
      level: "info",
      event,
      sessionId: this.#sessionId,
      correlationId,
      latencyMs,
      meta,
    });
  }
}

export class ReplayPcmAudioCapture implements AudioCapture {
  constructor(readonly frames: readonly PcmAudioFrame[]) {}

  static async fromJsonl(path: string): Promise<ReplayPcmAudioCapture> {
    return new ReplayPcmAudioCapture(await readPcmFrameJsonl(path));
  }

  open(): AudioReadableStream {
    const frames = this.frames.map((frame) => new Uint8Array(frame.data));
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = frames.shift();
        if (next === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(next);
      },
    });
  }
}

export class EnergyVadReplayASRProvider implements ASRProvider {
  readonly #transcriptSource: string | readonly TranscriptObservation[];
  readonly #thresholdRms: number;
  readonly #minSpeechFrames: number;
  lastTurns: EnergyVadTurn[] = [];

  constructor(options: EnergyVadReplayASROptions) {
    this.#transcriptSource = options.transcriptSource;
    this.#thresholdRms = options.thresholdRms ?? DEFAULT_VAD_THRESHOLD_RMS;
    this.#minSpeechFrames = options.minSpeechFrames ?? DEFAULT_MIN_SPEECH_FRAMES;
  }

  async *stream(audio: AudioReadableStream): AsyncIterable<TranscriptObservation> {
    const frames = await drainAudioFrames(audio);
    this.lastTurns = detectEnergyTurns(frames, {
      thresholdRms: this.#thresholdRms,
      minSpeechFrames: this.#minSpeechFrames,
    });
    const observations = await this.#loadTranscriptReplay();

    for (const [index, observation] of observations.entries()) {
      const turn = this.lastTurns[index] ?? this.lastTurns.at(-1);
      yield transcriptObservationSchema.parse({
        ...observation,
        speaker: null,
        utteranceId: turn === undefined ? observation.utteranceId : `vad-${turn.startFrame}-${turn.endFrame}-${index}`,
      });
    }
  }

  async #loadTranscriptReplay(): Promise<TranscriptObservation[]> {
    const observations =
      typeof this.#transcriptSource === "string"
        ? await readTranscriptObservationJsonl(this.#transcriptSource)
        : [...this.#transcriptSource];
    return observations.map((observation) => transcriptObservationSchema.parse(observation));
  }
}

export class CueWebSocketTranscriptionIngress implements CueTranscriptionIngress {
  readonly #url: string;
  readonly #readyTimeoutMs: number;
  readonly #responseTimeoutMs: number;
  #ws: WebSocket | null = null;
  #ready: Promise<void> | null = null;

  constructor(options: CueWebSocketTranscriptionIngressOptions) {
    this.#url = cueTranscriptionWebSocketUrl(options.baseUrl, options.sessionId);
    this.#readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.#responseTimeoutMs = options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
  }

  async send(event: CueTranscriptEvent): Promise<CueTranscriptionIngressResult> {
    const ws = await this.#connect();
    const response = waitForMessage(ws, this.#responseTimeoutMs, (message) => {
      return isRecord(message) && message.type === event.type && message.transcript === event.transcript;
    });
    ws.send(JSON.stringify(event));
    return { event, response: await response };
  }

  async close(): Promise<void> {
    const ws = this.#ws;
    this.#ws = null;
    this.#ready = null;
    if (ws === null || ws.readyState === WebSocket.CLOSED) {
      return;
    }
    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      ws.close();
      setTimeout(resolve, 250);
    });
  }

  async #connect(): Promise<WebSocket> {
    if (this.#ws !== null && this.#ws.readyState === WebSocket.OPEN) {
      return this.#ws;
    }

    const ws = new WebSocket(this.#url);
    this.#ws = ws;
    this.#ready = waitForOpen(ws, this.#readyTimeoutMs).then(async () => {
      await waitForMessage(ws, this.#readyTimeoutMs, (message) => {
        return isRecord(message) && message.type === "transcriber.ready";
      });
    });
    await this.#ready;
    return ws;
  }
}

export interface GatedBridgeSelectionOptions {
  sessionId: string;
  env?: Record<string, string | undefined>;
  liveCapture?: AudioCapture;
  replayTranscriptPath: string;
  replayPcmFramesPath: string;
  ingress: CueTranscriptionIngress;
  mute?: MuteGate;
  clock?: () => number;
  idFactory?: () => string;
  onTrace?: (event: LogEvent) => void;
}

export interface GatedBridgeSelection {
  bridge: AudioCaptureAsrBridge;
  mode: "live" | "record-replay";
  marker: string | null;
  asr: ASRProvider;
  capture: AudioCapture;
}

export async function createGatedAudioCaptureAsrBridge(
  options: GatedBridgeSelectionOptions,
): Promise<GatedBridgeSelection> {
  // When a caller passes an explicit env map it is the source of truth (tests
  // pass `env: {}` to mean "no key"); only fall back to process.env when no env
  // was provided at all, so the host shell's DEEPGRAM_API_KEY cannot leak in.
  const apiKey = (options.env ?? process.env).DEEPGRAM_API_KEY;
  if (apiKey !== undefined && apiKey.length > 0 && options.liveCapture !== undefined) {
    const asr = new DeepgramNova3ASRProvider({ apiKey, sessionId: options.sessionId });
    const bridge = new AudioCaptureAsrBridge({
      ...options,
      capture: options.liveCapture,
      asr,
      mode: "live",
      marker: null,
    });
    return { bridge, mode: "live", marker: null, asr, capture: options.liveCapture };
  }

  const capture = await ReplayPcmAudioCapture.fromJsonl(options.replayPcmFramesPath);
  const asr = new EnergyVadReplayASRProvider({ transcriptSource: options.replayTranscriptPath });
  const marker =
    apiKey === undefined || apiKey.length === 0
      ? LIVE_CAPTURE_SKIPPED_MARKER
      : "live capture skipped - needs microphone PCM capture";
  const bridge = new AudioCaptureAsrBridge({
    ...options,
    capture,
    asr,
    mode: "record-replay",
    marker,
  });
  return { bridge, mode: "record-replay", marker, asr, capture };
}

export function transcriptObservationToCueEvent(
  observation: TranscriptObservation,
  options: { correlationId: string; sentAtMs: number },
): CueTranscriptEvent {
  return {
    type: "qwen_asr.transcript",
    transcript: observation.text,
    text: observation.text,
    isFinal: observation.isFinal,
    speaker: observation.speaker,
    rawInferenceMs: observation.latencyMs,
    sentAtMs: options.sentAtMs,
    sessionId: observation.sessionId,
    utteranceId: observation.utteranceId,
    correlationId: options.correlationId,
  };
}

export function assertTranscriptOnlyCueEvent(value: unknown): void {
  assertNoRawAudio(value, []);
}

export async function readPcmFrameJsonl(path: string): Promise<PcmAudioFrame[]> {
  const body = await readFile(path, "utf8");
  const frames: PcmAudioFrame[] = [];

  for (const [index, rawLine] of body.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed) || typeof parsed.dataBase64 !== "string") {
      throw new Error(`Invalid PCM frame JSONL at line ${index + 1}: missing dataBase64.`);
    }
    frames.push({
      data: Buffer.from(parsed.dataBase64, "base64"),
      timestampMs: numberValue(parsed.timestampMs),
      sampleRateHz: numberValue(parsed.sampleRateHz),
      channels: numberValue(parsed.channels),
    });
  }

  return frames;
}

export function detectEnergyTurns(
  frames: readonly Uint8Array[],
  options: { thresholdRms?: number; minSpeechFrames?: number } = {},
): EnergyVadTurn[] {
  const thresholdRms = options.thresholdRms ?? DEFAULT_VAD_THRESHOLD_RMS;
  const minSpeechFrames = options.minSpeechFrames ?? DEFAULT_MIN_SPEECH_FRAMES;
  const turns: EnergyVadTurn[] = [];
  let current: { startFrame: number; endFrame: number; peakRms: number; speechFrames: number } | null = null;

  for (const [index, frame] of frames.entries()) {
    const rms = linear16Rms(frame);
    if (rms >= thresholdRms) {
      if (current === null) {
        current = { startFrame: index, endFrame: index, peakRms: rms, speechFrames: 1 };
      } else {
        current.endFrame = index;
        current.peakRms = Math.max(current.peakRms, rms);
        current.speechFrames += 1;
      }
      continue;
    }

    if (current !== null) {
      pushTurnIfLongEnough(turns, current, minSpeechFrames);
      current = null;
    }
  }

  if (current !== null) {
    pushTurnIfLongEnough(turns, current, minSpeechFrames);
  }

  return turns;
}

async function drainAudioFrames(audio: AudioReadableStream): Promise<Uint8Array[]> {
  const reader = audio.getReader();
  const frames: Uint8Array[] = [];
  try {
    while (true) {
      const read = await reader.read();
      if (read.done) {
        return frames;
      }
      frames.push(read.value);
    }
  } finally {
    reader.releaseLock();
  }
}

function muteGuardAudioStream(audio: AudioReadableStream, counters: AudioCounters, shouldForward: () => boolean): AudioReadableStream {
  const reader = audio.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        const read = await reader.read();
        if (read.done) {
          controller.close();
          return;
        }

        counters.framesRead += 1;
        counters.bytesRead += read.value.byteLength;
        if (!shouldForward()) {
          continue;
        }

        counters.framesForwarded += 1;
        counters.bytesForwarded += read.value.byteLength;
        controller.enqueue(read.value);
        return;
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

function cueTranscriptionWebSocketUrl(baseUrl: string, sessionId: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/sessions/${encodeURIComponent(sessionId)}/transcription`;
  url.search = "";
  return url.toString();
}

async function waitForOpen(ws: WebSocket, timeoutMs: number): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out opening Cue transcription WebSocket.")), timeoutMs);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitForMessage(ws: WebSocket, timeoutMs: number, accept: (message: unknown) => boolean): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for Cue transcription WebSocket message."));
    }, timeoutMs);
    const onMessage = (raw: RawData) => {
      try {
        const message = parseWsJson(raw);
        if (!accept(message)) {
          return;
        }
        cleanup();
        resolve(message);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("error", onError);
    };
    ws.on("message", onMessage);
    ws.on("error", onError);
  });
}

function parseWsJson(raw: RawData): unknown {
  const text = typeof raw === "string" ? raw : Buffer.from(raw as Uint8Array).toString("utf8");
  return JSON.parse(text) as unknown;
}

function linear16Rms(frame: Uint8Array): number {
  if (frame.byteLength < 2) {
    return 0;
  }

  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const sampleCount = Math.floor(frame.byteLength / 2);
  let sumSquares = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = view.getInt16(index * 2, true) / 32768;
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / sampleCount);
}

function pushTurnIfLongEnough(
  turns: EnergyVadTurn[],
  turn: { startFrame: number; endFrame: number; peakRms: number; speechFrames: number },
  minSpeechFrames: number,
): void {
  if (turn.speechFrames < minSpeechFrames) {
    return;
  }
  turns.push({
    startFrame: turn.startFrame,
    endFrame: turn.endFrame,
    peakRms: turn.peakRms,
    speaker: null,
  });
}

function assertNoRawAudio(value: unknown, path: string[]): void {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    throw new Error(`Cue transcription event contains raw audio at ${path.join(".") || "<root>"}.`);
  }

  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      assertNoRawAudio(child, [...path, String(index)]);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (RAW_AUDIO_KEYS.has(key.toLowerCase())) {
      throw new Error(`Cue transcription event contains raw-audio field ${[...path, key].join(".")}.`);
    }
    assertNoRawAudio(child, [...path, key]);
  }
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
