import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectorApp } from "./app";
import { createProjectorRuntime, type ProjectorRuntime } from "./composition";
import type { BuilderAgent } from "./idea-builder";
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
    { ideaDetector: args.detector, buildsRoot, builderAgent: noopBuilder },
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
