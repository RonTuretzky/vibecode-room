import { describe, expect, test } from "bun:test";
import type { TranscriptTurn } from "../detect/types";
import { ConceptTree, contentTokens, type TopicModelRunner, type TopicRefineRequest } from "./tree";

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

  test("a turn with no content words follows the freshest topic instead of founding a branch", () => {
    const tree = heuristicTree();
    tree.assign(turn("t1", "solar panels on the roof", 1_000));
    tree.assign(turn("t2", "yeah okay right", 2_000));
    const topics = tree.topics();
    expect(topics).toHaveLength(1);
    expect(topics[0]!.turnIds).toEqual(["t1", "t2"]);
  });

  test("update() re-scores a grown turn and can move it between branches", () => {
    const tree = heuristicTree();
    tree.assign(turn("t1", "solar panels power the roof", 1_000));
    tree.assign(turn("t2", "cats", 2_000));
    expect(tree.topics()).toHaveLength(2);
    // Coalescing grew the turn into solar-panel territory.
    tree.update(turn("t2", "cats sleep on warm solar panels", 2_000));
    const topics = tree.topics();
    expect(topics).toHaveLength(1);
    expect(topics[0]!.turnIds).toEqual(["t1", "t2"]);
    expect(tree.topicOf("t2")).toBe(topics[0]!.id);
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
