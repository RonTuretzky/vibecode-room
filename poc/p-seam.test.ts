import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import React from "react";
import { Gateway, createSmithers } from "smithers-orchestrator";
import { z } from "zod";

const PROBE_ID = "probe-cue-smithers-seam";
const BUILD_DIR = `artifacts/smithering/build/${PROBE_ID}`;
const PROBE_DIR = `artifacts/smithering/probes/${PROBE_ID}`;
const TRACE_DIR = `${BUILD_DIR}/trace`;
const TRACE_PATH = `${TRACE_DIR}/p-seam.jsonl`;
const CUE_REPO = "https://github.com/jameslbarnes/cue.git";
const CUE_ROOT = process.env.PANOP_CUE_SOURCE_DIR ?? join(tmpdir(), "panopticon-cue-src");
const NON_BLOCKING_BUDGET_MS = 150;
const LOOP_TICK_BUDGET_MS = 120;
const SPAWN_BUDGET_MS = 3_000;

type CueCore = Record<string, any>;
type RpcFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: any;
  error?: { code: string; message: string };
};
type WsEventFrame = {
  type: "event";
  event: string;
  payload?: any;
  seq: number;
  stateVersion: number;
};
type TestConnection = {
  connectionId: string;
  transport: "ws";
  authenticated: boolean;
  sessionToken: string;
  role: string;
  scopes: string[];
  userId: string;
  subscribedRuns: Set<string> | null;
  heartbeatTimer: null;
  devtoolsStreams: Map<string, unknown>;
  runEventStreams?: Map<string, unknown>;
  seq: number;
  ws: {
    OPEN: number;
    readyState: number;
    bufferedAmount: number;
    sent: WsEventFrame[];
    send: (data: string) => void;
  };
};
type CorrelationRecord = {
  upid: string;
  runId: string;
  steeringWindowId: string;
  sourceWindowHash: string;
  correlationId: string;
};
type SpawnRecord = {
  runId: string;
  upid: string;
  steeringWindowId: string;
  create: RpcFrame;
  waiting: RpcFrame;
  spawnMs: number;
};

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("P-SEAM Cue to Smithers gateway integration", () => {
  test("MappedActionTool dispatch is bidirectional, async, reconnectable, and restart-correlated", async () => {
    await assertDependencyVerdicts();
    const cue = await loadCue();
    const runtime = createRuntime("seam");
    const gateway = new Gateway({ heartbeatMs: 1_000, eventWindowSize: 200 });
    const connection = createConnection("probe:seam");
    const storePath = join(runtime.dir, "upid-correlations.json");
    const voiceOutputs: any[] = [];

    gateway.connections.add(connection as any);
    gateway.register("seam", runtime.workflow);

    const dispatcher = new SeamDispatcher({
      gateway,
      connection,
      workflow: "seam",
      storePath,
      traceCorrelationId: "p-seam:dispatch",
    });
    const harness = createCueHarness(cue, dispatcher, voiceOutputs);

    try {
      const startedAt = performance.now();
      const loopTick = new Promise<number>((resolve) => {
        setTimeout(() => resolve(performance.now() - startedAt), 25);
      });
      const ingest = harness.ingest(
        cue.transcriptObservation("Panop spawn smithers seam probe", {
          speaker: "operator",
          timestamp: 1_000,
        }),
      );
      const tickMs = await loopTick;
      const result = await ingest;
      const cueLoopMs = performance.now() - startedAt;

      const action = result.toolResults[0]?.actions[0];
      expect(result.toolCalls[0]?.tool).toBe("panopticon.spawnSmithers");
      expect(result.toolResults[0]?.tool).toBe("panopticon.spawnSmithers");
      expect(result.toolResults[0]?.status).toBe("ok");
      expect(action).toEqual(
        expect.objectContaining({
          type: "smithers.spawn.dispatched",
          payload: expect.objectContaining({
            upid: "upid-seam-001",
            runId: "p-seam-upid-seam-001",
            steeringWindowId: "window-seam-voice-001",
          }),
        }),
      );
      expect(dispatcher.spawnCalls).toHaveLength(1);
      expect(tickMs).toBeLessThanOrEqual(LOOP_TICK_BUDGET_MS);
      expect(cueLoopMs).toBeLessThanOrEqual(NON_BLOCKING_BUDGET_MS);

      const spawn = await dispatcher.waitForRun("upid-seam-001");
      expect(spawn.create.ok).toBe(true);
      expect(spawn.waiting.ok).toBe(true);
      expect(spawn.waiting.payload.status).toBe("waiting-event");
      expect(spawn.spawnMs).toBeLessThanOrEqual(SPAWN_BUDGET_MS);

      const firstStream = await subscribeRunEvents(gateway, connection, spawn.runId, 0);
      expect(firstStream.ok).toBe(true);
      const firstFrames = await waitForRunFrames(connection, spawn.runId, 1);
      const bridge = new SmithersCueObservationBridge(cue, harness, storePath);
      const bridged = await bridge.ingestFrames(firstFrames);
      expect(bridged.observations.length).toBeGreaterThan(0);
      expect(bridged.observations[0]).toEqual(
        expect.objectContaining({
          type: "smithers.run_event",
          payload: expect.objectContaining({
            upid: "upid-seam-001",
            runId: spawn.runId,
            steeringWindowId: "window-seam-voice-001",
          }),
        }),
      );
      expect(voiceOutputs.length).toBeGreaterThan(0);
      expect(voiceOutputs[0]).toEqual(
        expect.objectContaining({
          upid: "upid-seam-001",
          steeringWindowId: "window-seam-voice-001",
          source: "smithers.gateway.streamRunEvents",
        }),
      );

      const lastSeq = maxRunSeq(firstFrames);
      const reconnectAfterSeq =
        process.env.P_SEAM_RBG_BREAK_RECONNECT === "1" ? lastSeq + 500 : Math.max(0, lastSeq - 1);
      const reconnectConnection = createConnection("probe:seam-reconnect");
      gateway.connections.add(reconnectConnection as any);
      const reconnect = await subscribeRunEvents(gateway, reconnectConnection, spawn.runId, reconnectAfterSeq);
      expect(reconnect.ok).toBe(true);
      const replayFrames = await waitForRunFrames(reconnectConnection, spawn.runId, 1);
      expect(replayFrames.some((frame) => Number(frame.payload?.seq) >= lastSeq)).toBe(true);

      const restartedHarness = createCueHarness(cue, dispatcher, []);
      const restartedBridge = new SmithersCueObservationBridge(cue, restartedHarness, storePath, {
        simulateRestart: true,
      });
      const restarted = await restartedBridge.ingestFrames(replayFrames.slice(0, 1));
      expect(restarted.observations[0]?.payload).toEqual(
        expect.objectContaining({
          upid: "upid-seam-001",
          runId: spawn.runId,
          steeringWindowId: "window-seam-voice-001",
          sourceWindowHash: "source-window:panop-spawn-smithers-seam-probe",
        }),
      );

      await appendTrace("seam.assertions.passed", {
        actionOut: action,
        cueLoopMs,
        tickMs,
        spawnMs: spawn.spawnMs,
        runEventFrames: firstFrames.length,
        replayFrames: replayFrames.length,
        restartCorrelation: restarted.observations[0]?.payload,
      });
      await writeVerdict(true, "P-SEAM passed against real Cue and real Smithers Gateway mode.");
    } finally {
      await gateway.close().catch(() => {});
      closeRuntime(runtime);
    }
  }, 30_000);
});

class SeamDispatcher {
  readonly gateway: Gateway;
  readonly connection: TestConnection;
  readonly workflow: string;
  readonly storePath: string;
  readonly traceCorrelationId: string;
  readonly spawnCalls: Array<{ upid: string; runId: string; steeringWindowId: string }> = [];
  private readonly pending = new Map<string, Promise<SpawnRecord>>();

  constructor(options: {
    gateway: Gateway;
    connection: TestConnection;
    workflow: string;
    storePath: string;
    traceCorrelationId: string;
  }) {
    this.gateway = options.gateway;
    this.connection = options.connection;
    this.workflow = options.workflow;
    this.storePath = options.storePath;
    this.traceCorrelationId = options.traceCorrelationId;
  }

  dispatch(call: any, context: any) {
    const upid = String(call.arguments.upid);
    const steeringWindowId = String(call.arguments.steeringWindowId);
    const runId = `p-seam-${upid}`;
    const correlationId = `${upid}:${steeringWindowId}`;
    const sourceWindowHash = hashSourceWindow(context.state.sourceWindow(4000).transcript ?? "");

    if (process.env.P_SEAM_RBG_BLOCKING_DISPATCH === "1") {
      busyWait(350);
    }

    if (process.env.P_SEAM_RBG_BREAK_ACTION_OUT !== "1") {
      this.spawnCalls.push({ upid, runId, steeringWindowId });
      const pending = this.spawn({
        upid,
        runId,
        steeringWindowId,
        sourceWindowHash,
        correlationId,
        prompt: String(call.arguments.prompt),
      });
      this.pending.set(upid, pending);
    }

    void appendTrace("seam.dispatch.queued", {
      correlationId,
      upid,
      runId,
      steeringWindowId,
      sourceWindowHash,
      cueProgram: call.program,
    });

    return [
      {
        type: "smithers.spawn.dispatched",
        payload: { upid, runId, steeringWindowId, correlationId },
      },
    ];
  }

  async waitForRun(upid: string): Promise<SpawnRecord> {
    const pending = this.pending.get(upid);
    expect(pending).toBeDefined();
    return pending!;
  }

  private async spawn(args: {
    upid: string;
    runId: string;
    steeringWindowId: string;
    sourceWindowHash: string;
    correlationId: string;
    prompt: string;
  }): Promise<SpawnRecord> {
    const startedAt = performance.now();
    const create = await rpc(this.gateway, this.connection, "runs.create", {
      workflow: this.workflow,
      runId: args.runId,
      input: {
        upid: args.upid,
        steeringWindowId: args.steeringWindowId,
        sourceWindowHash: args.sourceWindowHash,
        correlationId: args.correlationId,
        prompt: args.prompt,
      },
    });
    if (create.ok) {
      await persistCorrelation(this.storePath, {
        upid: args.upid,
        runId: args.runId,
        steeringWindowId: args.steeringWindowId,
        sourceWindowHash: args.sourceWindowHash,
        correlationId: args.correlationId,
      });
    }
    const waiting = await waitForStatus(this.gateway, this.connection, args.runId, "waiting-event");
    const spawnMs = performance.now() - startedAt;
    await appendTrace("seam.spawn.completed", {
      correlationId: args.correlationId,
      runId: args.runId,
      upid: args.upid,
      status: waiting.payload?.status,
      spawnMs,
    });
    return {
      runId: args.runId,
      upid: args.upid,
      steeringWindowId: args.steeringWindowId,
      create,
      waiting,
      spawnMs,
    };
  }
}

class SmithersCueObservationBridge {
  readonly cue: CueCore;
  readonly harness: any;
  readonly storePath: string;
  readonly simulateRestart: boolean;

  constructor(cue: CueCore, harness: any, storePath: string, options: { simulateRestart?: boolean } = {}) {
    this.cue = cue;
    this.harness = harness;
    this.storePath = storePath;
    this.simulateRestart = options.simulateRestart ?? false;
  }

  async ingestFrames(frames: WsEventFrame[]) {
    const observations: any[] = [];
    const results: any[] = [];
    const correlations = await loadCorrelations(this.storePath, this.simulateRestart);
    for (const frame of frames) {
      if (frame.event !== "run.event" && frame.event !== "run.gap_resync") {
        continue;
      }
      const runId = String(frame.payload?.runId ?? "");
      const correlation = correlations.find((entry) => entry.runId === runId);
      const observation = this.cue.normalizeObservation({
        type: process.env.P_SEAM_RBG_BREAK_RUN_EVENT_BACK === "1" ? "smithers.dropped_event" : "smithers.run_event",
        source: "smithers.gateway.streamRunEvents",
        payload: {
          runId,
          event: String(frame.payload?.event ?? frame.event),
          seq: Number(frame.payload?.seq ?? 0),
          streamId: String(frame.payload?.streamId ?? ""),
          upid: correlation?.upid ?? null,
          steeringWindowId: correlation?.steeringWindowId ?? null,
          sourceWindowHash: correlation?.sourceWindowHash ?? null,
        },
      });
      observations.push(observation);
      results.push(await this.harness.ingest(observation));
      await appendTrace("seam.event.bridged", {
        runId,
        event: observation.payload.event,
        seq: observation.payload.seq,
        upid: observation.payload.upid,
        steeringWindowId: observation.payload.steeringWindowId,
      });
    }
    return { observations, results };
  }
}

function createCueHarness(cue: CueCore, dispatcher: SeamDispatcher, voiceOutputs: any[]) {
  const { CueHarness, MappedActionTool, TextCue, Triggers } = cue;
  return new CueHarness({
    sessionId: "p-seam-cue-session",
    cues: [new TextCue(["spawn smithers"])],
    programs: [
      {
        name: "cue-to-smithers-spawn",
        triggers: [Triggers.onCue("text")],
        allowedTools: ["panopticon.spawnSmithers"],
        llmProvider: {
          infer() {
            return [
              {
                tool: "panopticon.spawnSmithers",
                arguments: {
                  upid: "upid-seam-001",
                  steeringWindowId: "window-seam-voice-001",
                  prompt: "run seam probe",
                },
              },
            ];
          },
        },
      },
      {
        name: "smithers-events-to-voice",
        triggers: [Triggers.onObservation("smithers.run_event")],
        allowedTools: ["panopticon.voiceOut"],
        llmProvider: {
          infer({ observation }: any) {
            return [
              {
                tool: "panopticon.voiceOut",
                arguments: {
                  upid: observation.payload.upid,
                  runId: observation.payload.runId,
                  steeringWindowId: observation.payload.steeringWindowId,
                  event: observation.payload.event,
                  source: observation.source,
                  text: `Smithers ${observation.payload.event}`,
                },
              },
            ];
          },
        },
      },
    ],
    tools: [
      new MappedActionTool({
        name: "panopticon.spawnSmithers",
        description: "Dispatch a Cue action into Smithers Gateway run spawn.",
        inputSchema: {
          type: "object",
          required: ["upid", "steeringWindowId", "prompt"],
          properties: {
            upid: { type: "string" },
            steeringWindowId: { type: "string" },
            prompt: { type: "string" },
          },
        },
        mapper: (call: any, context: any) => dispatcher.dispatch(call, context),
      }),
      new MappedActionTool({
        name: "panopticon.voiceOut",
        description: "Record run-event observations as voice-out coherent output.",
        inputSchema: {
          type: "object",
          required: ["upid", "runId", "steeringWindowId", "event", "source", "text"],
          properties: {
            upid: { type: "string" },
            runId: { type: "string" },
            steeringWindowId: { type: "string" },
            event: { type: "string" },
            source: { type: "string" },
            text: { type: "string" },
          },
        },
        mapper: (call: any) => {
          voiceOutputs.push(call.arguments);
          return [{ type: "voice.out", payload: call.arguments }];
        },
      }),
    ],
  });
}

function createRuntime(label: string) {
  const dir = mkdtempSync(join(tmpdir(), `p-seam-${label}-`));
  tempDirs.push(dir);
  const dbPath = join(dir, "smithers.db");
  const api = createSmithers(
    {
      checkpoint: z.object({
        upid: z.string(),
        steeringWindowId: z.string(),
        sourceWindowHash: z.string(),
        correlationId: z.string(),
        prompt: z.string(),
      }),
      steer: z.object({
        command: z.string(),
      }),
      complete: z.object({
        upid: z.string(),
        steeringWindowId: z.string(),
        sourceWindowHash: z.string(),
        command: z.string(),
      }),
    },
    { dbPath, readableName: `P-SEAM ${label}` },
  );

  const workflow = api.smithers((ctx) => {
    const input = ctx.input as any;
    return React.createElement(
      api.Workflow,
      { name: "seam" },
      React.createElement(
        api.Sequence,
        null,
        React.createElement(api.Task, { id: "checkpoint", output: api.outputs.checkpoint }, input),
        React.createElement(api.Signal, {
          id: "steer",
          schema: api.outputs.steer,
          correlationId: String(input.correlationId),
          children: (data: { command: string }) =>
            React.createElement(api.Task, { id: "complete", output: api.outputs.complete }, {
              upid: String(input.upid),
              steeringWindowId: String(input.steeringWindowId),
              sourceWindowHash: String(input.sourceWindowHash),
              command: data.command,
            }),
        }),
      ),
    );
  });

  return { api, workflow, dir, dbPath };
}

async function assertDependencyVerdicts() {
  for (const [ticketId, path] of [
    ["probe-cue-substrate", "artifacts/smithering/probes/probe-cue-substrate/verdict.json"],
    ["probe-smithers-durable-runs", "artifacts/smithering/probes/probe-smithers-durable-runs/verdict.json"],
    ["probe-suite-harness", "artifacts/smithering/probes/probe-suite-harness/verdict.json"],
  ] as const) {
    const verdict = JSON.parse(await readFile(path, "utf8"));
    await appendTrace("seam.dependency.verdict", { ticketId, path, green: verdict.green === true });
    expect(verdict.green).toBe(true);
  }
}

async function loadCue(): Promise<CueCore> {
  ensureCueSource();
  const core = await import(pathToFileURL(join(CUE_ROOT, "packages/core/dist/index.js")).href);
  await appendTrace("seam.cue.loaded", {
    repo: CUE_REPO,
    sourceDir: CUE_ROOT,
    commit: git(CUE_ROOT, ["rev-parse", "HEAD"]),
  });
  return core;
}

function ensureCueSource(): void {
  if (!existsSync(join(CUE_ROOT, ".git"))) {
    execFileSync("git", ["clone", "--depth", "1", CUE_REPO, CUE_ROOT], { stdio: "pipe" });
  }
  execFileSync("git", ["ls-remote", CUE_REPO, "HEAD"], { stdio: "pipe" });
  if (!existsSync(join(CUE_ROOT, "packages/core/dist/index.js"))) {
    execFileSync("pnpm", ["install"], { cwd: CUE_ROOT, stdio: "pipe" });
    execFileSync("pnpm", ["build"], { cwd: CUE_ROOT, stdio: "pipe" });
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function rpc(
  gateway: Gateway,
  connection: TestConnection,
  method: string,
  params?: Record<string, unknown>,
): Promise<RpcFrame> {
  return (gateway as any).routeRequest(connection, {
    type: "req",
    id: `${method}:${Math.random().toString(36).slice(2)}`,
    method,
    params,
  });
}

async function subscribeRunEvents(
  gateway: Gateway,
  connection: TestConnection,
  runId: string,
  afterSeq: number,
): Promise<RpcFrame> {
  return rpc(gateway, connection, "streamRunEvents", { runId, afterSeq });
}

async function waitForStatus(
  gateway: Gateway,
  connection: TestConnection,
  runId: string,
  status: string,
  timeoutMs = 10_000,
): Promise<RpcFrame> {
  const startedAt = Date.now();
  let latest: RpcFrame | undefined;
  while (Date.now() - startedAt < timeoutMs) {
    latest = await rpc(gateway, connection, "runs.get", { runId });
    if (latest.ok && latest.payload.status === status) {
      return latest;
    }
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${runId} to reach ${status}; latest=${JSON.stringify(latest)}`);
}

async function waitForRunFrames(connection: TestConnection, runId: string, minimum: number, timeoutMs = 1_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const frames = connection.ws.sent.filter(
      (frame) =>
        (frame.event === "run.event" || frame.event === "run.gap_resync") &&
        frame.payload?.runId === runId,
    );
    if (frames.length >= minimum) {
      return frames;
    }
    await sleep(10);
  }
  throw new Error(`Timed out waiting for ${minimum} run event frames for ${runId}`);
}

function maxRunSeq(frames: WsEventFrame[]) {
  return frames.reduce((max, frame) => Math.max(max, Number(frame.payload?.seq ?? 0)), 0);
}

function createConnection(userId: string): TestConnection {
  const sent: WsEventFrame[] = [];
  const ws = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    sent,
    send: (data: string) => {
      sent.push(JSON.parse(data));
    },
  };
  return {
    connectionId: `${userId}:connection`,
    transport: "ws",
    authenticated: true,
    sessionToken: "probe-session",
    role: "operator",
    scopes: ["*"],
    userId,
    subscribedRuns: null,
    heartbeatTimer: null,
    devtoolsStreams: new Map(),
    seq: 0,
    ws,
  };
}

async function persistCorrelation(path: string, record: CorrelationRecord) {
  await mkdir(join(path, ".."), { recursive: true });
  const existing = existsSync(path) ? JSON.parse(await readFile(path, "utf8")) : [];
  const next = [...existing.filter((entry: CorrelationRecord) => entry.runId !== record.runId), record];
  await writeFile(path, JSON.stringify(next, null, 2) + "\n");
}

async function loadCorrelations(path: string, simulateRestart: boolean): Promise<CorrelationRecord[]> {
  if (simulateRestart && process.env.P_SEAM_RBG_BREAK_RESTART_CORRELATION === "1") {
    return [];
  }
  expect(existsSync(path)).toBe(true);
  const records = JSON.parse(await readFile(path, "utf8"));
  expect(Array.isArray(records)).toBe(true);
  return records;
}

async function appendTrace(event: string, fields: Record<string, unknown>) {
  await mkdir(TRACE_DIR, { recursive: true });
  await appendFile(
    TRACE_PATH,
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      correlationId: fields.correlationId ?? "p-seam",
      event,
      ...fields,
    }) + "\n",
  );
}

async function writeVerdict(green: boolean, summary: string) {
  await mkdir(PROBE_DIR, { recursive: true });
  await writeFile(
    `${PROBE_DIR}/verdict.json`,
    JSON.stringify({ green, ticketId: PROBE_ID, summary }, null, 2) + "\n",
  );
}

function hashSourceWindow(transcript: string) {
  return `source-window:${transcript.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

function closeRuntime(runtime: ReturnType<typeof createRuntime>) {
  try {
    runtime.api.db?.$client?.close?.();
  } catch {
    // Cleanup must not mask the assertion that already failed.
  }
}

function busyWait(ms: number) {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // Intentional RBG-only event-loop stall.
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
