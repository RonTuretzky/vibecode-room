// SELF-HOSTING MODE integration (VIBERSYN_SELF_MODE=1): the pinned mirror
// project, the steer→vibersyn-self commission chokepoint, the room-side green
// gate, the serialized exit-87 reload trigger, and the guarded HTTP surface —
// all over the real composition with a fake gateway transport, a fake git
// probe, and a captured exit (nothing spawns, nothing exits, no network).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectorRuntime, type ProjectorRuntime, type ProjectorRuntimeOptions } from "./composition";
import { createProjectorApp } from "./app";
import { healthPayload } from "./degradation-notice";
import { SELF_CALLSIGN, SELF_RELOADING_ACK, SELF_TITLE, SELF_UPID, SELF_WORKFLOW, type GitHeadFact } from "../self/commission";
import type { GatewayRpcTransport } from "../seam/smithers-client";
import type { ExecutionSnapshot } from "../buildloop/execution";

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface SelfHarness {
  runtime: ProjectorRuntime;
  env: Record<string, string>;
  launches: Array<Record<string, unknown>>;
  cancels: Array<Record<string, unknown>>;
  exits: number[];
  setHead(head: GitHeadFact | null): void;
  setRunStatus(status: string): void;
}

async function makeSelfRuntime(overrides: {
  env?: Record<string, string>;
  options?: ProjectorRuntimeOptions;
} = {}): Promise<SelfHarness> {
  const dir = mkdtempSync(join(tmpdir(), "vibersyn-self-"));
  tempDirs.push(dir);
  const replayPath = join(dir, "mic.jsonl");
  writeFileSync(replayPath, "", "utf8");

  const launches: Array<Record<string, unknown>> = [];
  const cancels: Array<Record<string, unknown>> = [];
  const exits: number[] = [];
  let head: GitHeadFact | null = { sha: "sha-prior", subject: "prior commit" };
  let runStatus = "running";

  const transport: GatewayRpcTransport = {
    async request(method, params) {
      if (method === "launchRun") {
        launches.push(params ?? {});
        return {};
      }
      if (method === "getRun") {
        return { status: runStatus };
      }
      if (method === "cancelRun") {
        cancels.push(params ?? {});
        return {};
      }
      return {};
    },
  };

  const env: Record<string, string> = {
    VIBERSYN_SELF_MODE: "1",
    VIBERSYN_INITIAL_MUTED: "0",
    VIBERSYN_MIC_REPLAY_PATH: replayPath,
    VIBERSYN_IDEA_DETECTOR: "heuristic",
    VIBERSYN_DETECT_TICK_MS: "0",
    VIBERSYN_RUN_POLL_MS: "3",
    VIBERSYN_SELF_RELOAD_DELAY_MS: "1",
    ...overrides.env,
  };
  const runtime = await createProjectorRuntime(env, {
    smithersTransport: transport,
    buildBackends: [],
    publishDeck: null,
    selfGitHead: async () => head,
    exitProcess: (code) => {
      exits.push(code);
    },
    ...overrides.options,
  });
  return {
    runtime,
    env,
    launches,
    cancels,
    exits,
    setHead: (next) => {
      head = next;
    },
    setRunStatus: (status) => {
      runStatus = status;
    },
  };
}

async function until(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("condition never became true");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function selfProcess(runtime: ProjectorRuntime): (Record<string, unknown> & { execution?: ExecutionSnapshot | null }) | undefined {
  return runtime.snapshot().processes.find((process) => process.upid === SELF_UPID) as
    | (Record<string, unknown> & { execution?: ExecutionSnapshot | null })
    | undefined;
}

describe("self mode boot: the pinned mirror project", () => {
  test("the SELF card is pinned with reserved upid/callsign/title, stage SELF, and no kickoff lanes", async () => {
    const { runtime } = await makeSelfRuntime();
    const snapshot = runtime.snapshot();
    const self = selfProcess(runtime);
    expect(self).toBeDefined();
    expect(self?.callsign).toBe(SELF_CALLSIGN);
    expect(self?.task).toBe(SELF_TITLE);
    expect(self?.stage).toBe("self");
    // No kickoff mock lanes, no execution lane before any steer.
    expect(self?.builds).toEqual([]);
    expect(self?.execution ?? null).toBeNull();
    // The snapshot's self surfaces.
    const surfaced = (snapshot as { self?: { callsign: string; reloadPending: boolean } }).self;
    expect(surfaced?.callsign).toBe(SELF_CALLSIGN);
    expect(surfaced?.reloadPending).toBe(false);
    expect(typeof (snapshot as { bootId?: string }).bootId).toBe("string");
    // /api/health exposes the stable per-boot id + the mode flag.
    const health = healthPayload(runtime);
    expect(health.bootId).toBe(runtime.bootId);
    expect(health.selfMode).toBe(true);
  });

  test("without VIBERSYN_SELF_MODE nothing is pinned and no self surfaces exist", async () => {
    const { runtime } = await makeSelfRuntime({ env: { VIBERSYN_SELF_MODE: "0" } });
    expect(runtime.selfMode).toBe(false);
    expect(selfProcess(runtime)).toBeUndefined();
    expect((runtime.snapshot() as { self?: unknown }).self).toBeNull();
    expect(runtime.requestSelfReload("corr-off").ok).toBe(false);
  });

  test("the SELF project refuses the execute (commission) path — steering IS its commission", async () => {
    const { runtime } = await makeSelfRuntime();
    const result = await runtime.executeProcess(SELF_UPID, "corr-exec-self");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toContain(SELF_CALLSIGN);
    }
  });
});

describe("steer → self-commission → green gate → serialized exit-87 reload", () => {
  test("a steer launches vibersyn-self; a verified green commit arms and fires the reload", async () => {
    const harness = await makeSelfRuntime();
    const { runtime, launches, exits } = harness;

    // Reload trigger is GATED: nothing green has run yet.
    const premature = runtime.requestSelfReload("corr-premature");
    expect(premature).toEqual({ ok: false, reason: "the last self-run did not verify green" });

    // Steer through the registry chokepoint (the same call click-steer,
    // "mirror, <instruction>", and POST /api/process/self/steer all reach).
    await runtime.registry.steer(SELF_UPID, { text: "make the header blue", source: "live-transcript" }, "corr-steer");
    await until(() => launches.length === 1);
    const launch = launches[0]!;
    expect(launch.workflow).toBe(SELF_WORKFLOW);
    const options = launch.options as { runId?: string } | undefined;
    expect(options?.runId).toStartWith("vibersyn-self-");
    // The lane shows executing telemetry on the SELF card, like a commission.
    expect(selfProcess(runtime)?.execution?.status).toBe("executing");

    // The run finishes AND a new "self:" commit landed → green → reload.
    harness.setHead({ sha: "sha-new", subject: "self: make the header blue" });
    harness.setRunStatus("finished");
    await until(() => exits.length === 1);
    expect(exits).toEqual([87]);
    expect(selfProcess(runtime)?.execution?.status).toBe("built");
    expect((runtime.snapshot() as { self?: { reloadPending: boolean } }).self?.reloadPending).toBe(true);

    // Serialized: a steer during the reload is refused with the spoken ack,
    // and no second run launches.
    await runtime.registry.steer(SELF_UPID, { text: "another change" }, "corr-steer-2");
    await until(() => runtime.snapshot().audio.lastSpoken === SELF_RELOADING_ACK);
    expect(launches).toHaveLength(1);
    // And a second trigger is refused while the first drains.
    expect(runtime.requestSelfReload("corr-again")).toEqual({ ok: false, reason: "a reload is already in flight" });
  });

  test("a finished run with NO new self: commit fails the gate — error lane, no reload, no exit", async () => {
    const harness = await makeSelfRuntime();
    const { runtime, launches, exits } = harness;
    await runtime.registry.steer(SELF_UPID, { text: "break something" }, "corr-steer");
    await until(() => launches.length === 1);
    harness.setRunStatus("finished"); // HEAD unchanged — the agent committed nothing.
    await until(() => selfProcess(runtime)?.execution?.status === "failed");
    expect(selfProcess(runtime)?.execution?.error).toContain("refusing to reload");
    expect(exits).toHaveLength(0);
    expect(runtime.requestSelfReload("corr-after-red").ok).toBe(false);
    expect((runtime.snapshot() as { self?: { reloadPending: boolean } }).self?.reloadPending).toBe(false);
  });

  test("emergency stop aborts an in-flight self-run like any commission", async () => {
    const harness = await makeSelfRuntime();
    const { runtime, launches, cancels, exits } = harness;
    await runtime.registry.steer(SELF_UPID, { text: "long change" }, "corr-steer");
    await until(() => launches.length === 1);
    await runtime.emergencyStop("corr-emergency");
    // The durable run was cancelled through the gateway and the lane died with
    // the process — a late green can never reload an emergency-stopped room.
    expect(cancels.length).toBeGreaterThanOrEqual(1);
    harness.setHead({ sha: "sha-new", subject: "self: long change" });
    harness.setRunStatus("finished");
    expect(runtime.requestSelfReload("corr-post-stop").ok).toBe(false);
    expect(exits).toHaveLength(0);
  });
});

describe("the guarded HTTP trigger (POST /api/self/reload)", () => {
  test("404 outside self mode; 409 with the reason while gated; wired to the runtime", async () => {
    const off = await makeSelfRuntime({ env: { VIBERSYN_SELF_MODE: "0" } });
    const offApp = createProjectorApp(off.runtime, { env: off.env });
    const offResponse = await offApp.request("/api/self/reload", { method: "POST" });
    expect(offResponse.status).toBe(404);

    const on = await makeSelfRuntime();
    const onApp = createProjectorApp(on.runtime, { env: on.env });
    const gated = await onApp.request("/api/self/reload", { method: "POST" });
    expect(gated.status).toBe(409);
    const body = (await gated.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("green");
  });

  test("/api/health carries the per-boot id over HTTP", async () => {
    const harness = await makeSelfRuntime();
    const app = createProjectorApp(harness.runtime, { env: harness.env });
    const response = await app.request("/api/health");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { bootId?: string; selfMode?: boolean };
    expect(body.bootId).toBe(harness.runtime.bootId);
    expect(body.selfMode).toBe(true);
  });
});
