import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectorApp } from "./app";
import { createProjectorRuntime, type ProjectorRuntime } from "./composition";
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
  interfaces?: () => InterfaceAddresses;
  // Inject a fake build-backend roster: routes accepts through the multi-backend
  // orchestrator instead of the legacy single-build ideaBuilds path.
  buildBackends?: BuildBackend[];
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
    },
    {
      ideaDetector: args.detector,
      buildsRoot,
      builderAgent: noopBuilder,
      buildBackends: args.buildBackends,
      executionArtifactsRoot: join(buildsRoot, "vibersyn-runs"),
    },
  );
  runtimes.push(runtime);
  const app = createProjectorApp(runtime, {
    env: {},
    host: args.host ?? "127.0.0.1",
    port: args.port ?? 8787,
    interfaces: args.interfaces,
  });
  return { app, runtime };
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
  test("a valid GitHub URL adds a fleet process with the imported shape and pushes it over the snapshot stream", async () => {
    const { app, runtime } = await makeApp();
    const published: ProjectorSnapshot[] = [];
    const unsubscribe = runtime.subscribe((snapshot) => published.push(snapshot));

    const response = await postJson(app, "/api/projects/import", { url: "https://github.com/RonTuretzky/gesture-wall" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    unsubscribe();

    const stateResponse = await app.request("/api/state");
    const state = (await stateResponse.json()) as ProjectorSnapshot;
    expect(state.processes).toHaveLength(1);
    const imported = state.processes[0]!;
    expect(imported.source).toEqual({ kind: "github-import", url: "https://github.com/RonTuretzky/gesture-wall" });
    expect(imported.task).toBe("Imported from GitHub: RonTuretzky/gesture-wall");
    expect(imported.state).toBe("active");
    expect(imported.progressLabel).toBe("imported");
    expect(imported.previewUrl).toBe("https://github.com/RonTuretzky/gesture-wall");
    expect(imported.callsign).toBe("GESTUREW");
    // SSE subscribers saw the import land without polling.
    expect(published.some((snapshot) => snapshot.processes.some((process) => process.source?.kind === "github-import"))).toBe(true);
  });

  test("invalid URLs are 400 { ok:false } and never reach the fleet", async () => {
    const { app, runtime } = await makeApp();
    const invalid = [
      "not a url",
      "ftp://github.com/o/r",
      "https://github.com/owner-only",
      "https://evilgithub.com/o/r",
      "https://github.com.evil.com/o/r",
      "https://github.com@evil.com/o/r",
    ];
    for (const url of invalid) {
      const response = await postJson(app, "/api/projects/import", { url });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { ok: boolean; error?: string };
      expect(body.ok).toBe(false);
      expect(body.error?.length ?? 0).toBeGreaterThan(0);
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
    expect(lane).toMatchObject({ status: "executing", runId: `vibersyn-${upid}`, percent: 0, previewUrl: null });
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
