import { describe, expect, test } from "bun:test";

import {
  TOPIC_CARD_PAGE_SIZE,
  linePage,
  memoryLine,
  pageOfLine,
  spanLine,
  summaryBlock,
  type TopicCardLine,
} from "./topic-card";

const line = (id: string, atMs: number, source: "said" | "recalled" = "said"): TopicCardLine => ({
  id,
  atMs,
  speaker: "ron",
  text: `line ${id}`,
  source,
});

describe("summaryBlock", () => {
  test("the agent's abstract is shown as content", () => {
    const block = summaryBlock({ summary: "  Mic failover, and why it never fired.  ", agentAtMs: 5, lines: [] });
    expect(block).toEqual({ kind: "agent", text: "Mic failover, and why it never fired." });
  });

  test("no abstract but the agent has spoken = not summarized YET", () => {
    expect(summaryBlock({ summary: null, agentAtMs: 5, lines: [] }).kind).toBe("pending");
  });

  test("no agent has ever spoken = a different silence, said differently", () => {
    const block = summaryBlock({ summary: null, agentAtMs: null, lines: [] });
    expect(block.kind).toBe("never");
    expect(block.text).toContain("No model has summarized");
  });

  test("an empty-string abstract is a silence, not a blank card", () => {
    expect(summaryBlock({ summary: "   ", agentAtMs: 5, lines: [] }).kind).toBe("pending");
  });
});

describe("memoryLine", () => {
  test("states elision instead of implying the thread is complete", () => {
    expect(memoryLine({ turnCount: 12, elidedCount: 3 })).toBe("12 turns · 3 earlier no longer kept");
  });

  test("no elision, no note; one turn is singular", () => {
    expect(memoryLine({ turnCount: 12, elidedCount: 0 })).toBe("12 turns");
    expect(memoryLine({ turnCount: 1, elidedCount: 0 })).toBe("1 turn");
  });
});

describe("spanLine", () => {
  const fmt = (atMs: number) => `t${atMs}`;
  test("start → end", () => {
    expect(spanLine({ firstAtMs: 1, freshAtMs: 9 }, fmt)).toBe("t1 → t9");
  });
  test("a single-moment thread shows one stamp", () => {
    expect(spanLine({ firstAtMs: 4, freshAtMs: 4 }, fmt)).toBe("t4");
  });
});

describe("linePage", () => {
  const lines = [line("a", 1), line("b", 2), line("c", 3), line("d", 4), line("e", 5)];

  test("pages the thread instead of scrolling it", () => {
    const first = linePage(lines, 0);
    expect(first.lines.map((l) => l.id)).toEqual(["a", "b", "c", "d"]);
    expect(first.pageCount).toBe(2);
    expect(linePage(lines, 1).lines.map((l) => l.id)).toEqual(["e"]);
  });

  test("a stale page index clamps rather than blanking the card", () => {
    expect(linePage(lines, 99).page).toBe(1);
    expect(linePage(lines, -3).page).toBe(0);
  });

  test("an empty thread still has one page", () => {
    expect(linePage([], 0)).toEqual({ lines: [], page: 0, pageCount: 1 });
  });
});

describe("pageOfLine", () => {
  const lines = [line("a", 1), line("b", 2), line("c", 3), line("d", 4), line("e", 5), line("f", 6)];

  test("picking one star opens the card on that star's page", () => {
    expect(pageOfLine(lines, "a")).toBe(0);
    expect(pageOfLine(lines, "e")).toBe(1);
  });

  test("a whole-patch pick (freshest turn, maybe not kept) opens on the freshest page", () => {
    expect(pageOfLine(lines, "not-kept")).toBe(1);
    expect(pageOfLine(lines, null)).toBe(0);
  });

  test("page size is the shared constant", () => {
    expect(TOPIC_CARD_PAGE_SIZE).toBe(4);
  });
});
