import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuildRequest, BuildStageEvent } from "../types";
import {
  ClaudeInvocationSemaphore,
  MOCK_ENRICH_ENV,
  rewriteMockSidecar,
  selectRevisionFiles,
  SmithersBuildBackend,
  SMITHERS_ENTRYPOINT,
  SMITHERS_SIDECAR,
  smithersBuildPrompt,
  smithersCorrectionPrompt,
  smithersFlowsPrompt,
  smithersMetaPrompt,
  summaryFromClaudeOutput,
  validateMockSidecar,
  type ClaudeLadderSemaphore,
  type ClaudeRunArgs,
  type ClaudeRunner,
  type ClaudeRunResult,
} from "./smithers";

// All tests inject a fake ClaudeRunner — no real `claude` spawn, fully hermetic.
// The ladder tests use a SCRIPTED runner: one behavior per successive CLI
// invocation (hero, flows, meta), so each stage's on-disk effect is explicit.

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)));
  roots.length = 0;
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "smithers-backend-"));
  roots.push(dir);
  return dir;
}

function request(outDir: string, overrides: Partial<BuildRequest> = {}): BuildRequest {
  return {
    upid: "upid-t",
    ideaId: "idea-t",
    prompt: "Build a pomodoro timer",
    callsign: "atlas",
    outDir,
    signal: new AbortController().signal,
    onProgress: () => undefined,
    ...overrides,
  };
}

// The scripted-fake-runner pattern: invocation N runs steps[N] (extra
// invocations fail the test loudly). Returns the runner + the seen prompts.
function scriptedRunner(
  steps: Array<(args: ClaudeRunArgs) => Promise<ClaudeRunResult>>,
): { runner: ClaudeRunner; prompts: string[] } {
  const prompts: string[] = [];
  const runner: ClaudeRunner = async (args) => {
    const step = steps[prompts.length];
    prompts.push(args.prompt);
    if (step === undefined) {
      throw new Error(`scripted runner exhausted after ${steps.length} invocation(s)`);
    }
    return step(args);
  };
  return { runner, prompts };
}

// A hero-quality entrypoint whose markup carries the nav-shell hash routes the
// sidecar validator checks against.
const HERO_HTML = '<!doctype html><h1>timer</h1><nav>#/ #/flow #/s/2 #/s/3 #/s/4</nav>';
const ENRICHED_HTML = '<!doctype html><h1>timer enriched</h1><nav>#/ #/flow #/s/2 #/s/3</nav>';

const heroStep =
  (stdout = JSON.stringify({ result: "Built the pomodoro timer." })) =>
  async ({ cwd }: ClaudeRunArgs): Promise<ClaudeRunResult> => {
    await writeFile(join(cwd, SMITHERS_ENTRYPOINT), HERO_HTML, "utf8");
    return { exitCode: 0, stdout };
  };

describe("smithers backend — prompts (pure)", () => {
  test("hero prompt asks for a CONCEPT MOCK (hero, pitch line, one interaction) with the hash-router nav shell", () => {
    const prompt = smithersBuildPrompt("A kanban wall");
    expect(prompt).toContain("IDEA: A kanban wall");
    expect(prompt).toContain("SELF-CONTAINED");
    expect(prompt).toContain(SMITHERS_ENTRYPOINT);
    expect(prompt).toContain("CONCEPT MOCK");
    expect(prompt).toContain("HERO SCREEN");
    expect(prompt).toContain("HEADLINE PITCH LINE");
    expect(prompt).toContain("HASH-ROUTER NAV SHELL");
    expect(prompt).toContain('"#/flow"');
    expect(prompt).toContain('"#/s/2"');
    expect(prompt).toContain("Do not build the full app");
  });

  test("hero prompt appends the IdeaBrief context block when the request carries one", () => {
    const brief = {
      pitch: "A kanban wall",
      sourceQuote: "we keep losing track of tickets, put a kanban on the wall",
      rationale: "Named tool, obvious hero screen.",
      qa: [
        { id: "q-cols", prompt: "How many columns?", answers: ["Three", "Five"] },
        { id: "q-drag", prompt: "Drag and drop?", answers: ["Yes", "Later"], chosen: "Yes" },
      ],
      callsign: null,
    };
    const prompt = smithersBuildPrompt("A kanban wall", brief);
    expect(prompt).toContain('AS HEARD IN THE ROOM (verbatim): "we keep losing track of tickets, put a kanban on the wall"');
    expect(prompt).toContain("WHY IT IS BUILDABLE: Named tool, obvious hero screen.");
    expect(prompt).toContain("DECISIONS ALREADY MADE:\n- Drag and drop? → Yes");
    expect(prompt).toContain("OPEN QUESTIONS:\n- How many columns? (options: Three / Five)");
    // The concept-mock instructions still follow the context block.
    expect(prompt).toContain("Build ONE small SELF-CONTAINED static page");
    // Without a brief the prompt is unchanged — no stray context headers.
    expect(smithersBuildPrompt("A kanban wall")).not.toContain("AS HEARD IN THE ROOM");
  });

  test("flows prompt serializes the existing files and piggybacks the mock.json sidecar ask", () => {
    const files = new Map([[SMITHERS_ENTRYPOINT, "<h1>HERO-MARKER</h1>"]]);
    const prompt = smithersFlowsPrompt("A kanban wall", files);
    expect(prompt).toContain("HERO-MARKER");
    expect(prompt).toContain("FILL IN");
    expect(prompt).toContain("#/s/2");
    expect(prompt).toContain(SMITHERS_SIDECAR);
    expect(prompt).toContain("suggestedQuestions");
    expect(prompt).toContain("Do not build the full app");
  });

  test("meta prompt asks ONLY for the sidecar and forbids touching the mock", () => {
    const files = new Map([[SMITHERS_ENTRYPOINT, "<h1>HERO-MARKER</h1>"]]);
    const prompt = smithersMetaPrompt("A kanban wall", files);
    expect(prompt).toContain("HERO-MARKER");
    expect(prompt).toContain(`Write ONLY a ${SMITHERS_SIDECAR} file`);
    expect(prompt).toContain("Do NOT modify any existing file");
    expect(prompt).toContain("pitchLine");
  });

  test("correction prompt includes the existing files' content AND the spoken correction", () => {
    const files = new Map([["index.html", "<h1>old app</h1>"]]);
    const prompt = smithersCorrectionPrompt("A kanban wall", files, "make the columns draggable");
    expect(prompt).toContain("<h1>old app</h1>");
    expect(prompt).toContain("make the columns draggable");
    expect(prompt).toContain("IN PLACE");
  });

  test("correction prompt frames an answer revision as the room's decision and names the targets", () => {
    const files = new Map([["index.html", "<h1>hero</h1>"]]);
    const prompt = smithersCorrectionPrompt("A kanban wall", files, {
      kind: "answer",
      text: "three columns, not five",
      questionId: "q-cols",
      answer: "Three",
      targetScreens: ["#/", "Board"],
      seq: 2,
    });
    expect(prompt).toContain("DECISION FROM THE ROOM (question q-cols)");
    expect(prompt).toContain("three columns, not five");
    expect(prompt).toContain("TARGETED SCREENS: #/, Board");
    expect(prompt).toContain("OTHER FILES EXIST on disk and must be left untouched");
  });

  test("summary uses the claude JSON envelope result, else a deterministic fallback", () => {
    expect(summaryFromClaudeOutput(JSON.stringify({ result: "Built a timer.\n\nDetails follow." }), "pitch", null)).toBe(
      "Built a timer.",
    );
    expect(summaryFromClaudeOutput("not json at all", "a pitch", null)).toContain("a pitch");
    expect(summaryFromClaudeOutput("", "pitch", "add dark mode")).toContain("add dark mode");
  });
});

describe("smithers backend — mock.json sidecar validation", () => {
  test("validateMockSidecar keeps only screens that are REAL on disk and clamps the rest", async () => {
    const outDir = await tempDir();
    await writeFile(join(outDir, SMITHERS_ENTRYPOINT), HERO_HTML, "utf8");
    await writeFile(join(outDir, "detail.html"), "<h1>detail</h1>", "utf8");
    await writeFile(
      join(outDir, SMITHERS_SIDECAR),
      JSON.stringify({
        pitchLine: "  A punchy line.  ",
        screens: [
          { path: "#/", title: "Hero" },
          { path: "#/flow", title: "Flow map" },
          { path: "#/s/9", title: "Phantom route (not in the markup)" },
          { path: "detail.html", title: "Detail file" },
          { path: "missing.html", title: "Phantom file" },
          { path: "../evil.html", title: "Traversal" },
          { path: "", title: "Empty path" },
          { title: "No path at all" },
        ],
        suggestedQuestions: ["Who is v1 for?", 42, "  ", "How polished?"],
      }),
      "utf8",
    );

    const sidecar = await validateMockSidecar(outDir);
    expect(sidecar).not.toBeNull();
    expect(sidecar!.pitchLine).toBe("A punchy line.");
    expect(sidecar!.screens).toEqual([
      { path: "#/", title: "Hero" },
      { path: "#/flow", title: "Flow map" },
      { path: "detail.html", title: "Detail file" },
    ]);
    expect(sidecar!.suggestedQuestions).toEqual(["Who is v1 for?", "How polished?"]);
  });

  test("an absent or unparseable sidecar reads null; rewriteMockSidecar lands atomically (no .tmp left)", async () => {
    const outDir = await tempDir();
    expect(await validateMockSidecar(outDir)).toBeNull();
    await writeFile(join(outDir, SMITHERS_SIDECAR), "{not json", "utf8");
    expect(await validateMockSidecar(outDir)).toBeNull();

    const sidecar = { pitchLine: "Line.", screens: [{ path: "#/", title: "Hero" }], suggestedQuestions: ["Q?"] };
    await rewriteMockSidecar(outDir, sidecar);
    expect(JSON.parse(await readFile(join(outDir, SMITHERS_SIDECAR), "utf8"))).toEqual(sidecar);
    await expect(readFile(join(outDir, `${SMITHERS_SIDECAR}.tmp`), "utf8")).rejects.toBeDefined();
  });

  test("selectRevisionFiles: targets pick screen files (path or title, hash → entrypoint); no match → full map", () => {
    const all = new Map([
      [SMITHERS_ENTRYPOINT, "<h1>hero</h1>"],
      ["detail.html", "<h1>detail</h1>"],
      ["extra.html", "<h1>extra</h1>"],
    ]);
    const sidecar = {
      pitchLine: null,
      screens: [
        { path: "#/", title: "Hero" },
        { path: "detail.html", title: "Detail" },
        { path: "extra.html", title: "Extra" },
      ],
      suggestedQuestions: [],
    };
    // By title (case-insensitive) and by path; a hash route maps to the entrypoint.
    expect([...selectRevisionFiles(all, sidecar, { kind: "steer", text: "x", targetScreens: ["detail"], seq: 1 }).keys()]).toEqual([
      "detail.html",
    ]);
    expect([...selectRevisionFiles(all, sidecar, { kind: "steer", text: "x", targetScreens: ["#/"], seq: 1 }).keys()]).toEqual([
      SMITHERS_ENTRYPOINT,
    ]);
    // Unmatched targets fall back to the FULL map (never an empty prompt)…
    expect(selectRevisionFiles(all, sidecar, { kind: "steer", text: "x", targetScreens: ["nope"], seq: 1 })).toBe(all);
    // …and so does a revision without targets or without a sidecar.
    expect(selectRevisionFiles(all, sidecar, { kind: "steer", text: "x", seq: 1 })).toBe(all);
    expect(selectRevisionFiles(all, null, { kind: "steer", text: "x", targetScreens: ["Detail"], seq: 1 })).toBe(all);
  });
});

describe("smithers backend — stage ladder via scripted runner", () => {
  test("full ladder: hero → flows piggybacks mock.json → meta validates; onStage fires per stage", async () => {
    const outDir = join(await tempDir(), "smithers");
    const { runner, prompts } = scriptedRunner([
      heroStep(),
      // Task 2 FLOWS: fills the screens AND piggybacks the sidecar (with one
      // phantom screen the backend must drop at validation).
      async ({ cwd }) => {
        await writeFile(join(cwd, SMITHERS_ENTRYPOINT), ENRICHED_HTML, "utf8");
        await writeFile(
          join(cwd, SMITHERS_SIDECAR),
          JSON.stringify({
            pitchLine: "Tomatoes, but punctual.",
            screens: [
              { path: "#/", title: "Hero" },
              { path: "#/flow", title: "Flow map" },
              { path: "#/s/9", title: "Phantom" },
            ],
            suggestedQuestions: ["Who is v1 for?"],
          }),
          "utf8",
        );
        return { exitCode: 0, stdout: "" };
      },
    ]);
    const stages: BuildStageEvent[] = [];
    const labels: string[] = [];
    const backend = new SmithersBuildBackend({ runner, semaphore: null });

    const result = await backend.build(
      request(outDir, {
        onStage: (event) => stages.push(event),
        onProgress: (update) => labels.push(update.label),
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.entrypoint).toBe(SMITHERS_ENTRYPOINT);
    expect(result.summary).toBe("Built the pomodoro timer.");
    expect(result.completedStages).toEqual(["hero", "flows", "meta"]);
    expect(result.screens).toEqual([
      { path: "#/", title: "Hero" },
      { path: "#/flow", title: "Flow map" },
    ]);
    expect(result.suggestedQuestions).toEqual(["Who is v1 for?"]);
    // Two invocations only — the piggybacked sidecar makes Task 3 unnecessary.
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("Build a pomodoro timer");
    expect(prompts[1]).toContain("timer</h1>"); // hero markup rode the flows prompt
    // onStage fired per stage, hero first (the orchestrator's ready-ratchet).
    expect(stages.map((event) => event.stage)).toEqual(["hero", "flows", "meta"]);
    expect(stages[0]).toMatchObject({ entrypoint: SMITHERS_ENTRYPOINT, summary: "Built the pomodoro timer." });
    expect(stages[2]!.screens).toEqual(result.screens!);
    expect(stages[2]!.suggestedQuestions).toEqual(["Who is v1 for?"]);
    // The sidecar on disk is the VALIDATED rewrite — the phantom screen is gone.
    const onDisk = JSON.parse(await readFile(join(outDir, SMITHERS_SIDECAR), "utf8")) as { screens: unknown };
    expect(onDisk.screens).toEqual(result.screens!);
    // Honest per-stage labels, ending ready.
    expect(labels[0]).toBe("mocking hero screen");
    expect(labels).toContain("hero ready — sketching flow screens");
    expect(labels.at(-1)).toBe("mock ready");
  });

  test("meta fallback: when flows does not write the sidecar, a third metadata-only invocation does", async () => {
    const outDir = join(await tempDir(), "smithers");
    const { runner, prompts } = scriptedRunner([
      heroStep(),
      async ({ cwd }) => {
        await writeFile(join(cwd, SMITHERS_ENTRYPOINT), ENRICHED_HTML, "utf8");
        return { exitCode: 0, stdout: "" };
      },
      async ({ cwd }) => {
        await writeFile(
          join(cwd, SMITHERS_SIDECAR),
          JSON.stringify({ pitchLine: "Line.", screens: [{ path: "#/flow", title: "Flow map" }], suggestedQuestions: [] }),
          "utf8",
        );
        return { exitCode: 0, stdout: "" };
      },
    ]);
    const backend = new SmithersBuildBackend({ runner, semaphore: null });

    const result = await backend.build(request(outDir));
    expect(result.ok).toBe(true);
    expect(result.completedStages).toEqual(["hero", "flows", "meta"]);
    expect(result.screens).toEqual([{ path: "#/flow", title: "Flow map" }]);
    expect(prompts).toHaveLength(3);
    expect(prompts[2]).toContain(`Write ONLY a ${SMITHERS_SIDECAR} file`);
  });

  test("missing/unusable sidecar after both enrichment chances: hero+flows stand, honestly labeled", async () => {
    const outDir = join(await tempDir(), "smithers");
    const { runner, prompts } = scriptedRunner([
      heroStep(),
      async ({ cwd }) => {
        await writeFile(join(cwd, SMITHERS_ENTRYPOINT), ENRICHED_HTML, "utf8");
        return { exitCode: 0, stdout: "" };
      },
      async () => ({ exitCode: 0, stdout: "" }), // meta invocation writes nothing
    ]);
    const labels: string[] = [];
    const backend = new SmithersBuildBackend({ runner, semaphore: null });

    const result = await backend.build(request(outDir, { onProgress: (update) => labels.push(update.label) }));
    expect(result.ok).toBe(true);
    expect(result.completedStages).toEqual(["hero", "flows"]);
    expect(result.screens).toBeUndefined();
    expect(prompts).toHaveLength(3);
    expect(labels.at(-1)).toBe("deck metadata missing — hero and flows stand");
  });

  test(`${MOCK_ENRICH_ENV}=0 kill-switch: hero only, ONE invocation, still an ok mock`, async () => {
    const outDir = join(await tempDir(), "smithers");
    const { runner, prompts } = scriptedRunner([heroStep()]);
    const stages: BuildStageEvent[] = [];
    const backend = new SmithersBuildBackend({ runner, semaphore: null, env: { [MOCK_ENRICH_ENV]: "0" } });

    const result = await backend.build(request(outDir, { onStage: (event) => stages.push(event) }));
    expect(result.ok).toBe(true);
    expect(result.completedStages).toEqual(["hero"]);
    expect(prompts).toHaveLength(1);
    expect(stages.map((event) => event.stage)).toEqual(["hero"]);
  });

  test("under contention enrichment degrades to 'skipped (busy)' instead of queueing — hero still wins a slot", async () => {
    const outDir = join(await tempDir(), "smithers");
    const acquired: string[] = [];
    // Hero waits for (and gets) a slot; enrichment's tryAcquire finds none.
    const busy: ClaudeLadderSemaphore = {
      async acquire() {
        acquired.push("acquire");
        return () => undefined;
      },
      tryAcquire() {
        acquired.push("try");
        return null;
      },
    };
    const { runner, prompts } = scriptedRunner([heroStep()]);
    const labels: string[] = [];
    const backend = new SmithersBuildBackend({ runner, semaphore: busy });

    const result = await backend.build(request(outDir, { onProgress: (update) => labels.push(update.label) }));
    expect(result.ok).toBe(true);
    expect(result.completedStages).toEqual(["hero"]);
    expect(prompts).toHaveLength(1); // flows never invoked
    expect(acquired).toEqual(["acquire", "try"]);
    expect(labels.at(-1)).toBe("enrichment skipped (busy)");
  });

  test("flows failure NEVER regresses the hero: the lane stays an ok hero mock", async () => {
    const outDir = join(await tempDir(), "smithers");
    const { runner, prompts } = scriptedRunner([
      async ({ cwd }) => {
        await writeFile(join(cwd, SMITHERS_ENTRYPOINT), HERO_HTML, "utf8");
        // Keep the hero's mtime strictly before the flows attempt so the
        // failed flows run cannot be salvaged off the hero's own write.
        await Bun.sleep(10);
        return { exitCode: 0, stdout: JSON.stringify({ result: "Hero line." }) };
      },
      async () => ({ exitCode: 1, stdout: "" }), // flows crashes without writing
    ]);
    const labels: string[] = [];
    const backend = new SmithersBuildBackend({ runner, semaphore: null });

    const result = await backend.build(request(outDir, { onProgress: (update) => labels.push(update.label) }));
    expect(result.ok).toBe(true);
    expect(result.entrypoint).toBe(SMITHERS_ENTRYPOINT);
    expect(result.summary).toBe("Hero line.");
    expect(result.completedStages).toEqual(["hero"]);
    expect(prompts).toHaveLength(2);
    expect(labels.at(-1)).toBe("flow screens failed — hero mock stands");
    await expect(readFile(join(outDir, SMITHERS_ENTRYPOINT), "utf8")).resolves.toContain("timer");
  });

  test("an abort during enrichment keeps the hero (freshest human intent wins over bonus work)", async () => {
    const outDir = join(await tempDir(), "smithers");
    const controller = new AbortController();
    const { runner } = scriptedRunner([
      heroStep(),
      async ({ signal }) => {
        // The revision path aborts in-flight enrichment: simulate the SIGKILL.
        controller.abort();
        signal.throwIfAborted();
        throw new Error("unreachable");
      },
    ]);
    const labels: string[] = [];
    const stages: BuildStageEvent[] = [];
    const backend = new SmithersBuildBackend({ runner, semaphore: null });

    const result = await backend.build(
      request(outDir, {
        signal: controller.signal,
        onStage: (event) => stages.push(event),
        onProgress: (update) => labels.push(update.label),
      }),
    );
    expect(result.ok).toBe(true); // the hero mock survives the abort
    expect(result.completedStages).toEqual(["hero"]);
    expect(stages.map((event) => event.stage)).toEqual(["hero"]);
    expect(labels.at(-1)).toBe("enrichment aborted — hero mock stands");
  });

  test("ClaudeInvocationSemaphore: 2 slots, FIFO acquire, tryAcquire never queues", async () => {
    const semaphore = new ClaudeInvocationSemaphore(2);
    const first = await semaphore.acquire();
    const second = await semaphore.acquire();
    expect(semaphore.tryAcquire()).toBeNull(); // full — enrichment would skip
    let granted = false;
    const waiting = semaphore.acquire().then((release) => {
      granted = true;
      return release;
    });
    await Bun.sleep(1);
    expect(granted).toBe(false); // heroes queue…
    first();
    const third = await waiting;
    expect(granted).toBe(true); // …and win as soon as a slot frees
    second();
    third();
    const slot = semaphore.tryAcquire();
    expect(slot).not.toBeNull();
    slot!();
  });
});

describe("smithers backend — build via injected runner", () => {
  test("the request's IdeaBrief reaches the claude prompt (fresh build)", async () => {
    const outDir = join(await tempDir(), "smithers");
    const seenPrompts: string[] = [];
    const runner: ClaudeRunner = async ({ prompt, cwd }) => {
      seenPrompts.push(prompt);
      await writeFile(join(cwd, "index.html"), "<!doctype html><h1>ok</h1>", "utf8");
      return { exitCode: 0, stdout: "" };
    };
    const backend = new SmithersBuildBackend({ runner, semaphore: null, env: { [MOCK_ENRICH_ENV]: "0" } });
    const result = await backend.build(
      request(outDir, {
        brief: {
          pitch: "Build a pomodoro timer",
          sourceQuote: "the timer should yell when the break is over",
          rationale: "",
          qa: [],
          callsign: null,
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(seenPrompts[0]).toContain('AS HEARD IN THE ROOM (verbatim): "the timer should yell when the break is over"');
  });

  test("a run that produces no index.html fails with a specific error", async () => {
    const outDir = join(await tempDir(), "smithers");
    const runner: ClaudeRunner = async () => ({ exitCode: 0, stdout: "" });
    const backend = new SmithersBuildBackend({ runner, semaphore: null });

    const result = await backend.build(request(outDir));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("index.html");
  });

  test("ceiling-killed hero (exit 137) whose entrypoint landed during the run is salvaged as ready", async () => {
    const outDir = join(await tempDir(), "smithers");
    const runner: ClaudeRunner = async ({ cwd }) => {
      // The CLI wrote the mock, then got SIGKILLed composing its final reply.
      await writeFile(join(cwd, "index.html"), "<!doctype html><h1>salvaged mock</h1>", "utf8");
      return { exitCode: 137, stdout: "" };
    };
    const backend = new SmithersBuildBackend({ runner, semaphore: null, env: { [MOCK_ENRICH_ENV]: "0" } });

    const result = await backend.build(request(outDir));
    expect(result.ok).toBe(true);
    expect(result.entrypoint).toBe(SMITHERS_ENTRYPOINT);
    expect(result.summary).toContain("Build a pomodoro timer"); // deterministic fallback pitch line
    expect(result.completedStages).toEqual(["hero"]);
  });

  test("nonzero exit with only a STALE pre-run entrypoint stays failed (no stale salvage)", async () => {
    const outDir = join(await tempDir(), "smithers");
    // A mock from an earlier boot is already on disk…
    await Bun.write(join(outDir, "index.html"), "<!doctype html><h1>stale other idea</h1>");
    // …and mtimes have ms precision: make sure the stale file is strictly older
    // than the run start before the runner crashes without writing anything.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const backend = new SmithersBuildBackend({ runner: async () => ({ exitCode: 1, stdout: "" }), semaphore: null });

    const result = await backend.build(request(outDir));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("exited 1");
  });

  test("correction mode: existing files + correction reach the prompt; app rewritten in place", async () => {
    const outDir = join(await tempDir(), "smithers");
    const backend = new SmithersBuildBackend({
      semaphore: null,
      runner: async ({ prompt, cwd }) => {
        expect(prompt).toContain("OLD-CONTENT-MARKER");
        expect(prompt).toContain("turn it neon green");
        await writeFile(join(cwd, "index.html"), "<!doctype html><h1>neon</h1>", "utf8");
        return { exitCode: 0, stdout: JSON.stringify({ result: "Turned it neon green." }) };
      },
    });
    // Seed the existing app the correction rewrites in place.
    await Bun.write(join(outDir, "index.html"), "<!doctype html><h1>OLD-CONTENT-MARKER</h1>");

    const result = await backend.build(request(outDir, { correction: "turn it neon green" }));
    expect(result.ok).toBe(true);
    await expect(readFile(join(outDir, "index.html"), "utf8")).resolves.toContain("neon");
  });

  test("a targeted revision serializes ONLY the named screens' files and re-surfaces the validated sidecar", async () => {
    const outDir = join(await tempDir(), "smithers");
    await Bun.write(join(outDir, SMITHERS_ENTRYPOINT), '<!doctype html><h1>INDEX-MARKER</h1><nav>#/</nav>');
    await Bun.write(join(outDir, "extra.html"), "<!doctype html><h1>EXTRA-MARKER</h1>");
    await Bun.write(
      join(outDir, SMITHERS_SIDECAR),
      JSON.stringify({
        pitchLine: "Line.",
        screens: [
          { path: "#/", title: "Hero" },
          { path: "extra.html", title: "Extra" },
        ],
        suggestedQuestions: ["Who is v1 for?"],
      }),
    );
    const seenPrompts: string[] = [];
    const backend = new SmithersBuildBackend({
      semaphore: null,
      runner: async ({ prompt, cwd }) => {
        seenPrompts.push(prompt);
        await writeFile(join(cwd, "extra.html"), "<!doctype html><h1>EXTRA neon</h1>", "utf8");
        return { exitCode: 0, stdout: JSON.stringify({ result: "Extra went neon." }) };
      },
    });

    const result = await backend.build(
      request(outDir, {
        correction: "make the extra screen neon",
        revision: {
          kind: "answer",
          text: "make the extra screen neon",
          questionId: "q-style",
          answer: "Neon",
          targetScreens: ["Extra"],
          seq: 4,
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.summary).toBe("Extra went neon.");
    // Incremental selection: only the targeted screen's file rode the prompt.
    expect(seenPrompts[0]).toContain("EXTRA-MARKER");
    expect(seenPrompts[0]).not.toContain("INDEX-MARKER");
    expect(seenPrompts[0]).toContain("TARGETED SCREENS: Extra");
    expect(seenPrompts[0]).toContain("DECISION FROM THE ROOM (question q-style)");
    // The post-rewrite sidecar is re-validated and re-surfaced.
    expect(result.screens).toEqual([
      { path: "#/", title: "Hero" },
      { path: "extra.html", title: "Extra" },
    ]);
    expect(result.suggestedQuestions).toEqual(["Who is v1 for?"]);
    await expect(readFile(join(outDir, "extra.html"), "utf8")).resolves.toContain("neon");
  });

  test("correction against an empty directory fails instead of hallucinating a rewrite", async () => {
    const outDir = join(await tempDir(), "smithers");
    const backend = new SmithersBuildBackend({ runner: async () => ({ exitCode: 0, stdout: "" }), semaphore: null });
    const result = await backend.build(request(outDir, { correction: "make it faster" }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no mock to correct");
  });

  test("abort: the signal rejects the run and the result reports 'aborted'", async () => {
    const outDir = join(await tempDir(), "smithers");
    const controller = new AbortController();
    const runner: ClaudeRunner = ({ signal }) =>
      new Promise((_, reject) => {
        if (signal.aborted) {
          reject(new Error("SIGKILLed"));
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("SIGKILLed")), { once: true });
      });
    const backend = new SmithersBuildBackend({ runner, semaphore: null });

    const pending = backend.build(request(outDir, { signal: controller.signal }));
    controller.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("aborted");
  });
});
