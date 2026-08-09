import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildOrchestrator, mergeLegacyBuildState, type ProcessBuildSnapshot } from "./orchestrator";
import { BackendSelector } from "./selector";
import type { BuildBackend, BuildBackendId, BuildRequest, BuildResult, BuildRevision } from "./types";

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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("until(): condition never became true");
    }
    await Bun.sleep(5);
  }
}

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
      expect(build.previewUrl).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+/${build.backend}/\\?v=[a-z0-9]+\\.1$`, "u"));
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
    // The accept's deck-ready planning questions must reach EVERY hook call
    // untouched — the integrator wires them into the deck's interactive cards.
    const planQuestions = [{ id: "q-sync-engine", prompt: "Sync engine?", answers: ["CRDT", "Server-authoritative"] }];
    const hookQuestions: unknown[] = [];
    const orchestrator = track(
      new BuildOrchestrator({
        selector,
        buildsRoot: await tempRoot(),
        slideshow: async (input) => {
          hookQuestions.push(input.planQuestions);
          if (input.backend === "native") {
            throw new Error("slideshow generator blew up");
          }
          await Bun.write(join(input.outDir, "slideshow", "index.html"), "<!doctype html><h1>slides</h1>");
        },
      }),
    );

    await orchestrator.start({ ...startInput("upid-slides"), planQuestions });

    const [smithers, native] = orchestrator.builds("upid-slides");
    expect(smithers!.slideshowUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/smithers\/slideshow\/\?v=[a-z0-9]+\.1$/u);
    expect((await fetch(smithers!.slideshowUrl!)).status).toBe(200);
    expect(native!.status).toBe("ready"); // hook failure is garnish, not a build failure
    expect(native!.slideshowUrl).toBeNull();
    expect(hookQuestions).toEqual([planQuestions, planQuestions]);
  });

  test("the accept's IdeaBrief rides start() into every backend BuildRequest AND the slideshow hook", async () => {
    const brief = {
      pitch: "a tiny app",
      sourceQuote: "what if the wall just built a tiny app for that",
      rationale: "Small, concrete, one interaction.",
      qa: [{ id: "q-scope", prompt: "How polished?", answers: ["Sketch", "Demo-ready"] }],
      callsign: "atlas",
      maturity: "proposed",
    };
    const buildBriefs: unknown[] = [];
    const hookBriefs: unknown[] = [];
    const selector = new BackendSelector({
      backends: [
        writingBackend("smithers", {
          build: async (req) => {
            buildBriefs.push(req.brief);
            await Bun.write(join(req.outDir, "index.html"), "<!doctype html><h1>ok</h1>");
            return { ok: true, entrypoint: "index.html", summary: "ok" };
          },
        }),
      ],
      env: { VIBERSYN_BUILD_BACKENDS: "smithers" },
    });
    const orchestrator = track(
      new BuildOrchestrator({
        selector,
        buildsRoot: await tempRoot(),
        slideshow: async (input) => {
          hookBriefs.push(input.brief);
        },
      }),
    );

    await orchestrator.start({ ...startInput("upid-brief"), brief });
    expect(buildBriefs).toEqual([brief]);
    expect(hookBriefs).toEqual([brief]);

    // A brief-less start passes NO brief key at all (legacy contract intact).
    await orchestrator.start(startInput("upid-no-brief"));
    expect(buildBriefs).toEqual([brief, undefined]);
    expect(hookBriefs).toEqual([brief, undefined]);
  });
});

describe("BuildOrchestrator — stage ladder (ready-ratchet)", () => {
  test("hero flips the lane ready mid-build; flows/meta bump ?v; meta re-fires the deck hook with screens", async () => {
    const enrich = deferred();
    const screens = [
      { path: "#/flow", title: "Flow map" },
      { path: "detail.html", title: "Detail" },
    ];
    const questions = ["Who is v1 for?", "How polished?"];
    const ladder = writingBackend("smithers", {
      build: async (req: BuildRequest): Promise<BuildResult> => {
        await Bun.write(join(req.outDir, "index.html"), "<!doctype html><h1>hero</h1>");
        req.onStage?.({ stage: "hero", entrypoint: "index.html", summary: "Hero pitch line." });
        await enrich.promise; // the test inspects the hero-ready lane here
        await Bun.write(join(req.outDir, "index.html"), "<!doctype html><h1>hero + flows</h1>");
        await Bun.write(join(req.outDir, "detail.html"), "<!doctype html><h1>detail</h1>");
        req.onStage?.({ stage: "flows", entrypoint: "index.html" });
        req.onStage?.({ stage: "meta", entrypoint: "index.html", screens, suggestedQuestions: questions });
        return {
          ok: true,
          entrypoint: "index.html",
          summary: "Hero pitch line.",
          completedStages: ["hero", "flows", "meta"],
          screens,
          suggestedQuestions: questions,
        };
      },
    });
    const hookCalls: Array<{ screens?: unknown; suggestedQuestions?: unknown }> = [];
    const selector = new BackendSelector({ backends: [ladder], env: { VIBERSYN_BUILD_BACKENDS: "smithers" } });
    const orchestrator = track(
      new BuildOrchestrator({
        selector,
        buildsRoot: await tempRoot(),
        slideshow: async (input) => {
          hookCalls.push({ screens: input.screens, suggestedQuestions: input.suggestedQuestions });
          await Bun.write(join(input.outDir, "slideshow", "index.html"), "<!doctype html><h1>slides</h1>");
        },
      }),
    );

    const started = orchestrator.start(startInput("upid-ladder"));
    // READY-RATCHET: the lane is live at the hero stage, while build() still runs.
    await until(() => orchestrator.builds("upid-ladder")[0]?.status === "ready");
    const hero = orchestrator.builds("upid-ladder")[0]!;
    expect(hero.phase).toBe("enriching");
    expect(hero.summary).toBe("Hero pitch line.");
    expect(hero.previewUrl).toMatch(/\.1$/u); // hero = version bump #1
    expect(await (await fetch(hero.previewUrl!)).text()).toContain("hero");
    // The deck generates off the hero (no screens yet — meta hasn't landed).
    await until(() => hookCalls.length === 1);
    expect(hookCalls[0]).toEqual({ screens: undefined, suggestedQuestions: undefined });

    enrich.resolve();
    await started;

    const complete = orchestrator.builds("upid-ladder")[0]!;
    expect(complete.status).toBe("ready");
    expect(complete.phase).toBe("complete");
    // hero(1) + flows(2) + meta(3): each stage cache-busts the wall's iframe.
    expect(complete.previewUrl).toMatch(/\.3$/u);
    // Validated screens surface as directly-openable URLs: hash routes ride the
    // entrypoint's fragment, file screens get their own path.
    expect(complete.screens).toHaveLength(2);
    expect(complete.screens![0]!.url).toMatch(/\/smithers\/\?v=[a-z0-9]+\.3#\/flow$/u);
    expect(complete.screens![1]!.url).toMatch(/\/smithers\/detail\.html\?v=[a-z0-9]+\.3$/u);
    expect((await fetch(complete.screens![1]!.url)).status).toBe(200);
    // The meta stage RE-FIRED the deck hook with the validated mock.json facts.
    expect(hookCalls).toHaveLength(2);
    expect(hookCalls[1]).toEqual({ screens, suggestedQuestions: questions });
    expect(complete.slideshowUrl).toMatch(/\.3$/u);
  });

  test("enrichment failure never regresses a hero-ready lane, and it is NOT retried from scratch", async () => {
    let buildCalls = 0;
    const ladder = writingBackend("smithers", {
      build: async (req: BuildRequest): Promise<BuildResult> => {
        buildCalls += 1;
        await Bun.write(join(req.outDir, "index.html"), "<!doctype html><h1>hero stands</h1>");
        req.onStage?.({ stage: "hero", entrypoint: "index.html", summary: "Hero line." });
        // The backend reports the enrichment failure as a failed RESULT while
        // the hero already ratcheted the lane ready.
        return { ok: false, entrypoint: null, summary: "", error: "flows blew up", completedStages: ["hero"] };
      },
    });
    const selector = new BackendSelector({ backends: [ladder], env: { VIBERSYN_BUILD_BACKENDS: "smithers" } });
    const orchestrator = track(new BuildOrchestrator({ selector, buildsRoot: await tempRoot() }));

    await orchestrator.start(startInput("upid-hero-stands"));

    const [build] = orchestrator.builds("upid-hero-stands");
    expect(build!.status).toBe("ready"); // never regresses
    expect(build!.phase).toBe("hero");
    expect(build!.error).toBe("flows blew up");
    expect(build!.previewUrl).toMatch(/\.1$/u);
    expect(await (await fetch(build!.previewUrl!)).text()).toContain("hero stands");
    // Retry happens ONLY from status "failed" — a hero-ready lane is never rebuilt.
    expect(buildCalls).toBe(1);
  });
});

describe("BuildOrchestrator — revision contract", () => {
  test("steer normalizes a structured revision (kind/questionId/targetScreens, seq assigned) into the backend request", async () => {
    const revisions: Array<BuildRevision | undefined> = [];
    const corrections: Array<string | undefined> = [];
    const backend = writingBackend("smithers", {
      build: async (req: BuildRequest): Promise<BuildResult> => {
        if (req.revision !== undefined || req.correction !== undefined) {
          revisions.push(req.revision);
          corrections.push(req.correction);
        }
        await Bun.write(join(req.outDir, "index.html"), "<!doctype html><h1>app</h1>");
        return { ok: true, entrypoint: "index.html", summary: "built" };
      },
    });
    const selector = new BackendSelector({ backends: [backend], env: { VIBERSYN_BUILD_BACKENDS: "smithers" } });
    const orchestrator = track(new BuildOrchestrator({ selector, buildsRoot: await tempRoot() }));
    await orchestrator.start(startInput("upid-rev"));

    await orchestrator.steer("upid-rev", {
      kind: "answer",
      text: "  three columns, not five  ",
      questionId: "q-cols",
      answer: "Three",
      targetScreens: [" #/ ", ""],
    });
    const expected: BuildRevision = {
      kind: "answer",
      text: "three columns, not five",
      questionId: "q-cols",
      answer: "Three",
      targetScreens: ["#/"],
      seq: 1,
    };
    expect(revisions).toEqual([expected]);
    // The flattened alias rides along for single-shot backends (eliza/native).
    expect(corrections).toEqual(["three columns, not five"]);

    // A legacy bare string is a plain steer; seq keeps advancing.
    await orchestrator.steer("upid-rev", "make it purple");
    expect(revisions[1]).toEqual({ kind: "steer", text: "make it purple", seq: 2 });

    // The snapshot carries the applied revision history, most recent last.
    const [build] = orchestrator.builds("upid-rev");
    expect(build!.revisions).toEqual([expected, { kind: "steer", text: "make it purple", seq: 2 }]);

    // Empty text is a no-op, not a rebuild.
    await orchestrator.steer("upid-rev", "   ");
    await orchestrator.steer("upid-rev", { text: "" });
    expect(revisions).toHaveLength(2);
  });

  test("an incoming revision ABORTS in-flight enrichment — freshest human intent wins", async () => {
    const heroLanded = deferred();
    let enrichmentAborted = false;
    const backend = writingBackend("smithers", {
      build: async (req: BuildRequest): Promise<BuildResult> => {
        if (req.revision === undefined) {
          await Bun.write(join(req.outDir, "index.html"), "<!doctype html><h1>hero</h1>");
          req.onStage?.({ stage: "hero", entrypoint: "index.html", summary: "Hero line." });
          heroLanded.resolve();
          // Enrichment hangs until the revision aborts it (the backend's
          // subprocess SIGKILL path), then the hero survives as an ok result.
          await new Promise<void>((resolvePromise) => {
            if (req.signal.aborted) {
              resolvePromise();
              return;
            }
            req.signal.addEventListener("abort", () => resolvePromise(), { once: true });
          });
          enrichmentAborted = req.signal.aborted;
          return { ok: true, entrypoint: "index.html", summary: "Hero line.", completedStages: ["hero"] };
        }
        await Bun.write(join(req.outDir, "index.html"), `<!doctype html><h1>corrected:${req.revision.text}</h1>`);
        return { ok: true, entrypoint: "index.html", summary: "corrected" };
      },
    });
    const selector = new BackendSelector({ backends: [backend], env: { VIBERSYN_BUILD_BACKENDS: "smithers" } });
    const orchestrator = track(new BuildOrchestrator({ selector, buildsRoot: await tempRoot() }));

    const started = orchestrator.start(startInput("upid-abort-enrich"));
    await heroLanded.promise;
    await until(() => orchestrator.builds("upid-abort-enrich")[0]?.status === "ready");

    await orchestrator.steer("upid-abort-enrich", "make it neon");
    await started;

    expect(enrichmentAborted).toBe(true);
    const [build] = orchestrator.builds("upid-abort-enrich");
    expect(build!.status).toBe("ready");
    expect(build!.revisions).toEqual([{ kind: "steer", text: "make it neon", seq: 1 }]);
    expect(build!.previewUrl).toMatch(/\.2$/u); // hero bump + correction bump
    expect(await (await fetch(build!.previewUrl!)).text()).toContain("corrected:make it neon");
  });

  test("the snapshot's revision history is capped at 8, most recent last", async () => {
    const selector = new BackendSelector({ backends: [writingBackend("smithers")], env: { VIBERSYN_BUILD_BACKENDS: "smithers" } });
    const orchestrator = track(new BuildOrchestrator({ selector, buildsRoot: await tempRoot() }));
    await orchestrator.start(startInput("upid-cap"));

    for (let index = 1; index <= 10; index += 1) {
      await orchestrator.steer("upid-cap", `steer-${index}`);
    }

    const [build] = orchestrator.builds("upid-cap");
    expect(build!.revisions).toHaveLength(8);
    expect(build!.revisions![0]).toEqual({ kind: "steer", text: "steer-3", seq: 3 });
    expect(build!.revisions!.at(-1)).toEqual({ kind: "steer", text: "steer-10", seq: 10 });
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
      expect(build.previewUrl).toMatch(/\.2$/u);
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
    expect(build!.previewUrl).toMatch(/\.1$/u); // no bump — old version still serves
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
