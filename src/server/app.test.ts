import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { createPhoneImportApp, createProjectorApp } from "./app";
import { TRANSCRIPT_ARCHIVE_DEFAULT_DIR, listDays, localDayKey, readDay } from "./transcript-archive";
import { registerForestSurface, type ForestState, type ForestSurfaceLoader } from "./github-org";
import { RemoteHandsHub } from "./remote-hands";
import { createProjectorRuntime, type ProjectorRuntime, type ProjectorRuntimeOptions } from "./composition";
import type { BuilderAgent } from "./idea-builder";
import type { BuildBackend, BuildRequest, BuildResult } from "../buildloop/types";
import type { DetectionInput, DetectionResult, IdeaDetector } from "../detect";
import type { InterfaceAddresses } from "./project-import";
import type { ProjectorSnapshot } from "../ui/types";
import { SELF_UPID } from "../self/commission";

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
  // Deployment-resolver seam. Default NULL (resolver off) — no test may ever
  // HEAD-probe a real host or spawn a real gh; deploy tests inject a fake.
  resolveDeployFn?: ProjectorRuntimeOptions["resolveDeployFn"];
  // /salem proxy upstream seam — no test may ever reach the real board.
  salemFetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  // Extra RUNTIME options merged LAST (the self version-rail tests inject
  // selfGitRunner/selfGhRunner/selfGitHead/exitProcess) — same contract as
  // runtimeEnv: makeApp's deterministic defaults stay unless overridden.
  runtimeOptions?: ProjectorRuntimeOptions;
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
      resolveDeployFn: args.resolveDeployFn ?? null,
      ...args.runtimeOptions,
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
    salemFetch: args.salemFetch ?? (async () => Promise.reject(new Error("no salemFetch injected"))),
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

    // A repo imported with NO instruction is STUDIED now, not built
    // (project-intake.ts) — this test is about the build pipeline, so it asks
    // for the build the way a person would.
    const response = await postJson(app, "/api/projects/import", {
      url: "https://github.com/RonTuretzky/gesture-wall",
      context: "build a live preview for this",
    });
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
    // `atMs` (the arrival stamp the wall's plant offer keys off) rides the
    // source now, so match structurally rather than exactly.
    expect(imported.source).toMatchObject({ kind: "github-import", url: "https://github.com/RonTuretzky/gesture-wall" });
    expect(typeof imported.source?.atMs).toBe("number");
    expect(imported.task).toBe("build a live preview for this");
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

  test("the brief EXISTENCE probe answers 200 either way — no console-404 per no-study import", async () => {
    const { app } = await makeApp();
    const response = await app.request("/api/process/upid-never-studied/brief/exists");
    expect(response.status).toBe(200);
    expect(((await response.json()) as { has: boolean }).has).toBe(false);
  });

  test("A BARE REPO LINK IS STUDIED, NOT BUILT — and the brief route serves it", async () => {
    // The live miss this exists for: someone imported a repo, typed "just
    // study it first", and the room built it anyway because the description
    // was only ever used as build framing. A repo with no instruction (or an
    // explicit ask to read) now produces a brief and fans out NOTHING.
    const { app, runtime } = await makeApp({
      cloneRepoFn: async ({ dir }) => ({ ok: true, dir }),
      // repoDigestFn is a runtime option (makeApp pins its own default above).
      runtimeOptions: { repoDigestFn: async () => "Appears to be a Vite + React app.\nStack: typescript, react" },
    });
    const response = await postJson(app, "/api/projects/import", {
      url: "https://github.com/acme/widget",
      context: "just study it first",
    });
    expect(response.status).toBe(200);
    const { upid } = (await response.json()) as { upid: string };

    // waitFor takes a SYNC predicate — an async one returns a truthy promise
    // and passes instantly. Poll the route directly.
    const deadline = Date.now() + 5_000;
    let briefStatus = 0;
    while (briefStatus !== 200 && Date.now() < deadline) {
      briefStatus = (await app.request(`/api/process/${upid}/brief`)).status;
      if (briefStatus !== 200) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    expect(briefStatus).toBe(200);
    const brief = (await (await app.request(`/api/process/${upid}/brief`)).json()) as {
      brief: { summary: string | null; ask: string | null };
      intent: string;
    };
    expect(brief.intent).toBe("study");
    expect(brief.brief.summary).toContain("Appears to be");
    expect(brief.brief.ask).toBe("just study it first");
    // NOTHING was built.
    expect(runtime.registry.builds(upid)).toHaveLength(0);

    // And the brief's one press forward flips the project to build intent —
    // the study was the first step, not a dead end.
    const built = await app.request(`/api/process/${upid}/build`, { method: "POST" });
    expect(built.status).toBe(200);
    expect(runtime.projectIntent(upid)).toBe("build");
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
    expect(process.source).toMatchObject({ kind: "phone-import", url: null });
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
    expect(process.source).toMatchObject({ kind: "phone-import", url: "https://example.com/spec" });
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
    // A bare link with no instruction is STUDIED now (project-intake.ts); this
    // test is about the fallback BUILD when the clone fails, so it asks.
    const response = await postJson(app, "/api/projects/import", {
      url: "https://github.com/o/gone",
      context: "build something from this link",
    });
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

  // The served assets resolve from the installed @mediapipe/tasks-vision
  // package plus the DOWNLOADED (gitignored) hand model in gesture-wall/models
  // — the same paths registerHandsSurface() serves. Environments without them
  // (CI, a worktree that never ran the model fetch) skip LOUDLY.
  const handsAssetFiles = [
    new URL("../../node_modules/@mediapipe/tasks-vision/vision_bundle.mjs", import.meta.url).pathname,
    new URL("../../node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.js", import.meta.url).pathname,
    new URL("../../node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm", import.meta.url).pathname,
    new URL("../../gesture-wall/models/hand_landmarker.task", import.meta.url).pathname,
  ];
  const handsAssetsMissing = handsAssetFiles.filter((path) => !existsSync(path));
  if (handsAssetsMissing.length > 0) {
    console.warn(
      `[hands-assets] skipping the self-hosted tracker asset test: missing ${handsAssetsMissing.join(", ")} (the hand model is downloaded, not committed)`,
    );
  }

  test.skipIf(handsAssetsMissing.length > 0)("self-hosted tracker assets: bundle, wasm, and model all serve with sane types", async () => {
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

  test("merge squashes the branch's OPEN PR, is idempotent, and refuses a branch with no PR", async () => {
    const git = branchRailGit();
    const gh = branchRailGh();
    const { app, runtime } = await makeApp({
      buildBackends: [new RouteFakeBackend()],
      treeGitRunner: git.run,
      treeGhRunner: gh.run,
    });
    const upid = await importAdopted(app, runtime);
    await postJson(app, `/api/process/${upid}/branch`, { name: "add dark mode" });

    // No PR yet: merging is refused with the honest reason, and gh never runs.
    const early = await postJson(app, `/api/process/${upid}/branch/add-dark-mode/merge`);
    expect(early.status).toBe(400);
    expect(((await early.json()) as { error: string }).error).toContain("PR");
    expect(gh.calls.some((argv) => argv[2] === "merge")).toBe(false);

    await postJson(app, `/api/process/${upid}/branch/add-dark-mode/pr`);
    const merged = await postJson(app, `/api/process/${upid}/branch/add-dark-mode/merge`);
    expect(merged.status).toBe(200);
    expect((await merged.json()) as unknown).toEqual({ ok: true, merged: true });
    // Squash-merge of the STORED PR url against the recorded origin.
    const merge = gh.calls.find((argv) => argv[1] === "pr" && argv[2] === "merge")!;
    expect(merge).toContain("--squash");
    expect(merge).toContain("https://github.com/acme/widget/pull/7");
    expect(merge[merge.indexOf("--repo") + 1]).toBe("acme/widget");

    // Idempotent: pressing again stays ok (upstream reports already merged).
    const again = await postJson(app, `/api/process/${upid}/branch/add-dark-mode/merge`);
    expect(again.status).toBe(200);
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
    const selfMerge = await postJson(app, "/api/process/self/branch/main/merge");
    expect(selfMerge.status).toBe(400);
    expect((await postJson(app, "/api/process/upid-1/branch", {})).status).toBe(400);
    expect((await postJson(app, "/api/process/upid-1/branch", { name: "   " })).status).toBe(400);
  });

  test("GET /api/process/:upid/repo is a 404 for a UPID with no tree repo", async () => {
    const { app } = await makeApp();
    const response = await app.request("/api/process/upid-ghost/repo");
    expect(response.status).toBe(404);
  });
});

// THE ROOM'S OWN VERSION RAILS (self git/gh over the injected seams — no real
// subprocess, no network, ever). These are the tree-tending surface's routes:
// GET /api/self/branches, POST /api/self/checkout, POST /api/self/branch
// (archive / delete+remote-prune / merge), POST /api/self/run/halt.
describe("self version rails over the seamed git/gh", () => {
  // Just enough git semantics for the self rails: a current branch, an ordered
  // (newest-first) branch list with subjects, fast-forward ancestry, and
  // scriptable push failures. Argv arrives WITHOUT the leading "git". For the
  // prune-excise rails each branch may carry a COMMIT MODEL (`commits`:
  // newest-first ids, shared ids = shared history) — that turns on real
  // containment answers for merge-base/rev-list, temp-worktree bookkeeping
  // (`worktree add/remove`, leading `-C <path>` context), scriptable revert
  // conflicts (`conflictOn`: branch names whose revert refuses), and the
  // update-ref CAS. Branches WITHOUT commits keep the legacy ffAncestors
  // behavior, so the older rails tests run unchanged.
  function selfRailGit(setup: {
    current: string;
    branches: Array<{ name: string; subject?: string; date?: string; commits?: string[] }>;
    ffAncestors?: string[];
    dirtySrc?: boolean;
    failPushDelete?: boolean;
    conflictOn?: string[];
  }): {
    calls: string[][];
    state: { current: string; branches: Array<{ name: string; subject: string; date: string; commits?: string[] }> };
    run: NonNullable<ProjectorRuntimeOptions["selfGitRunner"]>;
  } {
    const calls: string[][] = [];
    const state = {
      current: setup.current,
      branches: setup.branches.map((entry) => ({
        subject: "",
        date: "1 hour ago",
        ...entry,
        ...(entry.commits !== undefined ? { commits: [...entry.commits] } : {}),
      })),
    };
    // Temp worktrees the excise adds: path → the detached commit list plus
    // the branch whose tip it detached at (conflict scripting keys on it).
    const worktrees = new Map<string, { branch: string; commits: string[] }>();
    const byName = (name: string) => state.branches.find((entry) => entry.name === name);
    const refName = (ref: string) => ref.replace(/^refs\/(heads|remotes\/origin)\//u, "");
    const ok = (stdout = ""): { ok: true; stdout: string; stderr: string } => ({ ok: true, stdout, stderr: "" });
    const fail = (stderr: string): { ok: false; stdout: string; stderr: string } => ({ ok: false, stdout: "", stderr });
    const run: NonNullable<ProjectorRuntimeOptions["selfGitRunner"]> = async (rawArgv) => {
      calls.push(rawArgv);
      // Leading `-C <path>` = run inside a temp worktree (the excise's revert
      // context); everything else runs "in the live checkout" (state.current).
      let context: { branch: string; commits: string[] } | null = null;
      let argv = rawArgv;
      if (argv[0] === "-C") {
        const tracked = worktrees.get(argv[1]!);
        if (tracked === undefined) {
          return fail(`fatal: cannot change to '${argv[1]}'`);
        }
        context = tracked;
        argv = argv.slice(2);
      }
      switch (argv[0]) {
        case "branch": {
          if (argv[1] === "--show-current") {
            return ok(state.current);
          }
          if (argv[1] === "-D") {
            const index = state.branches.findIndex((entry) => entry.name === argv[2]);
            if (index < 0) {
              return fail(`error: branch '${argv[2]}' not found.`);
            }
            state.branches.splice(index, 1);
            return ok();
          }
          if (argv[1] === "-m") {
            const entry = state.branches.find((candidate) => candidate.name === argv[2]);
            if (entry === undefined) {
              return fail(`error: branch '${argv[2]}' not found.`);
            }
            entry.name = argv[3]!;
            return ok();
          }
          return ok();
        }
        case "for-each-ref": {
          // The excise's bare candidate listing (room/* names only)…
          if (argv.includes("--format=%(refname:short)")) {
            const lines = state.branches
              .filter((entry) => entry.name.startsWith("room/"))
              .map((entry) => entry.name);
            return ok(lines.join("\n"));
          }
          // …else the rails listing: room/* heads + the current branch, in
          // stored (newest-first) order.
          const lines = state.branches
            .filter((entry) => entry.name.startsWith("room/") || entry.name === state.current)
            .map((entry) => `${entry.name}${entry.subject}${entry.date}`);
          return ok(lines.join("\n"));
        }
        case "rev-parse": {
          const ref = argv[argv.length - 1]!;
          if (ref === "HEAD") {
            return context !== null
              ? ok(context.commits[0] ?? "")
              : ok(byName(state.current)?.commits?.[0] ?? state.current);
          }
          const name = refName(ref);
          const entry = byName(name);
          return entry !== undefined ? ok(entry.commits?.[0] ?? name) : fail("");
        }
        case "rev-list": {
          const range = argv[argv.length - 1]!;
          const [fromRef, toRef] = range.split("..");
          const from = new Set(byName(refName(fromRef ?? ""))?.commits ?? []);
          const to = byName(refName(toRef ?? ""))?.commits ?? [];
          const diff = to.filter((commit) => !from.has(commit));
          return argv[1] === "--count" ? ok(String(diff.length)) : ok(diff.join("\n"));
        }
        case "status":
          // Porcelain: the runner's out-join trims the leading space off the
          // first line, so an untracked entry (3-char "?? " prefix survives
          // the trim) is the faithful way to fake dirty src/.
          return ok(setup.dirtySrc === true ? "?? src/ui/App.tsx" : "");
        case "checkout":
          state.current = argv[argv.length - 1]!;
          return ok();
        case "merge-base": {
          // --is-ancestor <probe> <target>: containment over the commit model
          // when the target models commits (probe = a ref's tip or a bare
          // commit id); legacy ffAncestors scripting otherwise.
          const target = byName(refName(argv[argv.length - 1]!));
          const probe = argv[argv.length - 2]!;
          if (target?.commits !== undefined) {
            const probeCommit = byName(refName(probe))?.commits?.[0] ?? probe;
            return target.commits.includes(probeCommit) ? ok() : fail("");
          }
          return (setup.ffAncestors ?? []).includes(refName(argv[argv.length - 1]!)) ? ok() : fail("");
        }
        case "worktree": {
          if (argv[1] === "add") {
            const path = argv[argv.length - 2]!;
            const tip = argv[argv.length - 1]!;
            const source = state.branches.find((entry) => entry.commits?.[0] === tip);
            if (source?.commits === undefined) {
              return fail(`fatal: invalid reference: ${tip}`);
            }
            worktrees.set(path, { branch: source.name, commits: [...source.commits] });
            return ok();
          }
          if (argv[1] === "remove") {
            worktrees.delete(argv[argv.length - 1]!);
            return ok();
          }
          return ok(); // prune
        }
        case "revert": {
          if (argv[1] === "--abort") {
            return ok();
          }
          const target = context ?? { branch: state.current, commits: byName(state.current)?.commits ?? [] };
          if ((setup.conflictOn ?? []).includes(target.branch)) {
            return fail("error: could not revert — conflict in f.txt");
          }
          for (const commit of argv.slice(2)) {
            target.commits.unshift(`revert-of-${commit}`);
          }
          return ok();
        }
        case "update-ref": {
          const entry = byName(refName(argv[1]!));
          const newTip = argv[2]!;
          const oldTip = argv[3];
          if (entry === undefined) {
            return fail("");
          }
          // The old-value CAS: refuse if the tip moved under the excise.
          if (oldTip !== undefined && (entry.commits?.[0] ?? entry.name) !== oldTip) {
            return fail(`cannot lock ref 'refs/heads/${entry.name}'`);
          }
          const source = [...worktrees.values()].find((tracked) => tracked.commits[0] === newTip);
          if (source === undefined) {
            return fail(`fatal: ${newTip}: not a valid SHA1`);
          }
          entry.commits = [...source.commits];
          return ok();
        }
        case "push":
          if (argv.includes("--delete") && setup.failPushDelete === true) {
            return fail("remote: permission denied");
          }
          return ok();
        default:
          return ok();
      }
    };
    return { calls, state, run };
  }

  // gh seam (argv INCLUDES the leading "gh"): `pr list --state all` answers
  // the finalize probe, `--state open` the prune's close probe.
  function selfRailGh(setup: {
    pr?: { number: number; state: string; isDraft: boolean; baseRefName: string } | null;
    openPr?: { number: number } | null;
  } = {}): { calls: string[][]; run: NonNullable<ProjectorRuntimeOptions["selfGhRunner"]> } {
    const calls: string[][] = [];
    const run: NonNullable<ProjectorRuntimeOptions["selfGhRunner"]> = async (argv) => {
      calls.push(argv);
      if (argv[1] === "pr" && argv[2] === "list") {
        const openProbe = argv[argv.indexOf("--state") + 1] === "open";
        const listed = openProbe ? (setup.openPr ?? null) : (setup.pr ?? null);
        return { ok: true, stdout: JSON.stringify(listed === null ? [] : [listed]), stderr: "" };
      }
      return { ok: true, stdout: "", stderr: "" };
    };
    return { calls, run };
  }

  const RAILS = [
    { name: "room/hp-at-hp-four", subject: "the default is never an invisible cursor", date: "2 minutes ago" },
    { name: "room/older-limb", subject: "self: an older change", date: "2 hours ago" },
    { name: "main", subject: "trunk", date: "3 hours ago" },
  ];

  test("GET /api/self/branches: current + room/* heads through the seam, newest first", async () => {
    const git = selfRailGit({ current: "room/hp-at-hp-four", branches: RAILS });
    const { app } = await makeApp({ runtimeOptions: { selfGitRunner: git.run, selfGhRunner: selfRailGh().run } });
    const response = await app.request("/api/self/branches");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { current: string; branches: Array<{ name: string; subject: string }> };
    expect(body.current).toBe("room/hp-at-hp-four");
    expect(body.branches.map((entry) => entry.name)).toEqual(["room/hp-at-hp-four", "room/older-limb"]);
    expect(body.branches[0]?.subject).toBe("the default is never an invisible cursor");
  });

  test("checkout refuses honestly: unknown branch / dirty src/ / no supervisor", async () => {
    // No supervisor (VIBERSYN_SELF_MODE unset): the refusal names the launch.
    const bare = await makeApp({ runtimeOptions: { selfGitRunner: selfRailGit({ current: "main", branches: RAILS }).run } });
    const unsupervised = await postJson(bare.app, "/api/self/checkout", { branch: "room/older-limb" });
    expect(unsupervised.status).toBe(400);
    expect(((await unsupervised.json()) as { error: string }).error).toContain("no supervisor");

    // Self mode on: unknown branch and dirty src/ each say exactly why.
    const dirty = selfRailGit({ current: "room/hp-at-hp-four", branches: RAILS, dirtySrc: true });
    const { app } = await makeApp({
      runtimeEnv: { VIBERSYN_SELF_MODE: "1" },
      runtimeOptions: {
        selfGitRunner: dirty.run,
        selfGitHead: async () => ({ sha: "sha-0", subject: "prior" }),
        exitProcess: () => undefined,
      },
    });
    const ghost = await postJson(app, "/api/self/checkout", { branch: "room/ghost" });
    expect(ghost.status).toBe(400);
    expect(((await ghost.json()) as { error: string }).error).toContain("no local branch");
    const refused = await postJson(app, "/api/self/checkout", { branch: "room/older-limb" });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toContain("uncommitted work");
    expect(dirty.calls.some((argv) => argv[0] === "checkout")).toBe(false);
  });

  test("checkout success: git checkout runs and the supervisor exit fires through the seam", async () => {
    const git = selfRailGit({ current: "room/hp-at-hp-four", branches: RAILS });
    const exits: number[] = [];
    const { app } = await makeApp({
      runtimeEnv: { VIBERSYN_SELF_MODE: "1" },
      runtimeOptions: {
        selfGitRunner: git.run,
        selfGitHead: async () => ({ sha: "sha-0", subject: "prior" }),
        exitProcess: (code) => {
          exits.push(code);
        },
      },
    });
    const response = await postJson(app, "/api/self/checkout", { branch: "room/older-limb" });
    expect(response.status).toBe(200);
    expect(git.calls.some((argv) => argv[0] === "checkout" && argv[1] === "room/older-limb")).toBe(true);
    await waitFor(() => exits.length === 1, 2_000);
    expect(exits).toEqual([87]);
  });

  test("archive renames room/x → archive/x and the response carries the refreshed rails", async () => {
    const git = selfRailGit({ current: "room/hp-at-hp-four", branches: RAILS });
    const { app } = await makeApp({ runtimeOptions: { selfGitRunner: git.run, selfGhRunner: selfRailGh().run } });
    const response = await postJson(app, "/api/self/branch", { branch: "room/older-limb", action: "archive" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; current: string; branches: Array<{ name: string }> };
    expect(body.ok).toBe(true);
    expect(git.calls.some((argv) => argv[0] === "branch" && argv[1] === "-m" && argv[3] === "archive/older-limb")).toBe(true);
    // The tend refresh contract: no second GET needed — the archived limb is
    // already gone from the returned rails.
    expect(body.current).toBe("room/hp-at-hp-four");
    expect(body.branches.map((entry) => entry.name)).toEqual(["room/hp-at-hp-four"]);
  });

  test("delete prunes locally THEN remotely (branch -D → push origin --delete → pr close)", async () => {
    const git = selfRailGit({ current: "room/hp-at-hp-four", branches: RAILS });
    const gh = selfRailGh({ openPr: { number: 21 } });
    const { app } = await makeApp({ runtimeOptions: { selfGitRunner: git.run, selfGhRunner: gh.run } });
    const response = await postJson(app, "/api/self/branch", { branch: "room/older-limb", action: "delete" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; branches: Array<{ name: string }> };
    expect(body.ok).toBe(true);
    const deleteIndex = git.calls.findIndex((argv) => argv[0] === "branch" && argv[1] === "-D");
    const pushIndex = git.calls.findIndex((argv) => argv[0] === "push" && argv.includes("--delete"));
    expect(deleteIndex).toBeGreaterThanOrEqual(0);
    expect(pushIndex).toBeGreaterThan(deleteIndex);
    expect(git.calls[pushIndex]).toEqual(["push", "origin", "--delete", "room/older-limb"]);
    // The open PR was closed through the gh seam.
    expect(gh.calls.some((argv) => argv[1] === "pr" && argv[2] === "close" && argv[3] === "21")).toBe(true);
    expect(body.branches.map((entry) => entry.name)).toEqual(["room/hp-at-hp-four"]);
  });

  test("a remote-prune failure never rolls back the local prune: still 200 ok:true", async () => {
    const git = selfRailGit({ current: "room/hp-at-hp-four", branches: RAILS, failPushDelete: true });
    const { app } = await makeApp({ runtimeOptions: { selfGitRunner: git.run, selfGhRunner: selfRailGh().run } });
    const response = await postJson(app, "/api/self/branch", { branch: "room/older-limb", action: "delete" });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { ok: boolean }).ok).toBe(true);
  });

  test("delete refuses the running branch and the trunk", async () => {
    const git = selfRailGit({ current: "room/hp-at-hp-four", branches: RAILS });
    const { app } = await makeApp({ runtimeOptions: { selfGitRunner: git.run, selfGhRunner: selfRailGh().run } });
    const running = await postJson(app, "/api/self/branch", { branch: "room/hp-at-hp-four", action: "delete" });
    expect(running.status).toBe(400);
    expect(((await running.json()) as { error: string }).error).toContain("cannot tend the running branch");
    const trunk = await postJson(app, "/api/self/branch", { branch: "main", action: "delete" });
    expect(trunk.status).toBe(400);
    expect(git.calls.some((argv) => argv[0] === "branch" && argv[1] === "-D")).toBe(false);
  });

  // ── THE EXCISE: delete scope "everywhere" — the room's branches STACK, so a
  // pruned branch's own graft commits live on in descendants; "everywhere"
  // reverts them on every branch carrying them. Commit model: room/graft's
  // own commits are X2+X1 (newest-first — the revert order); the descendant
  // and the current branch both carry them; main carries only the base.
  const STACKED = [
    { name: "room/graft", subject: "the graft under the knife", date: "3 hours ago", commits: ["X2", "X1", "base"] },
    { name: "room/descendant", subject: "stacked on the graft", date: "2 hours ago", commits: ["D1", "X2", "X1", "base"] },
    { name: "room/live", subject: "the running branch", date: "1 hour ago", commits: ["L1", "X2", "X1", "base"] },
    { name: "main", subject: "trunk", date: "4 hours ago", commits: ["base"] },
  ];

  const excisedShape = (body: unknown) =>
    body as {
      ok: boolean;
      excised: Array<{ branch: string; reverted: number }>;
      conflicts: string[];
      reloading: boolean;
      current: string;
      branches: Array<{ name: string }>;
    };

  test("scope 'everywhere': temp-worktree revert on the descendant, in-place revert + exit 87 on the current branch", async () => {
    const git = selfRailGit({ current: "room/live", branches: STACKED });
    const exits: number[] = [];
    const { app } = await makeApp({
      runtimeEnv: { VIBERSYN_SELF_MODE: "1" },
      runtimeOptions: {
        selfGitRunner: git.run,
        selfGhRunner: selfRailGh().run,
        selfGitHead: async () => ({ sha: "sha-0", subject: "prior" }),
        exitProcess: (code) => {
          exits.push(code);
        },
      },
    });
    const response = await postJson(app, "/api/self/branch", { branch: "room/graft", action: "delete", scope: "everywhere" });
    expect(response.status).toBe(200);
    const body = excisedShape(await response.json());
    expect(body.ok).toBe(true);
    expect(body.excised).toEqual([
      { branch: "room/descendant", reverted: 2 },
      { branch: "room/live", reverted: 2 },
    ]);
    expect(body.conflicts).toEqual([]);
    expect(body.reloading).toBe(true);
    // The tend refresh contract still holds: fresh rails ride the response,
    // minus the pruned branch.
    expect(body.current).toBe("room/live");
    expect(body.branches.map((entry) => entry.name)).toEqual(["room/descendant", "room/live"]);
    // ORDER on the descendant: worktree add → revert IN the worktree (newest
    // first) → update-ref (CAS) → worktree remove — never the live checkout.
    const addIndex = git.calls.findIndex((argv) => argv[0] === "worktree" && argv[1] === "add");
    const revertIndex = git.calls.findIndex((argv) => argv[0] === "-C" && argv[2] === "revert" && argv[3] === "--no-edit");
    const updateIndex = git.calls.findIndex((argv) => argv[0] === "update-ref" && argv[1] === "refs/heads/room/descendant");
    const removeIndex = git.calls.findIndex((argv) => argv[0] === "worktree" && argv[1] === "remove");
    expect(addIndex).toBeGreaterThanOrEqual(0);
    expect(revertIndex).toBeGreaterThan(addIndex);
    expect(updateIndex).toBeGreaterThan(revertIndex);
    expect(removeIndex).toBeGreaterThan(updateIndex);
    expect(git.calls[revertIndex]!.slice(4)).toEqual(["X2", "X1"]);
    // The CURRENT branch reverts in the live checkout (no -C) and both
    // updated branches push their single explicit refspec.
    expect(git.calls.some((argv) => argv[0] === "revert" && argv[1] === "--no-edit" && argv[2] === "X2" && argv[3] === "X1")).toBe(true);
    expect(git.calls.some((argv) => argv[0] === "push" && argv[2] === "refs/heads/room/descendant:refs/heads/room/descendant")).toBe(true);
    expect(git.calls.some((argv) => argv[0] === "push" && argv[2] === "refs/heads/room/live:refs/heads/room/live")).toBe(true);
    // Both carriers gained the reverts (newest revert on top) and the pruned
    // label fell; the supervisor exit fires through the seam.
    expect(git.state.branches.find((entry) => entry.name === "room/descendant")!.commits!.slice(0, 2)).toEqual(["revert-of-X1", "revert-of-X2"]);
    expect(git.state.branches.find((entry) => entry.name === "room/live")!.commits!.slice(0, 2)).toEqual(["revert-of-X1", "revert-of-X2"]);
    expect(git.calls.some((argv) => argv[0] === "branch" && argv[1] === "-D" && argv[2] === "room/graft")).toBe(true);
    await waitFor(() => exits.length === 1, 2_000);
    expect(exits).toEqual([87]);
  });

  test("a conflicted revert is named, its branch untouched, the rest still excised — 200, partial honesty", async () => {
    const git = selfRailGit({ current: "room/live", branches: STACKED, conflictOn: ["room/descendant"] });
    const exits: number[] = [];
    const { app } = await makeApp({
      runtimeEnv: { VIBERSYN_SELF_MODE: "1" },
      runtimeOptions: {
        selfGitRunner: git.run,
        selfGhRunner: selfRailGh().run,
        selfGitHead: async () => ({ sha: "sha-0", subject: "prior" }),
        exitProcess: (code) => {
          exits.push(code);
        },
      },
    });
    const response = await postJson(app, "/api/self/branch", { branch: "room/graft", action: "delete", scope: "everywhere" });
    expect(response.status).toBe(200);
    const body = excisedShape(await response.json());
    expect(body.ok).toBe(true);
    expect(body.conflicts).toEqual(["room/descendant"]);
    expect(body.excised).toEqual([{ branch: "room/live", reverted: 2 }]);
    // The conflicted branch's tip never moved: abort ran IN the worktree, no
    // update-ref, and the temp worktree was still cleaned up.
    expect(git.state.branches.find((entry) => entry.name === "room/descendant")!.commits).toEqual(["D1", "X2", "X1", "base"]);
    expect(git.calls.some((argv) => argv[0] === "-C" && argv[2] === "revert" && argv[3] === "--abort")).toBe(true);
    expect(git.calls.some((argv) => argv[0] === "update-ref" && argv[1] === "refs/heads/room/descendant")).toBe(false);
    expect(git.calls.some((argv) => argv[0] === "worktree" && argv[1] === "remove")).toBe(true);
    // The current branch still lost the graft — the rebuild fires.
    await waitFor(() => exits.length === 1, 2_000);
    expect(exits).toEqual([87]);
  });

  test("omitted scope stays today's delete exactly — no worktree, no revert, no rev-list, no update-ref", async () => {
    const git = selfRailGit({ current: "room/live", branches: STACKED });
    const { app } = await makeApp({ runtimeOptions: { selfGitRunner: git.run, selfGhRunner: selfRailGh().run } });
    const response = await postJson(app, "/api/self/branch", { branch: "room/graft", action: "delete" });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { ok: boolean }).ok).toBe(true);
    for (const verb of ["worktree", "revert", "rev-list", "update-ref", "-C"]) {
      expect(git.calls.some((argv) => argv[0] === verb)).toBe(false);
    }
    // The descendants keep the graft — the label alone fell.
    expect(git.state.branches.find((entry) => entry.name === "room/descendant")!.commits).toEqual(["D1", "X2", "X1", "base"]);
  });

  test("dirty src/ blocks ONLY the current-branch revert — reported by name, the others still excised, no exit", async () => {
    const git = selfRailGit({ current: "room/live", branches: STACKED, dirtySrc: true });
    const exits: number[] = [];
    const { app } = await makeApp({
      runtimeEnv: { VIBERSYN_SELF_MODE: "1" },
      runtimeOptions: {
        selfGitRunner: git.run,
        selfGhRunner: selfRailGh().run,
        selfGitHead: async () => ({ sha: "sha-0", subject: "prior" }),
        exitProcess: (code) => {
          exits.push(code);
        },
      },
    });
    const response = await postJson(app, "/api/self/branch", { branch: "room/graft", action: "delete", scope: "everywhere" });
    expect(response.status).toBe(200);
    const body = excisedShape(await response.json());
    expect(body.excised).toEqual([{ branch: "room/descendant", reverted: 2 }]);
    expect(body.conflicts).toEqual(["room/live (uncommitted work)"]);
    expect(body.reloading).toBe(false);
    // The live checkout never reverted in place (a cwd revert has no -C).
    expect(git.calls.some((argv) => argv[0] === "revert")).toBe(false);
    // No rebuild fires (the 400ms exit window passes quietly).
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(exits).toEqual([]);
  });

  test("no supervisor: the current branch's excise is refused by name — the others still land, no exit", async () => {
    const git = selfRailGit({ current: "room/live", branches: STACKED });
    const { app } = await makeApp({ runtimeOptions: { selfGitRunner: git.run, selfGhRunner: selfRailGh().run } });
    const response = await postJson(app, "/api/self/branch", { branch: "room/graft", action: "delete", scope: "everywhere" });
    expect(response.status).toBe(200);
    const body = excisedShape(await response.json());
    expect(body.excised).toEqual([{ branch: "room/descendant", reverted: 2 }]);
    expect(body.conflicts).toEqual(["room/live (no supervisor — --self launch required)"]);
    expect(body.reloading).toBe(false);
    expect(git.calls.some((argv) => argv[0] === "revert")).toBe(false);
  });

  test("refusals hold with scope present: the trunk, the running branch, the unknown", async () => {
    const git = selfRailGit({ current: "room/live", branches: STACKED });
    const { app } = await makeApp({ runtimeOptions: { selfGitRunner: git.run, selfGhRunner: selfRailGh().run } });
    const running = await postJson(app, "/api/self/branch", { branch: "room/live", action: "delete", scope: "everywhere" });
    expect(running.status).toBe(400);
    expect(((await running.json()) as { error: string }).error).toContain("cannot tend the running branch");
    const trunk = await postJson(app, "/api/self/branch", { branch: "main", action: "delete", scope: "everywhere" });
    expect(trunk.status).toBe(400);
    const ghost = await postJson(app, "/api/self/branch", { branch: "room/ghost", action: "delete", scope: "everywhere" });
    expect(ghost.status).toBe(400);
    expect(((await ghost.json()) as { error: string }).error).toContain("no local branch");
    expect(git.calls.some((argv) => argv[0] === "worktree" || argv[0] === "revert")).toBe(false);
    expect(git.calls.some((argv) => argv[0] === "branch" && argv[1] === "-D")).toBe(false);
  });
});

// INTO THE TRUNK (finalize): POST /api/self/branch action:"merge" — the PR
// path (ready a draft, retarget the base to main, merge commit) and the
// no-PR fast-forward fallback, all through the seams.
describe("POST /api/self/branch action:'merge' (into the trunk)", () => {
  const RAILS = [
    { name: "room/current-limb", subject: "self: current", date: "1 minute ago" },
    { name: "room/grown-limb", subject: "self: grown", date: "1 hour ago" },
    { name: "main", subject: "trunk", date: "2 hours ago" },
  ];
  function railGit(extra: { ffAncestors?: string[] } = {}) {
    const calls: string[][] = [];
    const run: NonNullable<ProjectorRuntimeOptions["selfGitRunner"]> = async (argv) => {
      calls.push(argv);
      switch (argv[0]) {
        case "branch":
          return { ok: true, stdout: "room/current-limb", stderr: "" };
        case "for-each-ref":
          return {
            ok: true,
            stdout: RAILS.filter((entry) => entry.name.startsWith("room/"))
              .map((entry) => `${entry.name}${entry.subject}${entry.date}`)
              .join("\n"),
            stderr: "",
          };
        case "rev-parse": {
          const name = argv[argv.length - 1]!.replace(/^refs\/heads\//u, "");
          return RAILS.some((entry) => entry.name === name)
            ? { ok: true, stdout: name, stderr: "" }
            : { ok: false, stdout: "", stderr: "" };
        }
        case "merge-base":
          return (extra.ffAncestors ?? []).includes(argv[argv.length - 1]!.replace(/^refs\/heads\//u, ""))
            ? { ok: true, stdout: "", stderr: "" }
            : { ok: false, stdout: "", stderr: "" };
        default:
          return { ok: true, stdout: "", stderr: "" };
      }
    };
    return { calls, run };
  }
  function railGh(pr: { number: number; state: string; isDraft: boolean; baseRefName: string } | null) {
    const calls: string[][] = [];
    const run: NonNullable<ProjectorRuntimeOptions["selfGhRunner"]> = async (argv) => {
      calls.push(argv);
      if (argv[1] === "pr" && argv[2] === "list") {
        return { ok: true, stdout: JSON.stringify(pr === null ? [] : [pr]), stderr: "" };
      }
      return { ok: true, stdout: "", stderr: "" };
    };
    return { calls, run };
  }

  test("a draft PR based on another room/* is readied, retargeted to main, then merge-committed", async () => {
    const git = railGit();
    const gh = railGh({ number: 21, state: "OPEN", isDraft: true, baseRefName: "room/current-limb" });
    const { app } = await makeApp({ runtimeOptions: { selfGitRunner: git.run, selfGhRunner: gh.run } });
    const response = await postJson(app, "/api/self/branch", { branch: "room/grown-limb", action: "merge" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; merged: boolean; via: string; branches: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.merged).toBe(true);
    expect(body.via).toBe("pr");
    // Argv sequence: list → ready → edit --base main → merge --merge.
    const verbs = gh.calls.map((argv) => argv[2]);
    expect(verbs).toEqual(["list", "ready", "edit", "merge"]);
    const edit = gh.calls[2]!;
    expect(edit[edit.indexOf("--base") + 1]).toBe("main");
    const merge = gh.calls[3]!;
    expect(merge).toContain("--merge");
    expect(merge).not.toContain("--squash");
    // The refresh contract rides the same response.
    expect(Array.isArray(body.branches)).toBe(true);
  });

  test("an already-MERGED PR is idempotent ok — no ready/edit/merge calls", async () => {
    const gh = railGh({ number: 14, state: "MERGED", isDraft: false, baseRefName: "main" });
    const { app } = await makeApp({ runtimeOptions: { selfGitRunner: railGit().run, selfGhRunner: gh.run } });
    const response = await postJson(app, "/api/self/branch", { branch: "room/grown-limb", action: "merge" });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { via: string }).via).toBe("pr");
    expect(gh.calls.map((argv) => argv[2])).toEqual(["list"]);
  });

  test("no PR + main is an ancestor → a plain fast-forward push, never --force", async () => {
    const git = railGit({ ffAncestors: ["room/grown-limb"] });
    const { app } = await makeApp({ runtimeOptions: { selfGitRunner: git.run, selfGhRunner: railGh(null).run } });
    const response = await postJson(app, "/api/self/branch", { branch: "room/grown-limb", action: "merge" });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { via: string }).via).toBe("fast-forward");
    const push = git.calls.find((argv) => argv[0] === "push")!;
    expect(push).toEqual(["push", "origin", "refs/heads/room/grown-limb:refs/heads/main"]);
    expect(push).not.toContain("--force");
  });

  test("no PR + NOT fast-forward → honest 400, and nothing is pushed", async () => {
    const git = railGit();
    const { app } = await makeApp({ runtimeOptions: { selfGitRunner: git.run, selfGhRunner: railGh(null).run } });
    const response = await postJson(app, "/api/self/branch", { branch: "room/grown-limb", action: "merge" });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("needs a PR");
    expect(git.calls.some((argv) => argv[0] === "push")).toBe(false);
  });

  test("refuses the trunk and non-room names — gh never runs", async () => {
    const gh = railGh({ number: 9, state: "OPEN", isDraft: false, baseRefName: "main" });
    const { app } = await makeApp({ runtimeOptions: { selfGitRunner: railGit().run, selfGhRunner: gh.run } });
    for (const branch of ["main", "archive/old-limb", "feature/x"]) {
      const response = await postJson(app, "/api/self/branch", { branch, action: "merge" });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toContain("room/*");
    }
    expect(gh.calls).toHaveLength(0);
  });
});

// STOP GROWING: POST /api/self/run/halt cancels the executing self-run and
// settles the lane failed·"aborted" WITHOUT killing the pinned mirror record
// (that is /api/process/self/halt, the emergency path). Memory client — no
// gateway, no subprocess; the lane stays executing until halted.
describe("POST /api/self/run/halt (stop growing)", () => {
  test("outside self mode the refusal is honest", async () => {
    const { app } = await makeApp();
    const response = await postJson(app, "/api/self/run/halt");
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("self mode is off");
  });

  test("halts the executing run (lane failed·aborted, record alive), then idempotent {halted:false}", async () => {
    const { app, runtime } = await makeApp({
      runtimeEnv: { VIBERSYN_SELF_MODE: "1" },
      runtimeOptions: {
        selfGitHead: async () => ({ sha: "sha-0", subject: "prior" }),
        exitProcess: () => undefined,
      },
    });
    const selfProcess = () =>
      runtime.snapshot().processes.find((process) => process.upid === SELF_UPID) as
        | { state?: string; execution?: { status?: string; label?: string } | null }
        | undefined;
    // Seed an executing lane through the registry's steer chokepoint (the
    // same call click-steer and "mirror, <instruction>" reach).
    await runtime.registry.steer(SELF_UPID, { text: "make the header calmer" }, "corr-halt-test");
    await waitFor(() => selfProcess()?.execution?.status === "executing");

    const halted = await postJson(app, "/api/self/run/halt");
    expect(halted.status).toBe(200);
    expect((await halted.json()) as unknown).toEqual({ ok: true, halted: true });
    // The lane settled failed·"aborted"…
    expect(selfProcess()?.execution?.status).toBe("failed");
    expect(selfProcess()?.execution?.label).toBe("aborted");
    // …and the pinned record is NOT halted (the mirror stays live).
    expect(selfProcess()?.state).not.toBe("halted");

    // Idempotent: a second press is a truthful no-op, never an error.
    const again = await postJson(app, "/api/self/run/halt");
    expect(again.status).toBe(200);
    expect((await again.json()) as unknown).toEqual({ ok: true, halted: false });
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

// ── /salem authenticated app proxy ───────────────────────────────────────────
// A REAL reverse proxy (not the 8-line autocal idiom): cookie injection,
// frame-blocker stripping, conservative HTML rewriting, asset passthrough,
// Location rewrites, healthz, and the branded fallback. Upstream is ALWAYS the
// injected fake — no test ever reaches the real board.
describe("/salem authenticated app proxy", () => {
  interface SalemCall {
    url: string;
    method: string | undefined;
    headers: Record<string, string>;
    body: string | null;
  }

  function scriptedSalem(respond: (url: string, init?: RequestInit) => Response | Promise<Response>): {
    calls: SalemCall[];
    fetchFn: (input: string | URL, init?: RequestInit) => Promise<Response>;
  } {
    const calls: SalemCall[] = [];
    const fetchFn = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key] = value;
      });
      calls.push({
        url: String(input),
        method: init?.method,
        headers,
        body: typeof init?.body === "string" ? init.body : init?.body instanceof ArrayBuffer ? new TextDecoder().decode(init.body) : null,
      });
      return respond(String(input), init);
    };
    return { calls, fetchFn };
  }

  const SID_ENV = { VIBERSYN_SALEM_SID: "sid-abc123" };

  test("GET forwards path+query to the default upstream and injects the salem_session cookie", async () => {
    const salem = scriptedSalem(() => new Response("ok", { headers: { "content-type": "text/plain" } }));
    const { app } = await makeApp({ env: SID_ENV, salemFetch: salem.fetchFn });
    const response = await app.request("/salem/chores?week=2");
    expect(response.status).toBe(200);
    expect(salem.calls).toHaveLength(1);
    expect(salem.calls[0]!.url).toBe("https://residency.convent.fun/chores?week=2");
    expect(salem.calls[0]!.method).toBe("GET");
    expect(salem.calls[0]!.headers.cookie).toBe("salem_session=sid-abc123");
  });

  test("VIBERSYN_SALEM_UPSTREAM overrides the origin; /salem and /salem/ hit the upstream root", async () => {
    const salem = scriptedSalem(() => new Response("ok"));
    const { app } = await makeApp({
      env: { ...SID_ENV, VIBERSYN_SALEM_UPSTREAM: "https://board.example.dev" },
      salemFetch: salem.fetchFn,
    });
    await app.request("/salem");
    await app.request("/salem/");
    expect(salem.calls.map((call) => call.url)).toEqual(["https://board.example.dev/", "https://board.example.dev/"]);
  });

  test("sid UNSET degrades gracefully: no cookie header, the upstream login page rides through", async () => {
    const salem = scriptedSalem(
      () => new Response("<h1>Login</h1>", { headers: { "content-type": "text/html; charset=utf-8" } }),
    );
    const { app } = await makeApp({ env: {}, salemFetch: salem.fetchFn });
    const response = await app.request("/salem/");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Login");
    expect(salem.calls[0]!.headers.cookie).toBeUndefined();
  });

  test("frame blockers are STRIPPED (xfo + both CSP flavors); benign headers pass", async () => {
    const salem = scriptedSalem(
      () =>
        new Response("<p>board</p>", {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "x-frame-options": "DENY",
            "content-security-policy": "frame-ancestors 'none'",
            "content-security-policy-report-only": "frame-ancestors 'none'",
            "cache-control": "no-store",
          },
        }),
    );
    const { app } = await makeApp({ env: SID_ENV, salemFetch: salem.fetchFn });
    const response = await app.request("/salem/");
    expect(response.headers.get("x-frame-options")).toBeNull();
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(response.headers.get("content-security-policy-report-only")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("text/html gets ONE conservative rewrite pass: root-relative href/src/action/url( → /salem/", async () => {
    const html = [
      '<a href="/calendar">cal</a>',
      "<img src='/img/logo.png'>",
      '<form action="/login" method="post"></form>',
      '<div style="background:url(/bg.png)"></div>',
      '<a href="//cdn.example.dev/x">protocol-relative untouched</a>',
      '<a href="https://elsewhere.example.dev/">absolute untouched</a>',
      '<a href="/salem/already">already proxied untouched</a>',
    ].join("");
    const salem = scriptedSalem(() => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }));
    const { app } = await makeApp({ env: SID_ENV, salemFetch: salem.fetchFn });
    const body = await (await app.request("/salem/")).text();
    expect(body).toContain('href="/salem/calendar"');
    expect(body).toContain("src='/salem/img/logo.png'");
    expect(body).toContain('action="/salem/login"');
    expect(body).toContain("url(/salem/bg.png)");
    expect(body).toContain('href="//cdn.example.dev/x"');
    expect(body).toContain('href="https://elsewhere.example.dev/"');
    expect(body).toContain('href="/salem/already"');
  });

  test("binary/asset content-types pass through UNTOUCHED (bytes identical, even url(/-shaped)", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...new TextEncoder().encode('href="/x" url(/y)')]);
    const salem = scriptedSalem(() => new Response(bytes, { headers: { "content-type": "image/png" } }));
    const { app } = await makeApp({ env: SID_ENV, salemFetch: salem.fetchFn });
    const response = await app.request("/salem/img/logo.png");
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  test("3xx Location headers are rewritten under /salem (root-relative AND same-origin absolute)", async () => {
    const salem = scriptedSalem((url) =>
      url.endsWith("/a")
        ? new Response(null, { status: 302, headers: { location: "/login?next=%2F" } })
        : new Response(null, { status: 302, headers: { location: "https://residency.convent.fun/board?x=1" } }),
    );
    const { app } = await makeApp({ env: SID_ENV, salemFetch: salem.fetchFn });
    const rootRelative = await app.request("/salem/a");
    expect(rootRelative.status).toBe(302);
    expect(rootRelative.headers.get("location")).toBe("/salem/login?next=%2F");
    const absolute = await app.request("/salem/b");
    expect(absolute.headers.get("location")).toBe("/salem/board?x=1");
  });

  test("foreign-origin Location passes through untouched", async () => {
    const salem = scriptedSalem(
      () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example.dev/away" } }),
    );
    const { app } = await makeApp({ env: SID_ENV, salemFetch: salem.fetchFn });
    expect((await app.request("/salem/x")).headers.get("location")).toBe("https://elsewhere.example.dev/away");
  });

  test("POST forwards body + content-type and spoofs Origin/Referer to the upstream origin", async () => {
    const salem = scriptedSalem(() => new Response("posted", { headers: { "content-type": "text/plain" } }));
    const { app } = await makeApp({ env: SID_ENV, salemFetch: salem.fetchFn });
    const response = await app.request("/salem/chores/complete", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "chore=dishes&done=1",
    });
    expect(response.status).toBe(200);
    const call = salem.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.headers.origin).toBe("https://residency.convent.fun");
    expect(call.headers.referer).toBe("https://residency.convent.fun/");
    expect(call.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(call.headers.cookie).toBe("salem_session=sid-abc123");
    expect(call.body).toBe("chore=dishes&done=1");
  });

  test("upstream failure → the branded fallback page, never a blank frame", async () => {
    const { app } = await makeApp({
      env: SID_ENV,
      salemFetch: async () => {
        throw new Error("upstream down");
      },
    });
    const response = await app.request("/salem/");
    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("the board is napping");
    expect(body).toContain("the garden keeps growing");
  });

  test("GET /salem/healthz: authed when 200 without the login marker; unauthed on the login page or 401", async () => {
    const authedApp = await makeApp({
      env: SID_ENV,
      salemFetch: scriptedSalem(() => new Response("<h1>House Board</h1><a>Logout</a>", { headers: { "content-type": "text/html" } })).fetchFn,
    });
    expect(await (await authedApp.app.request("/salem/healthz")).json()).toEqual({ ok: true, authed: true, status: 200 });

    const loginApp = await makeApp({
      env: SID_ENV,
      // The REAL login/expired page carries the bot sign-in instructions —
      // that is the marker (the authed board mentions "login" in nav copy,
      // which false-positived the old word check; live-room finding).
      salemFetch: scriptedSalem(() => new Response("<p>message @SalemConventBot on telegram, send /dashboard</p>")).fetchFn,
    });
    expect(await (await loginApp.app.request("/salem/healthz")).json()).toEqual({ ok: true, authed: false, status: 200 });

    const deniedApp = await makeApp({
      env: SID_ENV,
      salemFetch: scriptedSalem(() => new Response("denied", { status: 401 })).fetchFn,
    });
    expect(await (await deniedApp.app.request("/salem/healthz")).json()).toEqual({ ok: true, authed: false, status: 401 });
  });

  test("GET /salem/healthz: a dead upstream is {ok:false}, never a throw", async () => {
    const { app } = await makeApp({
      env: SID_ENV,
      salemFetch: async () => {
        throw new Error("nope");
      },
    });
    expect(await (await app.request("/salem/healthz")).json()).toEqual({ ok: false, authed: false, status: 0 });
  });
});

// ── deployment resolver riding the import routine ────────────────────────────
describe("GitHub import → deploy resolver → deployUrl surfaces", () => {
  test("a resolved deployment lands on the snapshot process AND the /repo route", async () => {
    const resolverCalls: Array<{ owner: string; repo: string; repoDir: string | null }> = [];
    const { app, runtime } = await makeApp({
      buildBackends: [new RouteFakeBackend()],
      resolveDeployFn: async (input) => {
        resolverCalls.push({ owner: input.owner, repo: input.repo, repoDir: input.repoDir });
        return { url: "https://residency.convent.fun", source: "map" };
      },
      // The adopt path needs a repo/.git like a real checkout.
      cloneRepoFn: async ({ dir }) => {
        await import("node:fs/promises").then((fs) => fs.mkdir(join(dir, ".git"), { recursive: true }));
        return { ok: true, dir };
      },
      treeGitRunner: async () => ({ ok: true, stdout: "", stderr: "" }),
    });
    // Build intent: a bare link with no instruction is STUDIED now, and a
    // study never fans out — these assertions wait on the build.
    const response = await postJson(app, "/api/projects/import", {
      url: "https://github.com/RonTuretzky/convent-profile",
      context: "build a profile page",
    });
    expect(response.status).toBe(200);
    const { upid } = (await response.json()) as { upid: string };

    await waitFor(() => runtime.snapshot().processes.some((entry) => entry.upid === upid && entry.deployUrl != null));
    const process = runtime.snapshot().processes.find((entry) => entry.upid === upid)!;
    expect(process.deployUrl).toBe("https://residency.convent.fun");
    // The resolver saw the parsed identity + the clone's checkout dir.
    expect(resolverCalls[0]!.owner).toBe("RonTuretzky");
    expect(resolverCalls[0]!.repo).toBe("convent-profile");
    expect(resolverCalls[0]!.repoDir).toContain(`${upid}/repo`);

    // The tree-repo facts route carries it too (the menu/popup surface).
    await waitFor(() => runtime.treeRepoInfo(upid) !== null);
    const repo = await app.request(`/api/process/${upid}/repo`);
    expect(repo.status).toBe(200);
    expect(((await repo.json()) as { deployUrl?: string }).deployUrl).toBe("https://residency.convent.fun");
    await waitFor(() => runtime.registry.builds(upid).some((build) => build.status === "ready"));
  });

  test("no resolution (or the null test seam) → no deployUrl anywhere", async () => {
    const { app, runtime } = await makeApp({ buildBackends: [new RouteFakeBackend()] });
    const response = await postJson(app, "/api/projects/import", {
      url: "https://github.com/o/quiet",
      context: "build something quiet",
    });
    const { upid } = (await response.json()) as { upid: string };
    await waitFor(() => runtime.registry.builds(upid).some((build) => build.status === "ready"));
    expect(runtime.snapshot().processes.find((entry) => entry.upid === upid)!.deployUrl).toBeNull();
  });
});

// THE READ-BACK SURFACE. "Get me today's transcript" used to be a bespoke
// python pass over a rolling file that had already evicted most of the evening;
// the archive answers it with a read. (`bun run transcript` is the same read
// without a server, for when the room is down.)
describe("GET /api/transcript/*", () => {
  function seedArchive(lines: { text: string; atMs: number }[]): string {
    const dir = mkdtempSync(join(tmpdir(), "vibersyn-transcript-"));
    tempDirs.push(dir);
    const byDay = new Map<string, string[]>();
    for (const entry of lines) {
      const day = localDayKey(entry.atMs);
      const body = JSON.stringify({
        time: new Date(entry.atMs).toISOString().slice(11, 19),
        speaker: "speaker_0",
        text: entry.text,
        kind: "room",
        atMs: entry.atMs,
      });
      byDay.set(day, [...(byDay.get(day) ?? []), body]);
    }
    mkdirSync(dir, { recursive: true });
    for (const [day, bodies] of byDay) {
      writeFileSync(join(dir, `${day}.jsonl`), `${bodies.join("\n")}\n`);
    }
    return dir;
  }

  const noonToday = new Date(new Date().setHours(12, 0, 0, 0)).getTime();
  const noonYesterday = noonToday - 24 * 60 * 60_000;

  test("today's lines come back, in spoken order, with their original atMs", async () => {
    const archiveDir = seedArchive([
      { text: "we should build a birdhouse app", atMs: noonToday },
      { text: "with a webcam feed", atMs: noonToday + 2_000 },
    ]);
    const { app } = await makeApp({ runtimeOptions: { transcriptArchiveDir: archiveDir } });
    const response = await app.request("/api/transcript/today");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { day: string; archiveDir: string; lines: { text: string; atMs: number }[] };
    expect(body.archiveDir).toBe(archiveDir);
    expect(body.lines.map((line) => line.text)).toEqual(["we should build a birdhouse app", "with a webcam feed"]);
    expect(body.lines[0]!.atMs).toBe(noonToday);
  });

  test("yesterday, and an explicit YYYY-MM-DD, address their own segments", async () => {
    const archiveDir = seedArchive([
      { text: "last night", atMs: noonYesterday },
      { text: "this afternoon", atMs: noonToday },
    ]);
    const { app } = await makeApp({ runtimeOptions: { transcriptArchiveDir: archiveDir } });
    const yesterday = (await (await app.request("/api/transcript/yesterday")).json()) as { lines: { text: string }[] };
    expect(yesterday.lines.map((line) => line.text)).toEqual(["last night"]);
    const explicit = (await (await app.request(`/api/transcript/${localDayKey(noonToday)}`)).json()) as { lines: { text: string }[] };
    expect(explicit.lines.map((line) => line.text)).toEqual(["this afternoon"]);
  });

  test("?format=text renders LOCAL stamps a human can read", async () => {
    const at = new Date(new Date().setHours(17, 52, 1, 0)).getTime();
    const archiveDir = seedArchive([{ text: "not i just", atMs: at }]);
    const { app } = await makeApp({ runtimeOptions: { transcriptArchiveDir: archiveDir } });
    const response = await app.request("/api/transcript/today?format=text");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("17:52:01  speaker_0: not i just");
  });

  test("/days lists what the archive holds, oldest first", async () => {
    const archiveDir = seedArchive([
      { text: "last night", atMs: noonYesterday },
      { text: "this afternoon", atMs: noonToday },
    ]);
    const { app } = await makeApp({ runtimeOptions: { transcriptArchiveDir: archiveDir } });
    const body = (await (await app.request("/api/transcript/days")).json()) as { archiveDir: string; days: string[] };
    expect(body.days).toEqual([localDayKey(noonYesterday), localDayKey(noonToday)]);
  });

  // Every failure says something specific. An empty array would read as "we
  // said nothing", which is the one answer that must never be guessed at.
  test("a malformed day is 400, a day with no segment is 404, no archive is 503", async () => {
    const archiveDir = seedArchive([{ text: "this afternoon", atMs: noonToday }]);
    const { app } = await makeApp({ runtimeOptions: { transcriptArchiveDir: archiveDir } });
    const bad = await app.request("/api/transcript/tomorrow");
    expect(bad.status).toBe(400);
    expect((await bad.json()) as { error: string }).toHaveProperty("error");
    const missing = await app.request("/api/transcript/2001-01-01");
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { days: string[] }).days).toEqual([localDayKey(noonToday)]);

    const { app: noArchive } = await makeApp();
    expect((await noArchive.request("/api/transcript/today")).status).toBe(503);
    expect((await noArchive.request("/api/transcript/days")).status).toBe(503);
  });
});

// THE DEFAULT-ON GUARD, asserted the way the operator asked: a runtime built
// the way TESTS build one must write NOTHING to the default archive path.
// Commit 6a1d228 gated the old store behind an env marker because self-mode
// test runtimes were polluting the operator's live store; making the archive
// default-on at the BOOT ENTRY (src/server/index.ts) keeps that hole shut, and
// this test is what proves it stays shut.
describe("a test-built runtime keeps no archive", () => {
  const defaultArchivePath = resolve(process.cwd(), TRANSCRIPT_ARCHIVE_DEFAULT_DIR);

  test("no archive directory resolves, and the default path is never created", async () => {
    const before = existsSync(defaultArchivePath) ? listDays(defaultArchivePath).map((day) => `${day}:${readDay(defaultArchivePath, day).lines.length}`) : null;
    const { runtime } = await makeApp();
    expect(runtime.transcriptArchiveDir).toBeNull();
    const after = existsSync(defaultArchivePath) ? listDays(defaultArchivePath).map((day) => `${day}:${readDay(defaultArchivePath, day).lines.length}`) : null;
    expect(after).toEqual(before);
  });

  test("even a SELF-MODE runtime with no directory keeps no archive", async () => {
    const { runtime } = await makeApp({ runtimeEnv: { VIBERSYN_SELF_MODE: "1" } });
    expect(runtime.transcriptArchiveDir).toBeNull();
    expect(existsSync(defaultArchivePath) ? listDays(defaultArchivePath) : []).not.toContain("__never__");
  });
});
