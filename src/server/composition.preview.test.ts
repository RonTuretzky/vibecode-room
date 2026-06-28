import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectorRuntime, type ProjectorRuntime } from "./composition";
import type { BuilderAgent } from "./idea-builder";
import type { TranscriptObservation } from "../types";

// A no-op builder leaves the deterministic scaffold in place so the existing
// scaffold assertions hold; no real `claude` CLI is ever spawned in tests.
const noopBuilder: BuilderAgent = async () => undefined;

// Integration: the LIVE runtime accept path triggers a REAL accept->build->preview
// build. A fired suggestion + a spoken "yes" routes through the
// AcceptanceController -> ProcessRegistry.spawn, which kicks off idea-builder; the
// spawned process gains previewUrl + buildStatus "ready" on the snapshot and the
// URL serves the scaffolded page. No stubs: real files + a real loopback server.

describe("composition accept path — real build + preview on the snapshot", () => {
  const realFetch = globalThis.fetch;
  let buildsRoot: string;
  let priorCapacityGuard: string | undefined;
  let runtime: ProjectorRuntime | undefined;

  beforeEach(async () => {
    buildsRoot = await mkdtemp(join(tmpdir(), "composition-preview-"));
    // The demo fleet seeds two processes against the default cap of two; give the
    // acceptance spawn headroom (the pre-spawn check reads this from process.env).
    priorCapacityGuard = process.env.PANOP_RBG_DISABLE_CAPACITY_CHECK;
    process.env.PANOP_RBG_DISABLE_CAPACITY_CHECK = "1";
  });

  afterEach(async () => {
    // Real fetch must remain available for the live preview server probe.
    globalThis.fetch = realFetch;
    await runtime?.ideaBuilds.stopAll().catch(() => undefined);
    runtime = undefined;
    if (priorCapacityGuard === undefined) {
      delete process.env.PANOP_RBG_DISABLE_CAPACITY_CHECK;
    } else {
      process.env.PANOP_RBG_DISABLE_CAPACITY_CHECK = priorCapacityGuard;
    }
    await rm(buildsRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  test("a spoken 'yes' spawns a process that gains previewUrl + buildStatus 'ready'", async () => {
    runtime = await createProjectorRuntime(liveEnv(), {
      buildsRoot,
      builderAgent: noopBuilder,
      replaySource: [
        final("let's build a dashboard tool to ship the replay prototype today", "utt-build"),
        final("yes", "utt-yes"),
      ],
    });
    const upidsBefore = new Set(runtime.snapshot().processes.map((process) => process.upid));

    const session = runtime.startMicSession("corr-composition-preview");
    await session.stop();

    const spawned = runtime.snapshot().processes.find((process) => !upidsBefore.has(process.upid));
    expect(spawned).toBeDefined();
    if (spawned === undefined) return;

    // The build is fire-and-forget on spawn; await it to reach a terminal state.
    await runtime.ideaBuilds.settle(spawned.upid);

    const built = runtime.snapshot().processes.find((process) => process.upid === spawned.upid);
    expect(built?.buildStatus).toBe("ready");
    expect(built?.previewUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u);

    // The surfaced URL serves the real scaffolded page.
    const response = await fetch(built!.previewUrl!);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Panopticon prototype");
  });

  test("an injected real builder's output reaches the snapshot's preview building -> ready", async () => {
    const marker = "INJECTED-AGENT-APP-9f2c";
    const builder: BuilderAgent = async (_pitch, dir) => {
      await writeFile(join(dir, "index.html"), `<!doctype html><title>${marker}</title><h1>${marker}</h1>`, "utf8");
    };
    runtime = await createProjectorRuntime(liveEnv(), {
      buildsRoot,
      builderAgent: builder,
      replaySource: [
        final("let's build a dashboard tool to ship the replay prototype today", "utt-build"),
        final("yes", "utt-yes"),
      ],
    });
    const upidsBefore = new Set(runtime.snapshot().processes.map((process) => process.upid));

    const session = runtime.startMicSession("corr-composition-preview-injected");
    await session.stop();

    const spawned = runtime.snapshot().processes.find((process) => !upidsBefore.has(process.upid));
    expect(spawned).toBeDefined();
    if (spawned === undefined) return;

    await runtime.ideaBuilds.settle(spawned.upid);

    const built = runtime.snapshot().processes.find((process) => process.upid === spawned.upid);
    expect(built?.buildStatus).toBe("ready");
    expect(built?.previewUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u);

    // The served page reflects the injected builder's real output, not the
    // deterministic template scaffold.
    const response = await fetch(built!.previewUrl!);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain(marker);
    expect(body).not.toContain("Panopticon prototype");
  });

  test("an idle live runtime has no processes (no build, no fixtures)", async () => {
    runtime = await createProjectorRuntime(liveEnv(), { buildsRoot, replaySource: [] });
    // The seeded demo fleet is off by default: an idle runtime has zero processes
    // until a real idea is accepted, so there is nothing carrying a build at all.
    expect(runtime.snapshot().processes).toHaveLength(0);
  });

  test("emergency stop tears the live preview server down so its URL stops responding", async () => {
    runtime = await createProjectorRuntime(liveEnv(), {
      buildsRoot,
      builderAgent: noopBuilder,
      replaySource: [
        final("let's build a dashboard tool to ship the replay prototype today", "utt-build"),
        final("yes", "utt-yes"),
      ],
    });
    const upidsBefore = new Set(runtime.snapshot().processes.map((process) => process.upid));

    const session = runtime.startMicSession("corr-composition-preview-stop");
    await session.stop();

    const spawned = runtime.snapshot().processes.find((process) => !upidsBefore.has(process.upid));
    expect(spawned).toBeDefined();
    if (spawned === undefined) return;
    await runtime.ideaBuilds.settle(spawned.upid);

    const url = runtime.snapshot().processes.find((process) => process.upid === spawned.upid)?.previewUrl;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u);
    expect((await fetch(url!)).status).toBe(200);

    // The kill-all halts the process AND tears its preview server down: the URL no
    // longer connects, and the snapshot drops previewUrl/buildStatus for the dead
    // process.
    await runtime.emergencyStop("corr-emergency-preview");
    await expect(fetch(url!)).rejects.toBeDefined();

    const halted = runtime.snapshot().processes.find((process) => process.upid === spawned.upid);
    expect(halted?.previewUrl ?? null).toBeNull();
    expect(halted?.buildStatus ?? null).toBeNull();
  });
});

function liveEnv(): Record<string, string> {
  return {
    PANOP_INITIAL_MUTED: "0",
    PANOP_ASR_PROVIDER: "replay",
    PANOP_SUGGEST_WORD_FLOOR: "3",
    PANOP_SUGGEST_INTERRUPT_VELOCITY_WEIGHT: "0",
    PANOP_SUGGEST_INTERRUPT_RECENCY_WEIGHT: "0",
    PANOP_SUGGEST_INTERRUPT_PENDING_STEERING_WEIGHT: "0",
  };
}

function final(text: string, utteranceId: string): TranscriptObservation {
  return { text, isFinal: true, speaker: "Room", sessionId: "composition-preview", latencyMs: 20, utteranceId };
}
