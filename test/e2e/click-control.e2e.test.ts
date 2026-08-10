import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectorRuntime, type ProjectorRuntime, STEER_GRACE_MS } from "../../src/server/composition";
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
// 2) CLICK A PROJECT -> STEER IT (record-window contract): while a steering
//    target is set, FINAL transcripts COLLECT into the window slice (a
//    steering.window.collect trace per line, NO registry.steer) and never seed
//    ambient suggestions. Clearing the target opens the endpointing grace
//    (STEER_GRACE_MS); the drain then dispatches ONCE — a single registry.steer
//    carrying the joined slice — and ambient behavior resumes only after the
//    grace window lapses. Mirrors composition.steerslice.test.ts: injected
//    clock + a flush final for the lazy drain.

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
    await rm(replayDir, { recursive: true, force: true }).catch(() => undefined);
  });

  test("clicking the pending idea (acceptPendingSuggestion) yields a ready preview", async () => {
    await writeReplay([final("let's build a status board to track the migration dry run", "utt-build")]);
    runtime = await createProjectorRuntime(queueEnv(replayPath), { buildsRoot, builderAgent: noopBuilder });

    // A buildable utterance is DETECTED into a grounded idea — the popped idea
    // bubble the operator can click.
    await drive(runtime);
    expect(runtime.detection.primary()).not.toBeNull();

    const upidsBefore = new Set(runtime.snapshot().processes.map((process) => process.upid));

    // The click: accept the surfaced idea directly (no spoken "yes").
    const snapshot = await runtime.acceptPendingSuggestion("corr-click-accept");

    // Accepting consumes the detected idea (clears the bubble) and spawns a process.
    expect(runtime.detection.primary()).toBeNull();
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
    expect(await response.text()).toContain("Vibersyn prototype");
  });

  test("accept with no pending suggestion is a no-op returning the current snapshot", async () => {
    await writeReplay([]);
    runtime = await createProjectorRuntime(queueEnv(replayPath), { buildsRoot, builderAgent: noopBuilder });

    const before = runtime.snapshot();
    const after = await runtime.acceptPendingSuggestion("corr-noop");

    expect(after.processes).toHaveLength(before.processes.length);
    expect(runtime.detection.primary()).toBeNull();
  });

  test("AUTO-BUILD on: a fired idea builds itself with no click", async () => {
    // A low interrupt threshold makes the buildable utterance FIRE (not queue), and
    // VIBERSYN_AUTO_ACCEPT=1 boots with the toggle on — so driving the mic spawns a
    // build with no acceptPendingSuggestion() call.
    await writeReplay([final("let's build a status board to track the migration dry run", "utt-auto")]);
    runtime = await createProjectorRuntime(
      { ...fireEnv(replayPath), VIBERSYN_AUTO_ACCEPT: "1" },
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

  test("selecting a process COLLECTS finals in the steering window; the clear drains ONE steer dispatch", async () => {
    // Phase 1: queue + accept a suggestion so a live process exists to steer.
    let nowMs = 1_000_000;
    await writeReplay([final("let's build a status board to track the migration dry run", "utt-build")]);
    runtime = await createProjectorRuntime(queueEnv(replayPath), {
      buildsRoot,
      builderAgent: noopBuilder,
      clock: () => nowMs,
    });
    await drive(runtime);
    expect(runtime.detection.primary()).not.toBeNull();

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

    // Spy on the registry steer so we can prove the window COLLECTS (no
    // per-final dispatch) and the clear drains exactly one dispatch.
    const steerSpy = spyOn(runtime.registry, "steer");
    // The candidate count before the steered line lets us prove detection was NOT
    // driven while steering (a steered line never seeds a fresh ambient idea).
    const candidatesBefore = runtime.detection.candidates().length;

    // Phase 2: a FINAL transcript line while the steering window is open.
    await writeReplay([final("make the table sortable by column header", "utt-steer")]);
    await drive(runtime);

    // RECORD WINDOW = COLLECT ONLY: no registry.steer yet — the line joined the
    // slice and left a steering.window.collect trace for the target UPID.
    expect(steerSpy.mock.calls.length).toBe(0);
    const collects = runtime.trace
      .events()
      .filter((event) => event.event === "steering.window.collect" && event.upid === targetUpid);
    expect(collects.length).toBe(1);
    expect((collects[0]?.meta as { text?: string } | undefined)?.text).toContain("make the table sortable");

    // ...and idea detection was NOT consulted (no new candidate, no new bubble).
    expect(runtime.detection.candidates().length).toBe(candidatesBefore);
    expect(runtime.detection.primary()).toBeNull();

    // Phase 3: the clear opens the endpointing grace — still nothing dispatched.
    runtime.clearSteeringTarget("corr-click-steer-off");
    expect(steerSpy.mock.calls.length).toBe(0);

    // Once the grace lapses, the next FINAL triggers the lazy drain: ONE
    // registry.steer carrying the joined window slice.
    nowMs += STEER_GRACE_MS + 1_000;
    await writeReplay([final("unrelated room chatter drifting by", "utt-flush")]);
    await drive(runtime);

    expect(steerSpy.mock.calls.length).toBe(1);
    const steerCall = steerSpy.mock.calls.find((call) => call[0] === targetUpid);
    expect(steerCall).toBeDefined();
    const payload = steerCall?.[1] as { text?: string } | undefined;
    expect(payload?.text).toContain("make the table sortable");

    steerSpy.mockRestore();
  });

  test("clearing the steering target restores ambient behavior only AFTER the endpointing grace", async () => {
    let nowMs = 2_000_000;
    await writeReplay([final("let's build a status board to track the migration dry run", "utt-build")]);
    runtime = await createProjectorRuntime(queueEnv(replayPath), {
      buildsRoot,
      builderAgent: noopBuilder,
      clock: () => nowMs,
    });
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

    const steerSpy = spyOn(runtime.registry, "steer");

    // WITHIN the endpointing grace a trailing FINAL still belongs to the
    // released window: even a buildable line joins the grace slice instead of
    // driving idea detection — no fresh bubble, no dispatch yet.
    nowMs += 1_000; // < STEER_GRACE_MS
    await writeReplay([final("let's build a poll widget to collect the room votes", "utt-trailing")]);
    await drive(runtime);
    expect(runtime.detection.primary()).toBeNull();
    expect(steerSpy.mock.calls.length).toBe(0);

    // AFTER the grace lapses, ambient behavior resumes: the lazy drain
    // dispatches the collected slice ONCE to the released target, and the
    // fresh buildable utterance surfaces a new grounded idea bubble.
    nowMs += STEER_GRACE_MS + 1_000;
    await writeReplay([final("let's create an automation platform to wrap the deploy prototype", "utt-ambient")]);
    await drive(runtime);
    expect(runtime.detection.primary()).not.toBeNull();
    expect(steerSpy.mock.calls.length).toBe(1);
    const payload = steerSpy.mock.calls[0]?.[1] as { text?: string } | undefined;
    expect(payload?.text).toContain("poll widget");

    steerSpy.mockRestore();
  });
});

// Env that lets a single short utterance QUEUE (not auto-fire) a suggestion: a
// low word floor makes it eligible, and a saturated recency interrupt weight keeps
// the interrupt cost above the low threshold so the engine queues a pending
// suggestion (which the click then accepts) instead of firing immediately.
function queueEnv(replayPath: string): Record<string, string> {
  return {
    VIBERSYN_INITIAL_MUTED: "0",
    VIBERSYN_ASR_PROVIDER: "replay",
    VIBERSYN_MIC_REPLAY_PATH: replayPath,
    // Deterministic idea detection (no model spawn), eager scheduling, no tick.
    // A low ready threshold lets a single-cue buildable utterance surface.
    VIBERSYN_IDEA_DETECTOR: "heuristic",
    VIBERSYN_DETECT_MIN_NEW_TURNS: "1",
    VIBERSYN_DETECT_MIN_INTERVAL_MS: "0",
    VIBERSYN_DETECT_TICK_MS: "0",
    VIBERSYN_DETECT_READY_THRESHOLD: "0.5",
    // No accept cooldown so a later buildable line re-surfaces after an accept.
    VIBERSYN_DETECT_ACCEPT_COOLDOWN_MS: "0",
  };
}

// Env that lets a single short buildable utterance FIRE immediately (so the
// auto-accept fire-path hook runs): low word floor + a saturated low-interrupt
// threshold so the engine never holds it back as a queued pending suggestion.
function fireEnv(replayPath: string): Record<string, string> {
  return {
    VIBERSYN_INITIAL_MUTED: "0",
    VIBERSYN_ASR_PROVIDER: "replay",
    VIBERSYN_MIC_REPLAY_PATH: replayPath,
    // Deterministic idea detection (no model spawn), eager scheduling, no tick.
    // A low ready threshold lets a single-cue buildable utterance surface.
    VIBERSYN_IDEA_DETECTOR: "heuristic",
    VIBERSYN_DETECT_MIN_NEW_TURNS: "1",
    VIBERSYN_DETECT_MIN_INTERVAL_MS: "0",
    VIBERSYN_DETECT_TICK_MS: "0",
    VIBERSYN_DETECT_READY_THRESHOLD: "0.5",
    // Legacy immediate auto-build fire: these tests assert the no-click accept
    // path itself; the quiet-period settle gate has its own timing test in
    // composition.preview.test.ts.
    VIBERSYN_AUTOBUILD_SETTLE_MS: "0",
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
  await runtime.detection.flush();
}

function final(text: string, utteranceId: string): TranscriptObservation {
  return { text, isFinal: true, speaker: "Room", sessionId: "click-control-e2e", latencyMs: 20, utteranceId };
}
