import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createProjectorRuntime, type ProjectorRuntime, type ProjectorRuntimeEnv } from "../../src/server/composition";
import { GatewayRegistryClient } from "../../src/server/smithers-select";
import type {
  GatewayEventFrame,
  GatewayRpcTransport,
  StreamRunEventsOptions,
} from "../../src/seam/smithers-client";
import type { TranscriptObservation } from "../../src/types";

// ISSUE-0021 e2e, updated for the TWO-STAGE PIVOT: a COMMISSIONED run's LIVE
// gateway events reach the published process snapshot. With the Smithers
// gateway flagged on and a stub transport, a fired suggestion + a spoken "yes"
// spawns a KICKOFF-ONLY process (no gateway launch, no stream); the explicit
// executeProcess commission then launches the durable run and subscribes it to
// the transport's streamRunEvents. Synthetic GatewayEventFrames then drive the
// process's progress/lastOutput/state (and the execution lane's percent) on
// the published snapshot — while the seeded fleet (no live run) keeps its
// fixtures.

// Frames the stub gateway replays for the one streamed run. node.started keeps the
// run "active" mid-stream; node.output advances progress and carries the summary
// that must surface as the process's lastOutput.
const RUN_FRAMES: GatewayEventFrame[] = [
  { event: "node.started", payload: { seq: 1, summary: "Scaffolding the dashboard route" }, seq: 1 },
  { event: "node.output", payload: { seq: 2, summary: "Wired the live progress panel" }, seq: 2 },
];

class StubGatewayTransport implements GatewayRpcTransport {
  readonly requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
  readonly streamedRunIds: string[] = [];

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "getRun") {
      return { status: "finished" };
    }
    return { ok: true };
  }

  async *streamRunEvents(runId: string, options?: StreamRunEventsOptions): AsyncIterable<GatewayEventFrame> {
    this.streamedRunIds.push(runId);
    for (const frame of RUN_FRAMES) {
      if ((frame.seq ?? 0) <= (options?.afterSeq ?? 0)) {
        continue;
      }
      yield frame;
    }
  }

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

describe("run-events-snapshot e2e — live run progress reaches the published snapshot", () => {
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  let priorCapacityGuard: string | undefined;

  beforeEach(() => {
    fetchCalls = 0;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetchCalls += 1;
      throw new Error(`unexpected network fetch in the run-events snapshot path: ${String(args[0])}`);
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

  test("streamed GatewayEventFrames overlay the spawned process, not the fixture", async () => {
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

    expect(runtime.registry.client).toBeInstanceOf(GatewayRegistryClient);

    const seededUpids = new Set(runtime.snapshot().processes.map((process) => process.upid));

    // Drive accept->spawn: KICKOFF only. The registry spawns one process but
    // launches nothing on the gateway and streams nothing.
    await driveMic(runtime);

    const spawned = runtime.snapshot().processes.find((process) => !seededUpids.has(process.upid));
    expect(spawned).toBeDefined();
    if (spawned === undefined) return;
    expect(transport.launchedRunIds()).toHaveLength(0);
    expect(transport.streamedRunIds).toHaveLength(0);

    // COMMISSION: the explicit execute launches the durable run and subscribes
    // its live event stream.
    const executed = await runtime.executeProcess(spawned.upid);
    expect(executed.ok).toBe(true);
    // The commission launches under exactly the runId the snapshot advertised
    // (a per-boot nonce is folded in, so assert against the advertised id rather
    // than a hardcoded `vibersyn-<upid>`).
    expect(transport.launchedRunIds()).toEqual([spawned.runId]);

    // Wait for the in-flight subscription to fold in the live frames, then the
    // republish-driven snapshot reflects the overlay.
    await runtime.runEventDriver.idle();

    const overlaid = runtime.snapshot().processes.find((process) => process.upid === spawned.upid);
    expect(overlaid).toBeDefined();
    if (overlaid === undefined) return;

    // The commission execution lane is on the snapshot, fed by the same frames.
    const lane = (overlaid as { execution?: { status: string; percent: number; runId: string } }).execution;
    expect(lane).toMatchObject({ status: "executing", percent: 24, runId: spawned.runId });

    // The live frames — NOT the fixture/registry default — now drive the panel.
    expect(overlaid.state).toBe("active");
    expect(overlaid.lastOutput).toBe("Wired the live progress panel");
    expect(overlaid.progress).toBe(24); // last applied seq 2 * 12
    expect(overlaid.lastOutput).not.toBe("spawn");
    expect(overlaid.progress).toBeGreaterThan(0);

    // The runtime streamed exactly the spawned run's gateway-issued runId.
    expect(transport.streamedRunIds).toContain(spawned.runId);

    // The seeded fleet has no live run, so its fixtures are untouched.
    const seeded = runtime.snapshot().processes.filter((process) => seededUpids.has(process.upid));
    expect(seeded.length).toBeGreaterThan(0);
    for (const process of seeded) {
      expect(process.lastOutput).not.toBe("Wired the live progress panel");
    }

    // Heuristic decider + stubbed gateway only: nothing touched the network.
    expect(fetchCalls).toBe(0);
  });
});

function gatewayEnv(): ProjectorRuntimeEnv {
  return {
    VIBERSYN_SESSION_ID: "run-events-snapshot-e2e",
    VIBERSYN_INITIAL_MUTED: "0",
    VIBERSYN_ASR_PROVIDER: "replay",
    // Opt into the seeded demo fleet: this test asserts the spawned run's live
    // overlay does NOT touch the (no-live-run) seeded fixtures, so it needs them.
    VIBERSYN_SEED_DEMO_FLEET: "1",
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
  const session = runtime.startMicSession("corr-run-events-snapshot-e2e");
  await session.stop();
  await runtime.detection.flush();
}

function final(text: string, utteranceId: string): TranscriptObservation {
  return { text, isFinal: true, speaker: "Room", sessionId: "run-events-snapshot-e2e", latencyMs: 20, utteranceId };
}
