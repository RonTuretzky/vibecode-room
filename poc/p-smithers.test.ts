import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import React from "react";
import { Gateway, createSmithers } from "smithers-orchestrator";
import { z } from "zod";

const PROBE_ID = "probe-smithers-durable-runs";
const TRACE_DIR = "artifacts/smithering/probes/probe-smithers-durable-runs";
const AUTH = {
  triggeredBy: "probe",
  scopes: ["*"],
  role: "operator",
  tokenId: null,
};

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

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("P-SMITHERS durable run lifecycle against the real Gateway harness", () => {
  test("spawn, stream, pause/resume, gateway steering, restart recovery, fleet, and fork lineage are failably asserted", async () => {
    const runtime = createRuntime("lifecycle");
    const gateway = new Gateway({ heartbeatMs: 1_000, eventWindowSize: 200 });
    const connection = createConnection("probe:lifecycle");
    gateway.connections.add(connection as any);
    gateway.register("durable", runtime.workflow);

    try {
      const seed = "seed-alpha";
      const runId = "probe-run-alpha";
      const create = await rpc(gateway, connection, "runs.create", {
        workflow: "durable",
        runId,
        input: {
          seed,
          correlationId: seed,
          parentId: null,
          fleetIndex: 0,
        },
      });
      expect(create.ok).toBe(true);
      expect(create.payload).toEqual({ runId, workflow: "durable" });

      const paused = await waitForStatus(gateway, connection, runId, "waiting-event");
      expect(paused.payload.summary).toEqual(
        expect.objectContaining({
          finished: 1,
          "waiting-event": 1,
        }),
      );

      const checkpointBeforeRestart = await getNodeOutput(gateway, connection, runId, "checkpoint");
      expect(checkpointBeforeRestart.row).toEqual(
        expect.objectContaining({
          seed,
          parentId: "",
          checkpoint: "checkpoint:seed-alpha",
          fleetIndex: 0,
        }),
      );

      const stream = await rpc(gateway, connection, "streamRunEvents", { runId, afterSeq: 0 });
      expect(stream.ok).toBe(true);
      expect(stream.payload).toEqual(
        expect.objectContaining({
          runId,
          afterSeq: 0,
          currentSeq: expect.any(Number),
          streamId: expect.any(String),
        }),
      );
      await sleep(25);
      expect(connection.ws.sent).toContainEqual(
        expect.objectContaining({
          type: "event",
          event: "run.event",
          payload: expect.objectContaining({
            streamId: stream.payload.streamId,
            event: expect.any(String),
            seq: expect.any(Number),
            stateVersion: expect.any(Number),
          }),
        }),
      );

      const framesBeforeRestart = await rpc(gateway, connection, "frames.list", { runId, limit: 20 });
      const attemptsBeforeRestart = await rpc(gateway, connection, "attempts.list", { runId });
      expect(framesBeforeRestart.ok).toBe(true);
      expect(attemptsBeforeRestart.ok).toBe(true);
      await archiveProbeTrace("pre-kill-context.json", {
        correlationId: `${PROBE_ID}:pre-kill`,
        run: normalizeRun(paused.payload),
        checkpoint: checkpointBeforeRestart,
        frames: framesBeforeRestart.payload,
        attempts: attemptsBeforeRestart.payload,
      });

      await gateway.close();
      const recoveredDbPath =
        process.env.P_SMITHERS_RBG_DISABLE_CHECKPOINTING === "1"
          ? makeDbPath("checkpoint-disabled")
          : runtime.dbPath;

      const recoveredRuntime = createRuntime("lifecycle-recovered", recoveredDbPath);
      const recoveredGateway = new Gateway({ heartbeatMs: 1_000, eventWindowSize: 200 });
      const recoveredConnection = createConnection("probe:recovered");
      recoveredGateway.connections.add(recoveredConnection as any);
      recoveredGateway.register("durable", recoveredRuntime.workflow);

      try {
        const recovered = await rpc(recoveredGateway, recoveredConnection, "runs.get", { runId });
        expect(recovered.ok).toBe(true);
        expect(normalizeRun(recovered.payload)).toEqual(normalizeRun(paused.payload));

        const recoveredCheckpoint = await getNodeOutput(
          recoveredGateway,
          recoveredConnection,
          runId,
          "checkpoint",
        );
        expect(recoveredCheckpoint.row).toEqual(checkpointBeforeRestart.row);

        const explicitResume = await rpc(recoveredGateway, recoveredConnection, "resumeRun", { runId });
        expect(explicitResume.ok).toBe(true);
        expect(explicitResume.payload).toEqual({ runId, status: "resume_requested" });

        const steer = await rpc(recoveredGateway, recoveredConnection, "submitSignal", {
          runId,
          signalName: "steer",
          correlationId: seed,
          data: {
            command: "tighten-scope",
            injection: "gateway-signal-mid-run",
          },
        });
        expect(steer.ok).toBe(true);
        expect(steer.payload).toEqual(
          expect.objectContaining({
            runId,
            signalName: "steer",
            correlationId: seed,
            seq: expect.any(Number),
          }),
        );

        await waitForStatus(recoveredGateway, recoveredConnection, runId, "finished");
        const completed = await getNodeOutput(recoveredGateway, recoveredConnection, runId, "complete");
        expect(completed.row).toEqual(
          expect.objectContaining({
            seed,
            command: "tighten-scope",
            injection: "gateway-signal-mid-run",
            checkpoint: "checkpoint:seed-alpha",
            parentId: "",
          }),
        );

        await assertConcurrentFleet(recoveredGateway, recoveredConnection);
        await assertForkLineageVerdict(recoveredGateway, recoveredConnection, runId);
      } finally {
        await recoveredGateway.close();
      }
    } finally {
      await gateway.close().catch(() => {});
      closeRuntime(runtime);
    }
  }, 30_000);
});

function createRuntime(label: string, dbPath = makeDbPath(label)) {
  const api = createSmithers(
    {
      checkpoint: z.object({
        seed: z.string(),
        parentId: z.string(),
        checkpoint: z.string(),
        fleetIndex: z.number(),
      }),
      steer: z.object({
        command: z.string(),
        injection: z.string(),
      }),
      complete: z.object({
        seed: z.string(),
        parentId: z.string(),
        checkpoint: z.string(),
        command: z.string(),
        injection: z.string(),
        fleetIndex: z.number(),
      }),
    },
    { dbPath, readableName: `P-SMITHERS ${label}` },
  );

  const workflow = api.smithers((ctx) => {
    const seed = String((ctx.input as any).seed ?? "");
    const parentId = String((ctx.input as any).parentId ?? "");
    const fleetIndex = Number((ctx.input as any).fleetIndex ?? -1);
    const correlationId = String((ctx.input as any).correlationId ?? seed);
    const checkpoint = `checkpoint:${seed}`;

    return React.createElement(
      api.Workflow,
      { name: "durable" },
      React.createElement(
        api.Sequence,
        null,
        React.createElement(
          api.Task,
          { id: "checkpoint", output: api.outputs.checkpoint },
          { seed, parentId, checkpoint, fleetIndex },
        ),
        React.createElement(api.Signal, {
          id: "steer",
          schema: api.outputs.steer,
          correlationId,
          children: (data: { command: string; injection: string }) =>
            React.createElement(
              api.Task,
              { id: "complete", output: api.outputs.complete },
              {
                seed,
                parentId,
                checkpoint,
                command: data.command,
                injection: data.injection,
                fleetIndex,
              },
            ),
        }),
      ),
    );
  });

  return { api, workflow, dbPath };
}

async function assertConcurrentFleet(gateway: Gateway, connection: TestConnection) {
  const seeds = ["fleet-a", "fleet-b", "fleet-c", "fleet-d", "fleet-e"];
  await Promise.all(
    seeds.map((seed, index) =>
      rpc(gateway, connection, "runs.create", {
        workflow: "durable",
        runId: `probe-${seed}`,
        input: {
          seed,
          correlationId: seed,
          fleetIndex: index,
        },
      }).then((res) => expect(res.ok).toBe(true)),
    ),
  );

  await Promise.all(
    seeds.map((seed) => waitForStatus(gateway, connection, `probe-${seed}`, "waiting-event")),
  );

  await Promise.all(
    seeds.map((seed) =>
      rpc(gateway, connection, "submitSignal", {
        runId: `probe-${seed}`,
        signalName: "steer",
        correlationId: seed,
        data: { command: `ship-${seed}`, injection: "fleet-gateway-signal" },
      }).then((res) => expect(res.ok).toBe(true)),
    ),
  );

  await Promise.all(
    seeds.map(async (seed, index) => {
      await waitForStatus(gateway, connection, `probe-${seed}`, "finished");
      const output = await getNodeOutput(gateway, connection, `probe-${seed}`, "complete");
      expect(output.row).toEqual(
        expect.objectContaining({
          seed,
          fleetIndex: index,
          command: `ship-${seed}`,
          injection: "fleet-gateway-signal",
        }),
      );
    }),
  );
}

async function assertForkLineageVerdict(
  gateway: Gateway,
  connection: TestConnection,
  parentRunId: string,
) {
  const nativeForkRpc = await rpc(gateway, connection, "forkRun", {
    runId: parentRunId,
    frameNo: 1,
  });
  expect(nativeForkRpc.ok).toBe(false);
  expect(nativeForkRpc.error?.code).toBe("METHOD_NOT_FOUND");

  const childRunId = "probe-run-child-seeded";
  const child = await rpc(gateway, connection, "runs.create", {
    workflow: "durable",
    runId: childRunId,
    input: {
      seed: "seed-child",
      correlationId: "seed-child",
      parentId: parentRunId,
      fleetIndex: 99,
    },
  });
  expect(child.ok).toBe(true);
  await waitForStatus(gateway, connection, childRunId, "waiting-event");

  const checkpoint = await getNodeOutput(gateway, connection, childRunId, "checkpoint");
  expect(checkpoint.row).toEqual(
    expect.objectContaining({
      seed: "seed-child",
      parentId: parentRunId,
      checkpoint: "checkpoint:seed-child",
    }),
  );

  await archiveProbeTrace("fork-realization.json", {
    correlationId: `${PROBE_ID}:fork`,
    verdict: "seeded-parentId-lineage-for-gateway-v0",
    nativeForkRpc: {
      available: false,
      errorCode: nativeForkRpc.error?.code,
    },
    child: {
      runId: childRunId,
      parentId: parentRunId,
      checkpoint: checkpoint.row,
    },
  });
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

async function getNodeOutput(
  gateway: Gateway,
  connection: TestConnection,
  runId: string,
  nodeId: string,
) {
  const response = await rpc(gateway, connection, "getNodeOutput", {
    runId,
    nodeId,
    iteration: 0,
  });
  expect(response.ok).toBe(true);
  expect(response.payload.status).toBe("produced");
  return response.payload;
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

function makeDbPath(label: string) {
  const dir = mkdtempSync(join(tmpdir(), `p-smithers-${label}-`));
  tempDirs.push(dir);
  return join(dir, "smithers.db");
}

function closeRuntime(runtime: ReturnType<typeof createRuntime>) {
  try {
    runtime.api.db?.$client?.close?.();
  } catch {
    // Test cleanup must not mask the assertion that already failed.
  }
}

function normalizeRun(run: any) {
  return {
    runId: run.runId,
    workflowKey: run.workflowKey,
    workflowName: run.workflowName,
    status: run.status,
    summary: run.summary,
    runStateStatus: run.runState?.status,
  };
}

async function archiveProbeTrace(name: string, value: unknown) {
  await mkdir(TRACE_DIR, { recursive: true });
  await writeFile(join(TRACE_DIR, name), JSON.stringify(value, null, 2) + "\n");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
