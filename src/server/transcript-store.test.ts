import { describe, expect, test } from "bun:test";
import {
  TRANSCRIPT_RESTORE_MAX_AGE_MS,
  TRANSCRIPT_RESTORE_MAX_LINES,
  TranscriptStore,
  type StoredTranscriptLine,
  type TranscriptStoreNote,
} from "./transcript-store";
import { localDayKey, parseSegment, segmentPath } from "./transcript-archive";

// An in-memory fs: the store's whole seam surface, no disk. `appends` records
// EVERY body handed to the append seam, which is what makes the O(n^2) guard
// below possible — it can see exactly how many bytes a save costs.
function fakeFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const appends: { path: string; body: string }[] = [];
  const writes: { path: string; body: string }[] = [];
  return {
    files,
    appends,
    writes,
    read: (path: string) => {
      const body = files.get(path);
      if (body === undefined) {
        throw new Error("ENOENT");
      }
      return body;
    },
    write: (path: string, body: string) => {
      writes.push({ path, body });
      files.set(path, body);
    },
    appendTo: (path: string, body: string) => {
      appends.push({ path, body });
      files.set(path, `${files.get(path) ?? ""}${body}`);
    },
    rename: (from: string, to: string) => {
      const body = files.get(from);
      if (body === undefined) {
        throw new Error("ENOENT");
      }
      files.set(to, body);
      files.delete(from);
    },
    list: (dir: string) => {
      const prefix = `${dir}/`;
      return [...files.keys()].filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length));
    },
  };
}

// Seams only — `files`/`appends`/`writes` are the test's own handles.
function seams(fs: ReturnType<typeof fakeFs>) {
  return { read: fs.read, write: fs.write, appendTo: fs.appendTo, rename: fs.rename, list: fs.list };
}

const line = (text: string, atMs: number): StoredTranscriptLine => ({
  time: new Date(atMs).toISOString().slice(11, 19),
  speaker: "speaker_1",
  text,
  kind: "room",
  atMs,
});

// A fixed local-noon instant, so every day-key assertion is TZ-independent.
const NOON = new Date(2026, 7, 24, 12, 0, 0, 0).getTime();
const DAY_MS = 24 * 60 * 60_000;

describe("the archive is permanent: nothing is ever evicted", () => {
  test("far more than the old 400-line cap is appended, and all of it reads back", () => {
    const fs = fakeFs();
    const store = new TranscriptStore({ dir: "arc", clock: () => NOON, legacyPath: null, ...seams(fs) });
    const total = 2_500;
    for (let index = 0; index < total; index += 1) {
      // Spread across one local day so they all land in one segment.
      store.append(line(`line ${index}`, NOON - 6 * 3_600_000 + index * 1_000));
      store.flush();
    }
    const segment = parseSegment(fs.files.get(segmentPath("arc", localDayKey(NOON))) ?? "");
    expect(segment.skipped).toBe(0);
    expect(segment.lines.length).toBe(total);
    // The head — what the old rolling window destroyed first — is still there.
    expect(segment.lines[0]!.text).toBe("line 0");
    expect(segment.lines[total - 1]!.text).toBe(`line ${total - 1}`);
  });

  test("a save costs only the NEW line, never the whole archive (the O(n^2) guard)", () => {
    const fs = fakeFs();
    const store = new TranscriptStore({ dir: "arc", clock: () => NOON, legacyPath: null, ...seams(fs) });
    for (let index = 0; index < 500; index += 1) {
      store.append(line(`line ${index}`, NOON + index * 1_000));
      store.flush();
    }
    expect(fs.appends.length).toBe(500);
    // The 500th save writes the same handful of bytes as the 1st: the old store
    // re-serialized every retained line on every debounce, which is why keeping
    // more than 400 was impossible.
    const first = fs.appends[0]!.body.length;
    const last = fs.appends[499]!.body.length;
    expect(last).toBeLessThan(first + 20);
    // Whole-file rewrites are the thing being ruled out: the append path must
    // never touch the atomic write/rename seam at all.
    expect(fs.writes.length).toBe(0);
    for (const append of fs.appends) {
      expect(append.body.split("\n").filter((entry) => entry.length > 0).length).toBe(1);
    }
  });

  test("lines spoken across local midnight split into their own day segments", () => {
    const fs = fakeFs();
    const store = new TranscriptStore({ dir: "arc", clock: () => NOON, legacyPath: null, ...seams(fs) });
    const beforeMidnight = new Date(2026, 7, 24, 23, 59, 30).getTime();
    const afterMidnight = new Date(2026, 7, 25, 0, 0, 30).getTime();
    store.append(line("last word of the day", beforeMidnight));
    store.append(line("first word of the next", afterMidnight));
    store.dispose();
    expect(parseSegment(fs.files.get(segmentPath("arc", "2026-08-24")) ?? "").lines.map((entry) => entry.text)).toEqual([
      "last word of the day",
    ]);
    expect(parseSegment(fs.files.get(segmentPath("arc", "2026-08-25")) ?? "").lines.map((entry) => entry.text)).toEqual([
      "first word of the next",
    ]);
  });
});

describe("a damaged segment costs one line, not the file", () => {
  test("a truncated trailing line is skipped, reported, and the rest survives", () => {
    const fs = fakeFs();
    const day = localDayKey(NOON);
    const good = [line("we should build a birdhouse app", NOON - 3_000), line("with a webcam feed", NOON - 2_000)];
    // A kill mid-append: the last record is half-written, with no newline.
    fs.files.set(segmentPath("arc", day), `${good.map((entry) => JSON.stringify(entry)).join("\n")}\n{"time":"12:00:0`);
    const notes: TranscriptStoreNote[] = [];
    const store = new TranscriptStore({
      dir: "arc",
      clock: () => NOON,
      legacyPath: null,
      onNote: (note) => notes.push(note),
      ...seams(fs),
    });
    expect(store.restore().map((entry) => entry.text)).toEqual([
      "we should build a birdhouse app",
      "with a webcam feed",
    ]);
    // House rule: never a silent no-op.
    expect(notes.some((note) => note.kind === "transcript.archive.unreadable-lines" && note.level === "warn")).toBe(true);

    // And the next append recovers with no repair pass: a fresh well-formed
    // line simply lands after the stump.
    store.append(line("and a nesting sensor", NOON - 1_000));
    store.dispose();
    const reread = parseSegment(fs.files.get(segmentPath("arc", day)) ?? "");
    expect(reread.lines.map((entry) => entry.text)).toEqual([
      "we should build a birdhouse app",
      "with a webcam feed",
      "and a nesting sensor",
    ]);
    expect(reread.skipped).toBe(1);
  });
});

describe("restore is a recency-bounded READ, not a replay of the archive", () => {
  test("a reload resumes the same conversation", () => {
    const fs = fakeFs();
    const first = new TranscriptStore({ dir: "arc", clock: () => NOON, legacyPath: null, ...seams(fs) });
    first.append(line("we should build a birdhouse app", NOON - 5_000));
    first.append(line("with a webcam feed", NOON - 2_000));
    first.dispose(); // flushes synchronously

    const second = new TranscriptStore({ dir: "arc", clock: () => NOON + 15_000, legacyPath: null, ...seams(fs) });
    expect(second.restore().map((entry) => entry.text)).toEqual([
      "we should build a birdhouse app",
      "with a webcam feed",
    ]);
  });

  test("the whole archive is NOT restored — only the recent tail, with original atMs", () => {
    const fs = fakeFs();
    const store = new TranscriptStore({ dir: "arc", clock: () => NOON, legacyPath: null, ...seams(fs) });
    const total = 1_000;
    for (let index = 0; index < total; index += 1) {
      store.append(line(`line ${index}`, NOON - 3 * 3_600_000 + index * 1_000));
    }
    store.dispose();

    const restored = new TranscriptStore({ dir: "arc", clock: () => NOON, legacyPath: null, ...seams(fs) }).restore();
    expect(restored.length).toBe(TRANSCRIPT_RESTORE_MAX_LINES);
    expect(restored[restored.length - 1]!.text).toBe(`line ${total - 1}`);
    // Restored lines keep their ORIGINAL atMs — the ceiling's chronology and
    // "NOW" markers must not treat old speech as if it were just spoken.
    expect(restored[restored.length - 1]!.atMs).toBe(NOON - 3 * 3_600_000 + (total - 1) * 1_000);
    expect(restored[0]!.atMs).toBeLessThan(restored[restored.length - 1]!.atMs);
    // ...and the archive still holds all 1,000. Restoring is a read.
    expect(parseSegment(fs.files.get(segmentPath("arc", localDayKey(NOON))) ?? "").lines.length).toBe(total);
  });

  test("a restart after DINNER resumes; the next MORNING starts fresh", () => {
    const fs = fakeFs();
    const spoke = NOON + 6 * 3_600_000; // 18:00 local
    const evening = new TranscriptStore({ dir: "arc", clock: () => spoke, legacyPath: null, ...seams(fs) });
    evening.append(line("dinner is ready", spoke));
    evening.dispose();

    // 2.6h later — the gap that the old 45-minute window refused. This is the
    // case the operator actually asked for.
    const afterDinner = new TranscriptStore({
      dir: "arc",
      clock: () => spoke + 2.6 * 3_600_000,
      legacyPath: null,
      ...seams(fs),
    });
    expect(afterDinner.restore().map((entry) => entry.text)).toEqual(["dinner is ready"]);

    // The next morning: nothing restores, and the room SAYS where the words went.
    const notes: TranscriptStoreNote[] = [];
    const morning = new TranscriptStore({
      dir: "arc",
      clock: () => spoke + TRANSCRIPT_RESTORE_MAX_AGE_MS + 60_000,
      legacyPath: null,
      onNote: (note) => notes.push(note),
      ...seams(fs),
    });
    expect(morning.restore()).toEqual([]);
    expect(notes.some((note) => note.kind === "transcript.archive.stale")).toBe(true);
    // ...and the archive is untouched. The OLD store assigned #lines on
    // restore, so a declined restore left it empty and the next word spoken
    // overwrote the whole evening with a one-line file.
    expect(parseSegment(fs.files.get(segmentPath("arc", localDayKey(spoke))) ?? "").lines.length).toBe(1);
  });

  test("a boot just after local midnight reaches back into yesterday's segment", () => {
    const fs = fakeFs();
    const lateLastNight = new Date(2026, 7, 24, 23, 50, 0).getTime();
    const evening = new TranscriptStore({ dir: "arc", clock: () => lateLastNight, legacyPath: null, ...seams(fs) });
    evening.append(line("still talking at the date line", lateLastNight));
    evening.dispose();

    const justAfterMidnight = new Date(2026, 7, 25, 0, 5, 0).getTime();
    const rebooted = new TranscriptStore({ dir: "arc", clock: () => justAfterMidnight, legacyPath: null, ...seams(fs) });
    expect(rebooted.restore().map((entry) => entry.text)).toEqual(["still talking at the date line"]);
  });

  test("an empty or missing archive restores nothing and never throws", () => {
    const fs = fakeFs();
    expect(new TranscriptStore({ dir: "absent", legacyPath: null, ...seams(fs) }).restore()).toEqual([]);
  });
});

describe("the store says something when it cannot write", () => {
  test("a wedged disk warns ONCE, keeps the room running, and retries", () => {
    const fs = fakeFs();
    const notes: TranscriptStoreNote[] = [];
    let wedged = true;
    const store = new TranscriptStore({
      dir: "arc",
      clock: () => NOON,
      legacyPath: null,
      onNote: (note) => notes.push(note),
      ...seams(fs),
      appendTo: (path, body) => {
        if (wedged) {
          throw new Error("EROFS: read-only file system");
        }
        fs.appendTo(path, body);
      },
    });
    store.append(line("nobody is saving this", NOON));
    store.flush();
    store.append(line("nor this", NOON + 1_000));
    store.flush();
    const warnings = notes.filter((note) => note.kind === "transcript.archive.write-failed");
    // Once, not every 750ms — the old code said nothing at all, forever.
    expect(warnings.length).toBe(1);
    expect(warnings[0]!.level).toBe("warn");
    expect(warnings[0]!.message).toContain("read-only file system");

    // The unwritten lines were kept, so recovery loses nothing.
    wedged = false;
    store.dispose();
    expect(parseSegment(fs.files.get(segmentPath("arc", localDayKey(NOON))) ?? "").lines.map((entry) => entry.text)).toEqual([
      "nobody is saving this",
      "nor this",
    ]);
  });
});

describe("the pre-archive rolling file is migrated, never orphaned", () => {
  const legacyLines = [line("we hit the cap tonight", NOON - 10_000), line("and lost the evening", NOON - 9_000)];
  const legacyBody = JSON.stringify({ lines: legacyLines });

  test("legacy lines land in their local-day segment and the original is renamed aside", () => {
    const fs = fakeFs({ "builds/session-transcript.json": legacyBody });
    const notes: TranscriptStoreNote[] = [];
    const store = new TranscriptStore({
      dir: "builds/transcripts",
      clock: () => NOON,
      onNote: (note) => notes.push(note),
      ...seams(fs),
    });
    store.restore();
    const segment = parseSegment(fs.files.get(segmentPath("builds/transcripts", localDayKey(NOON))) ?? "");
    expect(segment.lines.map((entry) => entry.text)).toEqual(["we hit the cap tonight", "and lost the evening"]);
    // RENAMED, not deleted: the operator's only copy is never destroyed.
    expect(fs.files.has("builds/session-transcript.json")).toBe(false);
    expect(fs.files.get("builds/session-transcript.json.migrated")).toBe(legacyBody);
    expect(notes.some((note) => note.kind === "transcript.archive.migrated")).toBe(true);
  });

  test("migrating twice (or importing an overlapping rescue copy) never doubles a line", () => {
    const fs = fakeFs({ "builds/session-transcript.json": legacyBody });
    new TranscriptStore({ dir: "builds/transcripts", clock: () => NOON, ...seams(fs) }).restore();
    // A rescue snapshot of the SAME conversation plus one line the live file
    // had already evicted — the union must be recovered, the overlap collapsed.
    const rescue = new TranscriptStore({ dir: "builds/transcripts", clock: () => NOON, legacyPath: null, ...seams(fs) });
    rescue.importLines([...legacyLines, line("the line the cap ate", NOON - 11_000)]);
    const segment = parseSegment(fs.files.get(segmentPath("builds/transcripts", localDayKey(NOON))) ?? "");
    expect(segment.lines.map((entry) => entry.text)).toEqual([
      "the line the cap ate",
      "we hit the cap tonight",
      "and lost the evening",
    ]);
  });

  test("an UNREADABLE legacy file is left exactly where it is, loudly", () => {
    const fs = fakeFs({ "builds/session-transcript.json": "{not json" });
    const notes: TranscriptStoreNote[] = [];
    const store = new TranscriptStore({
      dir: "builds/transcripts",
      clock: () => NOON,
      onNote: (note) => notes.push(note),
      ...seams(fs),
    });
    store.restore();
    expect(fs.files.get("builds/session-transcript.json")).toBe("{not json");
    expect(fs.files.has("builds/session-transcript.json.migrated")).toBe(false);
    expect(notes.some((note) => note.kind === "transcript.archive.legacy-unreadable" && note.level === "warn")).toBe(true);
  });

  test("a legacy evening older than the restore window is ARCHIVED but not replayed", () => {
    const stale = NOON - 3 * DAY_MS;
    const fs = fakeFs({
      "builds/session-transcript.json": JSON.stringify({ lines: [line("last week's meeting", stale)] }),
    });
    const store = new TranscriptStore({ dir: "builds/transcripts", clock: () => NOON, ...seams(fs) });
    // Saved forever...
    expect(store.restore()).toEqual([]);
    // ...but never spoken back onto the wall.
    expect(parseSegment(fs.files.get(segmentPath("builds/transcripts", localDayKey(stale))) ?? "").lines.map((entry) => entry.text)).toEqual([
      "last week's meeting",
    ]);
  });
});
