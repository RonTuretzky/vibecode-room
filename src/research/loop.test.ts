import { describe, expect, test } from "bun:test";
import { ResearchLoop, type ResearchLoopOptions } from "./loop";
import type { ResearchAgent, ResearchReport, ResearchSuggester, ResearchSuggestion } from "./types";

function suggestion(overrides: Partial<ResearchSuggestion> = {}): ResearchSuggestion {
  return {
    matchId: null,
    kind: "fact-check",
    topic: "Blocker loss rate",
    claim: "Most remote teams miss half their blockers.",
    rationale: "",
    confidence: 0.7,
    contextSpan: { startTurnId: "rturn-0001", endTurnId: "rturn-0001", quote: "miss half their blockers" },
    ...overrides,
  };
}

const stubReport: ResearchReport = {
  summary: "A verified summary.",
  confidence: "medium",
  findings: [],
  biasNotes: [],
  sources: [],
  followUps: [],
};

class ScriptedSuggester implements ResearchSuggester {
  calls = 0;
  queue: ResearchSuggestion[][];
  constructor(queue: ResearchSuggestion[][]) {
    this.queue = queue;
  }
  async suggest(): Promise<ResearchSuggestion[]> {
    this.calls += 1;
    return this.queue.shift() ?? [];
  }
}

class InstantAgent implements ResearchAgent {
  async research(): Promise<ResearchReport> {
    return stubReport;
  }
}

class HangingAgent implements ResearchAgent {
  aborted = false;
  async research(_quest: unknown, options: { signal?: AbortSignal }): Promise<ResearchReport> {
    return await new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => {
        this.aborted = true;
        reject(new Error("aborted"));
      });
    });
  }
}

function makeLoop(overrides: Partial<ResearchLoopOptions> = {}): ResearchLoop {
  let clock = 0;
  return new ResearchLoop({
    sessionId: "test",
    suggester: new ScriptedSuggester([]),
    agent: new InstantAgent(),
    clock: overrides.clock ?? (() => (clock += 100)),
    minRoundIntervalMs: 0,
    newWordsThreshold: 1,
    ...overrides,
  });
}

describe("ResearchLoop dialogue window", () => {
  test("ingested turns get stable ids and respect the window cap", () => {
    const loop = makeLoop({ windowTurns: 3 });
    for (let index = 0; index < 5; index += 1) {
      loop.ingestTurn({ speaker: "s1", text: `turn ${index}`, atMs: index });
    }
    const turns = loop.turns();
    expect(turns).toHaveLength(3);
    expect(turns[0]!.id).toBe("rturn-0003");
    expect(turns[2]!.id).toBe("rturn-0005");
  });

  test("suggestion rounds run only while active", async () => {
    const suggester = new ScriptedSuggester([[suggestion()]]);
    const loop = makeLoop({ suggester });
    loop.ingestTurn({ speaker: "s1", text: "a claim worth checking", atMs: 1 });
    await loop.flush();
    expect(suggester.calls).toBe(0);
    loop.setActive(true);
    await loop.flush();
    expect(suggester.calls).toBe(1);
    expect(loop.quests()).toHaveLength(1);
    expect(loop.quests()[0]!.status).toBe("proposed");
  });
});

describe("ResearchLoop reconciliation", () => {
  test("matchId updates ratchet confidence and reset staleness", async () => {
    const suggester = new ScriptedSuggester([[suggestion({ confidence: 0.6 })]]);
    const loop = makeLoop({ suggester });
    loop.setActive(true);
    loop.ingestTurn({ speaker: "s1", text: "first mention", atMs: 1 });
    await loop.flush();
    const id = loop.quests()[0]!.id;
    // Second round: the model refines the same quest (higher + then lower conf).
    suggester.queue = [
      [suggestion({ matchId: id, confidence: 0.9, topic: "Refined topic" })],
      [suggestion({ matchId: id, confidence: 0.4 })],
    ];
    loop.ingestTurn({ speaker: "s1", text: "more detail", atMs: 2 });
    await loop.flush();
    expect(loop.quests()[0]!.confidence).toBeCloseTo(0.9);
    expect(loop.quests()[0]!.topic).toBe("Refined topic");
    loop.ingestTurn({ speaker: "s1", text: "even more", atMs: 3 });
    await loop.flush();
    // Ratchet: confidence never drops on an update.
    expect(loop.quests()[0]!.confidence).toBeCloseTo(0.9);
  });

  test("proposed quests missing enough rounds are pruned; committed work persists", async () => {
    const rounds: ResearchSuggestion[][] = [[suggestion()], [], [], []];
    const suggester = new ScriptedSuggester(rounds);
    const loop = makeLoop({ suggester, staleMissedRounds: 2 });
    loop.setActive(true);
    loop.ingestTurn({ speaker: "s1", text: "the claim", atMs: 1 });
    await loop.flush();
    const id = loop.quests()[0]!.id;
    loop.accept(id);
    await Bun.sleep(0); // the instant agent settles
    expect(loop.quest(id)!.status).toBe("complete");
    // Two empty rounds would prune a proposed quest — but not a completed one.
    loop.ingestTurn({ speaker: "s1", text: "unrelated a", atMs: 2 });
    await loop.flush();
    loop.ingestTurn({ speaker: "s1", text: "unrelated b", atMs: 3 });
    await loop.flush();
    expect(loop.quest(id)).not.toBeNull();
  });
});

describe("ResearchLoop lifecycle", () => {
  async function proposedQuest(loop: ResearchLoop, suggester: ScriptedSuggester): Promise<string> {
    loop.setActive(true);
    loop.ingestTurn({ speaker: "s1", text: "the claim", atMs: 1 });
    await loop.flush();
    return loop.quests()[0]!.id;
  }

  test("accept runs the agent to completion and stores the report", async () => {
    const suggester = new ScriptedSuggester([[suggestion()]]);
    const loop = makeLoop({ suggester });
    const id = await proposedQuest(loop, suggester);
    const accepted = loop.accept(id);
    expect(accepted!.status).toBe("researching");
    await Bun.sleep(0);
    const quest = loop.quest(id)!;
    expect(quest.status).toBe("complete");
    expect(quest.report).toEqual(stubReport);
    expect(quest.progress).toBe(100);
  });

  test("accept is 404-free: unknown and non-proposed ids are no-ops", async () => {
    const suggester = new ScriptedSuggester([[suggestion()]]);
    const loop = makeLoop({ suggester });
    const id = await proposedQuest(loop, suggester);
    expect(loop.accept("rq-nope")).toBeNull();
    loop.accept(id);
    expect(loop.accept(id)).toBeNull(); // already researching
  });

  test("dismissing a proposed quest suppresses its topic for the cooldown", async () => {
    const suggester = new ScriptedSuggester([[suggestion()], [suggestion()], [suggestion()]]);
    let nowMs = 0;
    const loop = makeLoop({ suggester, clock: () => nowMs, suppressMs: 1_000 });
    loop.setActive(true);
    nowMs = 100;
    loop.ingestTurn({ speaker: "s1", text: "the claim", atMs: 1 });
    await loop.flush();
    const id = loop.quests()[0]!.id;
    loop.dismiss(id);
    expect(loop.quests()).toHaveLength(0);
    // Re-suggested inside the window: suppressed.
    nowMs = 500;
    loop.ingestTurn({ speaker: "s1", text: "same claim again", atMs: 2 });
    await loop.flush();
    expect(loop.quests()).toHaveLength(0);
    // After the window: welcome back.
    nowMs = 2_000;
    loop.ingestTurn({ speaker: "s1", text: "same claim third time", atMs: 3 });
    await loop.flush();
    expect(loop.quests()).toHaveLength(1);
  });

  test("dismissing a researching quest aborts the agent; stopAll fails all in-flight", async () => {
    const agent = new HangingAgent();
    const suggester = new ScriptedSuggester([[suggestion()], [suggestion({ topic: "Other", claim: "Other claim" })]]);
    const loop = makeLoop({ suggester, agent });
    const id = await proposedQuest(loop, suggester);
    loop.accept(id);
    loop.dismiss(id);
    await Bun.sleep(0);
    expect(agent.aborted).toBe(true);
    expect(loop.quest(id)).toBeNull();

    loop.ingestTurn({ speaker: "s1", text: "other claim", atMs: 2 });
    await loop.flush();
    const second = loop.quests().find((quest) => quest.status === "proposed");
    loop.accept(second!.id);
    loop.stopAll("emergency stop");
    await Bun.sleep(0);
    expect(loop.quest(second!.id)!.status).toBe("failed");
    expect(loop.quest(second!.id)!.error).toBe("emergency stop");
  });

  test("tray ordering: researching → proposed by confidence → complete → failed", async () => {
    const suggester = new ScriptedSuggester([
      [
        suggestion({ topic: "A", claim: "claim a", confidence: 0.5 }),
        suggestion({ topic: "B", claim: "claim b", confidence: 0.9 }),
        suggestion({ topic: "C", claim: "claim c", confidence: 0.7 }),
      ],
    ]);
    const agent = new HangingAgent();
    const loop = makeLoop({ suggester, agent });
    loop.setActive(true);
    loop.ingestTurn({ speaker: "s1", text: "many claims", atMs: 1 });
    await loop.flush();
    const byTopic = (topic: string) => loop.quests().find((quest) => quest.topic === topic)!;
    loop.accept(byTopic("A").id);
    const order = loop.quests().map((quest) => quest.topic);
    expect(order[0]).toBe("A"); // researching first
    expect(order.slice(1)).toEqual(["B", "C"]); // proposed by confidence desc
  });
});
