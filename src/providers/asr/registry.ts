// ASR provider registry / factory (ISSUE-0002).
//
// `selectAsrProvider(env, opts)` is the single seam that maps VIBERSYN_ASR_PROVIDER
// onto a concrete ASR provider. It lives inside src/providers so it may import
// the concrete classes directly (the provider boundary lint only forbids that
// outside src/providers — see providers/boundary.test.ts).
//
// Default selection preserves today's composition behavior: Deepgram when
// DEEPGRAM_API_KEY is present, otherwise replay. An explicit VIBERSYN_ASR_PROVIDER
// always overrides the key-presence default.
//
// NOTE: this issue only delivers + unit-tests the factory and its barrel
// exposure. composition.ts is intentionally NOT rewired here; that swap happens
// with the live-loop wiring.

import { DeepgramNova3ASRProvider } from "./deepgram";
import { ReplayASRProvider, type ReplayASRSource } from "./replay";
import { VoxTermASRProvider, type VoxTermSegmentSource } from "./voxterm";
import { createVoxTermSegmentSource } from "./voxterm-source";
import type { ASRProvider } from "../types";

export type AsrProviderMode = "deepgram" | "voxterm" | "replay";

// Deepgram's stream() applies a close timer as a safety cap on total duration.
// A live mic must stay open for the whole session, so the mic profile lifts the
// cap well past any single demo (6h); the audio stream is closed explicitly on
// stop(). Carried forward from server/composition.ts so the mic path keeps its
// long-session cap. Overridable per-deploy via the MIC_CLOSE_TIMEOUT_MS env var.
export const MIC_CLOSE_TIMEOUT_MS = 6 * 60 * 60 * 1000;

export interface AsrSelectionEnv {
  VIBERSYN_ASR_PROVIDER?: string;
  DEEPGRAM_API_KEY?: string;
  MIC_CLOSE_TIMEOUT_MS?: string;
  VIBERSYN_ASR_REPLAY_FIXTURE?: string;
  [key: string]: string | undefined;
}

export interface AsrSelectionOptions {
  /** Session id stamped onto every emitted observation. */
  sessionId: string;
  /** Apply the lifted Deepgram close-timer for a continuous live-mic session. */
  micProfile?: boolean;
  /** End-of-utterance endpointing (ms or thunk) forwarded to the Deepgram backend. */
  endpointingMs?: number | (() => number);
  /** Replay source (observations array or jsonl path) for the replay backend. */
  replaySource?: ReplayASRSource;
  /** Injectable VoxTerm segment transport for the voxterm backend. */
  voxtermSource?: VoxTermSegmentSource;
}

export interface AsrSelection {
  mode: AsrProviderMode;
  provider: ASRProvider;
}

export function selectAsrProvider(env: AsrSelectionEnv, options: AsrSelectionOptions): AsrSelection {
  const mode = resolveAsrMode(env);
  switch (mode) {
    case "deepgram":
      return { mode, provider: createDeepgramProvider(env, options) };
    case "voxterm":
      return { mode, provider: createVoxTermProvider(options) };
    case "replay":
      return { mode, provider: createReplayProvider(env, options) };
  }
}

function resolveAsrMode(env: AsrSelectionEnv): AsrProviderMode {
  const explicit = env.VIBERSYN_ASR_PROVIDER?.trim().toLowerCase();
  if (explicit !== undefined && explicit.length > 0) {
    if (explicit === "deepgram" || explicit === "voxterm" || explicit === "replay") {
      return explicit;
    }
    throw new Error(
      `Unknown VIBERSYN_ASR_PROVIDER "${env.VIBERSYN_ASR_PROVIDER}". Expected one of: deepgram, voxterm, replay.`,
    );
  }

  // Unset: preserve today's default — Deepgram when a key is present, else replay.
  return hasDeepgramKey(env) ? "deepgram" : "replay";
}

function createDeepgramProvider(env: AsrSelectionEnv, options: AsrSelectionOptions): DeepgramNova3ASRProvider {
  const apiKey = env.DEEPGRAM_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("VIBERSYN_ASR_PROVIDER=deepgram requires DEEPGRAM_API_KEY to be set.");
  }

  return new DeepgramNova3ASRProvider({
    apiKey,
    sessionId: options.sessionId,
    // Only the live-mic path lifts the close-timer cap; a non-mic selection
    // leaves it at the provider default.
    closeTimeoutMs: options.micProfile === true ? resolveMicCloseTimeoutMs(env) : undefined,
    endpointingMs: options.endpointingMs,
  });
}

function createVoxTermProvider(options: AsrSelectionOptions): VoxTermASRProvider {
  return new VoxTermASRProvider({
    sessionId: options.sessionId,
    source: resolveVoxTermSource(options),
  });
}

/**
 * Pick the VoxTerm segment transport: the explicitly injected source when one is
 * provided (tests/e2e feed a synthetic source), otherwise the production
 * spawn-backed source that connects the forked VoxTerm child (GAP-002). The
 * production source spawns lazily, so binding it by default opens no mic/process
 * until a session actually streams.
 */
export function resolveVoxTermSource(options: AsrSelectionOptions): VoxTermSegmentSource {
  return options.voxtermSource ?? createVoxTermSegmentSource();
}

function createReplayProvider(env: AsrSelectionEnv, options: AsrSelectionOptions): ReplayASRProvider {
  const source = options.replaySource ?? env.VIBERSYN_ASR_REPLAY_FIXTURE ?? [];
  return new ReplayASRProvider(source);
}

function hasDeepgramKey(env: AsrSelectionEnv): boolean {
  return env.DEEPGRAM_API_KEY !== undefined && env.DEEPGRAM_API_KEY.length > 0;
}

function resolveMicCloseTimeoutMs(env: AsrSelectionEnv): number {
  const raw = env.MIC_CLOSE_TIMEOUT_MS;
  if (raw !== undefined && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return MIC_CLOSE_TIMEOUT_MS;
}
