import { describe, expect, test } from "bun:test";
import { ResearchLoop, type ResearchLoopOptions } from "./loop";
import { ConceptTree } from "./tree";
import type { ResearchAgent, ResearchReport, ResearchSuggester, ResearchSuggestion } from "./types";

function suggestion(overrides: Partial<ResearchSuggestion> = {}): ResearchSuggestion {
  return {
    matchId: null,
    kind: "fact-check",
    topic: "Blocker loss rate",
    claim: "Most remote teams miss half their blockers.",
    rationale: "",
    confidence: 0.7,
    // The quote must be GROUNDED in whatever the test ingests (the reconcile
    // precision guard drops proposals quoting things nobody said) — "the
    // claim" token-matches the suite's standard ingested turns.
    contextSpan: { startTurnId: "rturn-0001", endTurnId: "rturn-0001", quote: "the claim" },
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
    // Heuristic-only clustering: no debounce timers, no model calls in tests.
    conceptTree: new ConceptTree({ model: null }),
    ...overrides,
  });
}

describe("ResearchLoop dialogue window", () => {
  test("ingested turns get stable ids and respect the window cap", () => {
    const loop = makeLoop({ windowTurns: 3 });
    for (let index = 0; index < 5; index += 1) {
      // Spaced past the coalesce gap so each ingest is its own turn.
      loop.ingestTurn({ speaker: "s1", text: `turn ${index}`, atMs: index * 10_000 });
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
    loop.ingestTurn({ speaker: "s1", text: "first mention of the claim", atMs: 1 });
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
        // Token-distinct claims: the near-dupe guard merges Jaccard-similar
        // claims, so "claim a/b/c" would collapse into one quest.
        suggestion({ topic: "A", claim: "alpha rocket budgets claim", confidence: 0.5 }),
        suggestion({ topic: "B", claim: "beta ocean warming claim", confidence: 0.9 }),
        suggestion({ topic: "C", claim: "gamma cheese exports claim", confidence: 0.7 }),
      ],
    ]);
    const agent = new HangingAgent();
    const loop = makeLoop({ suggester, agent });
    loop.setActive(true);
    loop.ingestTurn({ speaker: "s1", text: "the claim", atMs: 1 });
    await loop.flush();
    const byTopic = (topic: string) => loop.quests().find((quest) => quest.topic === topic)!;
    loop.accept(byTopic("A").id);
    const order = loop.quests().map((quest) => quest.topic);
    expect(order[0]).toBe("A"); // researching first
    expect(order.slice(1)).toEqual(["B", "C"]); // proposed by confidence desc
  });
});

describe("ResearchLoop direct turn research", () => {
  test("researchTurn spawns and runs a quest even for a turn the heuristic declines", async () => {
    const loop = makeLoop();
    loop.setActive(true);
    loop.ingestTurn({ speaker: "s1", text: "hmm okay", atMs: 1 }); // too short for any heuristic
    const turnId = loop.turns()[0]!.id;
    const spawned = loop.researchTurn(turnId);
    expect(spawned!.status).toBe("researching");
    expect(spawned!.kind).toBe("deep-dive"); // human asked → deep-dive fallback
    expect(spawned!.contextSpan.startTurnId).toBe(turnId);
    await Bun.sleep(0);
    expect(loop.quest(spawned!.id)!.status).toBe("complete");
  });

  test("researchTurn is idempotent per turn and 404-free on unknown ids", () => {
    const loop = makeLoop();
    loop.setActive(true);
    expect(loop.researchTurn("rturn-nope")).toBeNull();
    loop.ingestTurn({ speaker: "s1", text: "how much money would vending machines save by using crypto", atMs: 1 });
    const turnId = loop.turns()[0]!.id;
    const first = loop.researchTurn(turnId)!;
    const second = loop.researchTurn(turnId)!;
    expect(second.id).toBe(first.id); // double-click cannot double-spawn
  });

  test("researchTurn is inert while research mode is off", () => {
    const loop = makeLoop();
    loop.ingestTurn({ speaker: "s1", text: "a checkable claim with the number 42 in it", atMs: 1 });
    const turnId = loop.turns()[0]!.id;
    expect(loop.researchTurn(turnId)).toBeNull();
  });
});

describe("ResearchLoop fragment coalescing", () => {
  test("same-speaker fragments inside the gap grow the newest turn in place", () => {
    const loop = makeLoop();
    const first = loop.ingestTurn({ speaker: "s1", text: "we could build a", atMs: 1_000 });
    const merged = loop.ingestTurn({ speaker: "s1", text: "vending machine that takes crypto", atMs: 3_000 });
    expect(merged.id).toBe(first.id);
    expect(loop.turns()).toHaveLength(1);
    expect(loop.turns()[0]!.text).toBe("we could build a vending machine that takes crypto");
    // atMs stays at the FIRST fragment — the turn's position in time is where
    // the utterance started.
    expect(loop.turns()[0]!.atMs).toBe(1_000);
  });

  test("speaker change, long gaps, and full turns all break the merge", () => {
    const loop = makeLoop({ coalesceMaxWords: 5 });
    loop.ingestTurn({ speaker: "s1", text: "first fragment here", atMs: 1_000 });
    loop.ingestTurn({ speaker: "s2", text: "different speaker", atMs: 2_000 });
    expect(loop.turns()).toHaveLength(2); // speaker change → new turn
    loop.ingestTurn({ speaker: "s2", text: "way later", atMs: 20_000 });
    expect(loop.turns()).toHaveLength(3); // > gap → new turn
    loop.ingestTurn({ speaker: "s2", text: "one two three four five", atMs: 21_000 });
    expect(loop.turns()).toHaveLength(3); // still under the word cap → merged
    loop.ingestTurn({ speaker: "s2", text: "overflow", atMs: 22_000 });
    expect(loop.turns()).toHaveLength(4); // newest turn is full → new turn
  });

  test("continuous speech merges by LAST-growth freshness, not first-fragment atMs", () => {
    const loop = makeLoop();
    loop.ingestTurn({ speaker: "s1", text: "started talking", atMs: 0 });
    loop.ingestTurn({ speaker: "s1", text: "still going", atMs: 5_000 });
    // 10s after the first fragment but only 5s after the last — same utterance.
    loop.ingestTurn({ speaker: "s1", text: "and going", atMs: 10_000 });
    expect(loop.turns()).toHaveLength(1);
  });

  test("coalesced words still count toward the suggestion cadence", async () => {
    const suggester = new ScriptedSuggester([[suggestion()]]);
    const loop = makeLoop({ suggester, newWordsThreshold: 6 });
    loop.setActive(true);
    loop.ingestTurn({ speaker: "s1", text: "three little words", atMs: 1_000 });
    await loop.flush();
    expect(suggester.calls).toBe(0); // 3 words < threshold
    loop.ingestTurn({ speaker: "s1", text: "and three more", atMs: 2_000 });
    await loop.flush();
    expect(suggester.calls).toBe(1); // merged, but 6 spoken words → round fires
  });

  test("quest turn anchors survive coalescing growth", async () => {
    const loop = makeLoop();
    loop.setActive(true);
    loop.ingestTurn({ speaker: "s1", text: "how much money would vending machines save by using crypto", atMs: 1_000 });
    const turnId = loop.turns()[0]!.id;
    const quest = loop.researchTurn(turnId)!;
    expect(quest.contextSpan.startTurnId).toBe(turnId);
    loop.ingestTurn({ speaker: "s1", text: "asking for a friend", atMs: 2_000 });
    // The anchor turn GREW but kept its id — the quest still resolves it.
    expect(loop.turns()).toHaveLength(1);
    expect(loop.turns()[0]!.id).toBe(turnId);
    expect(loop.quest(quest.id)!.contextSpan.startTurnId).toBe(turnId);
    await Bun.sleep(0); // let the instant agent settle before teardown
  });
});

describe("ResearchLoop concept topics", () => {
  test("loop.topics() surfaces the heuristic clustering with turn membership", () => {
    const loop = makeLoop();
    loop.ingestTurn({ speaker: "s1", text: "vending machines accept crypto payments", atMs: 1_000 });
    loop.ingestTurn({ speaker: "s2", text: "kabul weather looks snowy tonight", atMs: 2_000 });
    loop.ingestTurn({ speaker: "s1", text: "crypto payments make vending machines cheaper", atMs: 20_000 });
    const topics = loop.topics();
    expect(topics).toHaveLength(2);
    expect(topics[0]!.turnIds).toEqual(["rturn-0001", "rturn-0003"]);
    expect(topics[1]!.turnIds).toEqual(["rturn-0002"]);
    expect(topics[0]!.freshAtMs).toBe(20_000);
  });

  test("coalescing growth re-scores the merged turn's topic", () => {
    const loop = makeLoop();
    loop.ingestTurn({ speaker: "s1", text: "solar panels power the roof", atMs: 1_000 });
    loop.ingestTurn({ speaker: "s2", text: "cats", atMs: 2_000 });
    expect(loop.topics()).toHaveLength(2);
    // The cats turn grows into solar-panel territory → it moves branches.
    loop.ingestTurn({ speaker: "s2", text: "sleep on warm solar panels", atMs: 3_000 });
    const topics = loop.topics();
    expect(topics).toHaveLength(1);
    expect(topics[0]!.turnIds).toEqual(["rturn-0001", "rturn-0002"]);
  });

  test("topics never outlive the rolling window", () => {
    const loop = makeLoop({ windowTurns: 2 });
    loop.ingestTurn({ speaker: "s1", text: "alpha rocket engines", atMs: 0 });
    loop.ingestTurn({ speaker: "s1", text: "pasta cooking tips", atMs: 10_000 });
    loop.ingestTurn({ speaker: "s1", text: "gardening in winter", atMs: 20_000 });
    const topics = loop.topics();
    const surfaced = topics.flatMap((topic) => topic.turnIds);
    expect(surfaced.sort()).toEqual(["rturn-0002", "rturn-0003"]);
  });
});

describe("ResearchLoop full reset (the wall's 🌱 button)", () => {
  test("resetAll aborts in-flight agents and clears quests, turns, and topics", async () => {
    const agent = new HangingAgent();
    const loop = makeLoop({ agent });
    loop.setActive(true);
    loop.ingestTurn({ speaker: "s1", text: "how much money would vending machines save by using crypto", atMs: 1 });
    const turnId = loop.turns()[0]!.id;
    const spawned = loop.researchTurn(turnId)!;
    expect(spawned.status).toBe("researching");
    loop.resetAll();
    expect(agent.aborted).toBe(true);
    expect(loop.quests()).toEqual([]);
    expect(loop.turns()).toEqual([]);
    expect(loop.topics()).toEqual([]);
    // A fresh conversation grows from turn ids that keep incrementing — the
    // reset never recycles ids old quests might still reference in traces.
    const fresh = loop.ingestTurn({ speaker: "s1", text: "a brand new conversation", atMs: 60_000 });
    expect(fresh.id).not.toBe(turnId);
    expect(loop.turns().length).toBe(1);
  });
});

describe("topic-context grounding", () => {
  test("a direct turn click carries the whole concept branch as context", () => {
    const loop = makeLoop();
    loop.setActive(true);
    // Distinct speakers defeat coalescing; shared vocabulary clusters them.
    loop.ingestTurn({ speaker: "s1", text: "vending machines could take crypto payments", atMs: 1 });
    loop.ingestTurn({ speaker: "s2", text: "crypto payments would cut vending machine fees", atMs: 60_000 });
    const turnId = loop.turns()[1]!.id;
    const spawned = loop.researchTurn(turnId)!;
    expect(spawned.contextTurns!.length).toBeGreaterThanOrEqual(1);
    expect(spawned.contextTurns!.some((turn) => turn.text.includes("cut vending machine fees"))).toBe(true);
    // When both turns clustered into one topic, the sibling rides along too.
    if (loop.topics().length === 1) {
      expect(spawned.contextTurns!.length).toBe(2);
      expect(spawned.topicLabel).toBe(loop.topics()[0]!.label);
    }
  });
});

describe("dossier follow-ups", () => {
  test("researchFollowUp spawns a child quest inheriting the parent's grounding", async () => {
    const followUpReport: ResearchReport = { ...stubReport, followUps: ["How do fees compare across payment rails?"] };
    class FollowUpAgent implements ResearchAgent {
      async research(): Promise<ResearchReport> {
        return followUpReport;
      }
    }
    const loop = makeLoop({ agent: new FollowUpAgent() });
    loop.setActive(true);
    loop.ingestTurn({ speaker: "s1", text: "how much money would vending machines save by using crypto", atMs: 1 });
    const parent = loop.researchTurn(loop.turns()[0]!.id)!;
    await Bun.sleep(0);
    expect(loop.quest(parent.id)!.status).toBe("complete");
    const child = loop.researchFollowUp(parent.id, 0)!;
    expect(child.status).toBe("researching");
    expect(child.claim).toBe("How do fees compare across payment rails?");
    // Child anchors to the parent's turn → its crystal buds beside the parent.
    expect(child.contextSpan.endTurnId).toBe(parent.contextSpan.endTurnId);
    // Unknown index / parent are 404-free no-ops.
    expect(loop.researchFollowUp(parent.id, 9)).toBeNull();
    expect(loop.researchFollowUp("rq-nope", 0)).toBeNull();
  });
});
