import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createProjectorRuntime, type ProjectorRuntime, type ProjectorRuntimeEnv } from "../../src/server/composition";
import { GatewayRegistryClient } from "../../src/server/smithers-select";
import type {
  GatewayEventFrame,
  GatewayRpcTransport,
  StreamRunEventsOptions,
} from "../../src/seam/smithers-client";
import type { TranscriptObservation } from "../../src/types";

// ISSUE-0020 e2e: the full accept->spawn path on the LIVE runtime, but with the
// Smithers gateway flagged on (VIBERSYN_SMITHERS_GATEWAY_URL) and a stub transport
// standing in for the real gateway. A fired suggestion followed by a spoken "yes"
// routes through the AcceptanceController -> ProcessRegistry.spawn -> the gateway
// client, so the spawned ProjectorProcess on the snapshot carries the
// gateway-issued runId (`vibersyn-<upid>`) and that exact runId was launched over the
// transport. This proves the accept->spawn seam runs against the real gateway
// client, not just the in-memory default.

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

  launchedRunIds(): string[] {
    return this.requests
      .filter((entry) => entry.method === "launchRun")
      .map((entry) => {
        const options = entry.params?.options;
        return typeof options === "object" && options !== null
          ? String((options as Record<string, unknown>).runId)
          : "";
      });
  }
}

describe("gateway-accept-spawn e2e — say yes spawns a gateway-backed process", () => {
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  let priorCapacityGuard: string | undefined;

  beforeEach(() => {
    fetchCalls = 0;
    // The decider/ASR run with no credentials here; any network fetch is a bug and
    // the gateway itself is the injected stub, so nothing should hit the wire.
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetchCalls += 1;
      throw new Error(`unexpected network fetch in gateway accept-spawn path: ${String(args[0])}`);
    }) as unknown as typeof fetch;
    // The demo fleet seeds two processes against the default cap of two; give the
    // acceptance spawn headroom (the pre-spawn check reads this from process.env).
    priorCapacityGuard = process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK;
    process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK = "1";
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (priorCapacityGuard === undefined) {
      delete process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK;
    } else {
      process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK = priorCapacityGuard;
    }
  });

  test("accept->spawn over the gateway transport yields a real runId on the snapshot", async () => {
    const transport = new StubGatewayTransport();
    const runtime = await createProjectorRuntime(gatewayEnv(), {
      smithersTransport: transport,
      // No real coding-agent spawn in e2e: the accept path's build runs a noop.
      builderAgent: async () => undefined,
      replaySource: [
        final("let's build a dashboard tool to ship the replay prototype today", "utt-build"),
        final("yes", "utt-yes"),
      ],
    });

    // The runtime is wired to the gateway client, not the in-memory default.
    expect(runtime.registry.client).toBeInstanceOf(GatewayRegistryClient);

    const upidsBefore = new Set(runtime.snapshot().processes.map((process) => process.upid));
    const launchesBefore = transport.launchedRunIds().length;

    await driveMic(runtime);

    // Acceptance routed the affirmative and the registry spawned one new process.
    expect(runtime.trace.events().map((event) => event.event)).toContain("route.acceptance");

    const spawned = runtime.snapshot().processes.filter((process) => !upidsBefore.has(process.upid));
    expect(spawned).toHaveLength(1);
    const process = spawned[0];
    expect(process).toBeDefined();
    if (process === undefined) return;
    expect(["planning", "active"]).toContain(process.state);

    // The snapshot's runId is the gateway-issued one (`vibersyn-<upid>`), not the
    // in-memory client's `run-<upid>`.
    expect(process.runId).toBe(`vibersyn-${process.upid}`);

    // And that exact runId was launched over the gateway transport by the accept
    // path (one new launchRun beyond whatever the seeded fleet launched).
    const launches = transport.launchedRunIds();
    expect(launches.length).toBe(launchesBefore + 1);
    expect(launches).toContain(process.runId);

    // Heuristic decider + stubbed gateway only: nothing touched the network.
    expect(fetchCalls).toBe(0);
  });
});

function gatewayEnv(): ProjectorRuntimeEnv {
  return {
    VIBERSYN_SESSION_ID: "gateway-accept-spawn-e2e",
    VIBERSYN_INITIAL_MUTED: "0",
    VIBERSYN_ASR_PROVIDER: "replay",
    VIBERSYN_SMITHERS_GATEWAY_URL: "ws://gateway.local:8080",
    // Force the heuristic detector: a gateway client would otherwise select the
    // Smithers detector, which won't surface ideas through the stub transport.
    VIBERSYN_IDEA_DETECTOR: "heuristic",
    VIBERSYN_DETECT_MIN_NEW_TURNS: "1",
    VIBERSYN_DETECT_MIN_INTERVAL_MS: "0",
    VIBERSYN_DETECT_TICK_MS: "0",
  };
}

async function driveMic(runtime: ProjectorRuntime): Promise<void> {
  const session = runtime.startMicSession("corr-gateway-accept-spawn-e2e");
  await session.stop();
  await runtime.detection.flush();
}

function final(text: string, utteranceId: string): TranscriptObservation {
  return { text, isFinal: true, speaker: "Room", sessionId: "gateway-accept-spawn-e2e", latencyMs: 20, utteranceId };
}
