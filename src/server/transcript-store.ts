// TRANSCRIPT PERSISTENCE — the live writer over the permanent archive.
//
// The room's flagship move (speak a graft → green commit → exit 87 → rebuild →
// relaunch) used to erase the conversation: the transcript window, and with it
// the ceiling's memory, lived only in RAM. This store writes each FINAL line to
// disk and hands the recent ones back at boot.
//
// TWO CONCERNS, DELIBERATELY SEPARATE:
//   - The ARCHIVE is unbounded and permanent. Nothing is ever evicted. It is
//     the operator's record of what was said in this room, and the only thing
//     that can shrink it is the operator with `rm`.
//   - The RESTORE into the live room stays recency-bounded and small. Replaying
//     everything into the 40-line transcript window, the research loop and the
//     ceiling's constellations would flood surfaces that exist to show a LIVE
//     conversation — a week-old sentence must never arrive wearing a NOW marker.
//
// Writes are APPEND-ONLY (transcript-archive.ts owns the JSONL day layout), so
// a save costs the new bytes and nothing else — the old whole-file rewrite was
// O(n) per save and made an unbounded archive impossible. It also removes a
// live data-loss bug: the previous restore() ASSIGNED #lines, so a declined
// restore (file older than the window) left the array empty and the next word
// spoken flushed a one-line file over an entire evening. Restore is read-only
// now; it cannot truncate anything.
//
// Scope: FINAL transcript lines only (interims are ephemeral by definition).
// Restored lines carry their original atMs, so recency-driven surfaces (the
// ceiling's chronology, "NOW" markers) stay honest.
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  TRANSCRIPT_LEGACY_FILENAME,
  localDayKey,
  mergeTranscriptLines,
  parseLegacyBody,
  previousDayKey,
  readDay,
  segmentPath,
  serializeSegmentLines,
  type ArchiveFs,
  type StoredTranscriptLine,
} from "./transcript-archive";

export type { StoredTranscriptLine } from "./transcript-archive";

// How far back a restore may reach. The old 45-minute window was demonstrably
// too tight for this room: the operator's own archive contains a 155.9-minute
// gap starting 18:11 local — dinner — after which the conversation resumed. Six
// hours clears that with margin and still refuses an overnight (last word
// ~21:00, next morning's boot ~09:00 = 12h), so a room restarted after dinner
// resumes the same evening while a room opened the next day starts clean.
export const TRANSCRIPT_RESTORE_MAX_AGE_MS = 6 * 60 * 60_000;

// How MANY lines a restore may reach for. The panel shows 40 and the research
// loop keeps 40 turns, but the rig's two mics make most utterances arrive twice
// and the loop collapses the duplicates — ~60 archived lines is what it takes
// to refill a 40-turn window. Restoring the old 400 ran 340 pointless
// dedupe/tree/observeClouds passes at boot to arrive at the same 40 turns.
export const TRANSCRIPT_RESTORE_MAX_LINES = 60;

const SAVE_DEBOUNCE_MS = 750;

// Safety valve for a wedged disk: without it, a flush that throws forever would
// grow #pending without bound — the one way the memory the cap used to bound
// could sneak back in.
const MAX_PENDING_LINES = 5_000;

export interface TranscriptStoreNote {
  // Stable identifier for the KIND of trouble, so a dead disk says it once
  // instead of every 750ms. House rule: a failure must say something, once.
  kind: string;
  level: "info" | "warn";
  message: string;
}

export interface TranscriptStoreOptions {
  // Directory the day segments live in (YYYY-MM-DD.jsonl).
  dir: string;
  clock?: () => number;
  // The pre-archive rolling file, folded in once at first restore. Undefined →
  // the historical location (a `session-transcript.json` sibling of the archive
  // directory, i.e. builds/session-transcript.json). Null → no migration.
  legacyPath?: string | null;
  onNote?: (note: TranscriptStoreNote) => void;
  // Test seams — default to real fs.
  read?: (path: string) => string;
  write?: (path: string, body: string) => void;
  appendTo?: (path: string, body: string) => void;
  rename?: (from: string, to: string) => void;
  list?: (dir: string) => string[];
}

export class TranscriptStore {
  readonly #dir: string;
  readonly #clock: () => number;
  readonly #legacyPath: string | null;
  readonly #onNote: (note: TranscriptStoreNote) => void;
  readonly #read: (path: string) => string;
  readonly #write: (path: string, body: string) => void;
  readonly #appendTo: (path: string, body: string) => void;
  readonly #rename: (from: string, to: string) => void;
  readonly #list: (dir: string) => string[];
  // ONLY the lines not yet on disk. Steady state is 0-2 (whatever lands inside
  // one debounce): once writes are append-only there is no reason to hold
  // history in RAM, so memory is O(1) instead of O(session).
  #pending: StoredTranscriptLine[] = [];
  #timer: ReturnType<typeof setTimeout> | null = null;
  #saidWarnings = new Set<string>();
  #healedSegments = new Set<string>();
  #failedFlushes = 0;
  #migrated = false;

  constructor(options: TranscriptStoreOptions) {
    this.#dir = options.dir;
    this.#clock = options.clock ?? Date.now;
    this.#legacyPath =
      options.legacyPath === undefined ? join(dirname(options.dir), TRANSCRIPT_LEGACY_FILENAME) : options.legacyPath;
    this.#onNote = options.onNote ?? (() => undefined);
    this.#read = options.read ?? ((path) => readFileSync(path, "utf8"));
    this.#write =
      options.write ??
      ((path, body) => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, body);
      });
    this.#appendTo =
      options.appendTo ??
      ((path, body) => {
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, body);
      });
    this.#rename = options.rename ?? renameSync;
    this.#list = options.list ?? ((dir) => readdirSync(dir));
  }

  get dir(): string {
    return this.#dir;
  }

  // Resume the conversation: the recent tail of the archive, never the whole
  // thing. READ-ONLY — nothing here can shorten a segment.
  restore(): StoredTranscriptLine[] {
    this.migrateLegacy();
    const now = this.#clock();
    const today = localDayKey(now);
    const todaySegment = readDay(this.#dir, today, this.#fs());
    let candidates = todaySegment.lines;
    let skipped = todaySegment.skipped;
    // A boot just after local midnight has an almost-empty "today": reach back
    // one segment so the conversation in progress is not cut at the date line.
    if (candidates.length < TRANSCRIPT_RESTORE_MAX_LINES) {
      const yesterday = readDay(this.#dir, previousDayKey(today), this.#fs());
      candidates = [...yesterday.lines, ...candidates];
      skipped += yesterday.skipped;
    }
    if (skipped > 0) {
      this.#note({
        kind: "transcript.archive.unreadable-lines",
        level: "warn",
        message: `[transcript] ${skipped} unreadable line(s) in the archive at ${this.#dir} (a truncated write, most likely) — the rest of the archive is intact.`,
      });
    }
    const fresh = candidates.filter((line) => now - line.atMs <= TRANSCRIPT_RESTORE_MAX_AGE_MS);
    const restored = fresh.slice(-TRANSCRIPT_RESTORE_MAX_LINES);
    if (restored.length === 0 && candidates.length > 0) {
      // Not an error, but the operator must not mistake an intentionally blank
      // window for a lost archive — say where the old conversation went.
      const hours = Math.round(TRANSCRIPT_RESTORE_MAX_AGE_MS / 3_600_000);
      this.#note({
        kind: "transcript.archive.stale",
        level: "info",
        message: `[transcript] the archive at ${this.#dir} holds ${candidates.length} recent line(s), but nothing within ${hours}h — the room starts a fresh conversation. Read the old one with \`bun scripts/transcript.ts yesterday\`.`,
      });
    }
    return restored;
  }

  // Fold one FINAL line in and schedule the debounced append.
  append(line: StoredTranscriptLine): void {
    this.#pending.push(line);
    if (this.#pending.length > MAX_PENDING_LINES) {
      const dropped = this.#pending.length - MAX_PENDING_LINES;
      this.#pending = this.#pending.slice(dropped);
      this.#note({
        kind: "transcript.archive.backlog",
        level: "warn",
        message: `[transcript] the archive at ${this.#dir} has not accepted a write in ${this.#failedFlushes} attempt(s); dropping the ${dropped} oldest buffered line(s) so the room does not run out of memory — check the disk.`,
      });
    }
    if (this.#timer === null) {
      this.#timer = setTimeout(() => {
        this.#timer = null;
        this.flush();
      }, SAVE_DEBOUNCE_MS);
      // A pending save must never hold the process open on shutdown.
      (this.#timer as { unref?: () => void }).unref?.();
    }
  }

  // Append ONLY what is new, bucketed by the day each line belongs to. History
  // is never re-serialized, so a save is ~one line of bytes no matter how long
  // the archive has grown — and a run crossing local midnight rolls onto the
  // next segment with no restart.
  flush(): void {
    if (this.#pending.length === 0) {
      return;
    }
    const pending = this.#pending;
    this.#pending = [];
    const byDay = new Map<string, StoredTranscriptLine[]>();
    for (const line of pending) {
      const day = localDayKey(line.atMs);
      const bucket = byDay.get(day);
      if (bucket === undefined) {
        byDay.set(day, [line]);
      } else {
        bucket.push(line);
      }
    }
    const unwritten: StoredTranscriptLine[] = [];
    let failure: unknown = null;
    for (const [day, lines] of byDay) {
      try {
        this.#appendTo(segmentPath(this.#dir, day), `${this.#separatorFor(day)}${serializeSegmentLines(lines)}`);
        // The heal is only PROVEN once the write it rode on landed. Marking it
        // inside #separatorFor was enough to lose a second line: a first flush
        // that failed (full disk, permissions) still recorded the segment as
        // healed, so the retry emitted no leading newline and glued the next
        // utterance onto the stump — the exact "one corrupt line costs exactly
        // one line" promise, broken by the retry path.
        this.#healedSegments.add(day);
      } catch (error) {
        failure = error;
        unwritten.push(...lines);
      }
    }
    if (unwritten.length === 0) {
      this.#failedFlushes = 0;
      return;
    }
    // Keep the unwritten lines queued (the next final retries) but say so — the
    // old code swallowed disk trouble forever and the room looked healthy.
    this.#failedFlushes += 1;
    this.#pending = [...unwritten, ...this.#pending];
    this.#note({
      kind: "transcript.archive.write-failed",
      level: "warn",
      message: `[transcript] cannot write the archive at ${this.#dir} (${failure instanceof Error ? failure.message : String(failure)}) — the room keeps running and retries, but nothing is being saved.`,
    });
  }

  dispose(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.flush();
  }

  // ONE-SHOT MIGRATION of the pre-archive rolling file. Idempotent twice over:
  // the source is RENAMED (never deleted) once it lands, so it runs once; and
  // the merge de-dupes, so a crash between write and rename cannot double a
  // line. Runs before the first restore so a reload during the upgrade still
  // sees its own conversation.
  migrateLegacy(): void {
    if (this.#migrated || this.#legacyPath === null) {
      return;
    }
    this.#migrated = true;
    const legacyPath = this.#legacyPath;
    let body: string;
    try {
      body = this.#read(legacyPath);
    } catch {
      return; // No legacy file — the common case after the first boot.
    }
    let legacyLines: StoredTranscriptLine[];
    try {
      legacyLines = parseLegacyBody(body);
    } catch (error) {
      // Do NOT rename an unreadable file out of the way: it is the only copy of
      // whatever it holds, and a human may still rescue it.
      this.#note({
        kind: "transcript.archive.legacy-unreadable",
        level: "warn",
        message: `[transcript] ${legacyPath} could not be parsed (${error instanceof Error ? error.message : String(error)}) — it was left exactly where it is; nothing was migrated.`,
      });
      return;
    }
    const days = this.importLines(legacyLines);
    if (days === null) {
      return;
    }
    try {
      this.#rename(legacyPath, `${legacyPath}.migrated`);
    } catch (error) {
      this.#note({
        kind: "transcript.archive.legacy-rename-failed",
        level: "warn",
        message: `[transcript] migrated ${legacyLines.length} line(s) from ${legacyPath}, but could not rename it aside (${error instanceof Error ? error.message : String(error)}) — the next boot will migrate it again (the merge de-dupes, so nothing doubles).`,
      });
      return;
    }
    this.#note({
      kind: "transcript.archive.migrated",
      level: "info",
      message: `[transcript] migrated ${legacyLines.length} line(s) from ${legacyPath} into ${days.length} day segment(s) (${days.join(", ") || "none"}); the original is now ${legacyPath}.migrated`,
    });
  }

  // Fold a batch of lines into the archive, merging with whatever each day's
  // segment already holds. Used by the legacy migration and by the CLI's
  // --import rescue path. Returns the day keys touched, or null if a write
  // failed (the caller must not then discard its source).
  importLines(lines: readonly StoredTranscriptLine[]): string[] | null {
    const byDay = new Map<string, StoredTranscriptLine[]>();
    for (const line of lines) {
      const day = localDayKey(line.atMs);
      const bucket = byDay.get(day);
      if (bucket === undefined) {
        byDay.set(day, [line]);
      } else {
        bucket.push(line);
      }
    }
    const touched: string[] = [];
    for (const [day, dayLines] of [...byDay.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
      const existing = readDay(this.#dir, day, this.#fs());
      const merged = mergeTranscriptLines(existing.lines, dayLines);
      const path = segmentPath(this.#dir, day);
      try {
        // Merging rewrites a whole segment, so this ONE path stays atomic
        // (tmp+rename) — a crash mid-merge must not shred a day of speech.
        this.#write(`${path}.tmp`, serializeSegmentLines(merged));
        this.#rename(`${path}.tmp`, path);
      } catch (error) {
        this.#note({
          kind: "transcript.archive.import-failed",
          level: "warn",
          message: `[transcript] could not fold ${dayLines.length} line(s) into ${path} (${error instanceof Error ? error.message : String(error)}) — nothing was moved or deleted.`,
        });
        return null;
      }
      touched.push(day);
    }
    return touched;
  }

  // A crash mid-append can leave a segment whose last line is a stump with no
  // newline. Appending straight onto it would GLUE the next utterance to the
  // stump and lose that one too — one corrupt line must only ever cost one
  // line. So the first time this process touches a segment, it checks the tail
  // and heals the boundary with a leading newline. Once per segment per boot,
  // not per write, so the append path stays O(new bytes).
  #separatorFor(day: string): string {
    if (this.#healedSegments.has(day)) {
      return "";
    }
    // NOT marked healed here — flush() records that only after the write it
    // rode on actually landed. See the call site.
    let body: string;
    try {
      body = this.#read(segmentPath(this.#dir, day));
    } catch {
      return ""; // No segment yet — the append creates it.
    }
    return body.length === 0 || body.endsWith("\n") ? "" : "\n";
  }

  #fs(): ArchiveFs {
    return { read: this.#read, list: this.#list };
  }

  #note(note: TranscriptStoreNote): void {
    if (note.level === "warn") {
      if (this.#saidWarnings.has(note.kind)) {
        return;
      }
      this.#saidWarnings.add(note.kind);
    }
    this.#onNote(note);
  }
}
