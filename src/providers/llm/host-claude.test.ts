import { describe, expect, test } from "bun:test";
import { HostClaudeDecisionLLM, type ClaudeCliRunner } from "./host-claude";
import type { DecisionInput } from "../types";

function input(transcript: string, correlationId = "corr-1"): DecisionInput {
  return { model: "test-model", correlationId, temperature: 0, messages: [{ role: "user", content: transcript }] };
}

// A runner that records calls and replies with a fixed string.
function stubRunner(reply: string): ClaudeCliRunner & { calls: number } {
  const fn = (async (_prompt: string, _opts: { model: string; timeoutMs: number }) => {
    fn.calls += 1;
    return reply;
  }) as ClaudeCliRunner & { calls: number };
  fn.calls = 0;
  return fn;
}

describe("HostClaudeDecisionLLM", () => {
  test("acts on a buildable verdict, carrying the model's pitch + questions", async () => {
    const runner = stubRunner('{"act":true,"quality":0.84,"pitch":"Wrap the open-source repos in one dashboard","questions":["Scope as one task?"]}');
    const llm = new HostClaudeDecisionLLM({ runner, minIntervalMs: 0 });
    const out = await llm.decide(input("we could wrap those open source ones into one thing"));
    expect(out.decision.kind).toBe("action");
    if (out.decision.kind === "action") {
      expect(out.decision.meta.pitch).toBe("Wrap the open-source repos in one dashboard");
      expect(out.decision.meta.quality).toBe(0.84);
      expect(out.decision.action.payload).toMatchObject({ mcqs: ["Scope as one task?"] });
    }
    expect(runner.calls).toBe(1);
  });

  test("passes when the model declines (genuine inference, not keyword match)", async () => {
    const runner = stubRunner('{"act":false,"quality":0.1,"pitch":"","questions":[]}');
    const llm = new HostClaudeDecisionLLM({ runner, minIntervalMs: 0 });
    // contains the word "build" but the model judged it ambient — should PASS
    const out = await llm.decide(input("the kids build sandcastles at the beach every summer"));
    expect(out.decision.kind).toBe("pass");
  });

  test("passes on an unparseable reply (never throws / wedges)", async () => {
    const llm = new HostClaudeDecisionLLM({ runner: stubRunner("sorry, I can't do that"), minIntervalMs: 0 });
    expect((await llm.decide(input("let's build a tool"))).decision.kind).toBe("pass");
  });

  test("passes when the runner throws", async () => {
    const llm = new HostClaudeDecisionLLM({
      runner: async (_prompt: string, _opts: { model: string; timeoutMs: number }) => {
        throw new Error("claude unavailable");
      },
      minIntervalMs: 0,
    });
    expect((await llm.decide(input("let's build a tool"))).decision.kind).toBe("pass");
  });

  test("throttles: a call within the interval passes without invoking the runner", async () => {
    let clock = 1_000;
    const runner = stubRunner('{"act":true,"quality":0.9,"pitch":"Build the thing","questions":[]}');
    const llm = new HostClaudeDecisionLLM({ runner, minIntervalMs: 5_000, now: () => clock });

    const first = await llm.decide(input("let's build the thing", "c1"));
    expect(first.decision.kind).toBe("action");
    expect(runner.calls).toBe(1);

    clock += 1_000; // within the 5s interval
    const second = await llm.decide(input("and another idea here", "c2"));
    expect(second.decision.kind).toBe("pass");
    expect(runner.calls).toBe(1); // runner NOT called again

    clock += 6_000; // past the interval
    const third = await llm.decide(input("now build the dashboard", "c3"));
    expect(third.decision.kind).toBe("action");
    expect(runner.calls).toBe(2);
  });

  test("accumulates fragmented finals into a rolling window so the whole idea is judged", async () => {
    // Capture the prompt the runner receives on each (non-throttled) call.
    const prompts: string[] = [];
    const runner = (async (prompt: string) => {
      prompts.push(prompt);
      // Only ACT once the window has accumulated the full idea.
      return /snow.*water|water.*snow/i.test(prompt)
        ? '{"act":true,"quality":0.85,"pitch":"Build a snow-to-water calculator","questions":[]}'
        : '{"act":false,"quality":0.1,"pitch":"","questions":[]}';
    }) as ClaudeCliRunner;
    const llm = new HostClaudeDecisionLLM({ runner, minIntervalMs: 0 });

    const r1 = await llm.decide(input("i would really like us to make an app", "c1"));
    expect(r1.decision.kind).toBe("pass"); // fragment alone isn't a complete idea

    const r2 = await llm.decide(input("that tells me how much snow i need for drinking water", "c2"));
    expect(r2.decision.kind).toBe("action"); // the WINDOW now contains the whole idea
    // the second prompt carried the earlier fragment too
    expect(prompts[1]).toContain("make an app");
    expect(prompts[1]).toContain("snow");
  });

  test("empty transcript passes without invoking the runner", async () => {
    const runner = stubRunner('{"act":true,"quality":0.9,"pitch":"x","questions":[]}');
    const llm = new HostClaudeDecisionLLM({ runner, minIntervalMs: 0 });
    expect((await llm.decide(input("   "))).decision.kind).toBe("pass");
    expect(runner.calls).toBe(0);
  });
});
