import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectorRuntime, type ProjectorRuntime } from "../../src/server/composition";
import {
  DEFAULT_CLAUDE_DECISION_MODEL,
  type AnthropicMessagesRequest,
  type ClaudeMessagesTransport,
} from "../../src/providers/llm/claude";
import { cueDecisionSchema, type CueDecision, type TranscriptObservation } from "../../src/types";

// ISSUE-0023 e2e: with a model credential present (ANTHROPIC_API_KEY) and no
// explicit PANOP_DECISION_LLM, the live runtime (createProjectorRuntime) auto-
// selects the Claude decider. The SAME instance backs both the SuggestionEngine
// scoring and the acceptance intent-gate, so a buildable utterance is scored
// through the Claude path (fires a suggestion) and a subsequent affirmative that
// requires a semantic check is judged through the Claude path too (accepts +
// spawns). A stub transport stands in for Anthropic so nothing touches the network.

describe("claude decider e2e — credential-present runtime routes suggest + accept through Claude", () => {
  const realFetch = globalThis.fetch;
  const tempDirs: string[] = [];
  let fetchCalls = 0;
  let priorCapacityGuard: string | undefined;

  beforeEach(() => {
    fetchCalls = 0;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetchCalls += 1;
      throw new Error(`unexpected network fetch in injected-transport Claude e2e: ${String(args[0])}`);
    }) as unknown as typeof fetch;
    // The acceptance spawn needs headroom over the two seeded demo processes.
    priorCapacityGuard = process.env.PANOP_RBG_DISABLE_CAPACITY_CHECK;
    process.env.PANOP_RBG_DISABLE_CAPACITY_CHECK = "1";
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (priorCapacityGuard === undefined) {
      delete process.env.PANOP_RBG_DISABLE_CAPACITY_CHECK;
    } else {
      process.env.PANOP_RBG_DISABLE_CAPACITY_CHECK = priorCapacityGuard;
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("a credential auto-selects Claude; suggestion + acceptance decisions both hit the Claude transport", async () => {
    const requests: AnthropicMessagesRequest[] = [];
    const transport = recordingTransport(requests);

    const path = writeFixture(tempDirs, [
      final("let's build a dashboard tool to ship the replay prototype today", "utt-build"),
      // Not a bare "yes": this affirmative does not start with the matched accept
      // phrase ("do it"), so the acceptance intent-gate prefilter defers to the
      // decider — forcing the accept decision through the Claude path.
      final("okay let us do it now please", "utt-accept"),
    ]);

    const runtime = await createProjectorRuntime(liveEnv(path), { decisionTransport: transport });
    expect(runtime.asrMode).toBeDefined();
    const upidsBefore = new Set(runtime.snapshot().processes.map((process) => process.upid));
    const spawnsBefore = spawnTraceCount(runtime);

    await driveMic(runtime);

    // The suggestion was scored + fired, then the affirmative routed to acceptance
    // and spawned a brand-new process through the registry seam.
    const events = runtime.trace.events().map((event) => event.event);
    expect(events).toContain("route.suggestion");
    expect(events).toContain("route.acceptance");
    expect(spawnTraceCount(runtime)).toBe(spawnsBefore + 1);

    const processes = runtime.snapshot().processes;
    const spawned = processes.filter((process) => !upidsBefore.has(process.upid));
    expect(spawned.length).toBe(1);

    // Both the SuggestionEngine scoring and the acceptance intent-gate routed
    // through the one auto-selected Claude decider (its injected transport).
    const systemPrompts = requests.map((request) => request.system ?? "");
    expect(systemPrompts.some((prompt) => prompt.includes("buildable ambient suggestion"))).toBe(true);
    expect(systemPrompts.some((prompt) => prompt.includes("standalone user command"))).toBe(true);
    expect(requests.every((request) => request.temperature === 0)).toBe(true);

    // The Claude decider stood in entirely for the network.
    expect(fetchCalls).toBe(0);
  });
});

// A stub Anthropic transport: it records every request and always returns the
// same spawn-leaning decision, which both fires a suggestion (action.spawn with a
// high quality + pitch) and accepts at the intent-gate (decision.kind "action").
function recordingTransport(requests: AnthropicMessagesRequest[]): ClaudeMessagesTransport {
  return async (request) => {
    requests.push(request);
    return {
      id: `msg_claude_${requests.length}`,
      model: DEFAULT_CLAUDE_DECISION_MODEL,
      content: [{ type: "tool_use", name: "emit_cue_decision", input: { decision: spawnDecision() } }],
    };
  };
}

function spawnDecision(): CueDecision {
  const correlationId = "corr-claude-e2e";
  return cueDecisionSchema.parse({
    kind: "action",
    action: {
      type: "spawn",
      targetUPID: null,
      correlationId,
      payload: {
        quality: 0.92,
        pitch: "Build a dashboard tool to ship the replay prototype",
        mcqs: ["Scope it as one task?", "Spawn an agent now?"],
        answers: ["Yes, scope it", "Yes, spawn it"],
      },
    },
    policy: "claude-decider-e2e",
    decisionId: "decision-claude-e2e",
    correlationId,
    meta: { quality: 0.92, source: "claude" },
  });
}

function liveEnv(replayPath: string): Record<string, string> {
  return {
    // A resolvable model credential — the registry reads it only to gate the
    // auto-select; the host-subscription command (not this key) is the seam.
    ANTHROPIC_API_KEY: "sk-ant-test-0123456789abcdef0123456789",
    PANOP_INITIAL_MUTED: "0",
    PANOP_MIC_REPLAY_PATH: replayPath,
    PANOP_SUGGEST_WORD_FLOOR: "3",
    PANOP_SUGGEST_INTERRUPT_VELOCITY_WEIGHT: "0",
    PANOP_SUGGEST_INTERRUPT_RECENCY_WEIGHT: "0",
    PANOP_SUGGEST_INTERRUPT_PENDING_STEERING_WEIGHT: "0",
  };
}

function spawnTraceCount(runtime: ProjectorRuntime): number {
  return runtime.trace.events().filter((event) => event.event === "process.spawn").length;
}

async function driveMic(runtime: ProjectorRuntime): Promise<void> {
  const session = runtime.startMicSession("corr-claude-decider-e2e");
  await session.stop();
}

function writeFixture(tempDirs: string[], observations: TranscriptObservation[]): string {
  const dir = mkdtempSync(join(tmpdir(), "panop-claude-decider-"));
  tempDirs.push(dir);
  const path = join(dir, "mic.jsonl");
  writeFileSync(path, observations.map((observation) => JSON.stringify(observation)).join("\n"), "utf8");
  return path;
}

function final(text: string, utteranceId: string): TranscriptObservation {
  return { text, isFinal: true, speaker: "Room", sessionId: "claude-decider-e2e", latencyMs: 20, utteranceId };
}
