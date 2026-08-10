import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createPhoneImportApp, createProjectorApp } from "./app";
import { registerForestSurface, type ForestState, type ForestSurfaceLoader } from "./github-org";
import { RemoteHandsHub } from "./remote-hands";
import { createProjectorRuntime, type ProjectorRuntime, type ProjectorRuntimeOptions } from "./composition";
import type { BuilderAgent } from "./idea-builder";
import type { BuildBackend, BuildRequest, BuildResult } from "../buildloop/types";
import type { DetectionInput, DetectionResult, IdeaDetector } from "../detect";
import type { InterfaceAddresses } from "./project-import";
import type { ProjectorSnapshot } from "../ui/types";

// HTTP-level coverage of the projector app (no bound port — app.request()): the
// idea-tray endpoints, the QR import flow, and the phone submit page, all over a
// REAL runtime with an injected deterministic detector.

class ScriptedDetector implements IdeaDetector {
  #queue: DetectionResult[];
  constructor(queue: DetectionResult[]) {
    this.#queue = queue;
  }
  async detect(_input: DetectionInput): Promise<DetectionResult> {
    return this.#queue.shift() ?? { candidates: [] };
  }
}

function ideaResult(pitch: string, confidence: number): DetectionResult {
  return {
    candidates: [
      {
        matchId: null,
        pitch,
        confidence,
        questions: ["Build it?"],
        answers: ["Yes"],
        contextSpan: { startTurnId: "turn-0001", endTurnId: "turn-0001", quote: "evidence quote" },
        rationale: "",
      },
    ],
  };
}

const noopBuilder: BuilderAgent = async () => undefined;

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

interface MakeAppArgs {
  detector?: IdeaDetector;
  host?: string;
  port?: number;
  phonePort?: number | null;
  interfaces?: () => InterfaceAddresses;
  // Inject a fake build-backend roster: routes accepts through the multi-backend
  // orchestrator instead of the legacy single-build ideaBuilds path.
  buildBackends?: BuildBackend[];
  // Guest-hands surface seams: the TLS listener port and a shared relay hub.
  tlsPort?: number | null;
  hands?: RemoteHandsHub;
  // Phone-import clone seam. Default: instant fake success — NO test may ever
  // run a real `git clone` (network, subprocess, teardown races).
  cloneRepoFn?: ProjectorRuntimeOptions["cloneRepoFn"];
  // App-level env (e.g. VIBERSYN_AUTOCAL_PORT for the autocal proxy).
  env?: Record<string, string | undefined>;
  // Autocal proxy upstream seam — no test may ever reach a real calibrator.
  autocalFetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  // Build-stamp stat seam — no test may ever depend on a dist build on disk.
  distIndexStat?: () => Promise<{ mtimeMs: number }>;
  // Self-repo forest-loader seam — no test may ever kick the process-wide
  // loader (it spawns a real gh and pollutes shared forest state).
  forestLoader?: { load: (org: string) => Promise<void> };
  // Extra RUNTIME env (e.g. VIBERSYN_AUTOBUILD_SETTLE_MS for settle-gate
  // tests) — merged over makeApp's deterministic defaults.
  runtimeEnv?: Record<string, string>;
  // Git-substrate seams. Default NULL (substrate off) — no test may ever spawn
  // a real git; publish-repo tests inject scripted fakes.
  treeGitRunner?: ProjectorRuntimeOptions["treeGitRunner"];
  treeGhRunner?: ProjectorRuntimeOptions["treeGhRunner"];
}

async function makeApp(args: MakeAppArgs = {}): Promise<{ app: ReturnType<typeof createProjectorApp>; runtime: ProjectorRuntime }> {
  const buildsRoot = mkdtempSync(join(tmpdir(), "vibersyn-app-"));
  tempDirs.push(buildsRoot);
  const runtime = await createProjectorRuntime(
    {
      VIBERSYN_INITIAL_MUTED: "0",
      VIBERSYN_IDEA_DETECTOR: "heuristic",
      VIBERSYN_DETECT_MIN_NEW_TURNS: "1",
      VIBERSYN_DETECT_MIN_INTERVAL_MS: "0",
      VIBERSYN_DETECT_TICK_MS: "0",
      ...args.runtimeEnv,
    },
    {
      ideaDetector: args.detector,
      buildsRoot,
      builderAgent: noopBuilder,
      buildBackends: args.buildBackends,
      executionArtifactsRoot: join(buildsRoot, "vibersyn-runs"),
      cloneRepoFn: args.cloneRepoFn ?? (async ({ dir }) => ({ ok: true, dir })),
      repoDigestFn: async () => "digest: fake repo",
      treeGitRunner: args.treeGitRunner ?? null,
      treeGhRunner: args.treeGhRunner,
    },
  );
  runtimes.push(runtime);
  const app = createProjectorApp(runtime, {
    env: args.env ?? {},
    host: args.host ?? "127.0.0.1",
    port: args.port ?? 8787,
    phonePort: args.phonePort ?? null,
    tlsPort: args.tlsPort ?? null,
    hands: args.hands,
    interfaces: args.interfaces,
    autocalFetch: args.autocalFetch,
    distIndexStat: args.distIndexStat,
    forestLoader: args.forestLoader ?? { load: async () => undefined },
  });
  return { app, runtime };
}

// Poll until the fire-and-forget import routine (clone → startBuild) has kicked
// the build for `upid`, then await its settle. The clone gate and digest are
// injected fakes, so this converges in a few microtask turns.
async function settleImportBuild(runtime: ProjectorRuntime, upid: string): Promise<void> {
  for (let attempt = 0; attempt < 200 && runtime.ideaBuilds.state(upid) === undefined; attempt += 1) {
    await new Promise((resolveTick) => setTimeout(resolveTick, 5));
  }
  await runtime.ideaBuilds.settle(upid);
}

// Surface one detection candidate through the real runner (bubble delivery and
// snapshot publish included), returning its ledger id.
async function surfaceIdea(runtime: ProjectorRuntime, pitch: string, confidence = 0.9): Promise<string> {
  runtime.detection.ingestTurn({ speaker: "Room", text: `let's build ${pitch}`, atMs: Date.now(), correlationId: "corr-app-test" });
  await runtime.detection.flush();
  const candidate = runtime.detection.candidates().find((entry) => entry.pitch === pitch);
  if (candidate === undefined) {
    throw new Error(`expected the scripted detector to surface "${pitch}" (confidence ${confidence})`);
  }
  return candidate.id;
}

async function postJson(app: ReturnType<typeof createProjectorApp>, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("POST /api/idea/:id/accept", () => {
  test("accepts a specific ledger candidate: spawns a process and consumes the idea", async () => {
    const { app, runtime } = await makeApp({ detector: new ScriptedDetector([ideaResult("a replay dashboard", 0.9)]) });
    const id = await surfaceIdea(runtime, "a replay dashboard");

    const response = await postJson(app, `/api/idea/${id}/accept`);
    expect(response.status).toBe(200);
    const snapshot = (await response.json()) as ProjectorSnapshot;
    expect(snapshot.processes).toHaveLength(1);
    expect(snapshot.ideas ?? []).toHaveLength(0);
    expect(runtime.registry.activeRecords()).toHaveLength(1);
  });

  test("an unknown id is 404-free: 200 with the snapshot unchanged", async () => {
    const { app, runtime } = await makeApp({ detector: new ScriptedDetector([ideaResult("a replay dashboard", 0.9)]) });
    await surfaceIdea(runtime, "a replay dashboard");

    const response = await postJson(app, "/api/idea/idea-does-not-exist/accept");
    expect(response.status).toBe(200);
    const snapshot = (await response.json()) as ProjectorSnapshot;
    expect(snapshot.processes).toHaveLength(0);
    expect(snapshot.ideas).toHaveLength(1);
  });

  test("offline-demo referer guard: no spawn, cosmetic snapshot returned", async () => {
    const { app, runtime } = await makeApp({ detector: new ScriptedDetector([ideaResult("a replay dashboard", 0.9)]) });
    const id = await surfaceIdea(runtime, "a replay dashboard");

    const response = await postJson(app, `/api/idea/${id}/accept`, undefined, { referer: "http://localhost:8787/?live=0" });
    expect(response.status).toBe(200);
    expect(runtime.registry.activeRecords()).toHaveLength(0);
    expect(runtime.detection.candidates()).toHaveLength(1);
  });
});

describe("POST /api/idea/:id/dismiss", () => {
  test("drops the candidate from the ledger without building anything", async () => {
    const { app, runtime } = await makeApp({ detector: new ScriptedDetector([ideaResult("a replay dashboard", 0.9)]) });
    const id = await surfaceIdea(runtime, "a replay dashboard");

    const response = await postJson(app, `/api/idea/${id}/dismiss`);
    expect(response.status).toBe(200);
    const snapshot = (await response.json()) as ProjectorSnapshot;
    expect(snapshot.ideas ?? []).toHaveLength(0);
    expect(snapshot.processes).toHaveLength(0);
    expect(runtime.detection.candidates()).toHaveLength(0);
  });

  test("an unknown id returns the snapshot unchanged", async () => {
    const { app, runtime } = await makeApp({ detector: new ScriptedDetector([ideaResult("a replay dashboard", 0.9)]) });
    await surfaceIdea(runtime, "a replay dashboard");

    const response = await postJson(app, "/api/idea/idea-does-not-exist/dismiss");
    expect(response.status).toBe(200);
    const snapshot = (await response.json()) as ProjectorSnapshot;
    expect(snapshot.ideas).toHaveLength(1);
  });
});

// SELF-REBUILD ("the room rebuilds itself") runtime toggle. Mirrors the
// Auto-Build endpoint contract: explicit {on} sets, absent body flips, the
// offline demo's referer never mutates. Outside a --self launch the boot
// default is OFF and snapshot.selfSupervisor says no supervisor is wrapping
// the process (the exit-87 gate itself is covered in composition.self.test.ts).
describe("POST /api/self-rebuild", () => {
  test("explicit {on:true} arms it; absent body toggles; the snapshot persists the state", async () => {
    const { app, runtime } = await makeApp();
    // Boot default outside --self (no VIBERSYN_SELF_MODE): off.
    expect(runtime.selfRebuild()).toBe(false);

    const on = await postJson(app, "/api/self-rebuild", { on: true });
    expect(on.status).toBe(200);
    expect(((await on.json()) as ProjectorSnapshot).selfRebuild).toBe(true);
    expect(runtime.selfRebuild()).toBe(true);

    // Persisted: a later plain snapshot still carries the state.
    const state = await app.request("/api/state");
    expect(((await state.json()) as ProjectorSnapshot).selfRebuild).toBe(true);

    // Absent body flips the current state.
    const toggled = await postJson(app, "/api/self-rebuild");
    expect(((await toggled.json()) as ProjectorSnapshot).selfRebuild).toBe(false);
    expect(runtime.selfRebuild()).toBe(false);
  });

  test("the snapshot says honestly that no supervisor is wrapping this process", async () => {
    const { app } = await makeApp();
    const state = await app.request("/api/state");
    const snapshot = (await state.json()) as ProjectorSnapshot;
    expect(snapshot.selfSupervisor).toBe(false);
    expect(snapshot.selfRebuild).toBe(false);
  });

  test("offline-demo referer guard: cosmetic snapshot returned, nothing flips", async () => {
    const { app, runtime } = await makeApp();
    const response = await postJson(app, "/api/self-rebuild", { on: true }, { referer: "http://localhost:8787/?live=0" });
    expect(response.status).toBe(200);
    expect(runtime.selfRebuild()).toBe(false);
  });
});

// SELF-REPO surface: names the room's own repository for the wall's
// self-repo garden tree, and — because the wall always asks here before polling
// /api/forest — warms the forest loader whenever the room is armed (this is
// what makes a supervisor boot, where no toggle press ever fires, show data).
describe("GET /api/self-repo", () => {
  test("names the repo (default and VIBERSYN_SELF_REPO override)", async () => {
    const { app } = await makeApp();
    expect(await (await app.request("/api/self-repo")).json()).toEqual({ repo: "RonTuretzky/vibecode-room" });

    const { app: overridden } = await makeApp({ env: { VIBERSYN_SELF_REPO: "acme/room-fork" } });
    expect(await (await overridden.request("/api/self-repo")).json()).toEqual({ repo: "acme/room-fork" });
  });

  test("armed → the GET kicks the forest loader with the owner half; unarmed → it does not", async () => {
    const kicked: string[] = [];
    const { app } = await makeApp({ forestLoader: { load: async (org) => void kicked.push(org) } });

    await app.request("/api/self-repo");
    expect(kicked).toEqual([]);

    await postJson(app, "/api/self-rebuild", { on: true });
    // Arming itself kicks once; the panel's follow-up GET kicks again (the
    // loader dedupes/caches internally — this seam only records intent).
    await app.request("/api/self-repo");
    expect(kicked).toEqual(["RonTuretzky", "RonTuretzky"]);
  });
});

// GUIDED-DEMO HOLD: while a wall's demo sits on "describe your idea", the
// armed auto-build must not fire on its own — Done is the only trigger.
describe("POST /api/guided/hold", () => {
  test("held: a zero-settle auto-build stays ARMED instead of firing; release fires it", async () => {
    const { app, runtime } = await makeApp({
      detector: new ScriptedDetector([ideaResult("a garden kiosk", 0.9)]),
      runtimeEnv: { VIBERSYN_AUTOBUILD_SETTLE_MS: "0" },
    });
    await postJson(app, "/api/auto-accept", { on: true });
    await postJson(app, "/api/guided/hold", { on: true });
    await surfaceIdea(runtime, "a garden kiosk");
    // The zero-settle legacy path would spawn on the spot — the hold gates it,
    // keeping the candidate armed so the demo's Done can accept exactly it.
    await new Promise((resolveTick) => setTimeout(resolveTick, 30));
    expect(runtime.snapshot().processes).toHaveLength(0);
    expect(runtime.snapshot().ideas ?? []).toHaveLength(1);

    await postJson(app, "/api/guided/hold", { on: false });
    for (let attempt = 0; attempt < 200 && runtime.snapshot().processes.length === 0; attempt += 1) {
      await new Promise((resolveTick) => setTimeout(resolveTick, 10));
    }
    expect(runtime.snapshot().processes).toHaveLength(1);
  });

  test("offline-demo referer guard: cosmetic snapshot returned, no hold set", async () => {
    const { app, runtime } = await makeApp({
      detector: new ScriptedDetector([ideaResult("a mural wall", 0.9)]),
      runtimeEnv: { VIBERSYN_AUTOBUILD_SETTLE_MS: "0" },
    });
    await postJson(app, "/api/auto-accept", { on: true });
    const response = await postJson(app, "/api/guided/hold", { on: true }, { referer: "http://localhost:8787/?live=0" });
    expect(response.status).toBe(200);
    // The guard means the hold never landed: the zero-settle fire proceeds.
    await surfaceIdea(runtime, "a mural wall");
    for (let attempt = 0; attempt < 200 && runtime.snapshot().processes.length === 0; attempt += 1) {
      await new Promise((resolveTick) => setTimeout(resolveTick, 10));
    }
    expect(runtime.snapshot().processes).toHaveLength(1);
  });
});

describe("GET /api/state — snapshot.ideas over HTTP", () => {
  test("maps ready-then-forming with confidence ordering and evidence", async () => {
    const both: DetectionResult = {
      candidates: [
        { ...ideaResult("forming idea", 0.4).candidates[0]!, pitch: "forming idea", confidence: 0.4 },
        { ...ideaResult("ready idea", 0.9).candidates[0]!, pitch: "ready idea", confidence: 0.9 },
      ],
    };
    const { app, runtime } = await makeApp({ detector: new ScriptedDetector([both]) });
    runtime.detection.ingestTurn({ speaker: "Room", text: "two ideas at once", atMs: Date.now(), correlationId: "corr-app-two" });
    await runtime.detection.flush();

    const response = await app.request("/api/state");
    const snapshot = (await response.json()) as ProjectorSnapshot;
    expect(snapshot.ideas?.map((idea) => [idea.pitch, idea.status])).toEqual([
      ["ready idea", "ready"],
      ["forming idea", "forming"],
    ]);
    expect(snapshot.ideas?.[0]?.evidence).toBe("evidence quote");
  });
});

describe("POST /api/projects/import", () => {
  test("a GitHub link clones, joins the fleet, and becomes a REAL building project", async () => {
    // Deferred clone gate: the pre-build "cloning repository" window is
    // deterministic, then releasing the gate runs the same accept->build->
    // preview pipeline every accepted idea gets.
    let releaseClone!: (result: { ok: true; dir: string }) => void;
    const cloneGate = new Promise<{ ok: true; dir: string }>((resolveGate) => {
      releaseClone = resolveGate;
    });
    const { app, runtime } = await makeApp({ cloneRepoFn: async () => cloneGate });
    const published: ProjectorSnapshot[] = [];
    const unsubscribe = runtime.subscribe((snapshot) => published.push(snapshot));

    const response = await postJson(app, "/api/projects/import", { url: "https://github.com/RonTuretzky/gesture-wall" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; upid?: string; callsign?: string; title?: string | null };
    expect(body.ok).toBe(true);
    expect(body.upid).toBe("upid-1");
    expect(body.callsign).toBe("GESTUREW");
    unsubscribe();

    const stateResponse = await app.request("/api/state");
    const state = (await stateResponse.json()) as ProjectorSnapshot;
    expect(state.processes).toHaveLength(1);
    const imported = state.processes[0]!;
    expect(imported.source).toEqual({ kind: "github-import", url: "https://github.com/RonTuretzky/gesture-wall" });
    expect(imported.task).toBe("Imported from GitHub: RonTuretzky/gesture-wall");
    expect(imported.state).toBe("active");
    expect(imported.progressLabel).toBe("cloning repository");
    expect(imported.previewUrl).toBe("https://github.com/RonTuretzky/gesture-wall");
    expect(imported.callsign).toBe("GESTUREW");
    // SSE subscribers saw the import land without polling.
    expect(published.some((snapshot) => snapshot.processes.some((process) => process.source?.kind === "github-import"))).toBe(true);

    // Clone settles → the build fan-out kicks and a REAL local preview outranks
    // the repo URL on the legacy preview field.
    releaseClone({ ok: true, dir: join(tmpdir(), "fake-clone") });
    await settleImportBuild(runtime, "upid-1");
    const builtState = (await (await app.request("/api/state")).json()) as ProjectorSnapshot;
    const built = builtState.processes[0]!;
    expect(built.buildStatus).toBe("ready");
    expect(built.previewUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//u);
  });

  test("context alone starts a building project (no link required)", async () => {
    const { app, runtime } = await makeApp();
    const response = await postJson(app, "/api/projects/import", { context: "A synthwave dashboard for our ticket queue" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; upid?: string; callsign?: string };
    expect(body.ok).toBe(true);
    expect(typeof body.callsign).toBe("string");

    const state = (await (await app.request("/api/state")).json()) as ProjectorSnapshot;
    expect(state.processes).toHaveLength(1);
    const process = state.processes[0]!;
    expect(process.source).toEqual({ kind: "phone-import", url: null });
    expect(process.task).toBe("A synthwave dashboard for our ticket queue");

    // The fan-out starts immediately for non-github imports.
    await settleImportBuild(runtime, body.upid!);
    const builtState = (await (await app.request("/api/state")).json()) as ProjectorSnapshot;
    expect(builtState.processes[0]!.buildStatus).toBe("ready");
    expect(builtState.processes[0]!.previewUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//u);
  });

  test("any non-github link rides along as reference context, never a clone", async () => {
    let cloneCalls = 0;
    const { app } = await makeApp({
      cloneRepoFn: async ({ dir }) => {
        cloneCalls += 1;
        return { ok: true, dir };
      },
    });
    const response = await postJson(app, "/api/projects/import", {
      context: "make a viewer for this spec",
      url: "https://example.com/spec",
    });
    expect(response.status).toBe(200);
    const state = (await (await app.request("/api/state")).json()) as ProjectorSnapshot;
    const process = state.processes[0]!;
    expect(process.source).toEqual({ kind: "phone-import", url: "https://example.com/spec" });
    expect(process.task).toBe("make a viewer for this spec");
    expect(cloneCalls).toBe(0);
  });

  test("github lookalike hosts are reference links — the clone routine never fires (anti-spoof)", async () => {
    let cloneCalls = 0;
    const { app, runtime } = await makeApp({
      cloneRepoFn: async ({ dir }) => {
        cloneCalls += 1;
        return { ok: true, dir };
      },
    });
    const spoofs = [
      "https://evilgithub.com/o/r",
      "https://github.com.evil.com/o/r",
      "https://github.com@evil.com/o/r",
      "https://github.com/owner-only",
    ];
    for (const url of spoofs) {
      const response = await postJson(app, "/api/projects/import", { url });
      expect(response.status).toBe(200);
    }
    expect(cloneCalls).toBe(0);
    for (const record of runtime.registry.records()) {
      expect(runtime.snapshot().processes.find((process) => process.upid === record.upid)?.source?.kind).toBe("phone-import");
    }
  });

  test("a failed clone still builds from the link — never a dead card", async () => {
    const { app, runtime } = await makeApp({ cloneRepoFn: async () => ({ ok: false, error: "repository not found" }) });
    const response = await postJson(app, "/api/projects/import", { url: "https://github.com/o/gone" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { upid?: string };
    await settleImportBuild(runtime, body.upid!);
    const state = (await (await app.request("/api/state")).json()) as ProjectorSnapshot;
    const process = state.processes[0]!;
    // The fallback fan-out is the honest surface once live — the card must not
    // stay stuck on a clone label.
    expect(process.progressLabel).not.toBe("cloning repository");
    expect(process.buildStatus).toBe("ready");
    expect(process.previewUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//u);
  });

  test("a THROWING clone seam still ends in a fallback build — never a stuck 'cloning repository' card", async () => {
    const { app, runtime } = await makeApp({
      cloneRepoFn: async () => {
        throw new Error("git vanished");
      },
    });
    const response = await postJson(app, "/api/projects/import", { url: "https://github.com/o/r" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { upid?: string };
    await settleImportBuild(runtime, body.upid!);
    const state = (await (await app.request("/api/state")).json()) as ProjectorSnapshot;
    expect(state.processes[0]!.buildStatus).toBe("ready");
    expect(state.processes[0]!.progressLabel).not.toBe("cloning repository");
  });

  test("emergency stop mid-clone aborts the routine — no build ever starts (sticky kill-all invariant)", async () => {
    let cloneSignal: AbortSignal | undefined;
    let releaseClone!: (result: { ok: true; dir: string }) => void;
    const cloneGate = new Promise<{ ok: true; dir: string }>((resolveGate) => {
      releaseClone = resolveGate;
    });
    const { app, runtime } = await makeApp({
      cloneRepoFn: async ({ signal }) => {
        cloneSignal = signal;
        return cloneGate;
      },
    });
    const response = await postJson(app, "/api/projects/import", { url: "https://github.com/o/r" });
    const body = (await response.json()) as { upid?: string };
    expect(body.upid).toBe("upid-1");

    await runtime.emergencyStop("corr-test-emergency");
    // The in-flight clone's signal was aborted by the kill-all.
    expect(cloneSignal?.aborted).toBe(true);

    // A late clone settle must NOT start a build on the halted process.
    releaseClone({ ok: true, dir: join(tmpdir(), "late-clone") });
    await new Promise((resolveTick) => setTimeout(resolveTick, 25));
    expect(runtime.ideaBuilds.state("upid-1")).toBeUndefined();
    const state = (await (await app.request("/api/state")).json()) as ProjectorSnapshot;
    expect(state.processes[0]!.state).toBe("halted");
    expect(state.processes[0]!.previewUrl).toBe(null);
  });

  test("halting the process mid-clone aborts its git subprocess and blocks the deferred build", async () => {
    let cloneSignal: AbortSignal | undefined;
    let releaseClone!: (result: { ok: true; dir: string }) => void;
    const cloneGate = new Promise<{ ok: true; dir: string }>((resolveGate) => {
      releaseClone = resolveGate;
    });
    const { app, runtime } = await makeApp({
      cloneRepoFn: async ({ signal }) => {
        cloneSignal = signal;
        return cloneGate;
      },
    });
    const response = await postJson(app, "/api/projects/import", { url: "https://github.com/o/r" });
    const body = (await response.json()) as { upid?: string };

    await runtime.registry.halt(body.upid!, "corr-test-halt");
    expect(cloneSignal?.aborted).toBe(true);

    releaseClone({ ok: true, dir: join(tmpdir(), "late-clone") });
    await new Promise((resolveTick) => setTimeout(resolveTick, 25));
    expect(runtime.ideaBuilds.state(body.upid!)).toBeUndefined();
  });

  test("unusable submissions are 400 { ok:false } and never reach the fleet", async () => {
    const { app, runtime } = await makeApp();
    const invalid = [
      { url: "not a url" },
      { url: "ftp://github.com/o/r" },
      { url: "javascript:alert(1)", context: "" },
      { context: "   " },
      {},
    ];
    for (const body of invalid) {
      const response = await postJson(app, "/api/projects/import", body);
      expect(response.status).toBe(400);
      const parsed = (await response.json()) as { ok: boolean; error?: string };
      expect(parsed.ok).toBe(false);
      expect(parsed.error?.length ?? 0).toBeGreaterThan(0);
    }
    expect(runtime.registry.records()).toHaveLength(0);
  });

  test("a missing/malformed body is a 400, not a crash", async () => {
    const { app } = await makeApp();
    const response = await postJson(app, "/api/projects/import");
    expect(response.status).toBe(400);
    const noUrl = await postJson(app, "/api/projects/import", { nope: true });
    expect(noUrl.status).toBe(400);
  });

  test("offline-demo referer guard: cosmetic ok, nothing added", async () => {
    const { app, runtime } = await makeApp();
    const response = await postJson(
      app,
      "/api/projects/import",
      { url: "https://github.com/o/r" },
      { referer: "http://localhost:8787/?live=0" },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(runtime.registry.records()).toHaveLength(0);
  });
});

describe("GET /api/import/info", () => {
  const lan: InterfaceAddresses = {
    en0: [{ family: "IPv4", internal: false, address: "192.168.7.20" }],
  };

  test("loopback bind (default HOST) → lanReachable false with the loopback fallback", async () => {
    const { app } = await makeApp({ host: "127.0.0.1", port: 8787, interfaces: () => lan });
    const response = await app.request("/api/import/info");
    expect(await response.json()).toEqual({ submitUrl: "http://127.0.0.1:8787/submit", host: "127.0.0.1", lanReachable: false });
  });

  test("wildcard bind → first non-internal IPv4 submit URL", async () => {
    const { app } = await makeApp({ host: "0.0.0.0", port: 9100, interfaces: () => lan });
    const response = await app.request("/api/import/info");
    expect(await response.json()).toEqual({ submitUrl: "http://192.168.7.20:9100/submit", host: "192.168.7.20", lanReachable: true });
  });

  test("phone listener bound → QR advertises it via the LAN IPv4 even on a loopback main bind", async () => {
    const { app } = await makeApp({ host: "127.0.0.1", port: 8787, phonePort: 8788, interfaces: () => lan });
    const response = await app.request("/api/import/info");
    expect(await response.json()).toEqual({ submitUrl: "http://192.168.7.20:8788/submit", host: "192.168.7.20", lanReachable: true });
  });
});

describe("guest hands surface (GET /hands + /api/hands/info)", () => {
  const lan: InterfaceAddresses = {
    en0: [{ family: "IPv4", internal: false, address: "192.168.7.20" }],
  };

  test("serves the self-contained guest page", async () => {
    const { app } = await makeApp();
    const response = await app.request("/hands");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    // The page's two input modes and its ingest socket path.
    expect(html).toContain("/hands/ws");
    expect(html).toContain("guest-mode-hands");
    expect(html).toContain("guest-pad");
  });

  test("guest page: display-name input, persisted per device, announced via hello", async () => {
    const { app } = await makeApp();
    const html = await (await app.request("/hands")).text();
    expect(html).toContain('data-testid="guest-name"'); // the name input near the status header
    expect(html).toContain('placeholder="your name"');
    expect(html).toContain("vibersyn.guest-name"); // localStorage persistence key
  });

  test("camera cursor pipeline: One-Euro filter, interaction-zone inset, debounced+anchored pinch", async () => {
    const { app } = await makeApp();
    const html = await (await app.request("/hands")).text();
    // Named tuning constants in the inline script — renaming these should be a
    // deliberate act (they encode researched values, and this test names them).
    expect(html).toContain("ONE_EURO_MINCUTOFF");    // cursor jitter filter
    expect(html).toContain("PINCH_EURO_MINCUTOFF");  // pinch-ratio scalar filter
    expect(html).toContain("INSET_X_MIN");           // interaction-zone mapping
    expect(html).toContain("PINCH_ON_FRAMES");       // temporal pinch debounce
    expect(html).toContain("ENGAGE_MAX_SPEED");      // velocity gate on engage
    expect(html).toContain("BACKTRACK_MS");          // Heisenberg click anchor (snap-back)
    expect(html).toContain("HAND_LOST_FRAMES");      // dropout-tolerant release
    // HARD pinch freeze (operator request): while engaged the cursor must not
    // move at all — the drift-unfreeze (FREEZE_RADIUS) must stay gone.
    expect(html).not.toContain("FREEZE_RADIUS");
  });

  test("the guest page loads its hand tracker from THIS server, never a CDN (offline LAN)", async () => {
    const { app } = await makeApp();
    const html = await (await app.request("/hands")).text();
    expect(html).toContain("/hands/assets");
    expect(html).toContain("vision_bundle.mjs");
    expect(html).toContain("/hands/assets/hand_landmarker.task");
    expect(html).not.toContain("cdn.jsdelivr.net");
    expect(html).not.toContain("storage.googleapis.com");
  });

  test("self-hosted tracker assets: bundle, wasm, and model all serve with sane types", async () => {
    const { app } = await makeApp();
    const cases: Array<[string, string]> = [
      ["/hands/assets/vision_bundle.mjs", "text/javascript"],
      ["/hands/assets/wasm/vision_wasm_internal.js", "text/javascript"],
      ["/hands/assets/wasm/vision_wasm_internal.wasm", "application/wasm"],
      ["/hands/assets/hand_landmarker.task", "application/octet-stream"],
    ];
    for (const [path, type] of cases) {
      const response = await app.request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(type);
    }
    // Unknown assets 404 rather than falling through to another route.
    expect((await app.request("/hands/assets/nope.js")).status).toBe(404);
  });

  test("/api/hands/info reports reachability, the TLS URL, and the live hub state", async () => {
    const hub = new RemoteHandsHub();
    hub.addRoom(() => undefined).message(JSON.stringify({ type: "hello", wall: "A" }));
    hub.addGuest(() => undefined);
    const { app } = await makeApp({
      host: "127.0.0.1",
      port: 8787,
      phonePort: 8788,
      tlsPort: 8789,
      hands: hub,
      interfaces: () => lan,
    });
    const response = await app.request("/api/hands/info");
    expect(await response.json()).toEqual({
      url: "http://192.168.7.20:8788/hands",
      httpsUrl: "https://192.168.7.20:8789/hands",
      host: "192.168.7.20",
      lanReachable: true,
      guestCount: 1,
      walls: ["A"],
    });
  });

  test("no TLS listener → httpsUrl null; loopback-only → honestly unreachable", async () => {
    const { app } = await makeApp({ host: "127.0.0.1", port: 8787, interfaces: () => lan });
    const info = (await (await app.request("/api/hands/info")).json()) as { httpsUrl: string | null; lanReachable: boolean; url: string };
    expect(info.httpsUrl).toBeNull();
    expect(info.lanReachable).toBe(false);
    expect(info.url).toBe("http://127.0.0.1:8787/hands");
  });

  test("the phone (LAN) app serves the guest page too", async () => {
    const buildsRoot = mkdtempSync(join(tmpdir(), "vibersyn-phone-hands-"));
    tempDirs.push(buildsRoot);
    const runtime = await createProjectorRuntime(
      { VIBERSYN_INITIAL_MUTED: "0", VIBERSYN_IDEA_DETECTOR: "heuristic" },
      {
        buildsRoot,
        builderAgent: noopBuilder,
        executionArtifactsRoot: join(buildsRoot, "vibersyn-runs"),
        cloneRepoFn: async ({ dir }) => ({ ok: true, dir }),
        repoDigestFn: async () => "digest: fake repo",
      },
    );
    runtimes.push(runtime);
    const phoneApp = createPhoneImportApp(runtime, {
      host: "127.0.0.1",
      port: 8787,
      phonePort: 8788,
      tlsPort: 8789,
      interfaces: () => lan,
    });
    const page = await phoneApp.request("/hands");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("/hands/ws");
    const info = (await (await phoneApp.request("/api/hands/info")).json()) as { url: string; httpsUrl: string | null };
    expect(info.url).toBe("http://192.168.7.20:8788/hands");
    expect(info.httpsUrl).toBe("https://192.168.7.20:8789/hands");
  });
});

describe("createPhoneImportApp — the dedicated 0.0.0.0 phone surface", () => {
  test("serves /submit, /api/import/info, the import POST, and redirects / to /submit", async () => {
    const buildsRoot = mkdtempSync(join(tmpdir(), "vibersyn-phone-"));
    tempDirs.push(buildsRoot);
    const runtime = await createProjectorRuntime(
      { VIBERSYN_INITIAL_MUTED: "0", VIBERSYN_IDEA_DETECTOR: "heuristic" },
      {
        buildsRoot,
        builderAgent: noopBuilder,
        executionArtifactsRoot: join(buildsRoot, "vibersyn-runs"),
        cloneRepoFn: async ({ dir }) => ({ ok: true, dir }),
        repoDigestFn: async () => "digest: fake repo",
      },
    );
    runtimes.push(runtime);
    const lan: InterfaceAddresses = { en0: [{ family: "IPv4", internal: false, address: "192.168.7.20" }] };
    const phoneApp = createPhoneImportApp(runtime, { host: "127.0.0.1", port: 8787, phonePort: 8788, interfaces: () => lan });

    const rootResponse = await phoneApp.request("/");
    expect(rootResponse.status).toBe(302);
    expect(rootResponse.headers.get("location")).toBe("/submit");

    const page = await phoneApp.request("/submit");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("/api/projects/import");

    const info = await phoneApp.request("/api/import/info");
    expect(await info.json()).toEqual({ submitUrl: "http://192.168.7.20:8788/submit", host: "192.168.7.20", lanReachable: true });

    const imported = await phoneApp.request("/api/projects/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ context: "phone-listener submission" }),
    });
    expect(imported.status).toBe(200);
    expect(runtime.registry.records()).toHaveLength(1);
  });
});

describe("GET /submit", () => {
  test("serves the self-contained phone page that posts to the import endpoint", async () => {
    const { app } = await makeApp();
    const response = await app.request("/submit");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("/api/projects/import");
    expect(html).toContain("github.com");
    expect(html).toContain("<form");
    // The refactored contract: context is the primary field, the link optional.
    expect(html).toContain("project-context");
    expect(html).toContain("Link (optional)");
  });
});

// --- BUILD LOOP control routes ----------------------------------------------

class RouteFakeBackend implements BuildBackend {
  readonly id = "native" as const;
  readonly label = "Fake Native";
  corrections: string[] = [];
  async available(): Promise<{ ok: boolean; reason?: string }> {
    return { ok: true };
  }
  async build(req: BuildRequest): Promise<BuildResult> {
    if (typeof req.correction === "string") {
      this.corrections.push(req.correction);
    }
    await Bun.write(join(req.outDir, "index.html"), "<html><body>route fake</body></html>");
    req.onProgress({ label: "ready", percent: 100 });
    return { ok: true, entrypoint: "index.html", summary: "Route-test app." };
  }
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

describe("POST /api/backends", () => {
  test("toggles a registered backend off and on, returning the republished snapshot", async () => {
    const { app } = await makeApp({ buildBackends: [new RouteFakeBackend()] });

    const off = await postJson(app, "/api/backends", { id: "native", enabled: false });
    expect(off.status).toBe(200);
    const offSnapshot = (await off.json()) as ProjectorSnapshot & {
      backends?: Array<{ id: string; enabled: boolean; available: boolean }>;
    };
    expect(offSnapshot.backends?.find((chip) => chip.id === "native")?.enabled).toBe(false);

    const on = await postJson(app, "/api/backends", { id: "native", enabled: true });
    expect(on.status).toBe(200);
    const onSnapshot = (await on.json()) as ProjectorSnapshot & {
      backends?: Array<{ id: string; enabled: boolean; available: boolean }>;
    };
    expect(onSnapshot.backends?.find((chip) => chip.id === "native")?.enabled).toBe(true);
  });

  test("a malformed body or unregistered id is a 400", async () => {
    const { app } = await makeApp({ buildBackends: [new RouteFakeBackend()] });
    expect((await postJson(app, "/api/backends", { id: "native" })).status).toBe(400);
    expect((await postJson(app, "/api/backends", { enabled: true })).status).toBe(400);
    expect((await postJson(app, "/api/backends", { id: "not-a-backend", enabled: true })).status).toBe(400);
    expect((await postJson(app, "/api/backends")).status).toBe(400);
  });
});

// GIT SUBSTRATE explicit publish route. The runners are scripted seams — no
// real git/gh subprocess ever runs from this suite.
describe("POST /api/process/:upid/publish-repo", () => {
  test("400 {ok:false} when the substrate is disabled (the default test seam)", async () => {
    const { app } = await makeApp();
    const response = await postJson(app, "/api/process/upid-1/publish-repo");
    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("disabled");
  });

  test("publishes an accepted tree's repo through the injected git/gh seams: 200 {ok:true,url}", async () => {
    const refs = new Map<string, string>();
    let seq = 0;
    const treeGitRunner: NonNullable<ProjectorRuntimeOptions["treeGitRunner"]> = async (argv) => {
      const positional = argv.filter(
        (arg, index) =>
          !arg.startsWith("--git-dir=") && !arg.startsWith("--work-tree=") && arg !== "-c" && argv[index - 1] !== "-c",
      );
      switch (positional[0]) {
        case "write-tree":
        case "commit-tree":
          seq += 1;
          return { ok: true, stdout: `sha-${seq}`, stderr: "" };
        case "update-ref":
          refs.set(positional[1]!, positional[2]!);
          return { ok: true, stdout: "", stderr: "" };
        case "rev-parse": {
          const target = positional[positional.length - 1]!;
          if (target.endsWith("^{tree}")) {
            return { ok: true, stdout: `tree-of-${target}`, stderr: "" };
          }
          const sha = refs.get(target);
          return sha === undefined ? { ok: false, stdout: "", stderr: "" } : { ok: true, stdout: sha, stderr: "" };
        }
        default:
          return { ok: true, stdout: "", stderr: "" };
      }
    };
    const ghCalls: string[][] = [];
    const treeGhRunner: NonNullable<ProjectorRuntimeOptions["treeGhRunner"]> = async (argv) => {
      ghCalls.push(argv);
      if (argv[1] === "repo" && argv[2] === "create") {
        return { ok: true, stdout: `https://github.com/roomowner/${argv[3]}\n`, stderr: "" };
      }
      return { ok: true, stdout: "", stderr: "" };
    };
    const { app, runtime } = await makeApp({
      detector: new ScriptedDetector([ideaResult("a publishable dashboard", 0.9)]),
      buildBackends: [new RouteFakeBackend()],
      treeGitRunner,
      treeGhRunner,
    });
    const id = await surfaceIdea(runtime, "a publishable dashboard");
    await postJson(app, `/api/idea/${id}/accept`);
    const upid = runtime.snapshot().processes[0]!.upid;
    await waitFor(() => runtime.registry.builds(upid).some((build) => build.status === "ready"));

    const response = await postJson(app, `/api/process/${upid}/publish-repo`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; url: string };
    expect(body.ok).toBe(true);
    expect(body.url).toMatch(/^https:\/\/github\.com\/roomowner\//u);
    expect(ghCalls.some((argv) => argv[1] === "repo" && argv[2] === "create" && argv.includes("--private"))).toBe(true);
    // Idempotent: publishing again returns the same URL without a second create.
    const creates = ghCalls.filter((argv) => argv[1] === "repo" && argv[2] === "create").length;
    const again = await postJson(app, `/api/process/${upid}/publish-repo`);
    expect(((await again.json()) as { url: string }).url).toBe(body.url);
    expect(ghCalls.filter((argv) => argv[1] === "repo" && argv[2] === "create").length).toBe(creates);
  });
});

// ADOPTED-TREE BRANCH RAILS (the PR engine for GitHub imports). Scripted
// git/gh seams throughout — no real subprocess, no network, ever.
describe("adopted-tree branch + PR routes", () => {
  // Just enough git semantics for the branch rails AND the local-tree birth:
  // refs move via update-ref, fetch stamps FETCH_HEAD, the staged tree is a
  // constant (so a second commit attempt hits the no-change guard).
  function branchRailGit(): { calls: string[][]; run: NonNullable<ProjectorRuntimeOptions["treeGitRunner"]> } {
    const calls: string[][] = [];
    const refs = new Map<string, string>();
    const commitTrees = new Map<string, string>();
    let seq = 0;
    const run: NonNullable<ProjectorRuntimeOptions["treeGitRunner"]> = async (argv) => {
      calls.push(argv);
      const positional = argv.filter(
        (arg, index) =>
          !arg.startsWith("--git-dir=") && !arg.startsWith("--work-tree=") && arg !== "-c" && argv[index - 1] !== "-c",
      );
      switch (positional[0]) {
        case "fetch":
          refs.set("FETCH_HEAD", "origin-main-tip");
          return { ok: true, stdout: "", stderr: "" };
        case "write-tree":
          return { ok: true, stdout: "tree-working", stderr: "" };
        case "commit-tree": {
          seq += 1;
          const sha = `commit-${seq}`;
          commitTrees.set(sha, positional[1]!);
          return { ok: true, stdout: sha, stderr: "" };
        }
        case "update-ref":
          refs.set(positional[1]!, positional[2]!);
          return { ok: true, stdout: "", stderr: "" };
        case "rev-parse": {
          const target = positional[positional.length - 1]!;
          if (target.endsWith("^{tree}")) {
            const tree = commitTrees.get(target.slice(0, -"^{tree}".length));
            return tree === undefined ? { ok: false, stdout: "", stderr: "" } : { ok: true, stdout: tree, stderr: "" };
          }
          const sha = refs.get(target);
          return sha === undefined ? { ok: false, stdout: "", stderr: "" } : { ok: true, stdout: sha, stderr: "" };
        }
        default:
          return { ok: true, stdout: "", stderr: "" };
      }
    };
    return { calls, run };
  }

  function branchRailGh(): { calls: string[][]; run: NonNullable<ProjectorRuntimeOptions["treeGhRunner"]> } {
    const calls: string[][] = [];
    const run: NonNullable<ProjectorRuntimeOptions["treeGhRunner"]> = async (argv) => {
      calls.push(argv);
      if (argv[1] === "pr" && argv[2] === "create") {
        return { ok: true, stdout: "https://github.com/acme/widget/pull/7\n", stderr: "" };
      }
      return { ok: true, stdout: "", stderr: "" };
    };
    return { calls, run };
  }

  async function importAdopted(app: ReturnType<typeof createProjectorApp>, runtime: ProjectorRuntime): Promise<string> {
    const response = await postJson(app, "/api/projects/import", {
      url: "https://github.com/acme/widget",
      context: "give the widget a dark mode",
    });
    expect(response.status).toBe(200);
    const { upid } = (await response.json()) as { upid: string };
    // The fire-and-forget clone routine adopts after the (fake) clone lands;
    // let the post-clone fan-out settle too so teardown never races it.
    await waitFor(() => runtime.snapshot().processes.some((entry) => entry.upid === upid && entry.treeRepo?.remoteUrl != null));
    await waitFor(() => runtime.registry.builds(upid).some((build) => build.status === "ready"));
    return upid;
  }

  test("branch create fetches origin/main FIRST, cuts room/<slug> at the fetched tip, and the repo route shows it immediately", async () => {
    const git = branchRailGit();
    const gh = branchRailGh();
    const { app, runtime } = await makeApp({
      buildBackends: [new RouteFakeBackend()],
      treeGitRunner: git.run,
      treeGhRunner: gh.run,
    });
    const upid = await importAdopted(app, runtime);

    const created = await postJson(app, `/api/process/${upid}/branch`, { name: "Add Dark Mode!" });
    expect(created.status).toBe(200);
    expect((await created.json()) as unknown).toEqual({ ok: true, branch: "room/add-dark-mode" });

    // Argv shape: the authenticated deepened fetch runs BEFORE any base
    // resolution, against the CLONE's gitdir (builds/<upid>/repo/.git).
    const fetchIndex = git.calls.findIndex((argv) => argv.includes("fetch"));
    expect(fetchIndex).toBeGreaterThanOrEqual(0);
    const fetchArgv = git.calls[fetchIndex]!;
    expect(fetchArgv.some((arg) => arg.startsWith("--git-dir=") && arg.endsWith(`${upid}/repo/.git`))).toBe(true);
    expect(fetchArgv.join(" ")).toContain("-c credential.helper= -c credential.helper=!gh auth git-credential");
    expect(fetchArgv.slice(-3)).toEqual(["--depth=50", "origin", "main"]);
    const updateIndex = git.calls.findIndex((argv) => argv.includes("update-ref") && argv.includes("refs/heads/room/add-dark-mode"));
    expect(updateIndex).toBeGreaterThan(fetchIndex);
    expect(git.calls[updateIndex]).toContain("origin-main-tip");

    // The branch registers in the snapshot/repo surface IMMEDIATELY (0 commits).
    const repo = await app.request(`/api/process/${upid}/repo`);
    expect(repo.status).toBe(200);
    expect((await repo.json()) as unknown).toEqual({
      origin: "https://github.com/acme/widget",
      branches: [{ name: "room/add-dark-mode", commits: 0 }],
    });
  });

  test("the PR route commits spoken changes, pushes ONLY the room branch, opens one PR to the ORIGIN — and is idempotent", async () => {
    const git = branchRailGit();
    const gh = branchRailGh();
    const { app, runtime } = await makeApp({
      buildBackends: [new RouteFakeBackend()],
      treeGitRunner: git.run,
      treeGhRunner: gh.run,
    });
    const upid = await importAdopted(app, runtime);
    await postJson(app, `/api/process/${upid}/branch`, { name: "add dark mode" });

    const opened = await postJson(app, `/api/process/${upid}/branch/add-dark-mode/pr`);
    expect(opened.status).toBe(200);
    expect((await opened.json()) as unknown).toEqual({ ok: true, url: "https://github.com/acme/widget/pull/7" });

    // The working-tree commit landed on the room branch with the spoken-changes message.
    const commit = git.calls.find((argv) => argv.includes("commit-tree"))!;
    expect(commit[commit.indexOf("-m") + 1]).toBe("room: spoken changes");
    // Push: exactly refs/heads/room/<slug>, never --all / main / force.
    const push = git.calls.find((argv) => argv.includes("push"))!;
    expect(push).toContain("refs/heads/room/add-dark-mode:refs/heads/room/add-dark-mode");
    expect(push.join(" ")).toContain("credential.helper=!gh auth git-credential");
    expect(push).not.toContain("--all");
    expect(push).not.toContain("--force");
    expect(push.join(" ")).not.toContain("refs/heads/main");
    // The PR targets the ORIGIN recorded at adopt time — never a spoken name.
    const pr = gh.calls.find((argv) => argv[1] === "pr" && argv[2] === "create")!;
    expect(pr[pr.indexOf("--repo") + 1]).toBe("acme/widget");
    expect(pr[pr.indexOf("--head") + 1]).toBe("room/add-dark-mode");
    expect(pr[pr.indexOf("--base") + 1]).toBe("main");

    // Idempotent: a second call returns the SAME URL with no second pr create
    // (the unchanged working tree also produces no second commit).
    const commitsBefore = git.calls.filter((argv) => argv.includes("commit-tree")).length;
    const again = await postJson(app, `/api/process/${upid}/branch/add-dark-mode/pr`);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { url: string }).url).toBe("https://github.com/acme/widget/pull/7");
    expect(gh.calls.filter((argv) => argv[1] === "pr" && argv[2] === "create")).toHaveLength(1);
    expect(git.calls.filter((argv) => argv.includes("commit-tree"))).toHaveLength(commitsBefore);
    // The repo surface now carries the PR URL on the branch.
    const repo = (await (await app.request(`/api/process/${upid}/repo`)).json()) as {
      branches: Array<{ name: string; prUrl?: string }>;
    };
    expect(repo.branches[0]?.prUrl).toBe("https://github.com/acme/widget/pull/7");
  });

  test("local (non-adopted) trees are refused with a 400 — the rails are adopted-only", async () => {
    const git = branchRailGit();
    const { app, runtime } = await makeApp({
      detector: new ScriptedDetector([ideaResult("a local dashboard", 0.9)]),
      buildBackends: [new RouteFakeBackend()],
      treeGitRunner: git.run,
      treeGhRunner: branchRailGh().run,
    });
    const id = await surfaceIdea(runtime, "a local dashboard");
    await postJson(app, `/api/idea/${id}/accept`);
    const upid = runtime.snapshot().processes[0]!.upid;
    await waitFor(() => runtime.registry.builds(upid).some((build) => build.status === "ready"));

    const refused = await postJson(app, `/api/process/${upid}/branch`, { name: "add dark mode" });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toContain("adopted");
    expect(git.calls.some((argv) => argv.includes("fetch"))).toBe(false);
  });

  test("SELF is refused outright; a malformed branch body is a 400", async () => {
    const { app } = await makeApp({ buildBackends: [new RouteFakeBackend()] });
    const self = await postJson(app, "/api/process/self/branch", { name: "room/hack" });
    expect(self.status).toBe(400);
    const selfPr = await postJson(app, "/api/process/self/branch/main/pr");
    expect(selfPr.status).toBe(400);
    expect((await postJson(app, "/api/process/upid-1/branch", {})).status).toBe(400);
    expect((await postJson(app, "/api/process/upid-1/branch", { name: "   " })).status).toBe(400);
  });

  test("GET /api/process/:upid/repo is a 404 for a UPID with no tree repo", async () => {
    const { app } = await makeApp();
    const response = await app.request("/api/process/upid-ghost/repo");
    expect(response.status).toBe(404);
  });
});

describe("POST /api/process/:upid lifecycle + steer routes", () => {
  test("halt/pause/resume/steer on an unknown upid are 404-free: 200 with the snapshot", async () => {
    const { app } = await makeApp({ buildBackends: [new RouteFakeBackend()] });
    for (const action of ["halt", "pause", "resume"]) {
      const response = await postJson(app, `/api/process/upid-ghost/${action}`);
      expect(response.status).toBe(200);
      expect(((await response.json()) as ProjectorSnapshot).processes).toHaveLength(0);
    }
    const steer = await postJson(app, "/api/process/upid-ghost/steer", { text: "make it blue" });
    expect(steer.status).toBe(200);
  });

  test("steer with a malformed or empty body is a 400", async () => {
    const { app } = await makeApp({ buildBackends: [new RouteFakeBackend()] });
    expect((await postJson(app, "/api/process/upid-1/steer", { text: "   " })).status).toBe(400);
    expect((await postJson(app, "/api/process/upid-1/steer", {})).status).toBe(400);
    expect((await postJson(app, "/api/process/upid-1/steer")).status).toBe(400);
  });

  test("accept → build ready → steer route re-runs the build with the correction; halt tears it down", async () => {
    const backend = new RouteFakeBackend();
    const { app, runtime } = await makeApp({
      detector: new ScriptedDetector([ideaResult("a steerable dashboard", 0.9)]),
      buildBackends: [backend],
    });
    const id = await surfaceIdea(runtime, "a steerable dashboard");
    const accepted = await postJson(app, `/api/idea/${id}/accept`);
    expect(accepted.status).toBe(200);
    const upid = ((await accepted.json()) as ProjectorSnapshot).processes[0]?.upid;
    expect(upid).toBeDefined();
    if (upid === undefined) return;
    await waitFor(() => runtime.registry.builds(upid).some((build) => build.status === "ready"));

    const steered = await postJson(app, `/api/process/${upid}/steer`, { text: "make the header blue" });
    expect(steered.status).toBe(200);
    await waitFor(() => backend.corrections.length === 1);
    expect(backend.corrections[0]).toBe("make the header blue");

    const halted = await postJson(app, `/api/process/${upid}/halt`);
    expect(halted.status).toBe(200);
    const snapshot = (await halted.json()) as ProjectorSnapshot;
    expect(snapshot.processes.find((process) => process.upid === upid)?.state).toBe("halted");
    expect(runtime.registry.builds(upid)).toHaveLength(0);
  });
});

// PER-PROCESS DISMISS (the tree menu's 🗑 remove): unlike halt — which keeps
// a dead card on the wall — dismiss stops the process's builds AND removes it
// from the snapshot entirely. Builds bookkeeping only; the pinned SELF
// project is refused (the room must not dismiss itself).
describe("POST /api/process/:upid/dismiss", () => {
  test("stops the builds and removes the process from the snapshot (no dead card)", async () => {
    const { app, runtime } = await makeApp({
      detector: new ScriptedDetector([ideaResult("a removable dashboard", 0.9)]),
      buildBackends: [new RouteFakeBackend()],
    });
    const id = await surfaceIdea(runtime, "a removable dashboard");
    const accepted = await postJson(app, `/api/idea/${id}/accept`);
    const upid = ((await accepted.json()) as ProjectorSnapshot).processes[0]?.upid;
    expect(upid).toBeDefined();
    if (upid === undefined) return;
    await waitFor(() => runtime.registry.builds(upid).some((build) => build.status === "ready"));

    const dismissed = await postJson(app, `/api/process/${upid}/dismiss`);
    expect(dismissed.status).toBe(200);
    const snapshot = (await dismissed.json()) as ProjectorSnapshot;
    // Halt leaves a dead card; dismiss leaves NOTHING — the tree is gone.
    expect(snapshot.processes.find((process) => process.upid === upid)).toBeUndefined();
    expect(runtime.registry.records().find((record) => record.upid === upid)).toBeUndefined();
    expect(runtime.registry.builds(upid)).toHaveLength(0);
  });

  test("an unknown upid is 404-free: 200 with the snapshot unchanged", async () => {
    const { app } = await makeApp({ buildBackends: [new RouteFakeBackend()] });
    const response = await postJson(app, "/api/process/upid-ghost/dismiss");
    expect(response.status).toBe(200);
    expect(((await response.json()) as ProjectorSnapshot).processes).toHaveLength(0);
  });

  test("the SELF project is refused: the room must not dismiss itself", async () => {
    const { app } = await makeApp({ buildBackends: [new RouteFakeBackend()] });
    const response = await postJson(app, "/api/process/self/dismiss");
    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("cannot dismiss itself");
  });

  test("offline-demo referer guard: nothing is removed, cosmetic snapshot returned", async () => {
    const { app, runtime } = await makeApp({
      detector: new ScriptedDetector([ideaResult("a sticky dashboard", 0.9)]),
      buildBackends: [new RouteFakeBackend()],
    });
    const id = await surfaceIdea(runtime, "a sticky dashboard");
    const accepted = await postJson(app, `/api/idea/${id}/accept`);
    const upid = ((await accepted.json()) as ProjectorSnapshot).processes[0]?.upid;
    expect(upid).toBeDefined();
    if (upid === undefined) return;

    const response = await postJson(app, `/api/process/${upid}/dismiss`, undefined, {
      referer: "http://localhost:8787/?live=0",
    });
    expect(response.status).toBe(200);
    expect(runtime.registry.records().find((record) => record.upid === upid)).toBeDefined();
  });
});

describe("POST /api/process/:upid/answer — swipe-deck answers", () => {
  test("records the answer in the ledger AND steers the build with the question-framed correction", async () => {
    const backend = new RouteFakeBackend();
    const { app, runtime } = await makeApp({
      detector: new ScriptedDetector([ideaResult("an answerable quiz", 0.9)]),
      buildBackends: [backend],
    });
    const id = await surfaceIdea(runtime, "an answerable quiz");
    const accepted = await postJson(app, `/api/idea/${id}/accept`);
    const upid = ((await accepted.json()) as ProjectorSnapshot).processes[0]?.upid;
    expect(upid).toBeDefined();
    if (upid === undefined) return;
    await waitFor(() => runtime.registry.builds(upid).some((build) => build.status === "ready"));

    const answered = await postJson(app, `/api/process/${upid}/answer`, {
      questionId: "q-scope",
      prompt: "Real money or points first?",
      answer: "Points",
    });
    expect(answered.status).toBe(200);
    // Ledger first: the regeneration triggered by the steer must already see
    // this decision (renders the card pre-decided).
    expect(runtime.answeredQuestions(upid)).toEqual([
      { questionId: "q-scope", prompt: "Real money or points first?", answer: "Points" },
    ]);
    // The steer is framed as the ACTUAL question, not an opaque id.
    await waitFor(() => backend.corrections.length === 1);
    expect(backend.corrections[0]).toBe('Decision — for "Real money or points first?", the choice is "Points". Build accordingly.');
  });

  test("a re-answer replaces the ledger entry (latest answer per question wins)", async () => {
    const { app, runtime } = await makeApp({ buildBackends: [new RouteFakeBackend()] });
    await postJson(app, "/api/process/upid-quiz/answer", { questionId: "q-1", prompt: "Fork?", answer: "Left" });
    await postJson(app, "/api/process/upid-quiz/answer", { questionId: "q-1", prompt: "Fork?", answer: "Right" });
    expect(runtime.answeredQuestions("upid-quiz")).toEqual([{ questionId: "q-1", prompt: "Fork?", answer: "Right" }]);
  });

  test("a missing prompt falls back to the questionId for the framing (older deck copies)", async () => {
    const { app, runtime } = await makeApp({ buildBackends: [new RouteFakeBackend()] });
    const response = await postJson(app, "/api/process/upid-old/answer", { questionId: "q-legacy", answer: "Yes" });
    expect(response.status).toBe(200);
    expect(runtime.answeredQuestions("upid-old")).toEqual([{ questionId: "q-legacy", prompt: "q-legacy", answer: "Yes" }]);
  });

  test("malformed bodies are a 400 and never touch the ledger", async () => {
    const { app, runtime } = await makeApp({ buildBackends: [new RouteFakeBackend()] });
    expect((await postJson(app, "/api/process/upid-x/answer", { questionId: "q", answer: "  " })).status).toBe(400);
    expect((await postJson(app, "/api/process/upid-x/answer", { answer: "Yes" })).status).toBe(400);
    expect((await postJson(app, "/api/process/upid-x/answer")).status).toBe(400);
    expect(runtime.answeredQuestions("upid-x")).toEqual([]);
  });
});

describe("POST /api/process/:upid/execute — the COMMISSION stage", () => {
  test("kickoff accept never launches the durable run; execute opens the execution lane, and a repeat is a 400", async () => {
    const backend = new RouteFakeBackend();
    const { app, runtime } = await makeApp({
      detector: new ScriptedDetector([ideaResult("a commissionable dashboard", 0.9)]),
      buildBackends: [backend],
    });
    const id = await surfaceIdea(runtime, "a commissionable dashboard");
    const accepted = await postJson(app, `/api/idea/${id}/accept`);
    expect(accepted.status).toBe(200);
    const acceptedSnapshot = (await accepted.json()) as ProjectorSnapshot;
    const upid = acceptedSnapshot.processes[0]?.upid;
    // The per-boot nonce is folded into the pre-assigned runId; the commission
    // launches under exactly this advertised id.
    const spawnedRunId = acceptedSnapshot.processes[0]?.runId;
    expect(upid).toBeDefined();
    if (upid === undefined) return;
    // KICKOFF invariant: accept produced a process with NO execution lane.
    expect((acceptedSnapshot.processes[0] as { execution?: unknown }).execution ?? null).toBeNull();
    expect(runtime.registry.hasDurableRun(upid)).toBe(false);

    // COMMISSION: 200 with the fresh snapshot carrying the executing lane.
    const executed = await postJson(app, `/api/process/${upid}/execute`);
    expect(executed.status).toBe(200);
    const snapshot = (await executed.json()) as ProjectorSnapshot;
    const lane = (snapshot.processes.find((process) => process.upid === upid) as {
      execution?: { status: string; runId: string; percent: number; previewUrl: string | null };
    }).execution;
    expect(lane).toMatchObject({ status: "executing", runId: spawnedRunId, percent: 0, previewUrl: null });
    expect(runtime.registry.hasDurableRun(upid)).toBe(true);

    // Idempotent: a second execute is a 400, not a second launch.
    const again = await postJson(app, `/api/process/${upid}/execute`);
    expect(again.status).toBe(400);
    const body = (await again.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("already executing");
  });

  test("an unknown upid is a 404; a halted process cannot be commissioned", async () => {
    const { app, runtime } = await makeApp({
      detector: new ScriptedDetector([ideaResult("a doomed dashboard", 0.9)]),
      buildBackends: [new RouteFakeBackend()],
    });
    expect((await postJson(app, "/api/process/upid-ghost/execute")).status).toBe(404);

    const id = await surfaceIdea(runtime, "a doomed dashboard");
    await postJson(app, `/api/idea/${id}/accept`);
    const upid = runtime.snapshot().processes[0]?.upid;
    expect(upid).toBeDefined();
    if (upid === undefined) return;
    await postJson(app, `/api/process/${upid}/halt`);
    expect((await postJson(app, `/api/process/${upid}/execute`)).status).toBe(404);
  });
});

// --- AUTOCAL PROXY: the walls' same-origin window onto the python calibrator -

describe("autocal proxy — /api/autocal/state + /api/autocal/start", () => {
  function scriptedFetch(
    calls: Array<{ url: string; method: string | undefined }>,
    body: unknown,
  ): (input: string | URL, init?: RequestInit) => Promise<Response> {
    return async (input, init) => {
      calls.push({ url: String(input), method: init?.method });
      return Response.json(body);
    };
  }

  test("GET state proxies the local calibrator's JSON straight through", async () => {
    const calls: Array<{ url: string; method: string | undefined }> = [];
    const state = { phase: "running", marker: { wall: "A", u: 0.5, v: 0.25, r: 0.11 }, msg: "sweeping" };
    const { app } = await makeApp({ autocalFetch: scriptedFetch(calls, state) });

    const response = await app.request("/api/autocal/state");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(state);
    expect(calls).toEqual([{ url: "http://127.0.0.1:8801/calib/state", method: "GET" }]);
  });

  test("POST start proxies the POST and returns the calibrator's ack", async () => {
    const calls: Array<{ url: string; method: string | undefined }> = [];
    const { app } = await makeApp({ autocalFetch: scriptedFetch(calls, { ok: true }) });

    const response = await app.request("/api/autocal/start", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(calls).toEqual([{ url: "http://127.0.0.1:8801/calib/start", method: "POST" }]);
  });

  test("VIBERSYN_AUTOCAL_PORT redirects the proxy's upstream", async () => {
    const calls: Array<{ url: string; method: string | undefined }> = [];
    const { app } = await makeApp({
      env: { VIBERSYN_AUTOCAL_PORT: "9911" },
      autocalFetch: scriptedFetch(calls, { phase: "idle", marker: null, msg: "waiting" }),
    });
    await app.request("/api/autocal/state");
    expect(calls[0]?.url).toBe("http://127.0.0.1:9911/calib/state");
  });

  test("an unreachable calibrator is {up:false} with a 200 — the walls stay rooms", async () => {
    const { app } = await makeApp({
      autocalFetch: async () => {
        throw new Error("connection refused");
      },
    });
    for (const request of [app.request("/api/autocal/state"), app.request("/api/autocal/start", { method: "POST" })]) {
      const response = await request;
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ up: false });
    }
  });

  test("a non-OK upstream answer degrades to {up:false} too (never a 5xx to the wall)", async () => {
    const { app } = await makeApp({
      autocalFetch: async () => new Response("boom", { status: 500 }),
    });
    const response = await app.request("/api/autocal/state");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ up: false });
  });
});

// --- BUILD STAMP: the walls' auto-reload watches this ------------------------

describe("GET /api/build-stamp", () => {
  test("shape: {stamp} derived from the served dist/index.html mtime", async () => {
    const { app } = await makeApp({ distIndexStat: async () => ({ mtimeMs: 1723456789012 }) });
    const response = await app.request("/api/build-stamp");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stamp: "1723456789012" });
  });

  test("no dist build yet → {stamp:null} with a 200 (dev / first boot, never an error)", async () => {
    const { app } = await makeApp({
      distIndexStat: async () => {
        throw new Error("ENOENT");
      },
    });
    const response = await app.request("/api/build-stamp");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stamp: null });
  });

  test("the stat is cached (~5s): back-to-back polls hit the fs once", async () => {
    let statCalls = 0;
    const { app } = await makeApp({
      distIndexStat: async () => {
        statCalls += 1;
        return { mtimeMs: 42 };
      },
    });
    expect(await (await app.request("/api/build-stamp")).json()).toEqual({ stamp: "42" });
    expect(await (await app.request("/api/build-stamp")).json()).toEqual({ stamp: "42" });
    expect(statCalls).toBe(1);
  });
});

describe("seam action API — /api/seam/* over the live runtime", () => {
  test("POST /api/seam/actions status returns the live fleet summary (no placeholder)", async () => {
    const buildsRoot = mkdtempSync(join(tmpdir(), "vibersyn-app-seam-"));
    tempDirs.push(buildsRoot);
    const runtime = await createProjectorRuntime(
      {
        VIBERSYN_INITIAL_MUTED: "0",
        VIBERSYN_SEED_DEMO_FLEET: "1",
        VIBERSYN_IDEA_DETECTOR: "heuristic",
        VIBERSYN_DETECT_MIN_NEW_TURNS: "1",
        VIBERSYN_DETECT_MIN_INTERVAL_MS: "0",
        VIBERSYN_DETECT_TICK_MS: "0",
      },
      { buildsRoot, builderAgent: noopBuilder },
    );
    runtimes.push(runtime);
    const app = createProjectorApp(runtime, { env: {}, host: "127.0.0.1", port: 8787 });

    const health = await app.request("/api/seam/health");
    expect(health.status).toBe(200);

    const response = await postJson(app, "/api/seam/actions", {
      type: "status",
      targetUPID: null,
      payload: {},
      correlationId: "corr-seam-status-test",
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as { accepted: boolean; statusSummary?: string };
    expect(body.accepted).toBe(true);
    // Real registry status (the seeded fleet), not the removed "Status requested." placeholder.
    expect(body.statusSummary?.toLowerCase()).toContain("atlas");

    const status = await app.request("/api/seam/status");
    const statusBody = (await status.json()) as { summary: string };
    expect(statusBody.summary.toLowerCase()).toContain("atlas");
  });
});

// --- GITHUB FOREST surface: /api/org/import + /api/forest ---------------------
// Route behavior over an INJECTED loader fake (registerForestSurface's seam) —
// no test ever touches the process-wide gh-CLI loader with a POST.

describe("forest surface — POST /api/org/import + GET /api/forest", () => {
  function fakeForestLoader(state: ForestState): { loader: ForestSurfaceLoader; loads: string[] } {
    const loads: string[] = [];
    return {
      loads,
      loader: {
        async load(org: string): Promise<void> {
          loads.push(org);
        },
        current: () => state,
      },
    };
  }

  function forestApp(state: ForestState): { app: Hono; loads: string[] } {
    const app = new Hono();
    const { loader, loads } = fakeForestLoader(state);
    registerForestSurface(app, { loader });
    return { app, loads };
  }

  test("POST {org} starts loading and 202s with the normalized org", async () => {
    const { app, loads } = forestApp({ org: null });
    const response = await postJson(app, "/api/org/import", { org: "acme" });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, org: "acme" });
    expect(loads).toEqual(["acme"]);
  });

  test("a github URL normalizes to its org before loading", async () => {
    const { app, loads } = forestApp({ org: null });
    const response = await postJson(app, "/api/org/import", { org: "https://github.com/Acme-Org/some-repo" });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, org: "Acme-Org" });
    expect(loads).toEqual(["Acme-Org"]);
  });

  test("malformed bodies are a 400 and never reach the loader", async () => {
    const { app, loads } = forestApp({ org: null });
    for (const body of [undefined, {}, { org: "" }, { org: "not a name" }, { org: 42 }, { org: "../../etc" }]) {
      const response = await postJson(app, "/api/org/import", body);
      expect(response.status).toBe(400);
      const parsed = (await response.json()) as { ok: boolean; error?: string };
      expect(parsed.ok).toBe(false);
      expect(parsed.error?.length ?? 0).toBeGreaterThan(0);
    }
    expect(loads).toEqual([]);
  });

  test("GET /api/forest serves the loader's current payload verbatim", async () => {
    const payload: ForestState = {
      org: "acme",
      fetchedAtMs: 1_723_450_000_000,
      repos: [
        {
          name: "widget",
          pushedAtMs: 1_723_400_000_000,
          prs: [
            { number: 12, title: "Add grove", draft: false, ci: "pass", baseRef: "main", headRef: "feat/grove" },
            { number: 13, title: "Polish", draft: true, ci: "pending", baseRef: "feat/grove", headRef: "feat/polish", stackedOn: 12 },
          ],
          issues: [{ number: 3, title: "Crash on load", labels: ["bug"] }],
        },
      ],
    };
    const { app } = forestApp(payload);
    const response = await app.request("/api/forest");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(payload);
  });

  test("no org imported yet → {org:null}", async () => {
    const { app } = forestApp({ org: null });
    expect(await (await app.request("/api/forest")).json()).toEqual({ org: null });
  });

  test("the real projector app registers the surface (GET answers before the static catch-all)", async () => {
    const { app } = await makeApp();
    const response = await app.request("/api/forest");
    expect(response.status).toBe(200);
    // The process-wide loader starts empty; this test only asserts the route
    // exists — it must never POST an import (that would spawn a real gh).
    expect(((await response.json()) as { org: string | null }).org).toBeNull();
  });
});
