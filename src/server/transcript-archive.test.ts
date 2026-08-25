import { describe, expect, test } from "bun:test";
import {
  isStoredTranscriptLine,
  listDays,
  localDayKey,
  localTimeStamp,
  mergeTranscriptLines,
  parseLegacyBody,
  parseSegment,
  previousDayKey,
  readDay,
  renderTranscriptText,
  resolveDayKey,
  resolveTranscriptArchiveDir,
  segmentPath,
  serializeSegmentLines,
  type StoredTranscriptLine,
} from "./transcript-archive";

const line = (text: string, atMs: number): StoredTranscriptLine => ({
  time: new Date(atMs).toISOString().slice(11, 19),
  speaker: "speaker_0",
  text,
  kind: "room",
  atMs,
});

describe("day keys follow the LOCAL clock", () => {
  test("an evening that straddles UTC midnight stays one local day", () => {
    // The operator's real case: 17:52-21:07 local (EDT) crosses UTC midnight.
    // By UTC day those lines split 381/19, so "today's transcript" asked at
    // 21:07 would have answered with 19 lines. By local day it is one file.
    const evening = [
      new Date(2026, 7, 24, 17, 52, 0).getTime(),
      new Date(2026, 7, 24, 20, 30, 0).getTime(),
      new Date(2026, 7, 24, 21, 7, 0).getTime(),
    ];
    expect(evening.map((atMs) => localDayKey(atMs))).toEqual(["2026-08-24", "2026-08-24", "2026-08-24"]);
  });

  test("local midnight is the boundary, to the second", () => {
    expect(localDayKey(new Date(2026, 7, 24, 23, 59, 59).getTime())).toBe("2026-08-24");
    expect(localDayKey(new Date(2026, 7, 25, 0, 0, 0).getTime())).toBe("2026-08-25");
  });

  test("previousDayKey steps one calendar day back, across months and years", () => {
    expect(previousDayKey("2026-08-25")).toBe("2026-08-24");
    expect(previousDayKey("2026-08-01")).toBe("2026-07-31");
    expect(previousDayKey("2026-01-01")).toBe("2025-12-31");
    // Leap day, from the far side.
    expect(previousDayKey("2028-03-01")).toBe("2028-02-29");
  });
});

describe("a day spec resolves, or says it is not a day", () => {
  const now = new Date(2026, 7, 25, 0, 30, 0).getTime();

  test("today / yesterday / an explicit date", () => {
    expect(resolveDayKey("today", now)).toBe("2026-08-25");
    expect(resolveDayKey("YESTERDAY", now)).toBe("2026-08-24");
    expect(resolveDayKey(" 2026-08-24 ", now)).toBe("2026-08-24");
  });

  test("nonsense is null, so the caller can 400 instead of implying silence", () => {
    expect(resolveDayKey("tomorrow", now)).toBeNull();
    expect(resolveDayKey("2026-02-31", now)).toBeNull(); // calendar-shaped, not a date
    expect(resolveDayKey("2026-8-4", now)).toBeNull();
    expect(resolveDayKey("../../etc/passwd", now)).toBeNull();
    expect(resolveDayKey("", now)).toBeNull();
  });
});

describe("the JSONL segment format", () => {
  test("round trips, one physical line per utterance", () => {
    const lines = [line("we should build a birdhouse app", 1_000), line("with a webcam feed", 2_000)];
    const body = serializeSegmentLines(lines);
    expect(body.split("\n").filter((entry) => entry.length > 0).length).toBe(2);
    expect(parseSegment(body)).toEqual({ lines, skipped: 0 });
  });

  test("a newline inside speech cannot break the format", () => {
    const spoken = line("first thought\nsecond thought", 3_000);
    const body = serializeSegmentLines([spoken]);
    expect(body.split("\n").filter((entry) => entry.length > 0).length).toBe(1);
    expect(parseSegment(body).lines).toEqual([spoken]);
  });

  test("one bad line costs one line: the rest of the file survives, and is counted", () => {
    const good = [line("a", 1_000), line("b", 2_000)];
    const body = `${JSON.stringify(good[0])}\n{"time":"12:00:0\n${JSON.stringify(good[1])}\n{"text":"no timestamp"}\n`;
    const parsed = parseSegment(body);
    expect(parsed.lines).toEqual(good);
    expect(parsed.skipped).toBe(2);
  });

  test("blank lines are not corruption", () => {
    expect(parseSegment(`\n${JSON.stringify(line("a", 1))}\n\n`)).toEqual({ lines: [line("a", 1)], skipped: 0 });
  });

  test("a line missing any required field is not a transcript line", () => {
    expect(isStoredTranscriptLine(line("a", 1))).toBe(true);
    expect(isStoredTranscriptLine({ ...line("a", 1), atMs: "1" })).toBe(false);
    expect(isStoredTranscriptLine({ ...line("a", 1), atMs: Number.NaN })).toBe(false);
    expect(isStoredTranscriptLine(null)).toBe(false);
    expect(isStoredTranscriptLine("a string")).toBe(false);
  });
});

describe("reading the archive back", () => {
  const day = "2026-08-24";
  const lines = [line("first", new Date(2026, 7, 24, 17, 52, 1).getTime()), line("second", new Date(2026, 7, 24, 21, 7, 2).getTime())];
  const files = new Map<string, string>([
    [segmentPath("arc", day), serializeSegmentLines(lines)],
    [segmentPath("arc", "2026-08-23"), serializeSegmentLines([line("older", 1_000)])],
    ["arc/notes.txt", "not a segment"],
  ]);
  const fs = {
    read: (path: string) => {
      const body = files.get(path);
      if (body === undefined) {
        throw new Error("ENOENT");
      }
      return body;
    },
    list: (dir: string) => [...files.keys()].filter((path) => path.startsWith(`${dir}/`)).map((path) => path.slice(dir.length + 1)),
  };

  test("a day's segment reads back whole", () => {
    const segment = readDay("arc", day, fs);
    expect(segment.exists).toBe(true);
    expect(segment.skipped).toBe(0);
    expect(segment.lines).toEqual(lines);
  });

  test("a MISSING day is exists:false — different from a day of silence", () => {
    const segment = readDay("arc", "2026-08-22", fs);
    expect(segment.exists).toBe(false);
    expect(segment.lines).toEqual([]);
  });

  test("listDays returns only day segments, oldest first", () => {
    expect(listDays("arc", fs)).toEqual(["2026-08-23", "2026-08-24"]);
  });

  test("a missing archive directory is an empty archive, not a throw", () => {
    expect(
      listDays("nowhere", {
        list: () => {
          throw new Error("ENOENT");
        },
      }),
    ).toEqual([]);
  });

  test("the text rendering stamps LOCAL time, from the authoritative atMs", () => {
    // The stored `time` field is UTC (kept byte-identical for compatibility);
    // a human reading last night's transcript wants the clock they spoke against.
    const at = new Date(2026, 7, 24, 17, 52, 1).getTime();
    expect(localTimeStamp(at)).toBe("17:52:01");
    expect(renderTranscriptText([line("first", at)])).toBe("17:52:01  speaker_0: first");
  });
});

describe("merging snapshots of the same conversation", () => {
  test("overlapping copies collapse to the union, in spoken order", () => {
    const a = line("a", 3_000);
    const b = line("b", 1_000);
    const c = line("c", 2_000);
    expect(mergeTranscriptLines([a, b], [b, c]).map((entry) => entry.text)).toEqual(["b", "c", "a"]);
  });

  test("the same words at different times are two utterances (the rig repeats itself)", () => {
    expect(mergeTranscriptLines([line("yeah", 1_000)], [line("yeah", 2_000)]).length).toBe(2);
  });

  test("the legacy shapes both parse: {lines:[...]} and a bare array", () => {
    const lines = [line("a", 1_000)];
    expect(parseLegacyBody(JSON.stringify({ lines }))).toEqual(lines);
    expect(parseLegacyBody(JSON.stringify(lines))).toEqual(lines);
    expect(parseLegacyBody(JSON.stringify({ lines: [...lines, { text: "junk" }] }))).toEqual(lines);
    expect(parseLegacyBody(JSON.stringify({}))).toEqual([]);
  });
});

// THE DEFAULT-ON INVARIANT, asserted directly. Commit 6a1d228 gated the store
// behind an env marker because self-mode TEST runtimes were writing the LIVE
// store. Default-on must not undo that: this resolver NEVER invents a path, so
// the only thing that turns an archive on is a caller that means it — and the
// only caller that means it by default is the boot entry.
describe("the archive directory is resolved, never invented", () => {
  test("a bare runtime — including a self-mode one — resolves to NO archive", () => {
    expect(resolveTranscriptArchiveDir({})).toBeNull();
    expect(resolveTranscriptArchiveDir({ VIBERSYN_SELF_MODE: "1" })).toBeNull();
  });

  test("an env marker or an explicit option turns it on", () => {
    expect(resolveTranscriptArchiveDir({ VIBERSYN_TRANSCRIPT_ARCHIVE: "/tmp/arc" })).toBe("/tmp/arc");
    expect(resolveTranscriptArchiveDir({}, "/tmp/from-boot")).toBe("/tmp/from-boot");
  });

  test("an explicit null wins over the env, so a caller can refuse an archive", () => {
    expect(resolveTranscriptArchiveDir({ VIBERSYN_TRANSCRIPT_ARCHIVE: "/tmp/arc" }, null)).toBeNull();
  });

  test("empty / 0 / off are an explicit OPT-OUT, not a path", () => {
    expect(resolveTranscriptArchiveDir({ VIBERSYN_TRANSCRIPT_ARCHIVE: "" })).toBeNull();
    expect(resolveTranscriptArchiveDir({ VIBERSYN_TRANSCRIPT_ARCHIVE: "   " })).toBeNull();
    expect(resolveTranscriptArchiveDir({ VIBERSYN_TRANSCRIPT_ARCHIVE: "0" })).toBeNull();
    expect(resolveTranscriptArchiveDir({ VIBERSYN_TRANSCRIPT_ARCHIVE: "OFF" })).toBeNull();
  });
});
