import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectorApp } from "./app";
import { createProjectorRuntime, type ProjectorRuntime } from "./composition";
import type { ResearchAgent, ResearchReport, ResearchSuggester, ResearchSuggestion } from "../research";
import type { ProjectorSnapshot } from "../ui/types";

// HTTP-level coverage of RESEARCH MODE over a REAL runtime (no bound port —
// app.request()): the mode toggle, quest accept/dismiss, the dossier deck
// route, and the snapshot's research/dialogue fields.

function researchSuggestion(overrides: Partial<ResearchSuggestion> = {}): ResearchSuggestion {
  return {
    matchId: null,
    kind: "fact-check",
    topic: "Blocker loss rate",
    claim: "Most remote teams miss half their blockers.",
    rationale: "Reported statistic worth verifying.",
    confidence: 0.8,
    contextSpan: { startTurnId: "rturn-0001", endTurnId: "rturn-0001", quote: "miss half their blockers" },
    ...overrides,
  };
}

class ScriptedResearchSuggester implements ResearchSuggester {
  #queue: ResearchSuggestion[][];
  constructor(queue: ResearchSuggestion[][]) {
    this.#queue = queue;
  }
  async suggest(): Promise<ResearchSuggestion[]> {
    return this.#queue.shift() ?? [];
  }
}

const scriptedReport: ResearchReport = {
  summary: "Surveys put the loss at 20-50%.",
  confidence: "medium",
  findings: [{ claim: "Half are missed", verdict: "mixed", explanation: "Varies.", sourceIndexes: [0] }],
  biasNotes: [{ note: "Vendor-run surveys.", severity: "medium" }],
  sources: [{ title: "Async survey", url: "https://example.com/survey", publisher: "Example", note: "" }],
  followUps: [],
};

class ScriptedResearchAgent implements ResearchAgent {
  async research(): Promise<ResearchReport> {
    return scriptedReport;
  }
}

const tempDirs: string[] = [];
let runtimes: ProjectorRuntime[] = [];
let priorCapacityGuard: string | undefined;

beforeEach(() => {
  priorCapacityGuard = process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK;
  process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK = "1";
});

afterEach(async () => {
  if (priorCapacityGuard === undefined) {
    delete process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK;
  } else {
    process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK = priorCapacityGuard;
  }
  for (const runtime of runtimes) {
    runtime.research.stopAll("test teardown");
    await runtime.buildOrchestrator.abortEverything().catch(() => undefined);
    await runtime.ideaBuilds.stopAll().catch(() => undefined);
  }
  runtimes = [];
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

async function makeApp(suggestions: ResearchSuggestion[][] = [[researchSuggestion()]]): Promise<{
  app: ReturnType<typeof createProjectorApp>;
  runtime: ProjectorRuntime;
}> {
  const buildsRoot = mkdtempSync(join(tmpdir(), "vibersyn-research-"));
  tempDirs.push(buildsRoot);
  const runtime = await createProjectorRuntime(
    {
      VIBERSYN_INITIAL_MUTED: "0",
      VIBERSYN_IDEA_DETECTOR: "heuristic",
      VIBERSYN_DETECT_TICK_MS: "0",
    },
    {
      buildsRoot,
      builderAgent: async () => undefined,
      executionArtifactsRoot: join(buildsRoot, "vibersyn-runs"),
      researchSuggester: new ScriptedResearchSuggester(suggestions),
      researchAgent: new ScriptedResearchAgent(),
    },
  );
  runtimes.push(runtime);
  const app = createProjectorApp(runtime, { env: {}, host: "127.0.0.1", port: 8787 });
  return { app, runtime };
}

async function postJson(app: ReturnType<typeof createProjectorApp>, path: string, body?: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

// Surface one quest through the real loop: turn ingested, forced round awaited.
async function surfaceQuest(runtime: ProjectorRuntime): Promise<string> {
  runtime.research.ingestTurn({ speaker: "Room", text: "we heard a claim worth checking", atMs: Date.now() });
  await runtime.research.maybeSuggest(true);
  await runtime.research.flush();
  const quest = runtime.research.quests().find((entry) => entry.status === "proposed");
  if (quest === undefined) {
    throw new Error("expected the scripted suggester to surface a proposed quest");
  }
  return quest.id;
}

describe("POST /api/research-mode", () => {
  test("explicit {on:true} activates; absent body toggles; snapshot reflects it", async () => {
    const { app } = await makeApp();
    const on = await postJson(app, "/api/research-mode", { on: true });
    expect(on.status).toBe(200);
    expect(((await on.json()) as ProjectorSnapshot).researchMode).toBe(true);

    const toggled = await postJson(app, "/api/research-mode");
    expect(((await toggled.json()) as ProjectorSnapshot).researchMode).toBe(false);
  });
});

describe("research quest lifecycle over HTTP", () => {
  test("accept spawns the agent; the completed quest carries a deckUrl and the deck renders with QR codes", async () => {
    const { app, runtime } = await makeApp();
    runtime.setResearchMode(true);
    const id = await surfaceQuest(runtime);

    const response = await postJson(app, `/api/research/${id}/accept`);
    expect(response.status).toBe(200);
    // The scripted agent resolves on the microtask queue; give it a beat.
    await Bun.sleep(10);

    const state = await app.request("/api/state");
    const snapshot = (await state.json()) as ProjectorSnapshot;
    const quest = (snapshot.research ?? []).find((entry) => entry.id === id);
    expect(quest?.status).toBe("complete");
    expect(quest?.sourceCount).toBe(1);
    expect(quest?.deckUrl).toBe(`/api/research/${id}/deck`);
    expect(quest?.verdicts?.mixed).toBe(1);

    const deck = await app.request(`/api/research/${id}/deck`);
    expect(deck.status).toBe(200);
    const html = await deck.text();
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Blocker loss rate");
    // A real server-generated QR SVG per source.
    expect(html).toContain("<svg");
    expect(html).toContain("https://example.com/survey");
  });

  test("deck for an unknown/incomplete quest is a 404; unknown accept is a 404-free no-op", async () => {
    const { app, runtime } = await makeApp();
    runtime.setResearchMode(true);

    const deck = await app.request("/api/research/rq-nope/deck");
    expect(deck.status).toBe(404);

    const accept = await postJson(app, "/api/research/rq-nope/accept");
    expect(accept.status).toBe(200); // snapshot unchanged, no error

    const id = await surfaceQuest(runtime);
    const pendingDeck = await app.request(`/api/research/${id}/deck`);
    expect(pendingDeck.status).toBe(404); // proposed, not complete
  });

  test("dismiss drops a proposed quest from the snapshot", async () => {
    const { app, runtime } = await makeApp();
    runtime.setResearchMode(true);
    const id = await surfaceQuest(runtime);

    const response = await postJson(app, `/api/research/${id}/dismiss`);
    const snapshot = (await response.json()) as ProjectorSnapshot;
    expect((snapshot.research ?? []).find((entry) => entry.id === id)).toBeUndefined();
  });
});

describe("snapshot research/dialogue fields", () => {
  test("ingested turns surface as id-stable dialogue and anchor the quest's turnId", async () => {
    const { app, runtime } = await makeApp();
    runtime.setResearchMode(true);
    await surfaceQuest(runtime);

    const state = await app.request("/api/state");
    const snapshot = (await state.json()) as ProjectorSnapshot;
    expect(snapshot.dialogue?.length).toBe(1);
    expect(snapshot.dialogue?.[0]?.id).toBe("rturn-0001");
    expect(snapshot.research?.[0]?.turnId).toBe("rturn-0001");
    expect(snapshot.research?.[0]?.evidence).toBe("miss half their blockers");
  });

  test("emergency stop fails in-flight research and clears proposals from the snapshot", async () => {
    const { runtime } = await makeApp([[researchSuggestion()], [researchSuggestion({ topic: "Other", claim: "other claim" })]]);
    runtime.setResearchMode(true);
    const id = await surfaceQuest(runtime);
    runtime.acceptResearch(id);

    const snapshot = await runtime.emergencyStop();
    expect(snapshot.researchMode).toBe(false);
    const quest = (snapshot.research ?? []).find((entry) => entry.id === id);
    // Either the instant agent already completed it, or the stop failed it —
    // never a live "researching" entry after the kill-all.
    expect(quest?.status === "failed" || quest?.status === "complete").toBe(true);
  });
});
