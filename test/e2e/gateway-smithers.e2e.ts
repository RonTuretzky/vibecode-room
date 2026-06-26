import { describe, expect, test } from "bun:test";
import { createProjectorRuntime, type ProjectorRuntimeEnv } from "../../src/server/composition";
import { MemorySmithersClient } from "../../src/process/test-helpers";
import { GatewayRegistryClient } from "../../src/server/smithers-select";
import type { GatewayEventFrame, GatewayRpcTransport, StreamRunEventsOptions } from "../../src/seam/smithers-client";

// ISSUE-0011 e2e (GAP-004): the live runtime drives a real-run gateway when the
// gateway flag is set, and stays in-memory by default. A stub transport stands in
// for the real gateway so the seeded fleet's spawns surface as launchRun RPCs with
// no network. The seed step (createProjectorRuntime -> seedDemoFleet) is the
// accepted spawn that must reach the transport.

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
  return { PANOP_SESSION_ID: "gateway-smithers-e2e", PANOP_INITIAL_MUTED: "1" };
}

describe("gateway-smithers e2e — live runtime drives the gateway when flagged", () => {
  test("gateway env + stub transport records launchRun on an accepted spawn", async () => {
    const transport = new StubGatewayTransport();
    const env: ProjectorRuntimeEnv = { ...baseEnv(), PANOP_SMITHERS_GATEWAY_URL: "ws://gateway.local:8080" };

    const runtime = await createProjectorRuntime(env, { smithersTransport: transport });

    // The seeded fleet (Atlas + Cobalt) spawns through the gateway client.
    expect(runtime.registry.client).toBeInstanceOf(GatewayRegistryClient);
    expect(transport.methods()).toContain("launchRun");
    const launchCount = transport.requests.filter((entry) => entry.method === "launchRun").length;
    expect(launchCount).toBe(2);
    expect(runtime.registry.activeRecords().length).toBe(2);
  });

  test("no gateway config -> runtime stays on the in-memory client", async () => {
    const runtime = await createProjectorRuntime(baseEnv());
    expect(runtime.registry.client).toBeInstanceOf(MemorySmithersClient);
  });
});
