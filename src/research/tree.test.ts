import { describe, expect, test } from "bun:test";
import type { TranscriptTurn } from "../detect/types";
import { ConceptTree, contentTokens, contentWorthiness, stemToken, type TopicModelRunner, type TopicRefineRequest } from "./tree";

function turn(id: string, text: string, atMs: number): TranscriptTurn {
  return { id, speaker: "s1", text, atMs };
}

// Heuristic-only tree: no debounce timers, no model calls.
function heuristicTree(): ConceptTree {
  return new ConceptTree({ model: null });
}

// A tree with an injected model; the debounce is pushed out of reach so tests
// drive refinement explicitly via refineNow().
function modelTree(model: TopicModelRunner, onRefined?: () => void): ConceptTree {
  return new ConceptTree({ model, onRefined, debounceMs: 3_600_000 });
}

describe("ConceptTree heuristic clustering", () => {
  test("overlapping vocabulary joins a topic; disjoint vocabulary branches", () => {
    const tree = heuristicTree();
    tree.assign(turn("t1", "vending machines accept crypto payments", 1_000));
    tree.assign(turn("t2", "crypto payments make vending machines cheaper", 2_000));
    tree.assign(turn("t3", "the weather in kabul is snowy today", 3_000));
    const topics = tree.topics();
    expect(topics).toHaveLength(2);
    expect(topics[0]!.turnIds).toEqual(["t1", "t2"]);
    expect(topics[1]!.turnIds).toEqual(["t3"]);
  });

  test("a new topic gets a provisional label from its founding content words", () => {
    const tree = heuristicTree();
    tree.assign(turn("t1", "we should try vending machines that accept crypto payments", 1_000));
    expect(tree.topics()[0]!.label).toBe("Try vending machines accept");
  });

  test("topics are oldest-first and freshAtMs tracks the newest member", () => {
    const tree = heuristicTree();
    tree.assign(turn("t1", "solar panels on the roof", 1_000));
    tree.assign(turn("t2", "pasta cooking with garlic", 2_000));
    tree.assign(turn("t3", "cheaper solar panels arrived", 3_000));
    const topics = tree.topics();
    expect(topics.map((topic) => topic.turnIds)).toEqual([["t1", "t3"], ["t2"]]);
    expect(topics[0]!.freshAtMs).toBe(3_000);
    expect(topics[1]!.freshAtMs).toBe(2_000);
  });

  test("a turn with no content words goes to the DUST POOL, never a branch", () => {
    const tree = heuristicTree();
    tree.assign(turn("t1", "solar panels on the roof", 1_000));
    expect(tree.assign(turn("t2", "yeah okay right", 2_000))).toBeNull();
    const topics = tree.topics();
    expect(topics).toHaveLength(1);
    expect(topics[0]!.turnIds).toEqual(["t1"]);
    expect(tree.topicOf("t2")).toBeNull();
    expect(tree.dustTurnIds()).toEqual(["t2"]);
  });

  test("update() re-scores a grown turn and promotes dust onto a real branch", () => {
    const tree = heuristicTree();
    tree.assign(turn("t1", "solar panels power the roof", 1_000));
    tree.assign(turn("t2", "cats", 2_000));
    // "cats" alone is babble — dust, not a branch.
    expect(tree.topics()).toHaveLength(1);
    expect(tree.dustTurnIds()).toEqual(["t2"]);
    // Coalescing grew the turn into a real sentence in solar-panel territory.
    tree.update(turn("t2", "cats sleep on warm solar panels", 2_000));
    const topics = tree.topics();
    expect(topics).toHaveLength(1);
    expect(topics[0]!.turnIds).toEqual(["t1", "t2"]);
    expect(tree.topicOf("t2")).toBe(topics[0]!.id);
    expect(tree.dustTurnIds()).toEqual([]);
  });

  test("update() keeps a turn in place when nothing clears the bar (no id churn)", () => {
    const tree = heuristicTree();
    tree.assign(turn("t1", "solar panels power the roof", 1_000));
    const before = tree.topics()[0]!.id;
    tree.update(turn("t1", "solar panels power the roof and garden shed", 1_000));
    expect(tree.topics()[0]!.id).toBe(before);
    expect(tree.topics()).toHaveLength(1);
  });

  test("prune() drops dead turns and any topic left empty", () => {
    const tree = heuristicTree();
    tree.assign(turn("t1", "alpha rocket engines", 1_000));
    tree.assign(turn("t2", "pasta cooking tips", 2_000));
    tree.prune(["t2"]);
    const topics = tree.topics();
    expect(topics).toHaveLength(1);
    expect(topics[0]!.turnIds).toEqual(["t2"]);
    expect(tree.topicOf("t1")).toBeNull();
  });
});

describe("ConceptTree model refinement", () => {
  // Seed: t1+t2 clustered together, t3 apart.
  function seeded(model: TopicModelRunner, onRefined?: () => void): { tree: ConceptTree; aId: string; bId: string } {
    const tree = modelTree(model, onRefined);
    tree.assign(turn("t1", "alpha rocket engines ignite", 1_000));
    tree.assign(turn("t2", "rocket engines burn alpha fuel", 2_000));
    tree.assign(turn("t3", "pasta cooking with garlic", 3_000));
    const [a, b] = tree.topics();
    return { tree, aId: a!.id, bId: b!.id };
  }

  test("valid output re-clusters, relabels, and keeps stable ids by majority overlap", async () => {
    let refined = 0;
    let request: TopicRefineRequest | null = null;
    const model: TopicModelRunner = async (input) => {
      request = input;
      return JSON.stringify({
        topics: [
          { id: null, label: "rocket propulsion systems overview extra", turnIds: ["t1", "t2"] },
          { id: null, label: "pasta cooking", turnIds: ["t3"] },
        ],
      });
    };
    const { tree, aId, bId } = seeded(model, () => (refined += 1));
    await tree.refineNow();
    expect(refined).toBe(1);
    // The model saw the current clusters + recent turns.
    expect(request!.topics.map((topic) => topic.id)).toEqual([aId, bId]);
    expect(request!.recentTurns.map((entry) => entry.id)).toEqual(["t1", "t2", "t3"]);
    const topics = tree.topics();
    // Majority member overlap keeps both existing ids alive across the regroup.
    expect(topics.map((topic) => topic.id)).toEqual([aId, bId]);
    // Labels apply, clamped to 4 words and capitalized.
    expect(topics[0]!.label).toBe("Rocket propulsion systems overview");
    expect(topics[1]!.label).toBe("Pasta cooking");
  });

  test("a genuine split keeps the majority id and mints a fresh one", async () => {
    const model: TopicModelRunner = async () =>
      JSON.stringify({
        topics: [
          { id: null, label: "rocket engines", turnIds: ["t1", "t2"] },
          { id: null, label: "italian dinner", turnIds: ["t3"] },
        ],
      });
    // Force everything into ONE heuristic topic first, then let the model split.
    const tree = modelTree(model);
    tree.assign(turn("t1", "alpha rocket engines ignite", 1_000));
    tree.assign(turn("t2", "rocket engines burn alpha fuel", 2_000));
    tree.assign(turn("t3", "rocket pasta", 3_000)); // "rocket" drags it in
    expect(tree.topics()).toHaveLength(1);
    const originalId = tree.topics()[0]!.id;
    await tree.refineNow();
    const topics = tree.topics();
    expect(topics).toHaveLength(2);
    expect(topics[0]!.id).toBe(originalId); // 2 of 3 members → majority keeps it
    expect(topics[1]!.id).not.toBe(originalId);
  });

  test("fenced/chatty JSON is tolerated", async () => {
    const model: TopicModelRunner = async () =>
      'Sure! Here you go:\n```json\n{"topics":[{"id":null,"label":"space hardware","turnIds":["t1","t2","t3"]}]}\n```';
    const { tree } = seeded(model);
    await tree.refineNow();
    expect(tree.topics()).toHaveLength(1);
    expect(tree.topics()[0]!.label).toBe("Space hardware");
  });

  test.each([
    ["duplicate turn id", { topics: [{ id: null, label: "x", turnIds: ["t1", "t1"] }, { id: null, label: "y", turnIds: ["t2", "t3"] }] }],
    ["missing turn id", { topics: [{ id: null, label: "x", turnIds: ["t1", "t2"] }] }],
    ["unknown turn id", { topics: [{ id: null, label: "x", turnIds: ["t1", "t2", "t3", "t9"] }] }],
    ["not clustering-shaped", { answer: 42 }],
  ])("malformed output is dropped wholesale: %s", async (_name, payload) => {
    let refined = 0;
    const model: TopicModelRunner = async () => JSON.stringify(payload);
    const { tree } = seeded(model, () => (refined += 1));
    const before = tree.topics();
    await tree.refineNow();
    expect(refined).toBe(0);
    expect(tree.topics()).toEqual(before); // the heuristic clustering stands
  });

  test("model miss (null / throw / hang) leaves the heuristic clustering standing", async () => {
    const nullModel: TopicModelRunner = async () => null;
    const throwing: TopicModelRunner = async () => {
      throw new Error("boom");
    };
    for (const model of [nullModel, throwing]) {
      const { tree } = seeded(model);
      const before = tree.topics();
      await tree.refineNow(); // must not throw
      expect(tree.topics()).toEqual(before);
    }
    // A model that ignores its signal still loses to the timeout budget.
    const hanging: TopicModelRunner = () => new Promise(() => undefined);
    const tree = new ConceptTree({ model: hanging, debounceMs: 3_600_000, timeoutMs: 5 });
    tree.assign(turn("t1", "alpha rocket engines ignite", 1_000));
    const before = tree.topics();
    await tree.refineNow();
    expect(tree.topics()).toEqual(before);
    tree.dispose();
  });

  test("refinement debounces after changes and fires exactly once", async () => {
    let calls = 0;
    const model: TopicModelRunner = async () => {
      calls += 1;
      return null;
    };
    const tree = new ConceptTree({ model, debounceMs: 10 });
    tree.assign(turn("t1", "alpha rocket engines ignite", 1_000));
    tree.assign(turn("t2", "rocket engines burn fuel", 2_000));
    tree.assign(turn("t3", "pasta cooking with garlic", 3_000));
    expect(calls).toBe(0); // still inside the quiet period
    await Bun.sleep(40);
    expect(calls).toBe(1); // three changes → ONE debounced call
    tree.dispose();
  });

  test("refinement never overlaps: a second request while in flight coalesces", async () => {
    let calls = 0;
    let release: (() => void) | null = null;
    const model: TopicModelRunner = async () => {
      calls += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return null;
    };
    const { tree } = seeded(model);
    const first = tree.refineNow();
    const second = tree.refineNow(); // in flight → marks pending, no new call
    expect(calls).toBe(1);
    release!();
    await first;
    await second;
    await tree.settle();
    expect(calls).toBe(1);
    tree.dispose();
  });

  test("turns that arrive while the model thinks are re-placed onto the refined clusters", async () => {
    let release: ((value: string) => void) | null = null;
    const model: TopicModelRunner = () =>
      new Promise<string>((resolve) => {
        release = resolve;
      });
    const { tree, aId } = seeded(model);
    const run = tree.refineNow();
    // Mid-flight arrival: not in the model's snapshot.
    tree.assign(turn("t4", "rocket engines need more fuel", 4_000));
    release!(
      JSON.stringify({
        topics: [
          { id: aId, label: "rocket engines", turnIds: ["t1", "t2"] },
          { id: null, label: "pasta", turnIds: ["t3"] },
        ],
      }),
    );
    await run;
    // t4 overlaps the rocket cluster → hangs off the refined branch.
    expect(tree.topicOf("t4")).toBe(aId);
    tree.dispose();
  });
});

describe("contentTokens", () => {
  test("lowercases, strips punctuation, folds contractions into stopwords", () => {
    expect(contentTokens("Don't the Vending-Machines accept CRYPTO, right?")).toEqual([
      "vending",
      "machines",
      "accept",
      "crypto",
    ]);
  });
});

// ── the babble gate + join repairs (live-room evidence, 2026-08) ─────────────

describe("contentWorthiness (the babble gate)", () => {
  test("table-driven from the real room inventory: dust vs content", () => {
    const dust = [
      "yep",
      "we",
      "teddy",
      "bears",
      "sorry",
      "oh my god",
      "thats fine",
      "not funny but funny",
      "enough enough enough",
      "yeah okay right",
    ];
    const content = [
      "check out the repo on github dot com under khalil d h",
      "we started getting smart boards when i was in middle school",
      "five hundred k a year in event space they were telling us",
      "the overlay is now in and rendering in the off air preview",
    ];
    for (const text of dust) {
      expect(contentWorthiness(text)).toBe("dust");
    }
    for (const text of content) {
      expect(contentWorthiness(text)).toBe("content");
    }
  });

  test("the measured split on the 218-line wall recording holds (115 dust)", async () => {
    const lines = (await import("../../fixtures/research/wall-recording-2026-08-10.json"))
      .default as Array<{ speaker: string; text: string }>;
    expect(lines).toHaveLength(218);
    const dust = lines.filter((line) => contentWorthiness(line.text) === "dust");
    expect(dust).toHaveLength(115);
  });
});

describe("stemmed topic joins (caseless ASR carries no other signal)", () => {
  test("stemToken folds inflections review/reviewed, pack/packs, figure/figured", () => {
    expect(stemToken("reviewed")).toBe(stemToken("review"));
    expect(stemToken("packs")).toBe(stemToken("pack"));
    expect(stemToken("figured")).toBe(stemToken("figure"));
    expect(stemToken("checking")).toBe(stemToken("checks"));
  });

  test("'reviewed the packs' joins a review/pack topic post-stemming", () => {
    const tree = heuristicTree();
    tree.assign(turn("t1", "review the multiplayer packs before tonight", 1_000));
    tree.assign(turn("t2", "reviewed the packs already", 2_000));
    const topics = tree.topics();
    expect(topics).toHaveLength(1);
    expect(topics[0]!.turnIds).toEqual(["t1", "t2"]);
  });

  test("a later related sentence sharing 1 of its 3 tokens joins (0.333 ≥ 0.30)", () => {
    const tree = heuristicTree();
    tree.assign(turn("t1", "today i see telegram and shanti has a full setup", 1_000));
    // distinct tokens: telegram, instruction, manual — 1 shared / 3 = 0.333,
    // which the old 0.34 bar missed by 0.007 (the operator's exact wound).
    tree.assign(turn("t2", "the telegram instruction manual", 2_000));
    const topics = tree.topics();
    expect(topics).toHaveLength(1);
    expect(topics[0]!.turnIds).toEqual(["t1", "t2"]);
  });
});

describe("ConceptTree refiner loudness", () => {
  test("a throwing model builds a miss streak with its reason; a reply resets it", async () => {
    let mode: "throw" | "ok" = "throw";
    const tree = modelTree(async () => {
      if (mode === "throw") {
        throw new Error("cerebras 402: payment_required");
      }
      return JSON.stringify({ topics: [{ id: "topic-0001", label: "Solar roof", turnIds: ["t1"] }] });
    });
    tree.assign(turn("t1", "solar panels power the roof", 1_000));
    await tree.refineNow();
    await tree.refineNow();
    await tree.refineNow();
    expect(tree.agentHealth()).toEqual({ missStreak: 3, lastMissReason: "cerebras 402: payment_required" });
    mode = "ok";
    await tree.refineNow();
    expect(tree.agentHealth()).toEqual({ missStreak: 0, lastMissReason: null });
  });

  test("a miss re-debounces a bounded retry — capped so a dead account never churns forever", async () => {
    const tree = new ConceptTree({
      debounceMs: 1,
      model: async () => {
        throw new Error("cerebras 402: payment_required");
      },
    });
    tree.assign(turn("t1", "solar panels power the roof", 1_000));
    await tree.refineNow();
    expect(tree.agentHealth().missStreak).toBeGreaterThanOrEqual(1);
    // Retries self-schedule (1ms debounce here) with NO new material…
    await new Promise((resolve) => setTimeout(resolve, 80));
    await tree.settle();
    // …and stop at the cap: loud enough for the health leg (≥3), no infinite churn.
    expect(tree.agentHealth().missStreak).toBe(6);
    expect(tree.agentHealth().lastMissReason).toBe("cerebras 402: payment_required");
    tree.dispose();
  });

  test("a stand-in wrapped reply (host-claude rescue) applies clustering and resets the streak", async () => {
    // The production model seam (standin.ts composeAgentRunner) wraps replies
    // with transport provenance when the host CLI rescues a failing Cerebras
    // account — the tree must unwrap and apply it like any landed refinement.
    let mode: "throw" | "wrapped" = "throw";
    const tree = modelTree(async () => {
      if (mode === "throw") {
        throw new Error("cerebras 402: payment_required");
      }
      return {
        kind: "agent-reply",
        agent: "host-claude",
        standinFor: "cerebras 402: payment_required",
        reply: JSON.stringify({ topics: [{ id: null, label: "solar roof power", turnIds: ["t1"] }] }),
      };
    });
    tree.assign(turn("t1", "solar panels power the roof", 1_000));
    await tree.refineNow();
    expect(tree.agentHealth().missStreak).toBe(1);
    mode = "wrapped";
    await tree.refineNow();
    expect(tree.agentHealth()).toEqual({ missStreak: 0, lastMissReason: null });
    expect(tree.topics()[0]!.label).toBe("Solar roof power");
  });
});
