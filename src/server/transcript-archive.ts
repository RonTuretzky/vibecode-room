// THE CONVERSATION'S PERMANENT ARCHIVE — layout and reading.
//
// The old store kept a rolling window of 400 lines in one JSON file and
// silently evicted the head on every append. The operator asked for "today's
// transcript" and got the last 3.3 hours; an entire evening before that was
// already gone. Worse, the whole file was re-serialized on every 750ms save,
// so keeping MORE would have been quadratic.
//
// This module owns the layout that fixes both: one JSONL file per LOCAL day.
//   - JSONL, because appending costs only the new bytes. History is never
//     re-serialized, so the archive can grow without bound (~127 bytes/line,
//     ~615 lines/hour of active talk — a year of heavy evenings is ~115 MB).
//   - LOCAL day, not UTC. The operator's evening (17:52-21:07 EDT) straddles
//     UTC midnight: by UTC day those 400 lines split 381/19, so "today's
//     transcript" asked at 21:07 local would have answered with 19 lines.
//   - One file per day bounds any single segment, makes "get me today" a
//     single read, and makes retention obvious later (rm 2025-*.jsonl).
//
// Reading lives here (not in the writer) so the endpoint, the CLI script and
// the store's own restore path all share one parser, and so it can be unit
// tested with no writer and no disk.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface StoredTranscriptLine {
  time: string; // HH:MM:SS — the transcript panel's display stamp (UTC, historically)
  speaker: string;
  text: string;
  kind: string;
  atMs: number; // wall-clock ms at fold time — the AUTHORITATIVE timestamp
}

// Relative to the server's cwd. builds/ is wholly gitignored, so the operator's
// raw conversation can never be swept into a commit by the self-loop's git add
// (artifacts/ has tracked subtrees and would). Nothing enumerates builds/* as
// UPIDs — every lookup is join(buildsRoot, upid, ...) — so this is a safe sibling.
export const TRANSCRIPT_ARCHIVE_DEFAULT_DIR = "builds/transcripts";

// The pre-archive store's single rolling file, migrated once into the archive.
export const TRANSCRIPT_LEGACY_FILENAME = "session-transcript.json";

export interface ArchiveSegment {
  day: string;
  path: string;
  // A day with no file at all is a different answer from a day with an empty
  // file — the reader surfaces which so a caller can 404 instead of implying
  // the room sat silent.
  exists: boolean;
  lines: StoredTranscriptLine[];
  // Lines the parser could not read (a kill mid-write can leave a stump).
  // Reported, never swallowed — see parseSegment.
  skipped: number;
}

// Test seams; default to real fs.
export interface ArchiveFs {
  read?: (path: string) => string;
  list?: (dir: string) => string[];
}

export function isStoredTranscriptLine(value: unknown): value is StoredTranscriptLine {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const line = value as Partial<StoredTranscriptLine>;
  return (
    typeof line.time === "string" &&
    typeof line.speaker === "string" &&
    typeof line.text === "string" &&
    typeof line.kind === "string" &&
    typeof line.atMs === "number" &&
    Number.isFinite(line.atMs)
  );
}

// The day a line belongs to, in the HOST's local time. Derived per line from
// its own atMs, so a session running through local midnight simply starts
// writing tomorrow's segment — no restart, no special case.
//
// Caveat worth naming: day keys follow the host clock. Changing the machine's
// timezone mid-archive (or reading an archive on a differently-zoned machine)
// files a day under a neighbouring name. atMs stays authoritative, so nothing
// is actually wrong — acceptable for a single fixed installation.
export function localDayKey(atMs: number): string {
  const at = new Date(atMs);
  const month = `${at.getMonth() + 1}`.padStart(2, "0");
  const day = `${at.getDate()}`.padStart(2, "0");
  return `${at.getFullYear()}-${month}-${day}`;
}

// HH:MM:SS in LOCAL time, for the read-back surfaces. The stored `time` field
// is UTC (composition writes toISOString().slice(11,19)); it is preserved
// byte-identical for compatibility, but a human reading last night's
// transcript wants the clock they spoke against.
export function localTimeStamp(atMs: number): string {
  const at = new Date(atMs);
  const hours = `${at.getHours()}`.padStart(2, "0");
  const minutes = `${at.getMinutes()}`.padStart(2, "0");
  const seconds = `${at.getSeconds()}`.padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

export function previousDayKey(day: string): string {
  const parts = day.split("-");
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const date = Number(parts[2]);
  // Noon, not midnight: a DST transition moves local midnight by an hour, and
  // stepping back 24h from noon lands inside the previous day either way.
  const noon = new Date(year, month - 1, date, 12, 0, 0, 0);
  return localDayKey(noon.getTime() - 24 * 60 * 60_000);
}

// "today" | "yesterday" | "YYYY-MM-DD" -> a day key, or null when the spec is
// not a day at all (the caller answers 400 rather than an empty transcript,
// which would read as "we said nothing").
export function resolveDayKey(spec: string, nowMs: number): string | null {
  const trimmed = spec.trim().toLowerCase();
  if (trimmed === "today") {
    return localDayKey(nowMs);
  }
  if (trimmed === "yesterday") {
    return previousDayKey(localDayKey(nowMs));
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (match === null) {
    return null;
  }
  const at = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0, 0);
  // Round-tripping rejects calendar-shaped nonsense like 2026-02-31.
  return localDayKey(at.getTime()) === trimmed ? trimmed : null;
}

export function segmentPath(dir: string, day: string): string {
  return join(dir, `${day}.jsonl`);
}

// One JSON object per physical line. A `text` containing a newline stays on one
// line because JSON.stringify escapes it — the format cannot be broken by what
// somebody says in the room.
export function serializeSegmentLines(lines: readonly StoredTranscriptLine[]): string {
  if (lines.length === 0) {
    return "";
  }
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

// Every line is parsed in its own try/catch, so ONE bad line costs one line —
// not the file. A kill mid-append can leave a truncated stump at the end (a
// sub-200-byte O_APPEND write is a single syscall, so this is already unlikely);
// the next append just writes a fresh well-formed line after it, and no repair
// pass is needed. The count is returned, never swallowed.
export function parseSegment(body: string): { lines: StoredTranscriptLine[]; skipped: number } {
  const lines: StoredTranscriptLine[] = [];
  let skipped = 0;
  for (const raw of body.split("\n")) {
    if (raw.trim().length === 0) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isStoredTranscriptLine(parsed)) {
        lines.push(parsed);
      } else {
        skipped += 1;
      }
    } catch {
      skipped += 1;
    }
  }
  return { lines, skipped };
}

export function readDay(dir: string, day: string, fs: ArchiveFs = {}): ArchiveSegment {
  const read = fs.read ?? ((path: string) => readFileSync(path, "utf8"));
  const path = segmentPath(dir, day);
  let body: string;
  try {
    body = read(path);
  } catch {
    return { day, path, exists: false, lines: [], skipped: 0 };
  }
  const parsed = parseSegment(body);
  return { day, path, exists: true, lines: parsed.lines, skipped: parsed.skipped };
}

// Which days the archive holds, oldest first. A missing/unreadable directory is
// an empty archive, not a throw — the room boots before it has ever spoken.
export function listDays(dir: string, fs: ArchiveFs = {}): string[] {
  const list = fs.list ?? ((path: string) => readdirSync(path));
  let entries: string[];
  try {
    entries = list(dir);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry))
    .map((entry) => entry.slice(0, entry.length - ".jsonl".length))
    .sort();
}

export function readRange(dir: string, days: readonly string[], fs: ArchiveFs = {}): ArchiveSegment[] {
  return days.map((day) => readDay(dir, day, fs));
}

export function renderTranscriptText(lines: readonly StoredTranscriptLine[]): string {
  return lines.map((line) => `${localTimeStamp(line.atMs)}  ${line.speaker}: ${line.text}`).join("\n");
}

// De-dupe two overlapping snapshots of the same conversation (the legacy
// migration and the --import rescue path both merge into a live segment).
// atMs+speaker+text identifies an utterance; the result is chronological.
export function mergeTranscriptLines(
  existing: readonly StoredTranscriptLine[],
  incoming: readonly StoredTranscriptLine[],
): StoredTranscriptLine[] {
  const seen = new Set<string>();
  const merged: StoredTranscriptLine[] = [];
  for (const line of [...existing, ...incoming]) {
    const key = `${line.atMs}|${line.speaker}|${line.text}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(line);
  }
  return merged.sort((left, right) => left.atMs - right.atMs);
}

// The pre-archive file was `{ lines: [...] }`; a bare array is accepted too so
// a hand-made rescue copy imports without ceremony.
export function parseLegacyBody(body: string): StoredTranscriptLine[] {
  const parsed: unknown = JSON.parse(body);
  const raw = Array.isArray(parsed) ? parsed : ((parsed as { lines?: unknown })?.lines ?? []);
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(isStoredTranscriptLine);
}

// WHERE THE ARCHIVE LIVES — the one resolver both the boot entry and the
// runtime agree on. It NEVER invents a path: commit 6a1d228 made the store
// obey an explicit marker because self-mode TEST runtimes were writing the
// LIVE store and polluting the operator's record. That invariant survives
// default-on; the DEFAULT now lives at the boot entry (src/server/index.ts),
// the only real server process, so `bun run start`, run-room.sh and the
// supervisor all keep an archive while a directly-constructed runtime — how
// every unit test builds one — still has no directory at all.
export function resolveTranscriptArchiveDir(
  env: { VIBERSYN_TRANSCRIPT_ARCHIVE?: string | undefined; [key: string]: string | undefined },
  option?: string | null,
): string | null {
  // An explicit option wins outright, including an explicit null ("no archive").
  if (option !== undefined) {
    return option;
  }
  const marker = env.VIBERSYN_TRANSCRIPT_ARCHIVE;
  if (marker === undefined) {
    return null;
  }
  const trimmed = marker.trim();
  if (trimmed.length === 0 || trimmed === "0" || trimmed.toLowerCase() === "off") {
    return null;
  }
  return trimmed;
}
