// The "smithers" BuildBackend: a claude-shim STAGE LADDER that produces a
// staged CONCEPT MOCK at kickoff. Instead of the old 90s one-shot, build()
// runs up to three claude invocations through the same ClaudeRunner seam:
//
//   Task 1 HERO  (~75s): hero screen + headline pitch line + a hash-router
//     nav shell (#/, #/flow, #/s/2..#/s/4 "coming next" placeholders) in ONE
//     self-contained index.html. The moment it lands, onStage("hero") fires
//     and the orchestrator flips the lane ready — everything after is bonus.
//   Task 2 FLOWS (~60s): the existing files are serialized back into a fresh
//     prompt (the proven correction-mode pattern) and the CLI fills the
//     placeholder screens + completes the flow map. It ALSO piggybacks the
//     mock.json sidecar ask. Failure or abort here NEVER regresses the hero.
//   Task 3 META  (~30s): only when Task 2 didn't already write mock.json —
//     a metadata-only invocation. The backend then VALIDATES the sidecar
//     against disk (phantom screens dropped, paths sanitized) and rewrites it
//     atomically (tmp+rename) before surfacing screens/suggestedQuestions.
//
// A module-level SEMAPHORE caps concurrent claude invocations at 2 (the same
// throttle idea as cerebras-retry): hero and correction runs WAIT for a slot
// (they are the product / live human intent), enrichment stages only take a
// slot that is free RIGHT NOW — under fan-out contention they degrade to
// "skipped (busy)" instead of queueing behind another idea's hero.
// VIBERSYN_MOCK_ENRICH=0 disables Tasks 2-3 entirely.
//
// Correction (steer/revision) mode: the existing files' content is serialized
// INTO the prompt together with the revision, and the CLI rewrites the mock in
// place. When mock.json exists and the revision names targetScreens, ONLY the
// targeted screens' files are serialized (incremental rewrite).
//
// The claude subprocess is killable within the ~2s emergency-stop budget: the
// BuildRequest AbortSignal SIGKILLs it immediately (never a graceful drain).

import { existsSync } from "node:fs";
import { mkdir, readdir, rename, stat } from "node:fs/promises";
import { extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { briefContextBlock } from "../brief";
import type {
  BuildBackend,
  BuildBackendId,
  BuildBrief,
  BuildRequest,
  BuildResult,
  BuildRevision,
  BuildScreen,
  BuildStageId,
} from "../types";
import { sanitizeRelativePath } from "./native";

export const SMITHERS_BACKEND_LABEL = "Smithers";
export const SMITHERS_ENTRYPOINT = "index.html";
export const SMITHERS_SIDECAR = "mock.json";
export const MOCK_ENRICH_ENV = "VIBERSYN_MOCK_ENRICH";

// Per-stage ceilings. Each is a completion CHECKPOINT, not a death sentence:
// the CLI regularly writes its files early and gets SIGKILLed (exit 137)
// composing the final reply turn, so every stage salvages a killed run whose
// artifact landed during that run (mtime-gated — a stale file from an earlier
// boot never counts). The hero ceiling keeps the lane inside the kickoff
// budget; flows/meta are enrichment and can be cheaper.
const HERO_TIMEOUT_MS = 75_000;
const FLOWS_TIMEOUT_MS = 60_000;
const META_TIMEOUT_MS = 30_000;
const CORRECTION_TIMEOUT_MS = 90_000;
const MAX_PROMPT_FILE_CHARS = 20_000;
const MAX_READ_FILE_BYTES = 512 * 1024;
const SUMMARY_MAX_CHARS = 600;
const MAX_SIDECAR_SCREENS = 12;
const MAX_SIDECAR_QUESTIONS = 6;
const TEXT_EXTENSIONS = new Set([".html", ".htm", ".css", ".js", ".mjs", ".json", ".svg", ".txt", ".md", ".xml"]);

// --- claude runner seam -----------------------------------------------------
// One CLI invocation: prompt in, stdout out. Injectable so the backend is
// unit-testable with a fake runner (no real `claude` spawn).

export interface ClaudeRunArgs {
  cli: string;
  prompt: string;
  cwd: string;
  signal: AbortSignal;
  timeoutMs: number;
}

export interface ClaudeRunResult {
  exitCode: number;
  stdout: string;
}

export type ClaudeRunner = (args: ClaudeRunArgs) => Promise<ClaudeRunResult>;

// --- claude invocation semaphore --------------------------------------------
// Mirror of cerebras-retry's CerebrasThrottle idea for the claude CLI: tokens
// are in-flight invocations. acquire() waits FIFO (hero + correction runs —
// heroes always win eventually), tryAcquire() takes a slot only when one is
// free right now (enrichment stages skip rather than queue).

export interface ClaudeLadderSemaphore {
  acquire(signal?: AbortSignal): Promise<() => void>;
  tryAcquire(): (() => void) | null;
}

export const DEFAULT_CLAUDE_MAX_CONCURRENT = 2;

export class ClaudeInvocationSemaphore implements ClaudeLadderSemaphore {
  readonly #maxConcurrent: number;
  #active = 0;
  readonly #queue: Array<{ grant: () => void }> = [];

  constructor(maxConcurrent: number = DEFAULT_CLAUDE_MAX_CONCURRENT) {
    this.#maxConcurrent = Math.max(1, Math.floor(maxConcurrent));
  }

  get maxConcurrent(): number {
    return this.#maxConcurrent;
  }

  get active(): number {
    return this.#active;
  }

  get waiting(): number {
    return this.#queue.length;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.#active < this.#maxConcurrent) {
      this.#active += 1;
      return this.#releaser();
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        grant: () => {
          signal?.removeEventListener("abort", onAbort);
          this.#active += 1;
          resolve();
        },
      };
      const onAbort = (): void => {
        const index = this.#queue.indexOf(waiter);
        if (index >= 0) {
          this.#queue.splice(index, 1);
        }
        reject((signal?.reason as unknown) ?? new DOMException("This operation was aborted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#queue.push(waiter);
    });
    return this.#releaser();
  }

  tryAcquire(): (() => void) | null {
    if (this.#active >= this.#maxConcurrent) {
      return null;
    }
    this.#active += 1;
    return this.#releaser();
  }

  #releaser(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.#active -= 1;
      this.#queue.shift()?.grant();
    };
  }
}

// The module-level semaphore every default-configured backend instance shares:
// at most 2 concurrent claude CLI invocations process-wide.
let defaultClaudeSemaphore: ClaudeInvocationSemaphore | undefined;

export function getDefaultClaudeInvocationSemaphore(): ClaudeInvocationSemaphore {
  defaultClaudeSemaphore ??= new ClaudeInvocationSemaphore(DEFAULT_CLAUDE_MAX_CONCURRENT);
  return defaultClaudeSemaphore;
}

export interface SmithersBuildBackendOptions {
  /** Explicit claude CLI path; default: VIBERSYN_CLAUDE_CLI, then the repo shim, then PATH. */
  cliPath?: string;
  /** Env source (tests inject; defaults to process.env). VIBERSYN_MOCK_ENRICH=0 disables Tasks 2-3. */
  env?: Record<string, string | undefined>;
  /** Injected CLI runner for tests; default spawns the real claude CLI. */
  runner?: ClaudeRunner;
  /** When set, overrides EVERY per-stage ceiling (hero/flows/meta/correction). */
  timeoutMs?: number;
  /** Invocation semaphore; undefined = the shared module-level one, null = unthrottled. */
  semaphore?: ClaudeLadderSemaphore | null;
}

export class SmithersBuildBackend implements BuildBackend {
  readonly id: BuildBackendId = "smithers";
  readonly label = SMITHERS_BACKEND_LABEL;
  readonly #options: SmithersBuildBackendOptions;
  readonly #env: Record<string, string | undefined>;
  readonly #semaphore: ClaudeLadderSemaphore | null;

  constructor(options: SmithersBuildBackendOptions = {}) {
    this.#options = options;
    this.#env = options.env ?? process.env;
    this.#semaphore = options.semaphore === undefined ? getDefaultClaudeInvocationSemaphore() : options.semaphore;
  }

  async available(): Promise<{ ok: boolean; reason?: string }> {
    if (this.#options.runner !== undefined) {
      return { ok: true };
    }
    if (resolveClaudeCli({ cliPath: this.#options.cliPath, env: this.#env }) !== null) {
      return { ok: true };
    }
    return { ok: false, reason: "smithers backend needs a claude CLI (repo shim or PATH)" };
  }

  async build(req: BuildRequest): Promise<BuildResult> {
    const { signal } = req;
    try {
      signal.throwIfAborted();
      const cli = resolveClaudeCli({ cliPath: this.#options.cliPath, env: this.#env });
      const runner = this.#options.runner ?? defaultClaudeRunner;
      if (this.#options.runner === undefined && cli === null) {
        throw new Error("no claude CLI found (repo shim or PATH)");
      }
      await mkdir(req.outDir, { recursive: true });

      const revision = requestRevision(req);
      if (revision !== null) {
        return await this.#applyRevision(req, runner, cli ?? "claude", revision);
      }
      return await this.#runLadder(req, runner, cli ?? "claude");
    } catch (error) {
      const aborted = signal.aborted;
      return {
        ok: false,
        entrypoint: null,
        summary: aborted ? "Mock aborted by emergency stop." : "Smithers mock failed before completion.",
        error: aborted ? "aborted" : error instanceof Error ? error.message : String(error),
      };
    }
  }

  // --- the stage ladder -----------------------------------------------------

  async #runLadder(req: BuildRequest, runner: ClaudeRunner, cli: string): Promise<BuildResult> {
    const { signal, onProgress } = req;

    // --- Task 1: HERO — the lane's product. Waits for a semaphore slot. -----
    onProgress({ label: "mocking hero screen", percent: 10 });
    const heroStartedAt = Date.now();
    const preRunEntrypointMtime = await fileMtimeMs(req.outDir, SMITHERS_ENTRYPOINT);
    const heroRun = await this.#invoke(runner, {
      cli,
      prompt: smithersBuildPrompt(req.prompt, req.brief),
      cwd: req.outDir,
      signal,
      timeoutMs: this.#stageTimeout(HERO_TIMEOUT_MS),
    });
    signal.throwIfAborted();
    if (heroRun.exitCode !== 0) {
      // The ceiling SIGKILL (exit 137) regularly lands AFTER the CLI already
      // wrote the mock: under fan-out contention the final reply turn is what
      // times out, not the artifact. If THIS run wrote the entrypoint, the
      // hero is real — salvage it. Freshness = the mtime CHANGED vs the
      // pre-run snapshot (never a clock comparison: container filesystems
      // truncate mtimes, and a write landing sub-ms after Date.now() stats
      // BELOW it on CI — the wall-clock gate green locally, red on ubuntu).
      // A nonzero exit with an untouched entrypoint stays fatal, so a stale
      // mock from an earlier boot is never passed off as this idea's.
      const landedAt = await fileMtimeMs(req.outDir, SMITHERS_ENTRYPOINT);
      if (landedAt === null || landedAt === preRunEntrypointMtime) {
        throw new Error(`claude builder exited ${heroRun.exitCode}`);
      }
    }
    if (!existsSync(join(req.outDir, SMITHERS_ENTRYPOINT))) {
      return {
        ok: false,
        entrypoint: null,
        summary: "",
        error: `the claude mock produced no ${SMITHERS_ENTRYPOINT} entrypoint`,
      };
    }
    const summary = summaryFromClaudeOutput(heroRun.stdout, req.prompt, null);
    const completed: BuildStageId[] = ["hero"];
    req.onStage?.({ stage: "hero", entrypoint: SMITHERS_ENTRYPOINT, summary });
    const heroResult = (label: string): BuildResult => {
      onProgress({ label, percent: 100 });
      return { ok: true, entrypoint: SMITHERS_ENTRYPOINT, summary, completedStages: [...completed] };
    };

    if (this.#env[MOCK_ENRICH_ENV] === "0") {
      return heroResult("mock ready");
    }
    onProgress({ label: "hero ready — sketching flow screens", percent: 55 });

    // --- Tasks 2-3: enrichment. NEVER regresses the hero: any failure or ---
    // --- abort in here returns the hero-only success honestly labeled.   ---
    try {
      signal.throwIfAborted();

      // Task 2: FLOWS (+ piggybacked mock.json ask). Free-slot only.
      const flowsSlot = this.#trySlot();
      if (flowsSlot === null) {
        return heroResult("enrichment skipped (busy)");
      }
      let flowsLanded = false;
      const flowsStartedAt = Date.now();
      const preFlowsEntrypointMtime = await fileMtimeMs(req.outDir, SMITHERS_ENTRYPOINT);
      const preFlowsSidecarMtime = await fileMtimeMs(req.outDir, SMITHERS_SIDECAR);
      try {
        const files = await readProjectFiles(req.outDir);
        const flowsRun = await runner({
          cli,
          prompt: smithersFlowsPrompt(req.prompt, files, req.brief),
          cwd: req.outDir,
          signal,
          timeoutMs: this.#stageTimeout(FLOWS_TIMEOUT_MS),
        });
        signal.throwIfAborted();
        // Per-stage salvage: a killed flows run whose entrypoint (or sidecar)
        // was rewritten during the run still counts.
        flowsLanded =
          flowsRun.exitCode === 0 ||
          (await fileMtimeMs(req.outDir, SMITHERS_ENTRYPOINT)) !== preFlowsEntrypointMtime ||
          (await fileMtimeMs(req.outDir, SMITHERS_SIDECAR)) !== preFlowsSidecarMtime;
      } finally {
        flowsSlot();
      }
      if (!flowsLanded) {
        return heroResult("flow screens failed — hero mock stands");
      }
      completed.push("flows");
      req.onStage?.({ stage: "flows", entrypoint: SMITHERS_ENTRYPOINT });
      signal.throwIfAborted();

      // Task 3: META — only when Task 2's piggyback didn't already write it.
      onProgress({ label: "writing deck metadata", percent: 90 });
      if (!existsSync(join(req.outDir, SMITHERS_SIDECAR))) {
        const metaSlot = this.#trySlot();
        if (metaSlot === null) {
          return heroResult("deck metadata skipped (busy)");
        }
        try {
          const files = await readProjectFiles(req.outDir);
          await runner({
            cli,
            prompt: smithersMetaPrompt(req.prompt, files),
            cwd: req.outDir,
            signal,
            timeoutMs: this.#stageTimeout(META_TIMEOUT_MS),
          });
        } finally {
          metaSlot();
        }
        signal.throwIfAborted();
      }
      // Validate the sidecar against DISK (phantom screens dropped) and
      // rewrite it atomically so the deck only ever links real screens.
      const sidecar = await validateMockSidecar(req.outDir);
      if (sidecar !== null) {
        await rewriteMockSidecar(req.outDir, sidecar);
        completed.push("meta");
        req.onStage?.({
          stage: "meta",
          entrypoint: SMITHERS_ENTRYPOINT,
          screens: sidecar.screens,
          suggestedQuestions: sidecar.suggestedQuestions,
        });
        onProgress({ label: "mock ready", percent: 100 });
        return {
          ok: true,
          entrypoint: SMITHERS_ENTRYPOINT,
          summary,
          completedStages: [...completed],
          screens: sidecar.screens,
          suggestedQuestions: sidecar.suggestedQuestions,
        };
      }
      return heroResult("deck metadata missing — hero and flows stand");
    } catch (error) {
      // Freshest-human-intent aborts and enrichment crashes both land here:
      // the hero (and any completed flows) survive as an honest success.
      const label = signal.aborted
        ? "enrichment aborted — hero mock stands"
        : `enrichment failed — hero mock stands (${error instanceof Error ? error.message : String(error)})`;
      return heroResult(truncate(label, 200));
    }
  }

  // --- revision (steer/answer) mode -----------------------------------------

  async #applyRevision(req: BuildRequest, runner: ClaudeRunner, cli: string, revision: BuildRevision): Promise<BuildResult> {
    const { signal, onProgress } = req;
    onProgress({ label: "reading mock", percent: 10 });
    const allFiles = await readProjectFiles(req.outDir);
    if (allFiles.size === 0) {
      return { ok: false, entrypoint: null, summary: "", error: "steer requested but the build directory has no mock to correct" };
    }
    signal.throwIfAborted();
    // Incremental application: when the sidecar exists and the revision names
    // target screens, ONLY those screens' files ride the prompt.
    const sidecar = await validateMockSidecar(req.outDir);
    const files = selectRevisionFiles(allFiles, sidecar, revision);
    onProgress({ label: "applying correction", percent: 30, detail: truncate(revision.text, 120) });

    const startedAt = Date.now();
    const run = await this.#invoke(runner, {
      cli,
      prompt: smithersCorrectionPrompt(req.prompt, files, revision),
      cwd: req.outDir,
      signal,
      timeoutMs: this.#stageTimeout(CORRECTION_TIMEOUT_MS),
    });
    signal.throwIfAborted();
    if (run.exitCode !== 0) {
      const landedAt = await fileMtimeMs(req.outDir, SMITHERS_ENTRYPOINT);
      if (landedAt === null || landedAt < startedAt) {
        throw new Error(`claude builder exited ${run.exitCode}`);
      }
    }
    if (!existsSync(join(req.outDir, SMITHERS_ENTRYPOINT))) {
      return {
        ok: false,
        entrypoint: null,
        summary: "",
        error: `the claude mock produced no ${SMITHERS_ENTRYPOINT} entrypoint`,
      };
    }
    // Keep the deck metadata honest after the rewrite: re-validate whatever
    // sidecar is on disk now (the CLI may have updated it) and re-surface it.
    const after = await validateMockSidecar(req.outDir);
    if (after !== null) {
      await rewriteMockSidecar(req.outDir, after);
    }
    onProgress({ label: "mock ready", percent: 100 });
    return {
      ok: true,
      entrypoint: SMITHERS_ENTRYPOINT,
      summary: summaryFromClaudeOutput(run.stdout, req.prompt, revision.text),
      ...(after === null ? {} : { screens: after.screens, suggestedQuestions: after.suggestedQuestions }),
    };
  }

  // Priority path (hero + corrections): WAIT for a semaphore slot, run, release.
  async #invoke(runner: ClaudeRunner, args: ClaudeRunArgs): Promise<ClaudeRunResult> {
    const release = this.#semaphore === null ? null : await this.#semaphore.acquire(args.signal);
    try {
      return await runner(args);
    } finally {
      release?.();
    }
  }

  #trySlot(): (() => void) | null {
    if (this.#semaphore === null) {
      return () => undefined;
    }
    return this.#semaphore.tryAcquire();
  }

  #stageTimeout(defaultMs: number): number {
    return this.#options.timeoutMs ?? defaultMs;
  }
}

// The revision a request carries: the structured one when present, else the
// flattened correction alias promoted to a bare steer.
function requestRevision(req: BuildRequest): BuildRevision | null {
  if (req.revision !== undefined && req.revision.text.trim().length > 0) {
    return { ...req.revision, text: req.revision.text.trim() };
  }
  const correction = typeof req.correction === "string" && req.correction.trim().length > 0 ? req.correction.trim() : null;
  return correction === null ? null : { kind: "steer", text: correction, seq: 0 };
}

// The file subset a targeted revision serializes: each target matches a
// sidecar screen by path (or title, case-insensitive); hash-route screens map
// to the entrypoint. No sidecar / no targets / no matches → the full map.
export function selectRevisionFiles(
  all: ReadonlyMap<string, string>,
  sidecar: MockSidecar | null,
  revision: BuildRevision,
): ReadonlyMap<string, string> {
  const targets = (revision.targetScreens ?? []).map((target) => target.trim()).filter((target) => target.length > 0);
  if (sidecar === null || targets.length === 0) {
    return all;
  }
  const selected = new Map<string, string>();
  for (const target of targets) {
    const screen = sidecar.screens.find(
      (candidate) => candidate.path === target || candidate.title.toLowerCase() === target.toLowerCase(),
    );
    if (screen === undefined) {
      continue;
    }
    const file = screen.path.startsWith("#") ? SMITHERS_ENTRYPOINT : screen.path;
    const content = all.get(file);
    if (content !== undefined) {
      selected.set(file, content);
    }
  }
  return selected.size > 0 ? selected : all;
}

// --- mock.json sidecar (validated against disk) ------------------------------

export interface MockSidecar {
  pitchLine: string | null;
  screens: BuildScreen[];
  suggestedQuestions: string[];
}

// Parse + validate mock.json against what is ACTUALLY on disk: hash-route
// screens must appear in the entrypoint's markup, file screens must pass
// sanitizeRelativePath (native.ts's traversal guard) AND exist. Phantoms are
// dropped, never surfaced. null when the sidecar is absent/unparseable.
export async function validateMockSidecar(outDir: string): Promise<MockSidecar | null> {
  let raw: string;
  try {
    raw = await Bun.file(join(outDir, SMITHERS_SIDECAR)).text();
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const pitchLine =
    typeof parsed.pitchLine === "string" && parsed.pitchLine.trim().length > 0 ? truncate(parsed.pitchLine.trim(), 300) : null;
  let entrypointHtml = "";
  try {
    entrypointHtml = await Bun.file(join(outDir, SMITHERS_ENTRYPOINT)).text();
  } catch {
    // no entrypoint — every hash route is a phantom
  }
  const screens: BuildScreen[] = [];
  if (Array.isArray(parsed.screens)) {
    for (const entry of parsed.screens.slice(0, MAX_SIDECAR_SCREENS)) {
      if (!isRecord(entry) || typeof entry.path !== "string" || typeof entry.title !== "string") {
        continue;
      }
      const title = truncate(entry.title.trim(), 120);
      const path = entry.path.trim();
      if (title.length === 0 || path.length === 0) {
        continue;
      }
      if (path.startsWith("#")) {
        if (entrypointHtml.includes(path)) {
          screens.push({ path, title });
        }
        continue;
      }
      const safe = sanitizeRelativePath(path);
      if (safe !== null && existsSync(join(outDir, safe))) {
        screens.push({ path: safe, title });
      }
    }
  }
  const suggestedQuestions = Array.isArray(parsed.suggestedQuestions)
    ? parsed.suggestedQuestions
        .filter((question): question is string => typeof question === "string" && question.trim().length > 0)
        .map((question) => truncate(question.trim(), 200))
        .slice(0, MAX_SIDECAR_QUESTIONS)
    : [];
  return { pitchLine, screens, suggestedQuestions };
}

// Atomic rewrite (tmp + rename) so a half-written sidecar is never served.
export async function rewriteMockSidecar(outDir: string, sidecar: MockSidecar): Promise<void> {
  const tmp = join(outDir, `${SMITHERS_SIDECAR}.tmp`);
  await Bun.write(tmp, JSON.stringify(sidecar, null, 1));
  await rename(tmp, join(outDir, SMITHERS_SIDECAR));
}

// --- prompts (pure; unit-tested) --------------------------------------------

// Task 1 HERO: a fast CONCEPT MOCK — the hero screen plus the hash-router nav
// shell the later stages fill in. Still ONE self-contained file, still a
// pitch, never the product. When the accept carried an IdeaBrief its context
// block (the verbatim room quote, the judge's rationale, decided/open
// questions) grounds the mock.
export function smithersBuildPrompt(pitch: string, brief?: BuildBrief): string {
  const idea = pitch.trim().length > 0 ? pitch.trim() : "A small useful web tool.";
  const context = briefContextBlock(brief);
  return [
    "You are a rapid concept artist producing a CONCEPT MOCK of an imagined app — a pitch, not the product.",
    "",
    `IDEA: ${idea}`,
    "",
    ...(context.length === 0 ? [] : [context, ""]),
    "Build ONE small SELF-CONTAINED static page that sells this idea:",
    "- The HERO SCREEN of the imagined app: what its main screen would look like, with a strong visual identity (name, palette, typography).",
    "- A HEADLINE PITCH LINE displayed prominently — one punchy sentence that sells the idea.",
    "- ONE key interaction, lightly sketched: a single button/input/toggle that demonstrates the core feel. Full functionality is NOT the goal — this is a concept mock.",
    "- A HASH-ROUTER NAV SHELL, required, all in the same file:",
    '  - route "#/" shows the hero screen (the default view);',
    '  - route "#/flow" shows a FLOW MAP page: 3-5 labeled boxes naming the imagined app\'s main screens, each box a link to its route;',
    '  - routes "#/s/2", "#/s/3", "#/s/4" are "coming next" placeholder screens (screen title + one teaser line each);',
    '  - a persistent bottom nav bar of plain <button data-screen="..."> elements (one per route) that switches the hash route on click. Plain JS hashchange routing — no libraries.',
    `- Plain HTML/CSS/JavaScript, everything inline in a single ${SMITHERS_ENTRYPOINT}. NO build step, NO CDN, NO extra files. Keep it SMALL.`,
    "- Write the file directly into the current working directory. Overwrite any existing scaffold files.",
    "",
    "Do not ask questions. Do not build the full app. Produce the concept mock now,",
    "then reply with ONLY the headline pitch line as a single sentence.",
  ].join("\n");
}

// Task 2 FLOWS (+ piggybacked meta): the existing files ride the prompt (the
// proven correction-mode pattern) and the CLI fills the placeholders in place.
export function smithersFlowsPrompt(pitch: string, files: ReadonlyMap<string, string>, brief?: BuildBrief): string {
  const idea = pitch.trim().length > 0 ? pitch.trim() : "A small useful web tool.";
  const context = briefContextBlock(brief);
  return [
    "You are a rapid concept artist ENRICHING an existing concept mock in the current working directory.",
    "",
    `IDEA: ${idea}`,
    "",
    ...(context.length === 0 ? [] : [context, ""]),
    "CURRENT FILES (JSON map of path -> content — these are already on disk in the cwd):",
    serializeFiles(files),
    "",
    "The hero screen and hash-router nav shell already exist. Now, IN PLACE:",
    '- FILL IN the "coming next" placeholder screens (#/s/2, #/s/3, #/s/4) with real sketched screens of the imagined app — each small: a title, a plausible layout, static demo content. Drop any placeholder route you replace with nothing.',
    "- COMPLETE the flow map at #/flow: 3-5 labeled boxes, one per real screen, each linking to its route.",
    `- Keep everything in the single self-contained ${SMITHERS_ENTRYPOINT} (inline CSS/JS, no CDN, no build step). Overwrite it in the current working directory.`,
    "",
    `ALSO write a ${SMITHERS_SIDECAR} file next to it, exactly this JSON shape:`,
    '{"pitchLine": "<one punchy sentence>", "screens": [{"path": "<a route like #/ or #/flow or #/s/2>", "title": "<short screen title>"}, ...], "suggestedQuestions": ["<2-4 short decision questions for the room>", ...]}',
    `Every screens[].path MUST be a route that actually exists in ${SMITHERS_ENTRYPOINT}.`,
    "",
    "Do not ask questions. Do not build the full app. Enrich the mock now.",
  ].join("\n");
}

// Task 3 META (standalone fallback when Task 2 didn't write the sidecar):
// metadata only — never touches the mock itself.
export function smithersMetaPrompt(pitch: string, files: ReadonlyMap<string, string>): string {
  const idea = pitch.trim().length > 0 ? pitch.trim() : "A small useful web tool.";
  return [
    "You are describing an EXISTING concept mock for its pitch deck. Do NOT modify any existing file.",
    "",
    `IDEA: ${idea}`,
    "",
    "CURRENT FILES (JSON map of path -> content — these are already on disk in the cwd):",
    serializeFiles(files),
    "",
    `Write ONLY a ${SMITHERS_SIDECAR} file into the current working directory, exactly this JSON shape:`,
    '{"pitchLine": "<one punchy sentence>", "screens": [{"path": "<a route like #/ or #/flow or #/s/2>", "title": "<short screen title>"}, ...], "suggestedQuestions": ["<2-4 short decision questions for the room>", ...]}',
    `Every screens[].path MUST be a route that actually exists in ${SMITHERS_ENTRYPOINT}.`,
    "",
    "Do not ask questions. Write the file now.",
  ].join("\n");
}

// Revision mode: the (possibly target-selected) files' content + the revision,
// and the CLI rewrites the mock in place (same directory, same entrypoint).
// Accepts a bare correction string for legacy callers.
export function smithersCorrectionPrompt(
  pitch: string,
  files: ReadonlyMap<string, string>,
  revision: string | BuildRevision,
): string {
  const rev: BuildRevision = typeof revision === "string" ? { kind: "steer", text: revision, seq: 0 } : revision;
  const targets = (rev.targetScreens ?? []).map((target) => target.trim()).filter((target) => target.length > 0);
  const intent =
    rev.kind === "answer"
      ? `DECISION FROM THE ROOM${rev.questionId !== undefined ? ` (question ${rev.questionId})` : ""} — apply it faithfully: ${rev.text}`
      : `SPOKEN CORRECTION FROM THE ROOM — apply it faithfully: ${rev.text}`;
  return [
    "You are a rapid concept artist CORRECTING an existing concept mock in the current working directory.",
    "",
    `ORIGINAL IDEA: ${pitch.trim().length > 0 ? pitch.trim() : "A small useful web tool."}`,
    "",
    targets.length === 0
      ? "CURRENT FILES (JSON map of path -> content — these are already on disk in the cwd):"
      : `TARGETED SCREENS: ${targets.join(", ")} — only their files are shown below; OTHER FILES EXIST on disk and must be left untouched.`,
    ...(targets.length === 0 ? [] : ["CURRENT FILES (JSON map of path -> content — these are already on disk in the cwd):"]),
    serializeFiles(files),
    "",
    intent,
    "",
    "Rewrite the mock IN PLACE:",
    "- Overwrite the existing files in the current working directory with the corrected versions.",
    `- Keep it a SMALL SELF-CONTAINED concept mock: plain HTML/CSS/JS inline, ${SMITHERS_ENTRYPOINT} stays the entry file, no build step, no CDN.`,
    "- Preserve everything that already works; change only what the correction requires.",
    "",
    "Do not ask questions. Apply the correction now.",
  ].join("\n");
}

// The pitch-line summary for the snapshot: the claude JSON envelope's `result`
// text when parseable (the prompt asks for exactly the headline pitch line),
// else a deterministic pitch line from the idea.
export function summaryFromClaudeOutput(stdout: string, pitch: string, correction: string | null): string {
  const fallback =
    correction === null
      ? `${truncate(pitch.trim(), 160)} — concept mock, ready to commission.`
      : `Applied spoken correction: "${truncate(correction, 200)}".`;
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return fallback;
  }
  try {
    const envelope: unknown = JSON.parse(trimmed);
    if (isRecord(envelope) && typeof envelope.result === "string" && envelope.result.trim().length > 0) {
      return firstParagraph(envelope.result.trim());
    }
  } catch {
    // Non-JSON stdout — the agent's effect is the files it wrote; use the fallback.
  }
  return fallback;
}

function firstParagraph(text: string): string {
  const paragraph = text.split(/\n\s*\n/u)[0] ?? text;
  return truncate(paragraph.replace(/\s+/gu, " ").trim(), SUMMARY_MAX_CHARS);
}

// --- claude CLI plumbing ----------------------------------------------------

// Resolve the claude CLI: explicit path (or VIBERSYN_CLAUDE_CLI) must exist;
// otherwise prefer the repo shim, then whatever is on PATH.
export function resolveClaudeCli(options: { cliPath?: string; env?: Record<string, string | undefined> } = {}): string | null {
  const env = options.env ?? process.env;
  const explicit = options.cliPath ?? env.VIBERSYN_CLAUDE_CLI;
  if (explicit !== undefined && explicit.length > 0) {
    return existsSync(explicit) ? explicit : null;
  }
  const shim = fileURLToPath(new URL("../../../.context/claude-shim/claude", import.meta.url));
  if (existsSync(shim)) {
    return shim;
  }
  return Bun.which("claude");
}

// Default production runner: spawn the claude CLI in the build directory so it
// edits files in place. The abort signal SIGKILLs the subprocess immediately
// (emergency-stop budget ~2s); the timeout is a ceiling for unattended builds.
export const defaultClaudeRunner: ClaudeRunner = async ({ cli, prompt, cwd, signal, timeoutMs }) => {
  signal.throwIfAborted();
  const proc = Bun.spawn([cli, "-p", prompt, "--output-format", "json", "--dangerously-skip-permissions"], {
    cwd,
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  });
  const killHard = (): void => {
    try {
      proc.kill(9); // SIGKILL: no graceful drain inside the emergency-stop budget.
    } catch {
      // Already exited.
    }
  };
  signal.addEventListener("abort", killHard, { once: true });
  const timer = setTimeout(killHard, timeoutMs);
  try {
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    signal.throwIfAborted();
    return { exitCode, stdout };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", killHard);
  }
};

// mtime of a file in the build dir, or null when it does not exist — the
// per-stage salvage gate for ceiling-killed runs (only a file written during
// the run counts; a stale one from an earlier boot never does).
async function fileMtimeMs(outDir: string, name: string): Promise<number | null> {
  try {
    return (await stat(join(outDir, name))).mtimeMs;
  } catch {
    return null;
  }
}

// Read the existing app's text files (for the enrichment/correction prompts).
// Depth-safe: skips binaries, oversized files, and anything unreadable.
async function readProjectFiles(outDir: string): Promise<Map<string, string>> {
  const project = new Map<string, string>();
  let names: string[];
  try {
    names = (await readdir(outDir, { recursive: true })) as string[];
  } catch {
    return project;
  }
  for (const name of names) {
    const rel = name.split(sep).join("/");
    if (!TEXT_EXTENSIONS.has(extname(rel).toLowerCase())) {
      continue;
    }
    const abs = join(outDir, name);
    try {
      const info = await stat(abs);
      if (!info.isFile() || info.size > MAX_READ_FILE_BYTES) {
        continue;
      }
      project.set(rel, await Bun.file(abs).text());
    } catch {
      // unreadable entry — skip
    }
  }
  return project;
}

function serializeFiles(files: ReadonlyMap<string, string>): string {
  const record: Record<string, string> = {};
  for (const [path, content] of files) {
    record[path] =
      content.length > MAX_PROMPT_FILE_CHARS ? `${content.slice(0, MAX_PROMPT_FILE_CHARS)}\n/* …truncated… */` : content;
  }
  return JSON.stringify(record, null, 1);
}

// --- small helpers ----------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
