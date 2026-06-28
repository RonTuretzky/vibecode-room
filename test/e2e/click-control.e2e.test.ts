import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectorRuntime, type ProjectorRuntime } from "../../src/server/composition";
import type { BuilderAgent } from "../../src/server/idea-builder";
import type { TranscriptObservation } from "../../src/types";

// Inject a synthetic builder so NO real `claude` CLI is spawned in e2e: the
// no-op leaves the deterministic scaffold in place, which the assertions expect.
const noopBuilder: BuilderAgent = async () => undefined;

// e2e: CLICK-driven control on the LIVE runtime (no spoken "yes", no callsign).
//
// 1) CLICK THE IDEA BUBBLE -> BUILD: a buildable utterance QUEUES a pending
//    suggestion; calling acceptPendingSuggestion() (the /api/suggestion/accept
//    path) accepts it directly, spawning through the real accept->build->preview
//    path. The spawned process gains buildStatus "ready" + a previewUrl whose GET
//    serves the scaffolded page.
//
// 2) CLICK A PROJECT -> STEER IT: setting a steering target then feeding a FINAL
//    transcript routes that line to the process's agent loop (registry.steer for
//    that UPID) instead of seeding a fresh ambient suggestion.

describe("click-control e2e — click idea to build, click project to steer", () => {
  const realFetch = globalThis.fetch;
  let buildsRoot: string;
  let replayDir: string;
  let replayPath: string;
  let priorCapacityGuard: string | undefined;
  let runtime: ProjectorRuntime | undefined;

  beforeEach(async () => {
    buildsRoot = await mkdtemp(join(tmpdir(), "click-control-builds-"));
    replayDir = await mkdtemp(join(tmpdir(), "click-control-replay-"));
    replayPath = join(replayDir, "mic.jsonl");
    replayState.path = replayPath;
    priorCapacityGuard = process.env.PANOP_RBG_DISABLE_CAPACITY_CHECK;
    process.env.PANOP_RBG_DISABLE_CAPACITY_CHECK = "1";
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    await runtime?.ideaBuilds.stopAll().catch(() => undefined);
    runtime = undefined;
    if (priorCapacityGuard === undefined) {
      delete process.env.PANOP_RBG_DISABLE_CAPACITY_CHECK;
    } else {
      process.env.PANOP_RBG_DISABLE_CAPACITY_CHECK = priorCapacityGuard;
    }
    await rm(buildsRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(replayDir, { recursive: true, force: true }).catch(() => undefined);
  });

  test("clicking the pending idea (acceptPendingSuggestion) yields a ready preview", async () => {
    await writeReplay([final("let's build a status board to track the migration dry run", "utt-build")]);
    runtime = await createProjectorRuntime(queueEnv(replayPath), { buildsRoot, builderAgent: noopBuilder });

    // A buildable utterance queues a pending suggestion (high interrupt cost keeps
    // it from auto-firing) — the popped idea bubble the operator can click.
    await drive(runtime);
    expect(runtime.pendingSuggestion()).not.toBeNull();

    const upidsBefore = new Set(runtime.snapshot().processes.map((process) => process.upid));

    // The click: accept the pending suggestion directly (no spoken "yes").
    const snapshot = await runtime.acceptPendingSuggestion("corr-click-accept");

    // Accepting clears the pending suggestion and spawns a process.
    expect(runtime.pendingSuggestion()).toBeNull();
    const spawned = snapshot.processes.find((process) => !upidsBefore.has(process.upid));
    expect(spawned).toBeDefined();
    if (spawned === undefined) return;

    await runtime.ideaBuilds.settle(spawned.upid);

    const built = runtime.snapshot().processes.find((process) => process.upid === spawned.upid);
    expect(built?.buildStatus).toBe("ready");
    expect(built?.previewUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u);

    // The surfaced URL serves the real scaffolded prototype page.
    const response = await fetch(built!.previewUrl!);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Panopticon prototype");
  });

  test("accept with no pending suggestion is a no-op returning the current snapshot", async () => {
    await writeReplay([]);
    runtime = await createProjectorRuntime(queueEnv(replayPath), { buildsRoot, builderAgent: noopBuilder });

    const before = runtime.snapshot();
    const after = await runtime.acceptPendingSuggestion("corr-noop");

    expect(after.processes).toHaveLength(before.processes.length);
    expect(runtime.pendingSuggestion()).toBeNull();
  });

  test("AUTO-BUILD on: a fired idea builds itself with no click", async () => {
    // A low interrupt threshold makes the buildable utterance FIRE (not queue), and
    // PANOP_AUTO_ACCEPT=1 boots with the toggle on — so driving the mic spawns a
    // build with no acceptPendingSuggestion() call.
    await writeReplay([final("let's build a status board to track the migration dry run", "utt-auto")]);
    runtime = await createProjectorRuntime(
      { ...fireEnv(replayPath), PANOP_AUTO_ACCEPT: "1" },
      { buildsRoot, builderAgent: noopBuilder },
    );
    expect(runtime.autoAccept()).toBe(true);

    const upidsBefore = new Set(runtime.snapshot().processes.map((process) => process.upid));
    await drive(runtime);
    // Auto-accept runs fire-and-forget in the fire path; poll until the build lands.
    const spawned = await waitForNewProcess(runtime, upidsBefore);
    expect(spawned).toBeDefined();
    if (spawned === undefined) return;
    await runtime.ideaBuilds.settle(spawned.upid);
    expect(runtime.snapshot().processes.find((p) => p.upid === spawned.upid)?.buildStatus).toBe("ready");
  });

  test("AUTO-BUILD toggle: off then setAutoAccept(true) makes the next fired idea build itself", async () => {
    await writeReplay([final("let's build a status board to track the migration dry run", "utt-toggle")]);
    runtime = await createProjectorRuntime(fireEnv(replayPath), { buildsRoot, builderAgent: noopBuilder });
    expect(runtime.autoAccept()).toBe(false);

    const snap = runtime.setAutoAccept(true);
    expect(snap.autoAccept).toBe(true);
    expect(runtime.autoAccept()).toBe(true);

    const upidsBefore = new Set(runtime.snapshot().processes.map((process) => process.upid));
    await drive(runtime);
    const spawned = await waitForNewProcess(runtime, upidsBefore);
    expect(spawned).toBeDefined();
  });

  test("selecting a process routes the next FINAL transcript to its steer, not a new suggestion", async () => {
    // Phase 1: queue + accept a suggestion so a live process exists to steer.
    await writeReplay([final("let's build a status board to track the migration dry run", "utt-build")]);
    runtime = await createProjectorRuntime(queueEnv(replayPath), { buildsRoot, builderAgent: noopBuilder });
    await drive(runtime);
    expect(runtime.pendingSuggestion()).not.toBeNull();

    const upidsBefore = new Set(runtime.snapshot().processes.map((process) => process.upid));
    await runtime.acceptPendingSuggestion("corr-accept-for-steer");
    const spawned = runtime.snapshot().processes.find((process) => !upidsBefore.has(process.upid));
    expect(spawned).toBeDefined();
    if (spawned === undefined) return;
    const targetUpid = spawned.upid;

    // Click the project: it becomes the steering target and is surfaced on the
    // snapshot (highlight + "steering ->" indicator hang off these fields).
    const selectedSnapshot = runtime.setSteeringTarget(targetUpid, "corr-click-steer");
    expect(selectedSnapshot.steeringUpid).toBe(targetUpid);
    expect(selectedSnapshot.processes.find((p) => p.upid === targetUpid)?.steering).toBe(true);
    expect(runtime.steeringTarget()).toBe(targetUpid);

    // Spy on the registry steer so we can prove the next FINAL line routed to it.
    const steerSpy = spyOn(runtime.registry, "steer");
    const observeSpy = spyOn(runtime.suggestionEngine, "observe");

    // Phase 2: a FINAL transcript line while steering is active.
    await writeReplay([final("make the table sortable by column header", "utt-steer")]);
    await drive(runtime);

    // The registry received a steer for the target UPID carrying the transcript...
    expect(steerSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    const steerCall = steerSpy.mock.calls.find((call) => call[0] === targetUpid);
    expect(steerCall).toBeDefined();
    const payload = steerCall?.[1] as { text?: string } | undefined;
    expect(payload?.text).toContain("make the table sortable");

    // ...and the ambient suggestion engine was NOT consulted (no new suggestion).
    expect(observeSpy.mock.calls.length).toBe(0);
    expect(runtime.pendingSuggestion()).toBeNull();

    steerSpy.mockRestore();
    observeSpy.mockRestore();
  });

  test("clearing the steering target restores ambient suggestion behavior", async () => {
    await writeReplay([final("let's build a status board to track the migration dry run", "utt-build")]);
    runtime = await createProjectorRuntime(queueEnv(replayPath), { buildsRoot, builderAgent: noopBuilder });
    await drive(runtime);
    const upidsBefore = new Set(runtime.snapshot().processes.map((process) => process.upid));
    await runtime.acceptPendingSuggestion("corr-accept-clear");
    const spawned = runtime.snapshot().processes.find((process) => !upidsBefore.has(process.upid));
    expect(spawned).toBeDefined();
    if (spawned === undefined) return;

    runtime.setSteeringTarget(spawned.upid, "corr-steer-on");
    expect(runtime.steeringTarget()).toBe(spawned.upid);

    const cleared = runtime.clearSteeringTarget("corr-steer-off");
    expect(cleared.steeringUpid ?? null).toBeNull();
    expect(runtime.steeringTarget()).toBeNull();
    expect(cleared.processes.find((p) => p.upid === spawned.upid)?.steering).toBe(false);

    // With steering cleared, the next FINAL line drives the suggestion engine again.
    const observeSpy = spyOn(runtime.suggestionEngine, "observe");
    await writeReplay([final("the weather has been really nice and the coffee was good today", "utt-ambient")]);
    await drive(runtime);
    expect(observeSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    observeSpy.mockRestore();
  });
});

// Env that lets a single short utterance QUEUE (not auto-fire) a suggestion: a
// low word floor makes it eligible, and a saturated recency interrupt weight keeps
// the interrupt cost above the low threshold so the engine queues a pending
// suggestion (which the click then accepts) instead of firing immediately.
function queueEnv(replayPath: string): Record<string, string> {
  return {
    PANOP_INITIAL_MUTED: "0",
    PANOP_ASR_PROVIDER: "replay",
    PANOP_MIC_REPLAY_PATH: replayPath,
    PANOP_SUGGEST_WORD_FLOOR: "3",
    PANOP_SUGGEST_INTERRUPT_VELOCITY_WEIGHT: "0",
    PANOP_SUGGEST_INTERRUPT_RECENCY_WEIGHT: "1",
    PANOP_SUGGEST_INTERRUPT_PENDING_STEERING_WEIGHT: "0",
  };
}

// Env that lets a single short buildable utterance FIRE immediately (so the
// auto-accept fire-path hook runs): low word floor + a saturated low-interrupt
// threshold so the engine never holds it back as a queued pending suggestion.
function fireEnv(replayPath: string): Record<string, string> {
  return {
    PANOP_INITIAL_MUTED: "0",
    PANOP_ASR_PROVIDER: "replay",
    PANOP_MIC_REPLAY_PATH: replayPath,
    PANOP_SUGGEST_WORD_FLOOR: "3",
    PANOP_SUGGEST_INTERRUPT_LOW_THRESHOLD: "9999",
  };
}

// Poll the snapshot until a process not in `before` appears (auto-accept spawns
// fire-and-forget), or give up after ~2s.
async function waitForNewProcess(
  runtime: ProjectorRuntime,
  before: Set<string>,
): Promise<{ upid: string } | undefined> {
  for (let i = 0; i < 100; i++) {
    const found = runtime.snapshot().processes.find((process) => !before.has(process.upid));
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return undefined;
}

async function writeReplay(observations: TranscriptObservation[]): Promise<void> {
  await writeFile(replayState.path, observations.map((o) => JSON.stringify(o)).join("\n"), "utf8");
}

// The replay file path is rebound per-test in beforeEach; this indirection lets
// writeReplay() target the current test's file without threading it through args.
const replayState = { path: "" } as { path: string };

async function drive(runtime: ProjectorRuntime): Promise<void> {
  const session = runtime.startMicSession(`corr-drive-${Math.random().toString(36).slice(2)}`);
  await session.stop();
}

function final(text: string, utteranceId: string): TranscriptObservation {
  return { text, isFinal: true, speaker: "Room", sessionId: "click-control-e2e", latencyMs: 20, utteranceId };
}
