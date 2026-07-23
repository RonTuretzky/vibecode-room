import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildOrchestrator, mergeLegacyBuildState, type ProcessBuildSnapshot } from "./orchestrator";
import { BackendSelector } from "./selector";
import type { BuildBackend, BuildBackendId, BuildRequest, BuildResult } from "./types";

// Fake backends write REAL files; the orchestrator runs its REAL per-UPID
// preview server (ephemeral loopback port), so previewUrl assertions are
// genuine GETs. No claude/Cerebras is ever touched.

const roots: string[] = [];
const orchestrators: BuildOrchestrator[] = [];

afterEach(async () => {
  await Promise.all(orchestrators.map((orchestrator) => orchestrator.abortEverything().catch(() => undefined)));
  orchestrators.length = 0;
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)));
  roots.length = 0;
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "buildloop-orchestrator-"));
  roots.push(root);
  return root;
}

interface FakeBackendOptions {
  available?: { ok: boolean; reason?: string };
  build?: (req: BuildRequest) => Promise<BuildResult>;
}

function writingBackend(id: BuildBackendId, options: FakeBackendOptions = {}): BuildBackend {
  return {
    id,
    label: `${id} backend`,
    async available() {
      return options.available ?? { ok: true };
    },
    build:
      options.build ??
      (async (req: BuildRequest): Promise<BuildResult> => {
        req.onProgress({ label: "writing", percent: 50 });
        const marker = req.correction === undefined ? `${id}-app` : `${id}-corrected:${req.correction}`;
        await Bun.write(join(req.outDir, "index.html"), `<!doctype html><h1>${marker}</h1>`);
        return { ok: true, entrypoint: "index.html", summary: `${id} built it` };
      }),
  };
}

function track(orchestrator: BuildOrchestrator): BuildOrchestrator {
  orchestrators.push(orchestrator);
  return orchestrator;
}

const startInput = (upid: string) => ({ upid, ideaId: `idea-${upid}`, prompt: "a tiny app", callsign: "atlas" });

describe("BuildOrchestrator — fan-out", () => {
  test("builds every enabled+available backend concurrently, each with its own live previewUrl", async () => {
    const selector = new BackendSelector({
      backends: [writingBackend("smithers"), writingBackend("native")],
      env: {},
    });
    const orchestrator = track(new BuildOrchestrator({ selector, buildsRoot: await tempRoot() }));

    await orchestrator.start(startInput("upid-fan"));

    const builds = orchestrator.builds("upid-fan");
    expect(builds.map((build) => [build.backend, build.status])).toEqual([
      ["smithers", "ready"],
      ["native", "ready"],
    ]);
    // Each backend gets its OWN subdir URL off the shared per-UPID server.
    for (const build of builds) {
      expect(build.previewUrl).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+/${build.backend}/\\?v=1$`, "u"));
      const response = await fetch(build.previewUrl!);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control") ?? "").toContain("no-store");
      expect(await response.text()).toContain(`${build.backend}-app`);
      expect(build.summary).toBe(`${build.backend} built it`);
      expect(build.slideshowUrl).toBeNull();
    }
  });

  test("disabled and unavailable backends are skipped; a failing backend reads failed without sinking siblings", async () => {
    const selector = new BackendSelector({
      backends: [
        writingBackend("smithers", {
          build: async () => ({ ok: false, entrypoint: null, summary: "", error: "model blew up" }),
        }),
        writingBackend("eliza"), // disabled by default csv
        writingBackend("native", { available: { ok: false, reason: "no CLI" } }),
      ],
      env: {},
    });
    const orchestrator = track(new BuildOrchestrator({ selector, buildsRoot: await tempRoot() }));

    await orchestrator.start(startInput("upid-skip"));

    const builds = orchestrator.builds("upid-skip");
    expect(builds).toHaveLength(1);
    expect(builds[0]).toMatchObject({ backend: "smithers", status: "failed", previewUrl: null });
  });

  test("slideshow hook flips slideshowUrl on (previewUrl + slideshow/), and its failure never fails the build", async () => {
    const selector = new BackendSelector({
      backends: [writingBackend("smithers"), writingBackend("native")],
      env: {},
    });
    const orchestrator = track(
      new BuildOrchestrator({
        selector,
        buildsRoot: await tempRoot(),
        slideshow: async (input) => {
          if (input.backend === "native") {
            throw new Error("slideshow generator blew up");
          }
          await Bun.write(join(input.outDir, "slideshow", "index.html"), "<!doctype html><h1>slides</h1>");
        },
      }),
    );

    await orchestrator.start(startInput("upid-slides"));

    const [smithers, native] = orchestrator.builds("upid-slides");
    expect(smithers!.slideshowUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/smithers\/slideshow\/\?v=1$/u);
    expect((await fetch(smithers!.slideshowUrl!)).status).toBe(200);
    expect(native!.status).toBe("ready"); // hook failure is garnish, not a build failure
    expect(native!.slideshowUrl).toBeNull();
  });
});

describe("BuildOrchestrator — steer", () => {
  test("re-runs every ready build with the correction, rewrites in place, bumps ?v for cache-bust", async () => {
    const selector = new BackendSelector({
      backends: [writingBackend("smithers"), writingBackend("native")],
      env: {},
    });
    const orchestrator = track(new BuildOrchestrator({ selector, buildsRoot: await tempRoot() }));
    await orchestrator.start(startInput("upid-steer"));
    const before = orchestrator.builds("upid-steer");

    await orchestrator.steer("upid-steer", "make it purple");

    const after = orchestrator.builds("upid-steer");
    for (const [index, build] of after.entries()) {
      expect(build.status).toBe("ready");
      expect(build.previewUrl).toContain("?v=2");
      expect(build.previewUrl).not.toBe(before[index]!.previewUrl);
      const body = await (await fetch(build.previewUrl!)).text();
      expect(body).toContain("corrected:make it purple");
    }
  });

  test("a failed correction leaves the old app serving and the build ready", async () => {
    let corrections = 0;
    const selector = new BackendSelector({
      backends: [
        writingBackend("smithers", {
          build: async (req) => {
            if (req.correction !== undefined) {
              corrections += 1;
              return { ok: false, entrypoint: null, summary: "", error: "correction crashed" };
            }
            await Bun.write(join(req.outDir, "index.html"), "<!doctype html><h1>original</h1>");
            return { ok: true, entrypoint: "index.html", summary: "built" };
          },
        }),
      ],
      env: {},
    });
    const orchestrator = track(new BuildOrchestrator({ selector, buildsRoot: await tempRoot() }));
    await orchestrator.start(startInput("upid-steer-fail"));

    await orchestrator.steer("upid-steer-fail", "break please");

    expect(corrections).toBe(1);
    const [build] = orchestrator.builds("upid-steer-fail");
    expect(build!.status).toBe("ready");
    expect(build!.previewUrl).toContain("?v=1"); // no bump — old version still serves
    expect(await (await fetch(build!.previewUrl!)).text()).toContain("original");
  });
});

describe("BuildOrchestrator — emergency abort", () => {
  test("abortAll aborts an in-flight build within the ~2s budget and tears the preview server down", async () => {
    let sawAbort = false;
    const hanging = writingBackend("smithers", {
      build: (req) =>
        new Promise<BuildResult>((resolvePromise) => {
          const onAbort = () => {
            sawAbort = true; // the backend SIGKILLs its subprocess here
            resolvePromise({ ok: false, entrypoint: null, summary: "", error: "aborted" });
          };
          // Contract: a backend must honor an ALREADY-aborted signal too (the
          // abort can land between fan-out registration and build() entry).
          if (req.signal.aborted) {
            onAbort();
            return;
          }
          req.signal.addEventListener("abort", onAbort, { once: true });
        }),
    });
    const selector = new BackendSelector({ backends: [hanging], env: {} });
    const orchestrator = track(new BuildOrchestrator({ selector, buildsRoot: await tempRoot() }));

    const started = orchestrator.start(startInput("upid-abort"));
    // Wait until the fan-out is actually in flight (status building).
    while (orchestrator.builds("upid-abort").length === 0) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }

    const startedAt = Date.now();
    await orchestrator.abortAll("upid-abort");
    expect(Date.now() - startedAt).toBeLessThan(2_500);
    expect(sawAbort).toBe(true);
    expect(orchestrator.builds("upid-abort")).toEqual([]);
    await started; // the abandoned fan-out settles without throwing
  });

  test("abortEverything covers every live UPID", async () => {
    const selector = new BackendSelector({ backends: [writingBackend("smithers")], env: {} });
    const orchestrator = track(new BuildOrchestrator({ selector, buildsRoot: await tempRoot() }));
    await orchestrator.start(startInput("upid-a"));
    await orchestrator.start(startInput("upid-b"));
    const url = orchestrator.builds("upid-a")[0]!.previewUrl!;

    await orchestrator.abortEverything();

    expect(orchestrator.builds("upid-a")).toEqual([]);
    expect(orchestrator.builds("upid-b")).toEqual([]);
    await expect(fetch(url)).rejects.toBeDefined(); // the preview server is gone
  });
});

describe("mergeLegacyBuildState (pure)", () => {
  const entry = (status: ProcessBuildSnapshot["status"], previewUrl: string | null = null): ProcessBuildSnapshot => ({
    backend: "smithers",
    label: "Smithers",
    status,
    previewUrl,
    summary: null,
    slideshowUrl: null,
  });

  test("first ready build wins; building beats failed; all-failed reads failed; empty reads null", () => {
    expect(mergeLegacyBuildState([])).toBeNull();
    expect(mergeLegacyBuildState([entry("failed"), entry("ready", "http://x/")])).toEqual({
      status: "ready",
      previewUrl: "http://x/",
    });
    expect(mergeLegacyBuildState([entry("failed"), entry("building")])).toEqual({ status: "building", previewUrl: null });
    expect(mergeLegacyBuildState([entry("failed"), entry("failed")])).toEqual({ status: "failed", previewUrl: null });
  });
});
