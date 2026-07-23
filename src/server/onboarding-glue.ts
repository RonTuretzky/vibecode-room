// Session-start onboarding glue (audit: src/onboarding is tested but DEAD —
// nothing in composition ever constructed ConsentScheduler, ListeningIndicator,
// or the persistence guard). This is the thin seam composition calls at session
// start / mic open so the EXISTING tested modules run through their real APIs:
//
//   consent.ts             REQ-1: the exact disclosure literal is spoken+traced
//                          once at boot (session.start with transcriptOnlyStated)
//                          and returned as a "vibersyn" TranscriptLine so the
//                          wall transcript shows the disclosure too.
//   listening-indicator.ts the AUTHORITATIVE mic-state source: `listening()` is
//                          true only while a mic stream is actually open, driven
//                          by micOpened()/micClosed() — never a board-side guess.
//                          The stopped→streaming transition plays the E2 earcon
//                          and emits the earcon trace exactly once per open.
//   persistence-guard.ts   wrapped around every transcript-line fold: transcripts
//                          only, never raw audio, for the whole session. A
//                          payload smuggling PCM/audio buffers throws before the
//                          write happens.
//
// The glue owns NO policy of its own — it only constructs the tested modules
// with composition's real callbacks (recordOutput/emitOutput, recordExternalTrace,
// the shared AudioOutput, the injected clock) and re-exposes their APIs at the
// granularity the runtime calls them (boot, mic open/close, ingestTranscript).

import { ConsentScheduler, type ConsentSchedulerResult } from "../onboarding/consent";
import {
  ListeningIndicator,
  type AuthoritativeListeningIndicator,
  type ListeningIndicatorEmission,
} from "../onboarding/listening-indicator";
import {
  WholeSessionPersistenceGuard,
  type PersistenceGuardDecision,
  type PersistenceWriter,
  type SessionPhase,
} from "../onboarding/persistence-guard";
import type { AudioOutput } from "../audio/earcons";
import type { LogEvent, OutputDecision, TranscriptObservation } from "../types";
import type { TranscriptLine } from "../ui/types";

// Every live transcript fold is asserted against this one target so a raw-audio
// filename can never masquerade as the transcript sink.
export const TRANSCRIPT_PERSISTENCE_TARGET = "live-transcript";

export interface OnboardingGlueOptions {
  sessionId: string;
  // ASR backend label recorded on the REQ-1 session.start trace (the runtime's
  // live-mic mode, e.g. "deepgram" | "voxterm" | "replay").
  provider: string;
  // Earcon output the listening indicator plays E2 through (composition's shared
  // BufferedAudioOutput, so the indicator's earcon lands in the same sink as
  // every other audible).
  output: AudioOutput;
  clock?: () => number;
  // The consent disclosure is a tts OutputDecision; route it through the same
  // emit path stage transitions use so it is actually spoken AND recorded.
  onOutput?: (decision: OutputDecision) => void | Promise<void>;
  onTrace?: (event: LogEvent) => void;
}

export interface ConsentBootResult {
  result: ConsentSchedulerResult;
  // The disclosure as a wall-transcript line ("vibersyn" speaker), ready to fold
  // into the live transcript at boot.
  line: TranscriptLine;
}

export class OnboardingGlue {
  readonly #consent: ConsentScheduler;
  readonly #indicator: ListeningIndicator;
  readonly #guard: WholeSessionPersistenceGuard;

  constructor(options: OnboardingGlueOptions) {
    this.#consent = new ConsentScheduler({
      sessionId: options.sessionId,
      provider: options.provider,
      clock: options.clock,
      onOutput: options.onOutput,
      onTrace: options.onTrace,
    });
    this.#indicator = new ListeningIndicator({
      sessionId: options.sessionId,
      output: options.output,
      clock: options.clock,
      onTrace: options.onTrace,
    });
    this.#guard = new WholeSessionPersistenceGuard(options.sessionId);
  }

  // Boot (REQ-1): speak+trace the disclosure once. Idempotent — the scheduler
  // returns the first result on any later call, and onOutput/onTrace fire once.
  async announceConsent(startedAtMs?: number): Promise<ConsentBootResult> {
    const result = await this.#consent.start(startedAtMs);
    return { result, line: consentTranscriptLine(result) };
  }

  consentSpoken(): boolean {
    return this.#consent.consentSpoken();
  }

  // Mic-stream open: the ONLY input that can flip the authoritative indicator to
  // listening. Returns the E2 emission on a stopped→streaming transition, null
  // when the stream was already open (no double earcon).
  async micOpened(correlationId: string, nowMs?: number): Promise<ListeningIndicatorEmission | null> {
    return this.#indicator.updateFromMicStream({ phase: "streaming", correlationId, nowMs });
  }

  // Mic-stream close: flips the authoritative indicator back to not-listening.
  async micClosed(correlationId: string, nowMs?: number): Promise<void> {
    await this.#indicator.updateFromMicStream({ phase: "stopped", correlationId, nowMs });
  }

  // The snapshot's `listening` flag reads THIS — mic-stream truth, not session
  // bookkeeping. (Callers still AND in mute/emergency, which are stricter.)
  listening(): boolean {
    return this.#indicator.authoritativeState().listening;
  }

  listeningState(): AuthoritativeListeningIndicator {
    return this.#indicator.authoritativeState();
  }

  // Transcript-only persistence (whole session): assert BEFORE folding a line
  // into any persisted/published transcript state. Throws on raw audio; returns
  // the guard's decision so callers can trace the invariant if they want.
  guardTranscript(observation: TranscriptObservation, phase: SessionPhase = "streaming"): PersistenceGuardDecision {
    return this.#guard.assertSafeWrite({
      sink: "trace",
      target: TRANSCRIPT_PERSISTENCE_TARGET,
      payload: observation,
      phase,
    });
  }

  // Guarded write wrapper for callers that persist through a writer function
  // (e.g. a jsonl transcript sink): the writer only runs if the payload passes
  // the transcript-only assertion.
  async persistTranscript<T>(
    observation: TranscriptObservation,
    writer: PersistenceWriter<T>,
    phase: SessionPhase = "streaming",
  ): Promise<T> {
    return this.#guard.write(
      { sink: "disk", target: TRANSCRIPT_PERSISTENCE_TARGET, payload: observation, phase },
      writer,
    );
  }
}

// The REQ-1 disclosure as a wall-transcript line. Speaker/kind mirror how the
// projector renders runtime speech (kind "vibersyn", never "room").
export function consentTranscriptLine(result: ConsentSchedulerResult, at: Date = new Date()): TranscriptLine {
  return {
    time: at.toISOString().slice(11, 19),
    speaker: "Vibersyn",
    text: result.text,
    kind: "vibersyn",
  };
}
