import { type SuggestionGateMeta, type DuplicateSpawnGuardOptions } from "./runtime-contract";
import { ProcessRegistry, type RegistryProcess } from "../process/registry";
import { join, resolve } from "node:path";
import type { AcceptanceSpawnSeam } from "../acceptance/spawn";
import { type SuggestionEngineConfig, type SuggestionEngineDecision } from "../suggest/engine";
import { type DocumentedCommand } from "../routing/vocabulary";
import { hasBuildableCue } from "../detect";
import { IDEA_BRIEF_QUOTE_MAX_CHARS, type DispatchedAction, type IdeaBrief, type LogEvent, type PendingSuggestion } from "../types";
import type { ProjectorProcessState, ProjectorSuggestion } from "../ui/types";


// Forced-suggestion pitch cap: enough words for a spoken idea, too few for a
// transcript dump to reach the deck's verbatim slide.
export const FORCED_PITCH_MAX_WORDS = 40;


// Pure: the pitch for a forced (nothing-surfaced) accept. STARTS at the last
// spoken line with a buildable cue — joining every collected line shipped
// unrelated chatter straight onto the deck's "verbatim idea" slide ("i love
// waffles. i love pancakes. i want an app…"). No cue anywhere → the last two
// lines are the best guess. Word-capped against rambling tails.
export function forcedPitchFromLines(lines: readonly string[]): string {
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (hasBuildableCue(lines[i])) {
      start = i;
      break;
    }
  }
  const tail = start >= 0 ? lines.slice(start) : lines.slice(-2);
  const words = tail.join(". ").split(/\s+/);
  return words.slice(0, FORCED_PITCH_MAX_WORDS).join(" ");
}


// Pure: the DEGENERATE IdeaBrief for a forced (nothing-surfaced) accept. No
// judge ran, so the sourceQuote IS the spoken tail — honest by construction:
// the deck's "as heard in the room" slide quotes what the room actually said.
// When the joined tail exceeds the brief's quote cap the END is kept (recency
// is where the idea lives), marked with a leading ellipsis. No rationale, no
// Q&A, no maturity — those only exist when the detection judge produced them.
export function forcedBriefFromLines(lines: readonly string[]): IdeaBrief {
  const joined = lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(". ");
  return {
    pitch: forcedPitchFromLines(lines),
    sourceQuote:
      joined.length <= IDEA_BRIEF_QUOTE_MAX_CHARS ? joined : `…${joined.slice(-(IDEA_BRIEF_QUOTE_MAX_CHARS - 1))}`,
    rationale: "",
    qa: [],
    callsign: null,
  };
}


// Near-miss vocabulary: the routing grammar's documented commands PLUS the wake
// table's phrases (voice-commands.ts COMMAND_TABLE), so "vibersyn build ot"
// lands on "Did you mean 'build it'?". Ids reuse the closest DocumentedCommandId
// (they only surface in trace meta). Bare "yes"/"no" are deliberately excluded —
// at <=3 letters a distance-2 match fires on ordinary speech.
export const SOFT_LANDING_COMMANDS: readonly DocumentedCommand[] = [
  { id: "wake", spokenForm: "capture / start capturing / listen", effect: "enable idea capture" },
  { id: "mute", spokenForm: "stop capturing / capture off / stand down", effect: "disable idea capture" },
  { id: "accept", spokenForm: "build it / build that / build this / accept / ship it", effect: "build the surfaced idea" },
  { id: "decline", spokenForm: "dismiss / skip / next", effect: "dismiss the surfaced idea" },
  { id: "panic", spokenForm: "emergency / stop everything / kill everything / shut down", effect: "emergency stop" },
  { id: "pauseAll", spokenForm: "pause all", effect: "pause all running processes" },
  { id: "status", spokenForm: "status", effect: "speak active-process summary" },
  { id: "stop", spokenForm: "stop / halt", effect: "halt selected process" },
  { id: "pause", spokenForm: "pause", effect: "pause target process" },
  { id: "resume", spokenForm: "resume", effect: "resume target process" },
  { id: "endSteering", spokenForm: "done / back", effect: "close steering window" },
];


// Spoken word count for grammar-generated TTS output decisions.
export function countSpokenWords(text: string): number {
  return text.trim().split(/\s+/u).filter(Boolean).length;
}


// COMMISSION voice phrases (after the wake word): normalized-token match, same
// idiom as the wake-router COMMAND_TABLE. Exported for the colocated tests.
export const EXECUTE_PHRASES: ReadonlySet<string> = new Set([
  "execute",
  "execute it",
  "execute that",
  "commission",
  "commission it",
  "commission that",
  "make it real",
  "full build",
]);


export function isExecutePhrase(afterWake: string): boolean {
  const normalized = afterWake
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 0)
    .join(" ");
  return EXECUTE_PHRASES.has(normalized);
}


// The commission target of last resort: when nothing is steered/selected but
// exactly ONE process is live, "vibersyn execute" unambiguously means it.
export function soleActiveUpid(registry: ProcessRegistry): string | null {
  const active = registry.activeRecords();
  return active.length === 1 ? active[0]!.upid : null;
}


// Spoken form of a fired suggestion: the pitch plus its lead question, mirroring
// the canonical spine's suggestionSpeech so the live ack reads the same way.
export function suggestionSpeech(suggestion: PendingSuggestion): string {
  return `${suggestion.pitch}. ${suggestion.mcqs[0] ?? "Proceed?"}`;
}


export function projectorState(state: RegistryProcess["state"]): ProjectorProcessState {
  switch (state) {
    case "planning":
    case "active":
    case "paused":
      return state;
    case "dead":
      return "halted";
    default:
      return "blocked";
  }
}


// Map one live SuggestionEngine verdict to the projector's idea-bubble shape.
// Returns null for the `idle` no-op verdict so the caller keeps the demo bubble.
// The gate counters come from the engine: words/seconds are the decision meta's
// substantive totals, minWords/minSeconds are the configured REQ-3 floors.
// Exported (ISSUE-0018) so the fired-decision -> bubble projection is unit-testable
// independently of the full runtime drive.
export function liveProjectorSuggestion(
  decision: SuggestionEngineDecision,
  config: SuggestionEngineConfig,
): ProjectorSuggestion | null {
  const minWords = config.wordFloor;
  const minSeconds = config.timeFloorSeconds;
  switch (decision.kind) {
    case "queued":
      return {
        state: "queued",
        pitch: decision.queued.suggestion.pitch,
        confidence: decision.queued.decision.quality,
        gate: gateFrom(decision.queued.decision, minWords, minSeconds),
        questions: [...decision.queued.suggestion.mcqs],
      };
    case "fired": {
      const meta = suggestionMetaFromEvents(decision.events);
      return {
        state: "speaking",
        pitch: decision.suggestion.pitch,
        confidence: meta.quality,
        gate: gateFrom(meta, minWords, minSeconds),
        questions: [...decision.suggestion.mcqs],
      };
    }
    case "expired":
      return {
        state: "declined",
        pitch: decision.suggestion.suggestion.pitch,
        confidence: decision.suggestion.decision.quality,
        gate: gateFrom(decision.suggestion.decision, minWords, minSeconds),
        questions: [...decision.suggestion.suggestion.mcqs],
      };
    case "pass": {
      // A FINAL utterance was scored but produced no suggestion (below the REQ-3
      // floor, or failed the quality gate). Show an idle bubble whose gate still
      // reflects real accumulated speech, so the panel reacts to live audio.
      const meta = suggestionMetaFromEvents(decision.events);
      return {
        state: "idle",
        pitch: "",
        confidence: meta.quality,
        gate: gateFrom(meta, minWords, minSeconds),
        questions: [],
      };
    }
    case "idle":
      return null;
  }
}


export function gateFrom(meta: SuggestionGateMeta, minWords: number, minSeconds: number): ProjectorSuggestion["gate"] {
  return { words: meta.wordCount, minWords, seconds: meta.elapsedS, minSeconds };
}


// `fired`/`pass` verdicts don't carry the decision meta on the returned object,
// only on their trace events. Pull the substantive word/time/quality counters
// from the first event whose meta carries them.
export function suggestionMetaFromEvents(events: readonly LogEvent[]): SuggestionGateMeta {
  for (const event of events) {
    const meta = event.meta;
    if (typeof meta.wordCount === "number") {
      return {
        wordCount: meta.wordCount,
        elapsedS: numberOr(meta.elapsedS, 0),
        quality: numberOr(meta.quality, 0),
      };
    }
  }
  return { wordCount: 0, elapsedS: 0, quality: 0 };
}


// 0 or a non-number means "no explicit cap" — use a high finite ceiling rather
// than Infinity so refusal traces stay JSON-safe.
export function resolveMaxConcurrentProcesses(env: Record<string, string | undefined>): number {
  const raw = env.VIBERSYN_MAX_CONCURRENT_PROCESSES?.trim();
  const parsed = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  if (Number.isFinite(parsed) && parsed >= 1) {
    return Math.floor(parsed);
  }
  return 16;
}


export function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}


// Poll cadence for the commission completion watchdog (watchRunCompletion).
// Overridable for tests; production default keeps it to ~4 cheap RPCs a minute.
export function resolveRunCompletionPollMs(env: Record<string, string | undefined>): number {
  const raw = env.VIBERSYN_RUN_POLL_MS?.trim();
  const parsed = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  if (Number.isFinite(parsed) && parsed >= 1) {
    return Math.floor(parsed);
  }
  return 15_000;
}


export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


// Drain window before the self-reload exit(87): long enough for the trigger's
// HTTP response + the reloadPending SSE frame to flush, short enough that the
// wall barely notices. Overridable for tests (VIBERSYN_SELF_RELOAD_DELAY_MS).
export function resolveSelfReloadDelayMs(env: Record<string, string | undefined>): number {
  const raw = env.VIBERSYN_SELF_RELOAD_DELAY_MS?.trim();
  const parsed = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  if (Number.isFinite(parsed) && parsed >= 0) {
    return Math.floor(parsed);
  }
  return 750;
}


// --- Auto-build settle gate --------------------------------------------------
//
// LIVE-ROOM FINDING: firing auto-build the instant the first candidate crossed
// the ready threshold cut speakers off mid-description (guided demo and plain
// capture alike). The detector refines the same candidate on every round, so
// auto-build now waits until the room has been QUIET — no new FINAL utterances —
// for this long before building. ~8s comfortably covers a thinking pause
// without feeling unresponsive once the speaker actually stops.

// The live-mic Deepgram endpointing base (ms). Wider than Deepgram's 300 ms
// default so mid-sentence pauses stop splitting an idea into many finals; the
// first-run VAD tuner still applies its +50% grace on top for the first 5 min.
export const MIC_ENDPOINTING_BASE_MS = 900;


export const DEFAULT_AUTOBUILD_SETTLE_MS = 8_000;


// Guided-demo hold TTL: a wall that crashed/closed mid-"describe your idea"
// must never wedge auto-build — the hold self-expires after this long.
export const GUIDED_HOLD_TTL_MS = 10 * 60_000;


// Endpointing grace after the record toggle releases: ASR finals trail the
// speaker by 1-2s, so words spoken during the window arrive AFTER the clear.
// Finals inside this budget still route/commit to the released target.
export const STEER_GRACE_MS = 2_500;


// SMART BRANCH NAMING (live-room request): the spoken change names its own
// branch — "make a dancing cat under each tree" → "dancing-cat-under-each" —
// instead of a generic spoken-changes. First few meaningful words, kebab-cased,
// bounded; the substrate slugifies/prefixes room/ and dedupes on collision.
export const SPEECH_SLUG_STOPWORDS = new Set(["the", "a", "an", "to", "of", "and", "or", "please", "can", "you", "i", "we", "want", "make", "add", "like", "just", "so", "that", "it", "for", "on", "in"]);

export function slugFromSpeech(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/gu, " ")
    .split(/\s+/u)
    .filter((word) => word.length > 1 && !SPEECH_SLUG_STOPWORDS.has(word));
  const picked = words.slice(0, 4).join("-");
  return picked.length > 0 ? picked.slice(0, 48) : "spoken-changes";
}


// VIBERSYN_AUTOBUILD_SETTLE_MS — quiet period (ms) required before an armed
// auto-build fires. 0 restores the legacy immediate fire (fast tests).
export function readAutoBuildSettleMs(env: Record<string, string | undefined>): number {
  const raw = env.VIBERSYN_AUTOBUILD_SETTLE_MS?.trim();
  if (raw === undefined || raw === "") {
    return DEFAULT_AUTOBUILD_SETTLE_MS;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("VIBERSYN_AUTOBUILD_SETTLE_MS must be a non-negative number.");
  }
  return value;
}


// Recover the detection candidate id from a PendingSuggestion id minted by
// pendingSuggestionFromCandidate (`sug-<candidateId>`).
export function candidateIdFromSuggestionId(suggestionId: string): string | null {
  return suggestionId.startsWith("sug-") ? suggestionId.slice("sug-".length) : null;
}


// --- Duplicate-spawn guard ---------------------------------------------------
//
// Known bug this closes: one utterance could spawn upid-1 AND upid-2 — e.g. the
// auto-build fire and a click/spoken accept racing on the same surfaced idea, or
// the same pitch re-accepted seconds later. Every accept route funnels through
// the ONE acceptance seam composition builds, so the guard wraps it: a spawn
// whose normalized pitch matches an accept from the last DUPLICATE_ACCEPT_WINDOW_MS,
// or one whose spawn is still in flight, is refused at the seam (the spawner
// surfaces it as accepted:false / reason "seam" — no second process, no ack).

export const DUPLICATE_ACCEPT_WINDOW_MS = 120_000;


// Normalize a pitch for duplicate matching: lowercase, punctuation → spaces,
// collapsed whitespace — so "Build a status board!" and "build a status board"
// count as the same accepted idea.
export function normalizeAcceptPitch(pitch: string): string {
  return pitch
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}


export function createDuplicateSpawnGuard(seam: AcceptanceSpawnSeam, options: DuplicateSpawnGuardOptions = {}): AcceptanceSpawnSeam {
  const clock = options.clock ?? (() => Date.now());
  const windowMs = options.windowMs ?? DUPLICATE_ACCEPT_WINDOW_MS;
  const inFlight = new Set<string>();
  const recentAccepts = new Map<string, number>();
  return {
    async dispatch(action: DispatchedAction) {
      if (action.type !== "spawn") {
        return seam.dispatch(action);
      }
      const payload = action.payload as { pitch?: unknown } | null | undefined;
      const key = typeof payload?.pitch === "string" ? normalizeAcceptPitch(payload.pitch) : "";
      if (key.length === 0) {
        // No comparable pitch (should not happen on the accept path) — pass
        // through rather than wedging every pitchless spawn behind one guard key.
        return seam.dispatch(action);
      }
      const now = clock();
      for (const [pitch, acceptedAtMs] of recentAccepts) {
        if (now - acceptedAtMs >= windowMs) {
          recentAccepts.delete(pitch);
        }
      }
      const reason: "in-flight" | "recently-accepted" | null = inFlight.has(key)
        ? "in-flight"
        : (() => {
            const acceptedAtMs = recentAccepts.get(key);
            return acceptedAtMs !== undefined && now - acceptedAtMs < windowMs ? ("recently-accepted" as const) : null;
          })();
      if (reason !== null) {
        options.onSuppressed?.({ pitch: key, reason, correlationId: action.correlationId });
        return {
          accepted: false as const,
          correlationId: action.correlationId,
          error:
            reason === "in-flight"
              ? "Duplicate accept suppressed: an identical idea is already spawning."
              : "Duplicate accept suppressed: the same idea was accepted moments ago.",
        };
      }
      inFlight.add(key);
      try {
        const result = await seam.dispatch(action);
        if (result.accepted) {
          recentAccepts.set(key, clock());
        }
        return result;
      } finally {
        inFlight.delete(key);
      }
    },
  };
}
