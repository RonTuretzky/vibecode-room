import { describe, expect, test } from "bun:test";
import { ProcessRegistry } from "../../src/process/registry";
import { MemoryCorrelationStore } from "../../src/seam/correlation-store";
import { selectSmithersClient } from "../../src/server/smithers-select";
import type {
  GatewayEventFrame,
  GatewayRpcTransport,
  StreamRunEventsOptions,
} from "../../src/seam/smithers-client";

// ISSUE-0020 integration, updated for the TWO-STAGE PIVOT: with the gateway
// client selected (here via an injected transport, the same seam
// `VIBERSYN_SMITHERS_GATEWAY_URL` turns on in production), a ProcessRegistry
// SPAWN is kickoff-only and never touches the gateway; the explicit COMMISSION
// (registry.execute) drives `launchRun` over the transport and persists a
// UPID->runId correlation record. A later halt resolves that persisted runId
// and fires `cancelRun` for it — proving the in-memory client is swappable for
// the real gateway client without the registry knowing the difference.

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

  find(method: string): { method: string; params?: Record<string, unknown> } | undefined {
    return this.requests.find((entry) => entry.method === method);
  }
}

describe("gateway commission persists a runId and halt cancels it (integration)", () => {
  test("spawn stays kickoff-only; execute drives launchRun and the persisted runId is cancelled on halt", async () => {
    const transport = new RecordingTransport();
    const correlations = new MemoryCorrelationStore();
    const client = selectSmithersClient(
      { VIBERSYN_SMITHERS_GATEWAY_URL: "ws://gateway.local:8080" },
      { transport, correlations },
    );
    const registry = new ProcessRegistry({ client, sessionId: "gateway-spawn-itest" });

    // No explicit runId on the seed: the registry pre-assigns `vibersyn-<upid>`
    // (matching the gateway client's own default) so the SAME id flows through
    // launchRun at execute time, gets persisted, and is later cancelled.
    const spawned = await registry.spawn({
      upid: "upid-itest-1",
      callsign: "Atlas",
      workflow: "vibersyn-process",
      prompt: "ship the integration",
      input: { task: "ship the integration" },
      correlationId: "corr-itest-spawn",
    });
    expect(spawned.accepted).toBe(true);
    if (!spawned.accepted) return;

    const runId = spawned.spawn.runId;
    expect(runId).toBe("vibersyn-upid-itest-1");
    // TWO-STAGE PIVOT: the accept launched nothing on the gateway.
    expect(transport.requests).toHaveLength(0);

    // COMMISSION: execute launches the durable run under the pre-assigned runId.
    const executed = await registry.execute("upid-itest-1");
    expect(executed.started).toBe(true);
    const launch = transport.find("launchRun");
    expect(launch).toBeDefined();
    expect(launch?.params).toEqual(
      expect.objectContaining({
        workflow: "vibersyn-process",
        options: expect.objectContaining({ runId, idempotencyKey: "corr-execute-upid-itest-1" }),
      }),
    );

    // The UPID->runId correlation record was persisted on execute.
    const record = await correlations.findByUPID("upid-itest-1");
    expect(record).toEqual(expect.objectContaining({ upid: "upid-itest-1", runId }));

    // Halt resolves the persisted runId and cancels exactly that run.
    await registry.halt("upid-itest-1", "corr-itest-halt", "panic");

    const cancel = transport.find("cancelRun");
    expect(cancel).toBeDefined();
    expect(cancel?.params).toEqual({ runId });

    // The registry process is now dead and the transport saw launch then cancel.
    expect(registry.activeRecords()).toHaveLength(0);
    expect(transport.methods()).toEqual(["launchRun", "cancelRun"]);
  });

  test("halt with no persisted correlation record cannot fabricate a cancel", async () => {
    const transport = new RecordingTransport();
    const correlations = new MemoryCorrelationStore();
    const client = selectSmithersClient({}, { transport, correlations });
    const registry = new ProcessRegistry({ client, sessionId: "gateway-spawn-itest-orphan" });

    // Halting an unknown UPID never spawned: registry rejects it before the client,
    // so no cancelRun is fabricated against a runId that was never launched.
    await expect(registry.halt("upid-missing", "corr-orphan", "panic")).rejects.toThrow();
    expect(transport.requests).toHaveLength(0);
  });
});
