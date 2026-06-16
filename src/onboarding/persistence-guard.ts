import type { LogEvent, TranscriptObservation } from "../types";

export type PersistenceSinkKind = "disk" | "log" | "trace";
export type SessionPhase = "starting" | "streaming" | "muted" | "ended";

export interface PersistenceWriteAttempt {
  sessionId: string;
  sink: PersistenceSinkKind;
  target: string;
  payload: unknown;
  phase?: SessionPhase;
}

export interface PersistenceGuardDecision {
  ok: true;
  sessionId: string;
  invariant: "whole-session-transcript-only";
}

export type PersistenceWriter<T = void> = (attempt: PersistenceWriteAttempt) => T | Promise<T>;

interface RawAudioMatch {
  path: string;
  reason: string;
}

const RAW_AUDIO_KEY = /raw[-_ ]?audio|audio[-_ ]?buffer|pcm|samples?|waveform/iu;
const RAW_AUDIO_TARGET = /\.(?:wav|wave|pcm|raw|aiff|flac|mp3|ogg|opus|m4a)$/iu;

export class WholeSessionPersistenceGuard {
  readonly #sessionId: string;

  constructor(sessionId: string) {
    this.#sessionId = sessionId;
  }

  assertSafeWrite(attempt: Omit<PersistenceWriteAttempt, "sessionId"> & { sessionId?: string }): PersistenceGuardDecision {
    const normalized = { ...attempt, sessionId: attempt.sessionId ?? this.#sessionId };
    return assertTranscriptOnlyPersistence(normalized);
  }

  async write<T>(
    attempt: Omit<PersistenceWriteAttempt, "sessionId"> & { sessionId?: string },
    writer: PersistenceWriter<T>,
  ): Promise<T> {
    const normalized = { ...attempt, sessionId: attempt.sessionId ?? this.#sessionId };
    this.assertSafeWrite(normalized);
    return writer(normalized);
  }
}

export function assertTranscriptOnlyPersistence(attempt: PersistenceWriteAttempt): PersistenceGuardDecision {
  const targetMatch = RAW_AUDIO_TARGET.test(attempt.target) || /raw[-_.]?audio|audio[-_.]buffer|pcm/iu.test(attempt.target)
    ? { path: "target", reason: `raw-audio target ${attempt.target}` }
    : null;
  const payloadMatch = findRawAudio(attempt.payload, ["payload"], new Set<object>());
  const match = targetMatch ?? payloadMatch;

  if (match !== null) {
    throw new Error(
      `Whole-session raw-audio persistence blocked for ${attempt.sessionId} at ${match.path}: ${match.reason}. ` +
        "Only transcripts may be written for the entire session.",
    );
  }

  return {
    ok: true,
    sessionId: attempt.sessionId,
    invariant: "whole-session-transcript-only",
  };
}

export function createGuardedPersistenceWriter<T = void>(
  sessionId: string,
  writer: PersistenceWriter<T>,
): PersistenceWriter<Promise<T>> {
  const guard = new WholeSessionPersistenceGuard(sessionId);
  return (attempt) => guard.write(attempt, writer);
}

export function transcriptPersistencePayload(observation: TranscriptObservation): TranscriptObservation {
  return observation;
}

export function logPersistencePayload(event: LogEvent): LogEvent {
  assertTranscriptOnlyPersistence({
    sessionId: event.sessionId,
    sink: "log",
    target: event.event,
    payload: event,
  });
  return event;
}

function findRawAudio(value: unknown, path: string[], seen: Set<object>): RawAudioMatch | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (isRawAudioBuffer(value)) {
    return { path: path.join("."), reason: "audio buffer value" };
  }

  if (value instanceof ReadableStream) {
    return { path: path.join("."), reason: "audio stream value" };
  }

  if (typeof value !== "object") {
    return null;
  }

  if (seen.has(value)) {
    return null;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const match = findRawAudio(item, [...path, String(index)], seen);
      if (match !== null) {
        return match;
      }
    }
    return null;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (RAW_AUDIO_KEY.test(key)) {
      return { path: [...path, key].join("."), reason: `raw-audio field ${key}` };
    }
    const match = findRawAudio(child, [...path, key], seen);
    if (match !== null) {
      return match;
    }
  }

  return null;
}

function isRawAudioBuffer(value: unknown): boolean {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}
