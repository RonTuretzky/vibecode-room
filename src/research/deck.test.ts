import { describe, expect, test } from "bun:test";
import { renderResearchDeckHtml, type ResearchDeckInput } from "./deck";
import type { ResearchQuest, ResearchReport } from "./types";

function deckInput(overrides: Partial<ResearchDeckInput> = {}): ResearchDeckInput {
  const quest: ResearchQuest = {
    id: "rq-1",
    kind: "fact-check",
    topic: "Blocker loss <rate>",
    claim: 'Most remote teams miss "half" their blockers.',
    rationale: "",
    confidence: 0.7,
    contextSpan: { startTurnId: "rturn-1", endTurnId: "rturn-1", quote: "miss half their blockers" },
    status: "complete",
    progress: 100,
    progressLabel: "report ready",
    report: null,
    error: null,
    roundsSeen: 1,
    missedRounds: 0,
    firstSeenAtMs: 0,
    updatedAtMs: 0,
  };
  const report: ResearchReport = {
    summary: "Surveys put the loss at 20-50%, not half.",
    confidence: "medium",
    findings: [
      { claim: "Half of blockers are missed", verdict: "mixed", explanation: "Varies by survey.", sourceIndexes: [0] },
      { claim: "Async standups lose information", verdict: "supported", explanation: "", sourceIndexes: [0] },
    ],
    biasNotes: [{ note: "Both sources sell standup software.", severity: "high" }],
    sources: [{ title: "Async survey <2025>", url: "https://example.com/survey", publisher: "Example Research", note: "vendor-run" }],
    followUps: ["Which team sizes were surveyed?"],
  };
  return {
    quest,
    report,
    sources: report.sources.map((source) => ({ ...source, qrSvg: "<svg data-qr='1'></svg>" })),
    ...overrides,
  };
}

describe("renderResearchDeckHtml", () => {
  test("renders a complete self-contained document with all five slides", () => {
    const html = renderResearchDeckHtml(deckInput());
    expect(html).toStartWith("<!doctype html>");
    expect(html).toContain('data-slide="0"');
    expect(html).toContain('data-slide="4"');
    // Verdict badges + bias severity render.
    expect(html).toContain("verdict-mixed");
    expect(html).toContain("verdict-supported");
    expect(html).toContain("severity-high");
    // No external assets: everything inline.
    expect(html).not.toContain("src=\"http");
    expect(html).not.toContain("<link");
  });

  test("escapes model/user text but injects the server-generated QR SVG raw", () => {
    const html = renderResearchDeckHtml(deckInput());
    expect(html).toContain("Blocker loss &lt;rate&gt;");
    expect(html).toContain("Async survey &lt;2025&gt;");
    expect(html).not.toContain("Blocker loss <rate>");
    expect(html).toContain("<svg data-qr='1'></svg>");
  });

  test("empty sections render honest placeholders", () => {
    const input = deckInput();
    input.report = { ...input.report, biasNotes: [], followUps: [], findings: [] };
    const html = renderResearchDeckHtml({ ...input, sources: [] });
    expect(html).toContain("No significant bias signals");
    expect(html).toContain("No live sources were captured");
    expect(html).toContain("No discrete findings");
  });

  test("nav controls carry data-dwell so the gesture wall can drive the deck", () => {
    const html = renderResearchDeckHtml(deckInput());
    expect(html).toContain('data-dwell="deck-next"');
    expect(html).toContain('data-dwell="deck-prev"');
  });
});
