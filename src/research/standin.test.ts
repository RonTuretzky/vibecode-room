import { describe, expect, test } from "bun:test";
import {
  CEREBRAS_AGENT,
  HOST_CLAUDE_AGENT,
  STANDIN_MODEL,
  STANDIN_TIMEOUT_MS,
  composeAgentRunner,
  isAgentReply,
  parseCliEnvelope,
  readResearchAgentMode,
  unwrapAgentReply,
} from "./standin";

// The research agents' stand-in seam: Cerebras primary, host-claude CLI rescue
// on failure, deliberate no-agent when no key. Every path here is the ROUND 2
// root-cause fix for "the reorganizer never works" (live account 402s with a
// valid key) — so the mode rules, provenance wrapper, and loud double-failure
// are each pinned. All seams injected; no env, PATH, or CLI is ever touched.

const KEYED = () => ({ CEREBRAS_API_KEY: "csk-test" });
const KEYLESS = () => ({});
const signal = () => new AbortController().signal;

function runnerWith(overrides: Partial<Parameters<typeof composeAgentRunner<string>>[0]>) {
  return composeAgentRunner<string>({
    primary: async () => '{"ok":true}',
    promptFor: (request) => `PROMPT:${request}`,
    env: KEYED,
    cliAvailable: () => true,
    standIn: async () => '{"standin":true}',
    ...overrides,
  });
}

describe("readResearchAgentMode", () => {
  test("defaults to auto; explicit values pass; unknown throws (registry idiom)", () => {
    expect(readResearchAgentMode({})).toBe("auto");
    expect(readResearchAgentMode({ VIBERSYN_RESEARCH_LLM: "" })).toBe("auto");
    expect(readResearchAgentMode({ VIBERSYN_RESEARCH_LLM: "AUTO" })).toBe("auto");
    expect(readResearchAgentMode({ VIBERSYN_RESEARCH_LLM: "cerebras" })).toBe("cerebras");
    expect(readResearchAgentMode({ VIBERSYN_RESEARCH_LLM: " claude-cli " })).toBe("claude-cli");
    expect(() => readResearchAgentMode({ VIBERSYN_RESEARCH_LLM: "gpt" })).toThrow(/Unknown VIBERSYN_RESEARCH_LLM/u);
  });
});

describe("composeAgentRunner — auto mode", () => {
  test("primary success wraps with cerebras provenance and no stand-in reason", async () => {
    const run = runnerWith({});
    const value = await run("req", signal());
    expect(value).toEqual({ kind: "agent-reply", agent: CEREBRAS_AGENT, standinFor: null, reply: '{"ok":true}' });
  });

  test("no key is a clean no-agent no-op — even with the CLI on hand", async () => {
    // Tests, CI, and cred-blanked rig rooms must stay honestly lexical-only,
    // never spawn a surprise CLI process (rig scenario A depends on this).
    let cliCalls = 0;
    const run = runnerWith({
      env: KEYLESS,
      standIn: async () => {
        cliCalls += 1;
        return "never";
      },
    });
    expect(await run("req", signal())).toBeNull();
    expect(cliCalls).toBe(0);
  });

  test("a failing primary is rescued by the stand-in, carrying the failure reason", async () => {
    const prompts: string[] = [];
    const run = runnerWith({
      primary: async () => {
        throw new Error("cerebras 402: payment_required");
      },
      standIn: async (prompt, opts) => {
        prompts.push(prompt);
        expect(opts.model).toBe(STANDIN_MODEL);
        expect(opts.timeoutMs).toBe(STANDIN_TIMEOUT_MS);
        return '{"links":[]}';
      },
    });
    const value = await run("req", signal());
    expect(value).toEqual({
      kind: "agent-reply",
      agent: HOST_CLAUDE_AGENT,
      standinFor: "cerebras 402: payment_required",
      reply: '{"links":[]}',
    });
    expect(prompts).toEqual(["PROMPT:req"]);
  });

  test("a failing primary with no CLI on PATH rethrows the original reason", async () => {
    const run = runnerWith({
      primary: async () => {
        throw new Error("cerebras 402: payment_required");
      },
      cliAvailable: () => false,
    });
    await expect(run("req", signal())).rejects.toThrow("cerebras 402: payment_required");
  });

  test("both legs failing throws BOTH reasons — the miss trace names the whole story", async () => {
    const run = runnerWith({
      primary: async () => {
        throw new Error("cerebras 402: payment_required");
      },
      standIn: async () => {
        throw new Error("exit 1: not logged in");
      },
    });
    await expect(run("req", signal())).rejects.toThrow(
      "cerebras 402: payment_required; host-claude: exit 1: not logged in",
    );
  });

  test("an already-aborted budget never spawns the stand-in", async () => {
    const controller = new AbortController();
    let cliCalls = 0;
    const run = runnerWith({
      primary: async () => {
        controller.abort();
        throw new Error("cerebras aborted");
      },
      standIn: async () => {
        cliCalls += 1;
        return "never";
      },
    });
    await expect(run("req", controller.signal)).rejects.toThrow("cerebras aborted");
    expect(cliCalls).toBe(0);
  });
});

describe("composeAgentRunner — pinned modes", () => {
  test("cerebras pin never stands in (the old loud-miss behavior, byte for byte)", async () => {
    let cliCalls = 0;
    const run = runnerWith({
      env: () => ({ CEREBRAS_API_KEY: "csk-test", VIBERSYN_RESEARCH_LLM: "cerebras" }),
      primary: async () => {
        throw new Error("cerebras 402: payment_required");
      },
      standIn: async () => {
        cliCalls += 1;
        return "never";
      },
    });
    await expect(run("req", signal())).rejects.toThrow("cerebras 402: payment_required");
    expect(cliCalls).toBe(0);
  });

  test("claude-cli pin skips the primary entirely and needs no key", async () => {
    let primaryCalls = 0;
    const run = runnerWith({
      env: () => ({ VIBERSYN_RESEARCH_LLM: "claude-cli" }),
      primary: async () => {
        primaryCalls += 1;
        return "never";
      },
    });
    const value = await run("req", signal());
    expect(value).toEqual({ kind: "agent-reply", agent: HOST_CLAUDE_AGENT, standinFor: null, reply: '{"standin":true}' });
    expect(primaryCalls).toBe(0);
  });
});

describe("agent reply wrapper", () => {
  test("unwrapAgentReply passes plain values through with no provenance claim", () => {
    expect(unwrapAgentReply("{}")).toEqual({ agent: null, standinFor: null, reply: "{}" });
    expect(unwrapAgentReply(null)).toEqual({ agent: null, standinFor: null, reply: null });
    // A model reply OBJECT without the discriminant is never misread as a wrapper.
    const modelReply = { agent: "smith", reply: "x" };
    expect(unwrapAgentReply(modelReply)).toEqual({ agent: null, standinFor: null, reply: modelReply });
    expect(isAgentReply(modelReply)).toBe(false);
  });

  test("unwrapAgentReply unwraps the discriminated wrapper", () => {
    const wrapped = { kind: "agent-reply", agent: "host-claude", standinFor: "cerebras 402: x", reply: "{}" };
    expect(unwrapAgentReply(wrapped)).toEqual({ agent: "host-claude", standinFor: "cerebras 402: x", reply: "{}" });
  });
});

describe("parseCliEnvelope", () => {
  test("unwraps the --output-format json envelope to the model's text", () => {
    expect(parseCliEnvelope('{"type":"result","subtype":"success","is_error":false,"result":"```json\\n{}\\n```"}')).toBe(
      "```json\n{}\n```",
    );
  });

  test("every failure mode throws with its cause", () => {
    expect(() => parseCliEnvelope("not json at all")).toThrow(/not JSON/u);
    expect(() => parseCliEnvelope("[]")).toThrow(/not an object/u);
    expect(() => parseCliEnvelope('{"subtype":"error_during_execution"}')).toThrow(/no result string/u);
    expect(() => parseCliEnvelope('{"is_error":true,"result":"Credit balance too low"}')).toThrow(
      /host-claude error: Credit balance too low/u,
    );
  });
});
