import { describe, expect, test } from "bun:test";
import { CueCerebrasDecisionLLM, type IdeaProposer } from "./cue-cerebras";
import type { DecisionInput } from "../types";

function input(transcript: string, correlationId = "c"): DecisionInput {
  return { model: "m", correlationId, temperature: 0, messages: [{ role: "user", content: transcript }] };
}

describe("CueCerebrasDecisionLLM (decision mapping)", () => {
  test("emits a spawn action carrying the proposer's pitch + questions", async () => {
    const proposer: IdeaProposer = async () => ({
      act: true,
      quality: 0.82,
      pitch: "Build a snow-to-water calculator",
      questions: ["Scope as one task?"],
    });
    const out = await new CueCerebrasDecisionLLM({ proposer }).decide(input("we could map snow to drinking water"));
    expect(out.decision.kind).toBe("action");
    if (out.decision.kind === "action") {
      expect(out.decision.meta.pitch).toBe("Build a snow-to-water calculator");
      expect(out.decision.meta.quality).toBe(0.82);
      expect(out.decision.action.payload).toMatchObject({ mcqs: ["Scope as one task?"] });
    }
  });

  test("passes when the proposer declines", async () => {
    const proposer: IdeaProposer = async () => ({ act: false, quality: 0.1, pitch: "", questions: [] });
    expect((await new CueCerebrasDecisionLLM({ proposer }).decide(input("nice weather today"))).decision.kind).toBe("pass");
  });

  test("passes when the proposer returns null (Cue unavailable)", async () => {
    expect((await new CueCerebrasDecisionLLM({ proposer: async () => null }).decide(input("build a thing"))).decision.kind).toBe("pass");
  });

  test("passes (never throws) when the proposer throws", async () => {
    const proposer: IdeaProposer = async () => {
      throw new Error("cerebras down");
    };
    expect((await new CueCerebrasDecisionLLM({ proposer }).decide(input("build a thing"))).decision.kind).toBe("pass");
  });

  test("an act with an empty pitch is treated as a pass", async () => {
    const proposer: IdeaProposer = async () => ({ act: true, quality: 0.9, pitch: "   ", questions: [] });
    expect((await new CueCerebrasDecisionLLM({ proposer }).decide(input("hmm"))).decision.kind).toBe("pass");
  });

  test("empty transcript passes without consulting the proposer", async () => {
    let called = false;
    const proposer: IdeaProposer = async () => {
      called = true;
      return { act: true, quality: 1, pitch: "x", questions: [] };
    };
    expect((await new CueCerebrasDecisionLLM({ proposer }).decide(input("  "))).decision.kind).toBe("pass");
    expect(called).toBe(false);
  });
});
