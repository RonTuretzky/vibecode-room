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
// build. A detected idea + a spoken "yes" routes through the AcceptanceController
// -> ProcessRegistry.spawn, which kicks off idea-builder; the spawned process
// gains previewUrl + buildStatus "ready" on the snapshot and the URL serves the
// scaffolded page. Idea detection is the (deterministic heuristic) trigger.

describe("composition accept path — real build + preview on the snapshot", () => {
  const realFetch = globalThis.fetch;
  let buildsRoot: string;
  let replayPath: string;
  let priorCapacityGuard: string | undefined;
  let runtime: ProjectorRuntime | undefined;

  beforeEach(async () => {
    buildsRoot = await mkdtemp(join(tmpdir(), "composition-preview-"));
    replayPath = join(buildsRoot, "mic.jsonl");
    await writeFile(replayPath, "", "utf8");
    priorCapacityGuard = process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK;
    process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK = "1";
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    await runtime?.ideaBuilds.stopAll().catch(() => undefined);
    runtime = undefined;
    if (priorCapacityGuard === undefined) {
      delete process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK;
    } else {
      process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK = priorCapacityGuard;
    }
    await rm(buildsRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  // Feed observations through one mic session and await both the detection round
  // and any fire-and-forget bubble delivery, so state has settled on return.
  async function drive(obs: TranscriptObservation[]): Promise<void> {
    await writeFile(replayPath, obs.map((o) => JSON.stringify(o)).join("\n"), "utf8");
    const session = runtime!.startMicSession("corr-composition-preview");
    await session.stop();
    await runtime!.detection.flush();
  }

  // Detect a buildable idea (phase 1), then accept it with a spoken "yes" (phase 2);
  // returns the freshly spawned process.
  async function detectThenAccept(): Promise<{ upid: string } | undefined> {
    const before = new Set(runtime!.snapshot().processes.map((process) => process.upid));
    await drive([final("let's build a dashboard tool to ship the replay prototype today", "utt-build")]);
    await drive([final("yes", "utt-yes")]);
    return runtime!.snapshot().processes.find((process) => !before.has(process.upid));
  }

  test("a spoken 'yes' spawns a process that gains previewUrl + buildStatus 'ready'", async () => {
    runtime = await createProjectorRuntime(liveEnv(replayPath), { buildsRoot, builderAgent: noopBuilder });

    const spawned = await detectThenAccept();
    expect(spawned).toBeDefined();
    if (spawned === undefined) return;

    await runtime.ideaBuilds.settle(spawned.upid);
    const built = runtime.snapshot().processes.find((process) => process.upid === spawned.upid);
    expect(built?.buildStatus).toBe("ready");
    expect(built?.previewUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u);

    const response = await fetch(built!.previewUrl!);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Vibersyn prototype");
  });

  test("an injected real builder's output reaches the snapshot's preview building -> ready", async () => {
    const marker = "INJECTED-AGENT-APP-9f2c";
    const builder: BuilderAgent = async (_pitch, dir) => {
      await writeFile(join(dir, "index.html"), `<!doctype html><title>${marker}</title><h1>${marker}</h1>`, "utf8");
    };
    runtime = await createProjectorRuntime(liveEnv(replayPath), { buildsRoot, builderAgent: builder });

    const spawned = await detectThenAccept();
    expect(spawned).toBeDefined();
    if (spawned === undefined) return;

    await runtime.ideaBuilds.settle(spawned.upid);
    const built = runtime.snapshot().processes.find((process) => process.upid === spawned.upid);
    expect(built?.buildStatus).toBe("ready");
    expect(built?.previewUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u);

    const response = await fetch(built!.previewUrl!);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain(marker);
    expect(body).not.toContain("Vibersyn prototype");
  });

  test("an idle live runtime has no processes (no build, no fixtures)", async () => {
    runtime = await createProjectorRuntime(liveEnv(replayPath), { buildsRoot });
    expect(runtime.snapshot().processes).toHaveLength(0);
  });

  test("IDEA CAPTURE mode no longer auto-builds: the idea surfaces but nothing spawns", async () => {
    runtime = await createProjectorRuntime(liveEnv(replayPath), { buildsRoot, builderAgent: noopBuilder });
    runtime.setCaptureMode(true);
    const before = new Set(runtime.snapshot().processes.map((process) => process.upid));

    // A single buildable utterance — no affirmation. Capture is DETECTION-only
    // now: the idea surfaces (bubble + tray) awaiting an explicit accept; only
    // the separate AUTO-BUILD toggle spawns without one. Give any (buggy)
    // fire-and-forget spawn a beat to appear before asserting the absence.
    await drive([final("let's build a dashboard tool to ship the replay prototype today", "utt-build")]);
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(runtime.detection.primary()).not.toBeNull();
    expect(runtime.snapshot().ideas?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(runtime.snapshot().processes.some((process) => !before.has(process.upid))).toBe(false);
    expect(runtime.snapshot().captureMode).toBe(true);
  });

  test("AUTO-BUILD builds a detected idea with no spoken 'yes' (capture mode not required)", async () => {
    runtime = await createProjectorRuntime(liveEnv(replayPath), { buildsRoot, builderAgent: noopBuilder });
    runtime.setAutoAccept(true);
    const before = new Set(runtime.snapshot().processes.map((process) => process.upid));

    // A single buildable utterance — no affirmation. AUTO-BUILD accepts the
    // surfaced idea the instant it pops. The spawn is fire-and-forget from the
    // detection callback, so poll for it to appear.
    await drive([final("let's build a dashboard tool to ship the replay prototype today", "utt-build")]);
    const spawned = await waitFor(() => runtime!.snapshot().processes.find((process) => !before.has(process.upid)));

    expect(spawned).toBeDefined();
    if (spawned === undefined) return;
    await runtime.ideaBuilds.settle(spawned.upid);
    const built = runtime.snapshot().processes.find((process) => process.upid === spawned.upid);
    expect(built?.buildStatus).toBe("ready");
    expect(runtime.snapshot().autoAccept).toBe(true);
  });

  test("emergency stop tears the live preview server down so its URL stops responding", async () => {
    runtime = await createProjectorRuntime(liveEnv(replayPath), { buildsRoot, builderAgent: noopBuilder });

    const spawned = await detectThenAccept();
    expect(spawned).toBeDefined();
    if (spawned === undefined) return;
    await runtime.ideaBuilds.settle(spawned.upid);

    const url = runtime.snapshot().processes.find((process) => process.upid === spawned.upid)?.previewUrl;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u);
    expect((await fetch(url!)).status).toBe(200);

    await runtime.emergencyStop("corr-emergency-preview");
    await expect(fetch(url!)).rejects.toBeDefined();

    const halted = runtime.snapshot().processes.find((process) => process.upid === spawned.upid);
    expect(halted?.previewUrl ?? null).toBeNull();
    expect(halted?.buildStatus ?? null).toBeNull();
  });
});

function liveEnv(replayPath: string): Record<string, string> {
  return {
    VIBERSYN_INITIAL_MUTED: "0",
    VIBERSYN_ASR_PROVIDER: "replay",
    VIBERSYN_MIC_REPLAY_PATH: replayPath,
    // Deterministic detection: heuristic, eager scheduling, no background tick.
    VIBERSYN_IDEA_DETECTOR: "heuristic",
    VIBERSYN_DETECT_MIN_NEW_TURNS: "1",
    VIBERSYN_DETECT_MIN_INTERVAL_MS: "0",
    VIBERSYN_DETECT_TICK_MS: "0",
  };
}

function final(text: string, utteranceId: string): TranscriptObservation {
  return { text, isFinal: true, speaker: "Room", sessionId: "composition-preview", latencyMs: 20, utteranceId };
}

// Poll until `fn` returns a defined value or the timeout elapses (for state set by
// a fire-and-forget callback, e.g. capture-mode auto-build).
async function waitFor<T>(fn: () => T | undefined, timeoutMs = 4000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = fn();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return fn();
}
