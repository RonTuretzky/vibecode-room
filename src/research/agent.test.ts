import { describe, expect, test } from "bun:test";
import {
  HostClaudeResearchAgent,
  StubResearchAgent,
  parseReport,
  sanitizeReport,
  selectResearchAgent,
} from "./agent";
import type { ResearchQuest, ResearchReport } from "./types";

function quest(overrides: Partial<ResearchQuest> = {}): ResearchQuest {
  return {
    id: "rq-1",
    kind: "fact-check",
    topic: "Standup blocker loss",
    claim: "Most remote teams miss half their blockers in async standups.",
    rationale: "",
    confidence: 0.7,
    contextSpan: { startTurnId: "rturn-1", endTurnId: "rturn-1", quote: "miss half their blockers" },
    status: "researching",
    progress: 0,
    progressLabel: "",
    report: null,
    error: null,
    roundsSeen: 1,
    missedRounds: 0,
    firstSeenAtMs: 0,
    updatedAtMs: 0,
    ...overrides,
  };
}

function report(overrides: Partial<ResearchReport> = {}): ResearchReport {
  return {
    summary: "The claim overstates the research; one survey found ~30% loss.",
    confidence: "medium",
    findings: [
      { claim: "Half of blockers are missed", verdict: "mixed", explanation: "Surveys vary 20-50%.", sourceIndexes: [0] },
    ],
    biasNotes: [],
    sources: [{ title: "Async standup survey 2025", url: "https://example.com/survey", publisher: "Example Research", note: "" }],
    followUps: ["Which team sizes were surveyed?"],
    ...overrides,
  };
}

describe("HostClaudeResearchAgent", () => {
  // Routes each prompt kind to its scripted reply so the parallel pipeline's
  // calls can arrive in any order.
  function scriptedRunner(prompts: string[], overrides: Partial<Record<"lane" | "synthesis" | "check" | "bias", string>> = {}) {
    return async (prompt: string) => {
      prompts.push(prompt);
      if (prompt.includes("one lane of a parallel research")) {
        return overrides.lane ?? JSON.stringify(report());
      }
      if (prompt.includes("synthesis editor")) {
        return overrides.synthesis ?? JSON.stringify(report({ summary: "Synthesized summary." }));
      }
      if (prompt.includes("REFUTE")) {
        return overrides.check ?? JSON.stringify(report({ summary: "Fact-checked summary." }));
      }
      return (
        overrides.bias ??
        JSON.stringify(report({ summary: "Bias summary.", biasNotes: [{ note: "All sources are vendor blogs.", severity: "high" }] }))
      );
    };
  }

  test("fans out 3 source lanes, synthesizes a draft, then verifies in parallel", async () => {
    const prompts: string[] = [];
    const agent = new HostClaudeResearchAgent({ runner: scriptedRunner(prompts) });
    const progress: string[] = [];
    const drafts: string[] = [];
    const result = await agent.research(quest(), {
      correlationId: "corr-test",
      onProgress: (p) => progress.push(p.label),
      onDraft: (draft) => drafts.push(draft.summary),
    });
    expect(prompts).toHaveLength(6); // 3 lanes + synthesis + fact-check + bias
    expect(prompts.filter((p) => p.includes("one lane of a parallel research"))).toHaveLength(3);
    // The draft published mid-run is the synthesis, before verification.
    expect(drafts).toEqual(["Synthesized summary."]);
    // Fact-check owns findings/summary; bias pass owns biasNotes.
    expect(result.summary).toBe("Fact-checked summary.");
    expect(result.biasNotes).toHaveLength(1);
    expect(result.degraded).toBeUndefined();
    expect(progress).toContain("verifying findings (fact-check + bias)");
    expect(progress).toContain("report ready");
  });

  test("verification misses degrade HONESTLY: draft stands, notes recorded", async () => {
    const prompts: string[] = [];
    const agent = new HostClaudeResearchAgent({
      runner: scriptedRunner(prompts, { check: "no json", bias: "still no json" }),
    });
    const result = await agent.research(quest(), { correlationId: "corr-test" });
    expect(result.summary).toBe("Synthesized summary.");
    expect(result.degraded).toContain("fact-check pass failed — findings unverified");
    expect(result.degraded).toContain("bias scan failed");
  });

  test("a dead lane is dropped with a note; the rest still synthesize", async () => {
    const prompts: string[] = [];
    let laneCalls = 0;
    const agent = new HostClaudeResearchAgent({
      runner: async (prompt: string) => {
        prompts.push(prompt);
        if (prompt.includes("one lane of a parallel research")) {
          laneCalls += 1;
          return laneCalls === 1 ? "lane junk" : JSON.stringify(report());
        }
        if (prompt.includes("synthesis editor")) {
          return JSON.stringify(report({ summary: "Synthesized summary." }));
        }
        return JSON.stringify(report({ summary: "Verified." }));
      },
    });
    const result = await agent.research(quest(), { correlationId: "corr-test" });
    expect(result.summary).toBe("Verified.");
    // The final degraded notes still carry the dead lane.
    expect(result.degraded?.some((note) => note.includes("lane failed"))).toBe(true);
  });

  test("all lanes unparseable fails the quest", async () => {
    const agent = new HostClaudeResearchAgent({ runner: async () => "no json at all" });
    await expect(agent.research(quest(), { correlationId: "corr-test" })).rejects.toThrow(/no research lane/u);
  });

  test("an aborted signal stops between stages", async () => {
    const controller = new AbortController();
    const agent = new HostClaudeResearchAgent({
      runner: async () => {
        controller.abort();
        return JSON.stringify(report());
      },
    });
    await expect(agent.research(quest(), { correlationId: "corr-test", signal: controller.signal })).rejects.toThrow();
  });
});

describe("parseReport / sanitizeReport", () => {
  test("extracts the report from fenced prose", () => {
    const parsed = parseReport("Sure! Here you go:\n```json\n" + JSON.stringify(report()) + "\n```");
    expect(parsed?.summary).toBe(report().summary);
  });

  test("drops non-http sources and remaps finding indexes", () => {
    const dirty = report({
      sources: [
        { title: "Local file", url: "file:///etc/passwd", publisher: "", note: "" },
        { title: "Real source", url: "https://example.com/a", publisher: "", note: "" },
      ],
      findings: [
        { claim: "c", verdict: "supported", explanation: "", sourceIndexes: [0, 1] },
      ],
    });
    const clean = sanitizeReport(dirty);
    expect(clean.sources).toHaveLength(1);
    expect(clean.sources[0]!.url).toBe("https://example.com/a");
    expect(clean.findings[0]!.sourceIndexes).toEqual([0]);
  });
});

describe("StubResearchAgent", () => {
  test("emits an honest unverified report with zero network", async () => {
    const result = await new StubResearchAgent().research(quest(), { correlationId: "corr-test" });
    expect(result.confidence).toBe("low");
    expect(result.findings[0]!.verdict).toBe("unverified");
    expect(result.sources).toHaveLength(0);
  });
});

describe("selectResearchAgent", () => {
  test("defaults to host-claude; explicit stub wins", () => {
    expect(selectResearchAgent({}).mode).toBe("host-claude");
    expect(selectResearchAgent({ VIBERSYN_RESEARCH_AGENT: "stub" }).mode).toBe("stub");
  });
});
