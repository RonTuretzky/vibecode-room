import { describe, expect, test } from "bun:test";
import { WindowedDecisionLLM } from "./windowed";
import type { DecisionInput, DecisionLLM, DecisionOutput } from "../types";

function input(transcript: string, correlationId = "c"): DecisionInput {
  return { model: "m", correlationId, temperature: 0, messages: [{ role: "user", content: transcript }] };
}

// An inner decider that records the (windowed) transcript it was handed and
// returns action/pass based on a predicate over that text.
function inner(opts: { act: (text: string) => boolean; seen?: string[] }): DecisionLLM {
  return {
    async decide(inp: DecisionInput): Promise<DecisionOutput> {
      const text = inp.messages.filter((m) => m.role === "user").map((m) => m.content).join(" ");
      opts.seen?.push(text);
      const decision = opts.act(text)
        ? ({ kind: "action", action: { type: "spawn", targetUPID: null, correlationId: inp.correlationId, payload: {} }, policy: "p", decisionId: "d", correlationId: inp.correlationId, meta: {} } as const)
        : ({ kind: "pass", addressed: false, reason: "ambient", policy: "p", decisionId: "d", correlationId: inp.correlationId, meta: {} } as const);
      return { id: "x", model: inp.model, temperature: 0, decision };
    },
  };
}

describe("WindowedDecisionLLM", () => {
  test("accumulates fragments and hands the inner decider the whole window", async () => {
    const seen: string[] = [];
    const w = new WindowedDecisionLLM(inner({ act: (t) => /snow.*water/i.test(t), seen }), { minIntervalMs: 0 });

    expect((await w.decide(input("i want to make an app", "c1"))).decision.kind).toBe("pass");
    expect((await w.decide(input("that maps snow to drinking water", "c2"))).decision.kind).toBe("action");
    // the second call's text carried the first fragment too
    expect(seen[1]).toContain("make an app");
    expect(seen[1]).toContain("snow");
  });

  test("resets the window after an action so the same idea doesn't re-fire", async () => {
    const seen: string[] = [];
    const w = new WindowedDecisionLLM(inner({ act: (t) => t.includes("build"), seen }), { minIntervalMs: 0 });
    await w.decide(input("let's build it", "c1")); // action → clears window
    await w.decide(input("ok cool", "c2"));
    expect(seen[1]).toBe("ok cool"); // earlier "build" fragment was cleared
  });

  test("throttles inner calls within the interval", async () => {
    let clock = 0;
    const seen: string[] = [];
    const w = new WindowedDecisionLLM(inner({ act: () => false, seen }), { minIntervalMs: 1000, now: () => clock });
    await w.decide(input("one", "c1"));
    expect(seen).toHaveLength(1);
    clock += 200;
    const throttled = await w.decide(input("two", "c2"));
    expect(throttled.decision.kind).toBe("pass");
    expect(seen).toHaveLength(1); // inner NOT called again
    clock += 1000;
    await w.decide(input("three", "c3"));
    expect(seen).toHaveLength(2);
  });

  test("empty transcript passes without calling inner", async () => {
    const seen: string[] = [];
    const w = new WindowedDecisionLLM(inner({ act: () => true, seen }), { minIntervalMs: 0 });
    expect((await w.decide(input("   "))).decision.kind).toBe("pass");
    expect(seen).toHaveLength(0);
  });
});
