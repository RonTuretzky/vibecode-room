import { describe, expect, test } from "bun:test";
import { createProjectorRuntime, type ProjectorRuntimeEnv } from "../../src/server/composition";
import { MemorySmithersClient } from "../../src/process/test-helpers";
import { GatewayRegistryClient } from "../../src/server/smithers-select";
import type { GatewayEventFrame, GatewayRpcTransport, StreamRunEventsOptions } from "../../src/seam/smithers-client";

// ISSUE-0011 e2e (GAP-004), updated for the TWO-STAGE PIVOT: the live runtime
// selects the gateway client when the gateway flag is set, and stays in-memory
// by default. A stub transport stands in for the real gateway. Since the pivot
// a spawn (including the seeded fleet's) is KICKOFF ONLY and launches nothing;
// the explicit COMMISSION (executeProcess) is what surfaces as a launchRun RPC.

class StubGatewayTransport implements GatewayRpcTransport {
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

function baseEnv(): ProjectorRuntimeEnv {
  // No Deepgram key -> replay ASR; in-memory decider stays no-network.
  return { VIBERSYN_SESSION_ID: "gateway-smithers-e2e", VIBERSYN_INITIAL_MUTED: "1" };
}

describe("gateway-smithers e2e — live runtime drives the gateway when flagged", () => {
  test("gateway env + stub transport: spawn is kickoff-only, commission records launchRun", async () => {
    const transport = new StubGatewayTransport();
    // Opt into the seeded fleet so there are live processes to commission.
    const env: ProjectorRuntimeEnv = {
      ...baseEnv(),
      VIBERSYN_SEED_DEMO_FLEET: "1",
      VIBERSYN_SMITHERS_GATEWAY_URL: "ws://gateway.local:8080",
    };

    const runtime = await createProjectorRuntime(env, { smithersTransport: transport });

    // The seeded fleet (Atlas + Cobalt) registers through the gateway client,
    // but KICKOFF launches nothing on the gateway (two-stage pivot).
    expect(runtime.registry.client).toBeInstanceOf(GatewayRegistryClient);
    expect(runtime.registry.activeRecords().length).toBe(2);
    expect(transport.requests.filter((entry) => entry.method === "launchRun")).toHaveLength(0);

    // COMMISSION one process: exactly one launchRun reaches the transport.
    const upid = runtime.registry.activeRecords()[0]!.upid;
    const executed = await runtime.executeProcess(upid);
    expect(executed.ok).toBe(true);
    expect(transport.methods()).toContain("launchRun");
    expect(transport.requests.filter((entry) => entry.method === "launchRun")).toHaveLength(1);
  });

  test("no gateway config -> runtime stays on the in-memory client", async () => {
    const runtime = await createProjectorRuntime(baseEnv());
    expect(runtime.registry.client).toBeInstanceOf(MemorySmithersClient);
  });
});
