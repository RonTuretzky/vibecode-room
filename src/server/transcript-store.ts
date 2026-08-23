// TRANSCRIPT PERSISTENCE — the conversation survives the self reload.
//
// The room's flagship move (speak a graft → green commit → exit 87 → rebuild →
// relaunch) used to erase the conversation: the transcript window, and with it
// the ceiling's memory, lived only in RAM. Every successful self-change made
// the room forget the evening. This store writes each FINAL line to disk
// (debounced, atomic tmp+rename) and hands them back at boot when they are
// fresh — so a reboot resumes the same conversation instead of a blank room.
//
// Scope: FINAL transcript lines only (interims are ephemeral by definition).
// Restored lines carry their original atMs, so recency-driven surfaces (the
// ceiling's chronology, "NOW" markers) stay honest — nothing restored ever
// pretends to be new speech.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface StoredTranscriptLine {
  time: string; // HH:MM:SS — the transcript panel's display stamp
  speaker: string;
  text: string;
  kind: string;
  atMs: number; // wall-clock ms at fold time — restores chronology honestly
}

// A file older than this is a PREVIOUS session, not a reload: restoring an
// hours-old conversation into a fresh room would be a lie. Reloads take ~15s.
export const TRANSCRIPT_RESTORE_WINDOW_MS = 45 * 60_000;

// Bounded like the live window's spirit, but roomier: the ceiling's memory
// outlives the 40-line panel, so the store keeps enough to reseed it.
export const TRANSCRIPT_STORE_CAP = 400;

const SAVE_DEBOUNCE_MS = 750;

export interface TranscriptStoreOptions {
  path: string;
  clock?: () => number;
  // Test seams — default to real fs.
  read?: (path: string) => string;
  write?: (path: string, body: string) => void;
  rename?: (from: string, to: string) => void;
}

export class TranscriptStore {
  readonly #path: string;
  readonly #clock: () => number;
  readonly #read: (path: string) => string;
  readonly #write: (path: string, body: string) => void;
  readonly #rename: (from: string, to: string) => void;
  #lines: StoredTranscriptLine[] = [];
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: TranscriptStoreOptions) {
    this.#path = options.path;
    this.#clock = options.clock ?? Date.now;
    this.#read = options.read ?? ((path) => readFileSync(path, "utf8"));
    this.#write =
      options.write ??
      ((path, body) => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, body);
      });
    this.#rename = options.rename ?? renameSync;
  }

  // Restore the previous process's conversation — ONLY when it reads as a
  // reload (freshest line within the window). Anything else returns [] and
  // the room starts clean; a corrupt file is treated as absent, never a throw.
  restore(): StoredTranscriptLine[] {
    try {
      const parsed = JSON.parse(this.#read(this.#path)) as { lines?: StoredTranscriptLine[] };
      const lines = (parsed.lines ?? []).filter(
        (line) =>
          typeof line.text === "string" &&
          typeof line.speaker === "string" &&
          typeof line.time === "string" &&
          typeof line.atMs === "number",
      );
      const freshest = lines.length > 0 ? lines[lines.length - 1]!.atMs : 0;
      if (freshest <= 0 || this.#clock() - freshest > TRANSCRIPT_RESTORE_WINDOW_MS) {
        return [];
      }
      this.#lines = lines.slice(-TRANSCRIPT_STORE_CAP);
      return [...this.#lines];
    } catch {
      return [];
    }
  }

  // Fold one FINAL line in and schedule the debounced write.
  append(line: StoredTranscriptLine): void {
    this.#lines = [...this.#lines, line].slice(-TRANSCRIPT_STORE_CAP);
    if (this.#timer === null) {
      this.#timer = setTimeout(() => {
        this.#timer = null;
        this.flush();
      }, SAVE_DEBOUNCE_MS);
      // A pending save must never hold the process open on shutdown.
      (this.#timer as { unref?: () => void }).unref?.();
    }
  }

  // Atomic write: tmp + rename, so a crash mid-save can never leave a torn
  // file for the next boot to trip on. Failures are swallowed — persistence
  // is a convenience; losing a save must never cost the room its ingest.
  flush(): void {
    try {
      const tmp = `${this.#path}.tmp`;
      this.#write(tmp, JSON.stringify({ lines: this.#lines }));
      this.#rename(tmp, this.#path);
    } catch {
      // Disk trouble — the live room keeps running; the next final retries.
    }
  }

  dispose(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.flush();
  }
}
