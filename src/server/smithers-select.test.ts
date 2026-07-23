import { describe, expect, test } from "bun:test";
import { ProcessRegistry } from "../process/registry";
import { MemorySmithersClient } from "../process/test-helpers";
import { MemoryCorrelationStore } from "../seam/correlation-store";
import type { GatewayEventFrame, GatewayRpcTransport, StreamRunEventsOptions } from "../seam/smithers-client";
import { GatewayRegistryClient, selectSmithersClient } from "./smithers-select";

// A transport that records every RPC call and answers them with benign payloads.
// `getRun` returns a terminal run so the gateway client's pause/resume signal-wait
// loops short-circuit without polling.
class RecordingTransport implements GatewayRpcTransport {
  readonly requests: Array<{ method: string; params?: Record<string, unknown> }> = [];

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "getRun") {
      return { status: "finished" };
    }
    return { ok: true };
  }

  async *streamRunEvents(_runId: string, _options?: StreamRunEventsOptions): AsyncIterable<GatewayEventFrame> {}

  methods(): string[] {
    return this.requests.map((entry) => entry.method);
  }
}

describe("selectSmithersClient — client selection by gateway config (unit)", () => {
  test("no gateway env returns the in-memory MemorySmithersClient default", () => {
    const client = selectSmithersClient({});
    expect(client).toBeInstanceOf(MemorySmithersClient);
  });

  test("VIBERSYN_SMITHERS_GATEWAY_URL selects the gateway-backed client", () => {
    const client = selectSmithersClient({ VIBERSYN_SMITHERS_GATEWAY_URL: "ws://gateway.local:8080" });
    expect(client).toBeInstanceOf(GatewayRegistryClient);
    expect(client).not.toBeInstanceOf(MemorySmithersClient);
  });

  test("URL plus token still selects the gateway-backed client", () => {
    const client = selectSmithersClient({
      VIBERSYN_SMITHERS_GATEWAY_URL: "ws://gateway.local:8080",
      VIBERSYN_SMITHERS_GATEWAY_TOKEN: "secret-token",
    });
    expect(client).toBeInstanceOf(GatewayRegistryClient);
  });

  test("an injected transport selects the gateway client regardless of env", () => {
    const transport = new RecordingTransport();
    const client = selectSmithersClient({}, { transport });
    expect(client).toBeInstanceOf(GatewayRegistryClient);
  });

  test("partial config (token without URL) throws a clear error, no silent fallback", () => {
    expect(() => selectSmithersClient({ VIBERSYN_SMITHERS_GATEWAY_TOKEN: "secret-token" })).toThrow(
      /VIBERSYN_SMITHERS_GATEWAY_URL is missing/u,
    );
  });

  test("blank/whitespace gateway URL is treated as unset (in-memory default)", () => {
    const client = selectSmithersClient({ VIBERSYN_SMITHERS_GATEWAY_URL: "   " });
    expect(client).toBeInstanceOf(MemorySmithersClient);
  });
});

describe("gateway-backed registry routes execute/halt through the transport (integration)", () => {
  test("KICKOFF spawn never reaches the transport; registry.execute -> launchRun and registry.halt -> cancelRun", async () => {
    const transport = new RecordingTransport();
    const correlations = new MemoryCorrelationStore();
    const client = selectSmithersClient({}, { transport, correlations });
    const registry = new ProcessRegistry({ client, sessionId: "gateway-select-itest" });

    const spawned = await registry.spawn({
      upid: "upid-gw-1",
      runId: "run-gw-1",
      callsign: "Atlas",
      workflow: "vibersyn-process",
      prompt: "ship the feature",
      input: { task: "ship the feature" },
      correlationId: "corr-gw-spawn",
    });
    expect(spawned.accepted).toBe(true);
    // TWO-STAGE PIVOT: accepting an idea is kickoff only — no gateway launch.
    expect(transport.requests).toHaveLength(0);

    // COMMISSION: the explicit execute launches the durable run, under the
    // runId pre-assigned at kickoff and a stable per-UPID idempotency key.
    const executed = await registry.execute("upid-gw-1");
    expect(executed.started).toBe(true);
    const launch = transport.requests.find((entry) => entry.method === "launchRun");
    expect(launch).toBeDefined();
    expect(launch?.params).toEqual(
      expect.objectContaining({
        workflow: "vibersyn-process",
        options: expect.objectContaining({ runId: "run-gw-1", idempotencyKey: "corr-execute-upid-gw-1" }),
      }),
    );

    // The execute must have persisted a correlation record so the halt below can
    // resolve the runId — otherwise GatewaySmithersClient.halt cannot fire cancelRun.
    expect(await correlations.findByUPID("upid-gw-1")).toEqual(
      expect.objectContaining({ runId: "run-gw-1" }),
    );

    await registry.halt("upid-gw-1", "corr-gw-halt", "panic");

    const cancel = transport.requests.find((entry) => entry.method === "cancelRun");
    expect(cancel).toBeDefined();
    expect(cancel?.params).toEqual({ runId: "run-gw-1" });
    expect(transport.methods()).toEqual(["launchRun", "cancelRun"]);
  });
});
