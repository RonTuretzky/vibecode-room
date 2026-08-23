import { describe, expect, test } from "bun:test";
import { appendSliceLine, joinedSliceText, STEER_SLICE_MAX_LINES, STEER_SLICE_WINDOW_MS } from "./transcript-slice";

// Pure slice logic — no clock, no fs, no runtime.

describe("appendSliceLine", () => {
  test("appends without mutating the input", () => {
    const lines = [{ text: "one", atMs: 1 }];
    const appended = appendSliceLine(lines, { text: "two", atMs: 2 });
    expect(appended).toEqual([
      { text: "one", atMs: 1 },
      { text: "two", atMs: 2 },
    ]);
    expect(lines).toHaveLength(1);
  });

  test("drops the oldest lines beyond the cap", () => {
    let lines: ReturnType<typeof appendSliceLine> = [];
    for (let index = 0; index < STEER_SLICE_MAX_LINES + 5; index += 1) {
      lines = appendSliceLine(lines, { text: `line ${index}`, atMs: index });
    }
    expect(lines).toHaveLength(STEER_SLICE_MAX_LINES);
    expect(lines[0]!.text).toBe("line 5");
    expect(lines[lines.length - 1]!.text).toBe(`line ${STEER_SLICE_MAX_LINES + 4}`);
  });
});

describe("joinedSliceText", () => {
  test("joins finals within the window into one spoken instruction", () => {
    const lines = [
      { text: "make the header blue", atMs: 1_000 },
      { text: "and add a welcome note", atMs: 2_000 },
    ];
    expect(joinedSliceText(lines, 3_000)).toBe("make the header blue and add a welcome note");
  });

  test("lines older than the trailing 60s window are excluded", () => {
    const nowMs = 200_000;
    const lines = [
      { text: "stale narration from earlier", atMs: nowMs - STEER_SLICE_WINDOW_MS - 1 },
      { text: "exactly on the boundary", atMs: nowMs - STEER_SLICE_WINDOW_MS },
      { text: "fresh change", atMs: nowMs - 1_000 },
    ];
    expect(joinedSliceText(lines, nowMs)).toBe("exactly on the boundary fresh change");
  });

  test("whitespace-only lines vanish; an all-stale or empty slice joins to the empty string", () => {
    expect(joinedSliceText([], 1_000)).toBe("");
    expect(joinedSliceText([{ text: "   ", atMs: 900 }], 1_000)).toBe("");
    expect(joinedSliceText([{ text: "old", atMs: 0 }], STEER_SLICE_WINDOW_MS * 3)).toBe("");
  });

  test("internal whitespace collapses so the joined text reads as one line", () => {
    const lines = [{ text: "  make   the\nheader blue  ", atMs: 1_000 }];
    expect(joinedSliceText(lines, 1_500)).toBe("make the header blue");
  });
});
