import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { Gateway, createSmithers } from "smithers-orchestrator";
import { z } from "zod";
import { MemoryCorrelationStore } from "../../src/seam/correlation-store";
import { SeamDispatcher } from "../../src/seam/dispatcher";
import { GatewaySmithersClient, InProcessGatewayTransport } from "../../src/seam/smithers-client";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("seam slice spine e2e", () => {
  test("real durable spawn confirms within 3 seconds through the Gateway path", async () => {
    const runtime = createRuntime("spine");
    const gateway = new Gateway({ heartbeatMs: 1_000, eventWindowSize: 200 });
    const connection = createConnection("spine");
    gateway.connections.add(connection as any);
    gateway.register("panopticon-spine", runtime.workflow as any);

    const store = new MemoryCorrelationStore();
    const client = new GatewaySmithersClient({
      transport: new InProcessGatewayTransport(gateway as any, connection),
      correlations: store,
      defaultWorkflow: "panopticon-spine",
    });
    const dispatcher = new SeamDispatcher({ client, correlations: store, sessionId: "spine-e2e" });

    try {
      const startedAt = performance.now();
      const accepted = await dispatcher.dispatch({
        type: "spawn",
        targetUPID: null,
        payload: {
          upid: "upid-spine-001",
          runId: "run-spine-001",
          workflow: "panopticon-spine",
          callsign: "Atlas",
          steeringWindowId: "window-spine-001",
          seed: "spine spawn",
          input: {
            seed: "spine spawn",
          },
        },
        correlationId: "corr-spine-001",
      });
      expect(accepted.accepted).toBe(true);
      await dispatcher.drain();
      if (process.env.PANOP_RBG_SLOW_SEAM === "1") {
        await sleep(3_250);
      }
      const confirmedMs = performance.now() - startedAt;

      expect(confirmedMs).toBeLessThanOrEqual(3_000);
      await waitForStatus(gateway, connection, "run-spine-001", "waiting-event");
      expect(await store.findByUPID("upid-spine-001")).toEqual(
        expect.objectContaining({
          runId: "run-spine-001",
          callsign: "Atlas",
          steeringWindowId: "window-spine-001",
        }),
      );
    } finally {
      await gateway.close().catch(() => {});
      closeRuntime(runtime);
    }
  }, 10_000);
});

function createRuntime(label: string) {
  const dir = mkdtempSync(join(tmpdir(), `panop-spine-${label}-`));
  tempDirs.push(dir);
  const api = createSmithers(
    {
      checkpoint: z.object({
        seed: z.string(),
        upid: z.string(),
        callsign: z.string().nullable(),
      }),
      steer: z.object({ command: z.string().optional() }),
    },
    { dbPath: join(dir, "smithers.db"), readableName: `Panopticon spine ${label}` },
  );
  const workflow = api.smithers((ctx) => {
    const input = ctx.input as any;
    return React.createElement(
      api.Workflow,
      { name: "panopticon-spine" },
      React.createElement(
        api.Sequence,
        null,
        React.createElement(
          api.Task,
          { id: "checkpoint", output: api.outputs.checkpoint },
          {
            seed: String(input.seed ?? input.prompt ?? ""),
            upid: String(input.upid ?? ""),
            callsign: typeof input.callsign === "string" ? input.callsign : null,
          } as any,
        ),
        React.createElement(api.Signal, {
          id: "steer",
          schema: api.outputs.steer,
          correlationId: String(input.correlationId ?? ""),
        }),
      ),
    );
  });
  return { api, workflow };
}

async function waitForStatus(gateway: Gateway, connection: unknown, runId: string, status: string) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    const response = await (gateway as any).routeRequest(connection, {
      type: "req",
      id: `getRun:${crypto.randomUUID()}`,
      method: "getRun",
      params: { runId },
    });
    if (response.ok && response.payload.status === status) {
      return response.payload;
    }
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${runId} to reach ${status}`);
}

function createConnection(userId: string) {
  return {
    connectionId: `${userId}:connection`,
    transport: "ws",
    authenticated: true,
    sessionToken: "spine-session",
    role: "operator",
    scopes: ["*"],
    userId,
    subscribedRuns: null,
    heartbeatTimer: null,
    devtoolsStreams: new Map(),
    runEventStreams: new Map(),
    seq: 0,
    ws: {
      OPEN: 1,
      readyState: 1,
      bufferedAmount: 0,
      sent: [],
      send(data: string) {
        this.sent.push(JSON.parse(data) as never);
      },
    },
  };
}

function closeRuntime(runtime: ReturnType<typeof createRuntime>) {
  (runtime.api.db as any)?.$client?.close?.();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
