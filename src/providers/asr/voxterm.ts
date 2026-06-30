// VoxTerm ASR provider — bridges VoxTerm real-time transcript segments into the
// strict TranscriptObservation shape consumed across Panopticon.
//
// UPSTREAM / IPC CONTRACT
// -----------------------
// dmarzzz/VoxTerm `main` ships transcription as a *markdown/file poller* only
// (see docs/planning/03-eng.md:1280 — "voxterm (markdown file poller)"). That
// shape cannot drive a low-latency observation loop: there is no real-time
// per-segment event, only a file that is re-read on an interval.
//
// This provider therefore depends on a forked branch that adds a real-time
// segment IPC:
//
//   repo:      github.com/dmarzzz/VoxTerm
//   branch:    panopticon/realtime-segment-ipc
//   fork base: 64521b623ffdbbe456b5428445e43933898bb4b3 (dmarzzz/VoxTerm HEAD the
//              realtime-segment-ipc patch is cut from; resolve `git ls-remote`)
//
// The fork-base SHA above is the exact upstream commit the IPC patch is applied
// on top of; see docs/providers/voxterm.md for the pin rationale and the full
// frame contract. Re-pin both this header and that doc whenever the branch moves.
//
// IPC contract (newline-delimited JSON segment frames, one per line, emitted on
// the VoxTerm child's stdout / a Unix domain socket as each partial or final
// hypothesis is produced):
//
//   {
//     "utteranceId": <string|number>,  // stable across interims + the final
//                                       // commit of the SAME spoken utterance
//     "text":        <string>,         // current hypothesis text
//     "final":       <boolean>,        // false = interim, true = committed
//     "speaker":     <string|number|null?>, // optional diarization label
//     "startedAtMs": <number?>,        // wall-clock ms the utterance began
//     "emittedAtMs": <number?>         // wall-clock ms this frame was emitted
//   }
//
// The transport that yields these frames is INJECTABLE (see VoxTermSegmentSource)
// so unit/integration/e2e tests feed synthetic segments with no real VoxTerm
// process, microphone, or network. The full contract is mirrored in
// docs/providers/voxterm.md.
//
// This module is constructed only through the providers barrel (registry/barrel
// wiring lives in ISSUE-0002); it never opens a mic or socket on its own.

import { transcriptObservationSchema, type TranscriptObservation } from "../../types";
import type { ASRProvider, AudioReadableStream } from "../types";

/**
 * A single real-time hypothesis frame as emitted by the forked VoxTerm IPC.
 * Field semantics mirror the contract documented in the file header.
 */
export interface VoxTermSegment {
  /** Stable id shared by every interim update and the final commit of one utterance. */
  utteranceId: string | number;
  /** Current hypothesis text for the utterance. */
  text: string;
  /** false = interim hypothesis; true = committed/final. */
  final: boolean;
  /** Optional diarization label (number → `speaker_N`, string passed through). */
  speaker?: string | number | null;
  /** Wall-clock ms the utterance started (used for latency when present). */
  startedAtMs?: number;
  /** Wall-clock ms this frame was emitted by VoxTerm. */
  emittedAtMs?: number;
}

/**
 * Injectable transport that turns the captured audio into a stream of VoxTerm
 * segment frames. Production binds this to the forked VoxTerm child process;
 * tests bind it to a synthetic in-memory feed (see {@link arraySegmentSource}).
 */
export interface VoxTermSegmentSource {
  open(audio: AudioReadableStream): AsyncIterable<VoxTermSegment>;
}

export interface VoxTermNormalizeOptions {
  sessionId: string;
  receivedAtMs: number;
  utteranceIdPrefix: string;
}

export interface VoxTermASROptions {
  sessionId: string;
  /** The injectable segment transport. */
  source: VoxTermSegmentSource;
  /** Prefix applied to derived utterance ids; defaults to `"vox"`. */
  utteranceIdPrefix?: string;
  /** Monotonic clock in ms; defaults to `performance.now`. */
  clock?: () => number;
}

export class VoxTermASRProvider implements ASRProvider {
  readonly #sessionId: string;
  readonly #source: VoxTermSegmentSource;
  readonly #utteranceIdPrefix: string;
  readonly #clock: () => number;

  constructor(options: VoxTermASROptions) {
    if (options.sessionId.length === 0) {
      throw new Error("VoxTermASRProvider requires a non-empty sessionId.");
    }

    this.#sessionId = options.sessionId;
    this.#source = options.source;
    this.#utteranceIdPrefix = options.utteranceIdPrefix ?? "vox";
    this.#clock = options.clock ?? (() => performance.now());
  }

  async *stream(audio: AudioReadableStream): AsyncIterable<TranscriptObservation> {
    for await (const segment of this.#source.open(audio)) {
      yield normalizeVoxTermSegment(segment, {
        sessionId: this.#sessionId,
        receivedAtMs: this.#clock(),
        utteranceIdPrefix: this.#utteranceIdPrefix,
      });
    }
  }
}

/**
 * Map a single VoxTerm segment frame onto the strict TranscriptObservation shape.
 * Always returns a schema-valid observation (it parses before returning).
 */
export function normalizeVoxTermSegment(
  segment: VoxTermSegment,
  options: VoxTermNormalizeOptions,
): TranscriptObservation {
  return transcriptObservationSchema.parse({
    text: segment.text,
    isFinal: segment.final,
    speaker: formatSpeakerLabel(segment.speaker),
    sessionId: options.sessionId,
    latencyMs: measuredLatencyMs(segment, options.receivedAtMs),
    utteranceId: deriveUtteranceId(options.utteranceIdPrefix, segment.utteranceId),
  });
}

/**
 * An in-memory segment source for tests/e2e: yields the supplied frames in order
 * and terminates when the array is exhausted. Touches no mic, process, or network.
 */
export function arraySegmentSource(segments: Iterable<VoxTermSegment>): VoxTermSegmentSource {
  const frames = [...segments];
  return {
    async *open() {
      for (const segment of frames) {
        yield segment;
      }
    },
  };
}

function deriveUtteranceId(prefix: string, raw: string | number): string {
  const sanitizedPrefix = sanitizeIdentifier(prefix) || "vox";
  const sanitizedRaw = sanitizeIdentifier(String(raw));
  return `${sanitizedPrefix}-${sanitizedRaw || "0"}`;
}

function measuredLatencyMs(segment: VoxTermSegment, receivedAtMs: number): number {
  const emittedAtMs = numberValue(segment.emittedAtMs) ?? numberValue(segment.startedAtMs);
  if (emittedAtMs === null) {
    return 0;
  }
  return Math.max(0, Math.round(receivedAtMs - emittedAtMs));
}

function formatSpeakerLabel(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return `speaker_${value}`;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }
    const numeric = /^speaker[_-]?(\d+)$/u.exec(trimmed);
    if (numeric !== null) {
      return `speaker_${numeric[1]}`;
    }
    return trimmed;
  }

  return null;
}

function sanitizeIdentifier(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/gu, "-").replace(/^-|-$/gu, "");
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
