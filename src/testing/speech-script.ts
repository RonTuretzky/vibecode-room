// SPEECH SCRIPT — the injected-microphone DSL.
//
// A test writes what a HUMAN DOES ("somebody says X, pauses, says Y") and this
// module compiles it into the exact frame stream a real-time ASR emits: a run of
// interim (partial) hypotheses at a realistic cadence, then one committed final
// after a stretch of trailing silence (endpointing). The compiled frames are
// replayed by scripts/fake-voxterm.ts on a wall clock, so the room experiences
// speech arriving at human speed — not a fixture dumped in one microtask.
//
// WHY A COMPILER AND NOT A FIXTURE: every existing "e2e" in this repo hands the
// runtime a finished array of TranscriptObservations (test/e2e/*.e2e.ts), which
// makes cadence, interim/final interleaving and endpointing structurally
// untestable. Those are exactly the properties the wall's responsivity depends
// on, so the harness models them explicitly and measures against them.
//
// The compiled frame shape is the forked-VoxTerm NDJSON IPC contract documented
// in src/providers/asr/voxterm.ts (utteranceId / text / final / speaker /
// emittedAtMs). That contract is production's own ASR seam — the harness fakes
// the OUTSIDE WORLD (the recognizer) and nothing else.

/**
 * End-of-utterance silence the room asks its recognizer for, mirrored from
 * MIC_ENDPOINTING_BASE_MS (src/server/composition.ts:4895) so a scripted pause
 * is the same length as the one the live room waits out. Kept as a literal (not
 * an import) because importing composition.ts drags the whole runtime into the
 * compiler; speech-script.test.ts asserts the two stay in sync.
 */
export const DEFAULT_ENDPOINT_MS = 900;

/** Interim cadence of a real streaming recognizer (~100–300ms per partial). */
export const DEFAULT_INTERIM_EVERY_MS = 220;

/** How long the speaker's words take to arrive, per word, before endpointing. */
export const DEFAULT_MS_PER_WORD = 240;

export interface ScriptedUtterance {
  /** The committed text — what the room should end up believing was said. */
  text: string;
  /**
   * Diarization label. Numbers become `speaker_N` (src/providers/asr/voxterm.ts
   * formatSpeakerLabel). OMIT to reproduce production's own default: the live
   * room never asks Deepgram for `diarize=true`, so every real line is "Room".
   */
  speaker?: number | string;
  /** Silence held BEFORE this utterance starts, on top of the previous endpoint. */
  pauseBeforeMs?: number;
  /**
   * Explicit interim hypotheses. Default: cumulative word prefixes, which is
   * what a streaming recognizer actually emits. `[]` = no interims at all
   * (a recognizer that only commits).
   */
  interims?: string[];
  /** ms between interim frames. Default {@link DEFAULT_INTERIM_EVERY_MS}. */
  interimEveryMs?: number;
  /**
   * Trailing silence before the final commits. Default
   * {@link DEFAULT_ENDPOINT_MS} — the room's own endpointing target.
   */
  endpointMs?: number;
  /**
   * Emit an extra `final` frame every N words INSIDE the utterance. Real
   * Deepgram does this constantly (is_final fires mid-sentence; only
   * speech_final marks the true end, and src/providers/asr/deepgram.ts:236
   * throws speech_final away). Set this to reproduce the fragmentation the
   * live room actually receives.
   */
  midFinalsEveryWords?: number;
}

export interface SpeechScript {
  utterances: ScriptedUtterance[];
  /** Silence held after the last final, before the injector goes idle. */
  tailSilenceMs?: number;
}

/** One frame as scripts/fake-voxterm.ts will emit it on the child's stdout. */
export interface ScriptFrame {
  /** ms from the start of the mic session at which this frame is emitted. */
  atMs: number;
  utteranceId: string;
  text: string;
  final: boolean;
  speaker?: number | string;
}

export interface CompiledScript {
  frames: ScriptFrame[];
  /** Total wall time the injector needs, including the tail silence. */
  durationMs: number;
  /** The committed text of every utterance, in order — the assertion oracle. */
  finals: string[];
}

/**
 * Cumulative word prefixes: "build a status wall" →
 * ["build", "build a", "build a status"]. The final full text is NOT included;
 * it arrives as the committed frame, which is how a recognizer behaves.
 */
export function cumulativeInterims(text: string): string[] {
  const words = text.trim().split(/\s+/u).filter((word) => word.length > 0);
  const prefixes: string[] = [];
  for (let count = 1; count < words.length; count += 1) {
    prefixes.push(words.slice(0, count).join(" "));
  }
  return prefixes;
}

/**
 * Compile a script into an absolutely-timed frame list. Times are relative to
 * the moment the mic session opens; the injector sleeps to each one.
 */
export function compileScript(script: SpeechScript): CompiledScript {
  const frames: ScriptFrame[] = [];
  const finals: string[] = [];
  let cursorMs = 0;

  script.utterances.forEach((utterance, index) => {
    const text = utterance.text.trim();
    if (text.length === 0) {
      throw new Error(`speech script utterance #${index} has empty text`);
    }
    const utteranceId = `u${index + 1}`;
    const interimEveryMs = utterance.interimEveryMs ?? DEFAULT_INTERIM_EVERY_MS;
    const endpointMs = utterance.endpointMs ?? DEFAULT_ENDPOINT_MS;
    const interims = utterance.interims ?? cumulativeInterims(text);

    cursorMs += utterance.pauseBeforeMs ?? 0;

    // Interims tick at the recognizer's cadence while the person is talking.
    for (const partial of interims) {
      cursorMs += interimEveryMs;
      frames.push(frame(cursorMs, utteranceId, partial, false, utterance.speaker));
    }

    // Mid-utterance finals: a real is_final fragment lands and the recognizer
    // keeps going. Emitted at the interim cadence, interleaved by word count.
    const midEvery = utterance.midFinalsEveryWords ?? 0;
    if (midEvery > 0) {
      const words = text.split(/\s+/u);
      for (let cut = midEvery; cut < words.length; cut += midEvery) {
        cursorMs += interimEveryMs;
        frames.push(frame(cursorMs, `${utteranceId}f${cut}`, words.slice(cut - midEvery, cut).join(" "), true, utterance.speaker));
      }
    }

    // Then the speaker stops and the recognizer waits out its endpointing
    // window before committing.
    cursorMs += Math.max(interimEveryMs, endpointMs);
    frames.push(frame(cursorMs, utteranceId, text, true, utterance.speaker));
    finals.push(text);
  });

  const durationMs = cursorMs + (script.tailSilenceMs ?? 0);
  return { frames, durationMs, finals };
}

function frame(
  atMs: number,
  utteranceId: string,
  text: string,
  final: boolean,
  speaker: number | string | undefined,
): ScriptFrame {
  const built: ScriptFrame = { atMs: Math.round(atMs), utteranceId, text, final };
  if (speaker !== undefined) {
    built.speaker = speaker;
  }
  return built;
}

/** Shorthand: a plain list of sentences, each with default cadence + endpointing. */
export function say(...sentences: string[]): SpeechScript {
  return { utterances: sentences.map((text) => ({ text })) };
}
