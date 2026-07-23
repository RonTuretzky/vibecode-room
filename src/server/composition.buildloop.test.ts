import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DUPLICATE_ACCEPT_WINDOW_MS,
  createDuplicateSpawnGuard,
  createProjectorRuntime,
  normalizeAcceptPitch,
  type ProjectorRuntime,
  type ProjectorRuntimeOptions,
} from "./composition";
import type { AcceptanceSpawnSeam } from "../acceptance/spawn";
import type { BuildBackend, BuildRequest, BuildResult } from "../buildloop/types";
import type { ProcessBuild } from "../ui/buildloop";
import type { DispatchedAction, PendingSuggestion, TranscriptObservation } from "../types";

// Integration coverage for the BUILD-LOOP wiring the composition owns:
//   - accept → orchestrator fan-out → snapshot builds[] + legacy preview merge
//     + top-level backends[] + per-backend slideshow;
//   - registry.steer → orchestrator correction re-run (version cache-bust);
//   - emergency stop aborts every in-flight build inside the ~2s budget;
//   - the DUPLICATE-SPAWN GUARD (one utterance must never spawn upid-1 AND
//     upid-2) at both the pure-seam and the runtime level;
//   - VOICE CALLSIGN STEERING: "<callsign> …" selects the process and routes
//     the remainder as steer text.
// All backends are fakes — no model call, no CLI spawn, loopback servers only.

const BUILDABLE = "let's build a dashboard tool to ship the replay prototype today";

class FakeBackend implements BuildBackend {
  readonly id = "native" as const;
  readonly label = "Fake Native";
  builds = 0;
  corrections: string[] = [];
  async available(): Promise<{ ok: boolean; reason?: string }> {
    return { ok: true };
  }
  async build(req: BuildRequest): Promise<BuildResult> {
    if (typeof req.correction === "string") {
      this.corrections.push(req.correction);
    } else {
      this.builds += 1;
    }
    await Bun.write(join(req.outDir, "index.html"), `<html><body>fake build ${this.builds}</body></html>`);
    req.onProgress({ label: "ready", percent: 100 });
    return { ok: true, entrypoint: "index.html", summary: "A fake app, built instantly." };
  }
}

// Never resolves until aborted — proves the emergency stop path settles builds
// via their AbortSignal inside the budget instead of waiting them out.
class HangingBackend implements BuildBackend {
  readonly id = "native" as const;
  readonly label = "Hanging Native";
  aborted = false;
  async available(): Promise<{ ok: boolean; reason?: string }> {
    return { ok: true };
  }
  async build(req: BuildRequest): Promise<BuildResult> {
    await new Promise<void>((resolve) => {
      if (req.signal.aborted) {
        resolve();
        return;
      }
      req.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    this.aborted = true;
    return { ok: false, entrypoint: null, summary: "", error: "aborted" };
  }
}

const tempDirs: string[] = [];
let runtimes: ProjectorRuntime[] = [];
let priorCapacityGuard: string | undefined;

beforeEach(() => {
  priorCapacityGuard = process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK;
  process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK = "1";
});

afterEach(async () => {
  if (priorCapacityGuard === undefined) {
    delete process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK;
  } else {
    process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK = priorCapacityGuard;
  }
  for (const runtime of runtimes) {
    await runtime.buildOrchestrator.abortEverything().catch(() => undefined);
    await runtime.ideaBuilds.stopAll().catch(() => undefined);
  }
  runtimes = [];
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("buildloop wiring — accept fans out through the orchestrator", () => {
  test("an accepted idea yields builds[] + merged legacy preview + backends[] + slideshow on the snapshot", async () => {
    const backend = new FakeBackend();
    const { runtime } = await makeRuntime({ buildBackends: [backend] });
    await drive(runtime, [final(BUILDABLE, "utt-build")]);
    expect(runtime.detection.primary()).not.toBeNull();

    await runtime.acceptPendingSuggestion("corr-buildloop-accept");
    const upid = runtime.snapshot().processes[0]?.upid;
    expect(upid).toBeDefined();
    if (upid === undefined) return;

    await waitFor(() => runtime.registry.builds(upid).some((build) => build.status === "ready"));
    // The slideshow hook (real generateSlideshow, deterministic no-key fallback)
    // flips slideshowUrl on after ready.
    await waitFor(() => runtime.registry.builds(upid)[0]?.slideshowUrl !== null);

    const snapshot = runtime.snapshot();
    const process = snapshot.processes.find((entry) => entry.upid === upid);
    expect(process).toBeDefined();
    const builds = (process as { builds?: ProcessBuild[] }).builds ?? [];
    expect(builds).toHaveLength(1);
    expect(builds[0]?.backend).toBe("native");
    expect(builds[0]?.status).toBe("ready");
    expect(builds[0]?.summary).toBe("A fake app, built instantly.");
    expect(builds[0]?.previewUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/native\/\?v=1$/u);
    expect(builds[0]?.slideshowUrl).toMatch(/\/native\/slideshow\/\?v=1$/u);
    // Legacy fields merge from the orchestrated builds (mergeLegacyBuildState).
    expect(process?.buildStatus).toBe("ready");
    expect(process?.previewUrl).toBe(builds[0]?.previewUrl ?? null);
    // Top-level backends[] mirrors the selector roster.
    const backends = (snapshot as { backends?: Array<{ id: string; enabled: boolean; available: boolean }> }).backends ?? [];
    expect(backends.map((chip) => chip.id)).toEqual(["native"]);
    expect(backends[0]?.enabled).toBe(true);
    expect(backends[0]?.available).toBe(true);

    // The per-backend preview URL actually serves the built app.
    const response = await fetch(builds[0]!.previewUrl!);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("fake build 1");
    // And the slideshow deck is reachable too.
    const slides = await fetch(builds[0]!.slideshowUrl!);
    expect(slides.status).toBe(200);
  });

  test("registry.steer re-runs ready builds with the correction and bumps the cache-bust version", async () => {
    const backend = new FakeBackend();
    const { runtime } = await makeRuntime({ buildBackends: [backend] });
    await drive(runtime, [final(BUILDABLE, "utt-build")]);
    await runtime.acceptPendingSuggestion("corr-steer-accept");
    const upid = runtime.snapshot().processes[0]?.upid;
    expect(upid).toBeDefined();
    if (upid === undefined) return;
    await waitFor(() => runtime.registry.builds(upid).some((build) => build.status === "ready"));

    await runtime.registry.steer(upid, { text: "make the header blue", source: "test" }, "corr-steer");
    await waitFor(() => backend.corrections.length === 1);
    expect(backend.corrections[0]).toBe("make the header blue");
    await waitFor(() => runtime.registry.builds(upid)[0]?.previewUrl?.endsWith("?v=2") === true);
    expect(runtime.registry.builds(upid)[0]?.status).toBe("ready");
  });

  test("emergency stop aborts an in-flight build via its AbortSignal inside the budget", async () => {
    const backend = new HangingBackend();
    const { runtime } = await makeRuntime({ buildBackends: [backend] });
    await drive(runtime, [final(BUILDABLE, "utt-build")]);
    await runtime.acceptPendingSuggestion("corr-emergency-accept");
    const upid = runtime.snapshot().processes[0]?.upid;
    expect(upid).toBeDefined();
    if (upid === undefined) return;
    await waitFor(() => runtime.registry.builds(upid).some((build) => build.status === "building"));

    const startedAt = Date.now();
    await runtime.emergencyStop("corr-emergency");
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    await waitFor(() => backend.aborted);
    // The halted process shows no builds (servers down, state forgotten).
    expect(runtime.registry.builds(upid)).toHaveLength(0);
  });
});

describe("duplicate-spawn guard", () => {
  test("normalizeAcceptPitch folds case, punctuation, and whitespace", () => {
    expect(normalizeAcceptPitch("  Build a Status Board!  ")).toBe("build a status board");
    expect(normalizeAcceptPitch("build   a status-board")).toBe("build a status board");
    expect(normalizeAcceptPitch("!!!")).toBe("");
  });

  test("an in-flight duplicate and a recent re-accept are refused; the window reopens after 120s", async () => {
    let now = 1_000;
    let dispatches = 0;
    let release: (() => void) | undefined;
    const seam: AcceptanceSpawnSeam = {
      async dispatch(action: DispatchedAction) {
        dispatches += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          accepted: true as const,
          actionType: "spawn" as const,
          correlationId: action.correlationId,
          targetUPID: null,
          process: {
            upid: `upid-${dispatches}`,
            runId: `run-${dispatches}`,
            callsign: "atlas",
            state: "planning" as const,
            selected: true,
            progressSeq: 0,
            lastAction: "spawn",
            updatedAtMs: now,
          },
        };
      },
    };
    const suppressed: string[] = [];
    const guarded = createDuplicateSpawnGuard(seam, {
      clock: () => now,
      onSuppressed: (info) => suppressed.push(info.reason),
    });
    const action = (correlationId: string): DispatchedAction => ({
      type: "spawn",
      targetUPID: null,
      payload: { pitch: "Build a status board!", mcqs: [], answers: [] },
      correlationId,
    });

    // Two concurrent accepts of the same pitch: exactly one reaches the seam.
    const first = guarded.dispatch(action("corr-1"));
    const second = await guarded.dispatch(action("corr-2"));
    expect(second.accepted).toBe(false);
    expect(suppressed).toEqual(["in-flight"]);
    release?.();
    expect((await first).accepted).toBe(true);
    expect(dispatches).toBe(1);

    // A re-accept inside the 120s window is refused without touching the seam.
    now += DUPLICATE_ACCEPT_WINDOW_MS - 1;
    const third = await guarded.dispatch(action("corr-3"));
    expect(third.accepted).toBe(false);
    expect(suppressed).toEqual(["in-flight", "recently-accepted"]);
    expect(dispatches).toBe(1);

    // Once the window elapses the same pitch may spawn again.
    now += 2;
    const fourth = guarded.dispatch(action("corr-4"));
    await Promise.resolve();
    release?.();
    expect((await fourth).accepted).toBe(true);
    expect(dispatches).toBe(2);

    // A different pitch is never blocked by the first one's window.
    const other = guarded.dispatch({ ...action("corr-5"), payload: { pitch: "ship a fish tank", mcqs: [], answers: [] } });
    await Promise.resolve();
    release?.();
    expect((await other).accepted).toBe(true);
    expect(dispatches).toBe(3);
  });

  test("runtime integration: two racing accepts of one suggestion spawn exactly one process", async () => {
    const backend = new FakeBackend();
    const { runtime } = await makeRuntime({ buildBackends: [backend] });
    const suggestion: PendingSuggestion = {
      suggestionId: "sug-dup",
      pitch: "build a fish tank dashboard",
      mcqs: [],
      answers: [],
      correlationId: "corr-dup",
      expiresAt: Date.now() + 60_000,
    };

    const [first, second] = await Promise.all([
      runtime.acceptanceController.spawnAccepted(suggestion, "corr-dup-1"),
      runtime.acceptanceController.spawnAccepted(suggestion, "corr-dup-2"),
    ]);
    expect([first.accepted, second.accepted].filter(Boolean)).toHaveLength(1);
    // Driving the controller directly bypasses the runtime accept methods that
    // publish — rebuild the snapshot the way the HTTP routes do.
    expect(runtime.publishNow().processes).toHaveLength(1);

    // A third accept of the same pitch moments later is refused too.
    const third = await runtime.acceptanceController.spawnAccepted(suggestion, "corr-dup-3");
    expect(third.accepted).toBe(false);
    expect(runtime.publishNow().processes).toHaveLength(1);
    expect(runtime.trace.events().some((event) => event.event === "spawn.duplicate.suppressed")).toBe(true);
  });
});

describe("voice callsign steering", () => {
  test("an utterance starting with a live callsign selects the process and steers the remainder", async () => {
    const backend = new FakeBackend();
    const { runtime } = await makeRuntime({ buildBackends: [backend] });
    await drive(runtime, [final(BUILDABLE, "utt-build")]);
    await runtime.acceptPendingSuggestion("corr-callsign-accept");
    const process = runtime.snapshot().processes[0];
    expect(process).toBeDefined();
    if (process === undefined) return;
    await waitFor(() => runtime.registry.builds(process.upid).some((build) => build.status === "ready"));

    await drive(runtime, [final(`${process.callsign} make the header blue`, "utt-callsign")]);

    // The callsign address set the steering target and steered the remainder.
    expect(runtime.steeringTarget()).toBe(process.upid);
    const events = runtime.trace.events();
    expect(events.some((event) => event.event === "steering.callsign")).toBe(true);
    expect(events.some((event) => event.event === "process.steer" && event.upid === process.upid)).toBe(true);
    // The steer reached the orchestrator as a correction on the ready build.
    await waitFor(() => backend.corrections.length === 1);
    expect(backend.corrections[0]).toBe("make the header blue");
  });

  test("ordinary room talk that does not address a callsign never sets a steering target", async () => {
    const backend = new FakeBackend();
    const { runtime } = await makeRuntime({ buildBackends: [backend] });
    await drive(runtime, [final(BUILDABLE, "utt-build")]);
    await runtime.acceptPendingSuggestion("corr-ambient-accept");
    expect(runtime.snapshot().processes).toHaveLength(1);

    await drive(runtime, [final("the weather has been really nice and the coffee was good", "utt-ambient")]);
    expect(runtime.steeringTarget()).toBeNull();
  });
});

describe("commission stage — two-stage pivot", () => {
  test("accept is kickoff-only; executeProcess opens the lane; completed run events serve the artifacts as built", async () => {
    const backend = new FakeBackend();
    const { runtime } = await makeRuntime({ buildBackends: [backend] });
    await drive(runtime, [final(BUILDABLE, "utt-build")]);
    await runtime.acceptPendingSuggestion("corr-commission-accept");
    const upid = runtime.snapshot().processes[0]?.upid;
    expect(upid).toBeDefined();
    if (upid === undefined) return;
    // The pre-assigned runId carries the per-boot nonce; the durable run launches
    // and streams under exactly this id, so drive the ingests with it too.
    const runId = runtime.snapshot().processes[0]?.runId ?? `vibersyn-${upid}`;

    // KICKOFF: mock lane fans out, but there is no durable run / execution lane.
    await waitFor(() => runtime.registry.builds(upid).some((build) => build.status === "ready"));
    expect(runtime.registry.hasDurableRun(upid)).toBe(false);
    expect(runtime.registry.execution(upid)).toBeNull();
    // Mock lanes speak mock language and pitch-line summaries.
    expect(runtime.registry.builds(upid)[0]?.progressLabel).toBe("mock ready");

    // COMMISSION: the lane opens executing.
    const executed = await runtime.executeProcess(upid, "corr-commission");
    expect(executed.ok).toBe(true);
    expect(runtime.registry.hasDurableRun(upid)).toBe(true);
    expect(runtime.registry.execution(upid)).toMatchObject({ status: "executing", runId });

    // The durable run lands its full-app artifacts, then completes: the lane
    // flips to built and the artifacts serve as the execution previewUrl.
    await Bun.write(join(runtime.executionRegistry.artifactsDir(upid), "index.html"), "<html>the full app</html>");
    runtime.runEventDriver.ingest({ upid, runId, kind: "output", text: "building the app", seq: 3 });
    expect(runtime.registry.execution(upid)).toMatchObject({ status: "executing", label: "building the app" });
    runtime.runEventDriver.ingest({ upid, runId, kind: "completed", text: "run finished", seq: 4 });
    await waitFor(() => runtime.registry.execution(upid)?.status === "built");

    const lane = runtime.registry.execution(upid);
    expect(lane).toMatchObject({ status: "built", percent: 100 });
    expect(lane?.previewUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?v=1$/u);
    const served = await fetch(lane!.previewUrl!);
    expect(served.status).toBe(200);
    expect(await served.text()).toContain("the full app");
    // The legacy per-process previewUrl prefers the BUILT full app over mocks.
    const process = runtime.snapshot().processes.find((entry) => entry.upid === upid);
    expect(process?.previewUrl).toBe(lane?.previewUrl ?? null);

    // Emergency stop tears the execution lane down with everything else.
    await runtime.emergencyStop("corr-commission-emergency");
    expect(runtime.executionRegistry.snapshot(upid)).toBeNull();
  });

  test("voice 'vibersyn execute' commissions the selected process through the same path", async () => {
    const backend = new FakeBackend();
    const { runtime } = await makeRuntime({ buildBackends: [backend] });
    await drive(runtime, [final(BUILDABLE, "utt-build")]);
    await runtime.acceptPendingSuggestion("corr-voice-exec-accept");
    const upid = runtime.snapshot().processes[0]?.upid;
    expect(upid).toBeDefined();
    if (upid === undefined) return;
    expect(runtime.registry.hasDurableRun(upid)).toBe(false);

    await drive(runtime, [final("vibersyn execute", "utt-execute")]);

    expect(runtime.registry.hasDurableRun(upid)).toBe(true);
    expect(runtime.registry.execution(upid)).toMatchObject({ status: "executing" });
    expect(runtime.snapshot().voice?.lastCommand).toBe("execute");
  });
});

// --- harness -----------------------------------------------------------------

async function makeRuntime(
  options: ProjectorRuntimeOptions & { env?: Record<string, string> } = {},
): Promise<{ runtime: ProjectorRuntime; path: string }> {
  const dir = mkdtempSync(join(tmpdir(), "vibersyn-buildloop-"));
  tempDirs.push(dir);
  const path = join(dir, "mic.jsonl");
  writeFileSync(path, "", "utf8");
  const { env, ...runtimeOptions } = options;
  const runtime = await createProjectorRuntime(
    {
      VIBERSYN_INITIAL_MUTED: "0",
      VIBERSYN_MIC_REPLAY_PATH: path,
      VIBERSYN_IDEA_DETECTOR: "heuristic",
      VIBERSYN_DETECT_MIN_NEW_TURNS: "1",
      VIBERSYN_DETECT_MIN_INTERVAL_MS: "0",
      VIBERSYN_DETECT_TICK_MS: "0",
      ...env,
    },
    { buildsRoot: join(dir, "builds"), executionArtifactsRoot: join(dir, "vibersyn-runs"), ...runtimeOptions },
  );
  runtimes.push(runtime);
  runtimePaths.set(runtime, path);
  return { runtime, path };
}

async function drive(runtime: ProjectorRuntime, observations: TranscriptObservation[]): Promise<void> {
  const path = runtimePathFor(runtime);
  writeFileSync(path, observations.map((observation) => JSON.stringify(observation)).join("\n"), "utf8");
  const session = runtime.startMicSession("corr-buildloop-mic");
  await session.stop();
  await runtime.detection.flush();
}

// The replay path lives in the runtime's env — recover it from the newest temp
// dir the harness created for this runtime (one dir per makeRuntime call).
const runtimePaths = new Map<ProjectorRuntime, string>();
function runtimePathFor(runtime: ProjectorRuntime): string {
  const path = runtimePaths.get(runtime);
  if (path !== undefined) {
    return path;
  }
  throw new Error("drive() called for a runtime makeRuntime did not create");
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function final(text: string, utteranceId: string): TranscriptObservation {
  return { text, isFinal: true, speaker: "Room", sessionId: "buildloop-test", latencyMs: 0, utteranceId };
}
