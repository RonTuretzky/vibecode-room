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
  test("runs the three stages and returns the final (bias-scanned) report", async () => {
    const prompts: string[] = [];
    const agent = new HostClaudeResearchAgent({
      runner: async (prompt) => {
        prompts.push(prompt);
        if (prompts.length === 1) {
          return JSON.stringify(report());
        }
        if (prompts.length === 2) {
          return JSON.stringify(report({ summary: "Fact-checked summary." }));
        }
        return JSON.stringify(
          report({ summary: "Fact-checked summary.", biasNotes: [{ note: "All sources are vendor blogs.", severity: "high" }] }),
        );
      },
    });
    const progress: string[] = [];
    const result = await agent.research(quest(), {
      correlationId: "corr-test",
      onProgress: (p) => progress.push(p.label),
    });
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain("web search");
    expect(prompts[1]).toContain("REFUTE");
    expect(prompts[2]).toContain("media-bias");
    expect(result.biasNotes).toHaveLength(1);
    expect(progress).toContain("fact-checking findings");
    expect(progress).toContain("report ready");
  });

  test("stage 2/3 misses degrade to the prior stage's report", async () => {
    let call = 0;
    const agent = new HostClaudeResearchAgent({
      runner: async () => {
        call += 1;
        return call === 1 ? JSON.stringify(report()) : "the model rambled with no JSON";
      },
    });
    const result = await agent.research(quest(), { correlationId: "corr-test" });
    expect(result.summary).toBe(report().summary);
  });

  test("an unparseable research stage fails the quest", async () => {
    const agent = new HostClaudeResearchAgent({ runner: async () => "no json at all" });
    await expect(agent.research(quest(), { correlationId: "corr-test" })).rejects.toThrow(/no parseable report/u);
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
