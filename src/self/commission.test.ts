import { describe, expect, test } from "bun:test";
import {
  SELF_BUSY_ACK,
  SELF_CALLSIGN,
  SELF_RELOADING_ACK,
  SELF_TITLE,
  SELF_UPID,
  SELF_WORKFLOW,
  SelfCommissioner,
  selfModeEnabled,
  selfRoutingOrchestrator,
  type GitHeadFact,
  type SelfSpawnClient,
} from "./commission";
import { CallsignAllocator, reservedControlWords, validateCallsignCandidate } from "../routing/callsigns";
import { ProcessRegistry, type BuildLoopOrchestrator } from "../process/registry";
import { MemorySmithersClient } from "../process/test-helpers";
import type { OutputDecision } from "../types";
import type { SpawnSeed } from "../seam/smithers-client";

// ── env flag ─────────────────────────────────────────────────────────────────

describe("selfModeEnabled", () => {
  test("only VIBERSYN_SELF_MODE=1/true turns the mode on", () => {
    expect(selfModeEnabled({})).toBe(false);
    expect(selfModeEnabled({ VIBERSYN_SELF_MODE: "0" })).toBe(false);
    expect(selfModeEnabled({ VIBERSYN_SELF_MODE: "" })).toBe(false);
    expect(selfModeEnabled({ VIBERSYN_SELF_MODE: "1" })).toBe(true);
    expect(selfModeEnabled({ VIBERSYN_SELF_MODE: "true" })).toBe(true);
  });
});

// ── reserved callsign ────────────────────────────────────────────────────────

describe("reserved SELF callsign (mirror)", () => {
  const selfReserved = [...reservedControlWords({}), SELF_CALLSIGN];

  test("the allocator with mirror reserved still accepts its own pool", () => {
    // Constructor runs assertCallsignPool against the reserved words — a
    // collision between the pool and "mirror" would throw here.
    expect(() => new CallsignAllocator({ reservedWords: selfReserved })).not.toThrow();
  });

  test("mirror is rejected for ordinary processes, and is phonetically clear of the wake word", () => {
    const validation = validateCallsignCandidate("mirror", [], selfReserved);
    expect(validation.accepted).toBe(false);
    // "vibersyn" is the wake word — the reserved callsign must NOT sound like
    // it (a mirror address must never wake the room and vice versa).
    expect(validateCallsignCandidate("mirror", [], ["vibersyn"]).accepted).toBe(true);
  });

  test("registry: pinned self spawn keeps mirror + title; a later mirror proposal falls back to the pool", async () => {
    const registry = new ProcessRegistry({
      client: new MemorySmithersClient(),
      callsigns: new CallsignAllocator({ reservedWords: selfReserved }),
      namer: null,
    });
    // The pin bypasses the collision guard the same way composition does.
    const prior = process.env.VIBERSYN_RBG_DISABLE_CALLSIGN_COLLISION_GUARD;
    process.env.VIBERSYN_RBG_DISABLE_CALLSIGN_COLLISION_GUARD = "1";
    let pinned: Awaited<ReturnType<ProcessRegistry["spawn"]>>;
    try {
      pinned = await registry.spawn({
        upid: SELF_UPID,
        callsign: SELF_CALLSIGN,
        title: SELF_TITLE,
        workflow: SELF_WORKFLOW,
        prompt: "The Vibersyn room itself.",
        correlationId: "corr-self-pin-test",
      });
    } finally {
      if (prior === undefined) {
        delete process.env.VIBERSYN_RBG_DISABLE_CALLSIGN_COLLISION_GUARD;
      } else {
        process.env.VIBERSYN_RBG_DISABLE_CALLSIGN_COLLISION_GUARD = prior;
      }
    }
    if (!pinned.accepted) {
      throw new Error("self pin refused");
    }
    expect(pinned.process.upid).toBe(SELF_UPID);
    expect(pinned.process.callsign).toBe(SELF_CALLSIGN);
    // The pinned title is exact — inference/namer never rename it.
    expect(pinned.process.title).toBe(SELF_TITLE);

    // With the guard ON again, another process proposing "mirror" (e.g. an
    // inferred handle from a pitch about mirrors) must NOT get it.
    const other = await registry.spawn({
      callsign: SELF_CALLSIGN,
      prompt: "a mirror gallery app",
      correlationId: "corr-other",
    });
    if (!other.accepted) {
      throw new Error("second spawn refused");
    }
    expect(other.process.callsign).not.toBe(SELF_CALLSIGN);
  });
});

// ── commissioner ─────────────────────────────────────────────────────────────

interface Harness {
  commissioner: SelfCommissioner;
  spawns: SpawnSeed[];
  halts: string[];
  outputs: OutputDecision[];
  launched: string[];
  greens: string[];
  setHead(head: GitHeadFact | null): void;
  setRunStatus(status: string | null): void;
}

function makeHarness(options: { pollMs?: number; withProbe?: boolean } = {}): Harness {
  const spawns: SpawnSeed[] = [];
  const halts: string[] = [];
  const outputs: OutputDecision[] = [];
  const launched: string[] = [];
  const greens: string[] = [];
  let head: GitHeadFact | null = { sha: "sha-prior", subject: "prior commit" };
  let runStatus: string | null = "running";
  const client: SelfSpawnClient = {
    async spawn(seed) {
      spawns.push(seed);
      return { upid: seed.upid, runId: seed.runId ?? "run", workflow: seed.workflow, parentId: null };
    },
    async halt(upid) {
      halts.push(upid);
      return { ok: true };
    },
  };
  const commissioner = new SelfCommissioner({
    client,
    runIdNonce: "nonce",
    onOutput: (decision) => outputs.push(decision),
    onLaunched: (runId) => launched.push(runId),
    onGreen: (lane) => greens.push(lane.runId),
    gitHead: async () => head,
    getRunStatus: options.withProbe === false ? null : async () => runStatus,
    pollMs: options.pollMs ?? 2,
  });
  return {
    commissioner,
    spawns,
    halts,
    outputs,
    launched,
    greens,
    setHead: (next) => {
      head = next;
    },
    setRunStatus: (status) => {
      runStatus = status;
    },
  };
}

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("condition never became true");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("SelfCommissioner", () => {
  test("a steer launches ONE durable vibersyn-self run and opens the executing lane", async () => {
    const h = makeHarness({ withProbe: false });
    const result = await h.commissioner.steer("make the header blue", "corr-steer-1");
    expect(result.accepted).toBe(true);
    expect(h.spawns).toHaveLength(1);
    const seed = h.spawns[0]!;
    expect(seed.upid).toBe(SELF_UPID);
    expect(seed.workflow).toBe(SELF_WORKFLOW);
    expect(seed.callsign).toBe(SELF_CALLSIGN);
    expect(seed.runId).toBe("vibersyn-self-nonce-1");
    expect(seed.prompt).toBe("make the header blue");
    expect((seed.input as { instruction?: string }).instruction).toBe("make the header blue");
    expect(h.launched).toEqual(["vibersyn-self-nonce-1"]);
    const lane = h.commissioner.lane();
    expect(lane?.status).toBe("executing");
    expect(lane?.instruction).toBe("make the header blue");
    expect(h.commissioner.lastRunGreen()).toBe(false);
  });

  test("telemetry folds into the lane, capped below 100 while executing", async () => {
    const h = makeHarness({ withProbe: false });
    await h.commissioner.steer("add a clock", "corr-steer-2");
    h.commissioner.progress({ percent: 40, label: "editing composition.ts" });
    expect(h.commissioner.lane()?.percent).toBe(40);
    expect(h.commissioner.lane()?.label).toBe("editing composition.ts");
    h.commissioner.progress({ percent: 500 });
    expect(h.commissioner.lane()?.percent).toBe(99);
  });

  test("GREEN GATE: finished run + a NEW 'self:' commit flips built and fires onGreen once", async () => {
    const h = makeHarness({ withProbe: false });
    await h.commissioner.steer("add a clock", "corr-steer-3");
    h.setHead({ sha: "sha-new", subject: "self: add a clock" });
    await h.commissioner.completeFromRun("finished");
    const lane = h.commissioner.lane();
    expect(lane?.status).toBe("built");
    expect(lane?.percent).toBe(100);
    expect(h.commissioner.lastRunGreen()).toBe(true);
    expect(h.greens).toEqual(["vibersyn-self-nonce-1"]);
    // Idempotent — a replayed completion never double-fires the reload.
    await h.commissioner.completeFromRun("finished");
    expect(h.greens).toHaveLength(1);
  });

  test("GREEN GATE: a finished run with NO new commit fails the lane and never fires onGreen", async () => {
    const h = makeHarness({ withProbe: false });
    await h.commissioner.steer("add a clock", "corr-steer-4");
    // HEAD unchanged.
    await h.commissioner.completeFromRun("finished");
    expect(h.commissioner.lane()?.status).toBe("failed");
    expect(h.commissioner.lastRunGreen()).toBe(false);
    expect(h.greens).toHaveLength(0);
  });

  test("GREEN GATE: a new commit WITHOUT the self: subject is not green", async () => {
    const h = makeHarness({ withProbe: false });
    await h.commissioner.steer("add a clock", "corr-steer-5");
    h.setHead({ sha: "sha-new", subject: "wip: something else" });
    await h.commissioner.completeFromRun("finished");
    expect(h.commissioner.lane()?.status).toBe("failed");
    expect(h.greens).toHaveLength(0);
  });

  test("a failed/cancelled run settles the lane failed with the error surfaced", async () => {
    const h = makeHarness({ withProbe: false });
    await h.commissioner.steer("add a clock", "corr-steer-6");
    await h.commissioner.completeFromRun("cancelled");
    const lane = h.commissioner.lane();
    expect(lane?.status).toBe("failed");
    expect(lane?.error).toContain("cancelled");
    expect(h.greens).toHaveLength(0);
  });

  test("SERIALIZED: a second steer while one executes is refused with the spoken busy ack", async () => {
    const h = makeHarness({ withProbe: false });
    await h.commissioner.steer("first", "corr-a");
    const second = await h.commissioner.steer("second", "corr-b");
    expect(second).toEqual({ accepted: false, reason: "busy" });
    expect(h.spawns).toHaveLength(1);
    const spoken = h.outputs.find((decision) => decision.channel === "tts");
    expect(spoken?.channel === "tts" ? spoken.text : null).toBe(SELF_BUSY_ACK);
  });

  test("SERIALIZED: after green (reload armed) a steer is refused with the reloading ack", async () => {
    const h = makeHarness({ withProbe: false });
    await h.commissioner.steer("first", "corr-a");
    h.setHead({ sha: "sha-new", subject: "self: first" });
    await h.commissioner.completeFromRun("finished");
    const next = await h.commissioner.steer("second", "corr-b");
    expect(next).toEqual({ accepted: false, reason: "reloading" });
    const spoken = h.outputs.filter((decision) => decision.channel === "tts").at(-1);
    expect(spoken?.channel === "tts" ? spoken.text : null).toBe(SELF_RELOADING_ACK);
    expect(h.spawns).toHaveLength(1);
  });

  test("abort (halt/emergency stop) cancels the run, fails the lane, and blocks green", async () => {
    const h = makeHarness({ withProbe: false });
    await h.commissioner.steer("first", "corr-a");
    await h.commissioner.abort();
    expect(h.halts).toEqual([SELF_UPID]);
    expect(h.commissioner.lane()?.status).toBe("failed");
    // A late completion frame must not resurrect the aborted run into green.
    h.setHead({ sha: "sha-new", subject: "self: first" });
    await h.commissioner.completeFromRun("finished");
    expect(h.commissioner.lastRunGreen()).toBe(false);
    expect(h.greens).toHaveLength(0);
  });

  test("the poll watchdog settles a run whose terminal stream frame was missed", async () => {
    const h = makeHarness({ pollMs: 2 });
    await h.commissioner.steer("first", "corr-a");
    h.setHead({ sha: "sha-new", subject: "self: first" });
    h.setRunStatus("finished");
    await until(() => h.commissioner.lane()?.status === "built");
    expect(h.greens).toHaveLength(1);
  });

  test("an empty instruction is a no-op", async () => {
    const h = makeHarness({ withProbe: false });
    const result = await h.commissioner.steer("   ", "corr-a");
    expect(result).toEqual({ accepted: false, reason: "empty" });
    expect(h.spawns).toHaveLength(0);
  });
});

// ── orchestrator routing ─────────────────────────────────────────────────────

describe("selfRoutingOrchestrator", () => {
  function makeBase(): BuildLoopOrchestrator & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      async start(input) {
        calls.push(`start:${input.upid}`);
      },
      async steer(upid, text) {
        calls.push(`steer:${upid}:${text}`);
      },
      async abortAll(upid) {
        calls.push(`abort:${upid}`);
      },
      builds(upid) {
        calls.push(`builds:${upid}`);
        return [];
      },
    };
  }

  test("SELF steers/aborts route to the commissioner; other upids keep the base orchestrator", async () => {
    const base = makeBase();
    const steered: string[] = [];
    let aborted = 0;
    const wrapped = selfRoutingOrchestrator(base, () => ({
      steer: async (text: string) => {
        steered.push(text);
        return { accepted: true as const, runId: "r" };
      },
      abort: async () => {
        aborted += 1;
      },
    }));

    await wrapped.steer(SELF_UPID, "change the room");
    await wrapped.steer("upid-1", "change the mock");
    await wrapped.abortAll(SELF_UPID);
    await wrapped.abortAll("upid-1");
    expect(steered).toEqual(["change the room"]);
    expect(aborted).toBe(1);
    expect(base.calls).toEqual(["steer:upid-1:change the mock", "abort:upid-1"]);
  });

  test("the SELF project has no kickoff mock lanes: start is skipped and builds are empty", async () => {
    const base = makeBase();
    const wrapped = selfRoutingOrchestrator(base, () => null);
    await wrapped.start({ upid: SELF_UPID, ideaId: "self", prompt: "x", callsign: SELF_CALLSIGN });
    expect(wrapped.builds(SELF_UPID)).toEqual([]);
    await wrapped.start({ upid: "upid-1", ideaId: "i", prompt: "x", callsign: null });
    expect(base.calls).toEqual(["start:upid-1"]);
  });

  test("a null base (legacy single-build path) still routes SELF and no-ops the rest", async () => {
    const steered: string[] = [];
    const wrapped = selfRoutingOrchestrator(null, () => ({
      steer: async (text: string) => {
        steered.push(text);
        return { accepted: true as const, runId: "r" };
      },
      abort: async () => undefined,
    }));
    await wrapped.steer(SELF_UPID, "fix it");
    await wrapped.steer("upid-9", "ignored");
    expect(steered).toEqual(["fix it"]);
    expect(wrapped.builds("upid-9")).toEqual([]);
  });
});
