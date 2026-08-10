// Multi-backend KICKOFF orchestrator: for one accepted idea, fan build() out to
// every enabled+available backend CONCURRENTLY, each into its own
// builds/<upid>/<backendId>/ subdirectory, all served off ONE per-UPID preview
// server (idea-builder's servePreviewDirectory — no-cache headers, per-backend
// subdir index resolution) so every backend gets its own previewUrl. Since the
// two-stage pivot each backend produces a fast CONCEPT MOCK (status stays the
// machine enum building/ready/failed; progressLabel carries the mock-oriented
// wording) — the full app is the separate commission stage (execution.ts).
//
// STAGE LADDER (smithers): a backend may report per-stage progress via
// BuildRequest.onStage. The hero stage is a READY-RATCHET: the lane flips
// ready (version bump, slideshow hook) the moment the hero lands, while the
// backend keeps enriching (flow screens, mock.json meta). Later stages bump
// the version again (iframe cache-bust) and the meta stage re-fires the
// slideshow hook with the validated screens/suggestedQuestions so the deck can
// consume them. A hero-ready lane NEVER regresses: enrichment failure keeps it
// ready, and retry-from-scratch happens only from status "failed".
//
// Per-(upid,backend) status/progress is tracked live and exposed as the
// snapshot builds[] fragment the wall consumes. steer(upid, revision) accepts
// a bare correction string OR a structured revision ({kind, text, questionId,
// answer, targetScreens}); it re-runs every ready build with the revision
// (concurrent, rewritten in place) and bumps a per-build version so the
// previewUrl changes (?v=N) and the wall's iframe cache-busts. An incoming
// revision ABORTS in-flight enrichment stages first — freshest human intent
// wins. abortAll(upid)/abortEverything() abort every in-flight build via its
// AbortSignal (backends SIGKILL their subprocesses) inside the ~2s
// emergency-stop budget.

import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { servePreviewDirectory, type PreviewServer } from "../server/idea-builder";
import type { BackendSelector } from "./selector";
import type { BuildBackend, BuildBackendId, BuildBrief, BuildRevision, BuildScreen, BuildStageId } from "./types";

export type OrchestratorBuildStatus = "building" | "ready" | "failed";

// The ladder phase riding NEXT TO the machine status enum (which stays
// untouched so eliza/native and the wall chips keep working): "hero" = only
// the hero-level mock exists, "enriching" = hero is live and later stages are
// in flight, "complete" = the full ladder (incl. mock.json meta) landed.
export type OrchestratorBuildPhase = "hero" | "enriching" | "complete";

// The snapshot builds[] entry the wall UI consumes (contract shape).
export interface ProcessBuildSnapshot {
  backend: BuildBackendId;
  label: string;
  status: OrchestratorBuildStatus;
  previewUrl: string | null;
  summary: string | null;
  slideshowUrl: string | null;
  progressLabel?: string;
  percent?: number;
  /** Last backend failure message (honesty surface — present only when set). */
  error?: string;
  /** Stage-ladder phase (present only for ladder backends). */
  phase?: OrchestratorBuildPhase;
  /** Validated mock screens as directly-openable URLs (from mock.json meta). */
  screens?: Array<{ title: string; url: string }>;
  /** Revision history applied to this lane, most recent last (capped). */
  revisions?: readonly BuildRevision[];
}

export interface OrchestratorStartInput {
  upid: string;
  ideaId: string;
  prompt: string;
  callsign: string | null;
  // Deck-ready decision questions from the planning routine, riding the accept.
  // Mirrors PlanQuestion in src/detect/plan-questions.ts BY CONVENTION — that
  // module is owned by the detection track and this track must stand alone (no
  // cross-track imports); the shapes are structurally identical. Absent for
  // kickoffs without questions (repo imports, demo seeds).
  planQuestions?: readonly { id: string; prompt: string; answers: string[] }[];
  // The idea's context brief riding the accept (see BuildBrief in ./types —
  // the structural mirror of src/types.ts's IdeaBrief, same no-cross-track
  // rule as planQuestions above). Threaded verbatim into every backend's
  // BuildRequest and the slideshow hook. Absent for kickoffs without one
  // (repo imports, demo seeds).
  brief?: BuildBrief;
}

// The structured revision steer() accepts next to the legacy bare string.
// `seq` is normally assigned by the orchestrator (per-process monotonic).
export interface OrchestratorRevisionInput {
  kind?: "steer" | "answer";
  text: string;
  questionId?: string;
  answer?: string;
  targetScreens?: readonly string[];
  seq?: number;
}

// Optional per-build slideshow hook (the slideshow track's generateSlideshow,
// wired by the integrator). Called after a successful build/correction — and
// RE-FIRED after the meta stage with the validated screens/suggestedQuestions
// so the deck can consume mock.json data; a resolved hook flips the build's
// slideshowUrl on (previewUrl + "slideshow/"). The accept's planQuestions pass
// through untouched so the integrator can wire them into the deck's
// interactive swipe-to-answer cards. Failures are swallowed — the slideshow is
// garnish, never a build failure.
export type SlideshowHook = (input: {
  upid: string;
  ideaId: string;
  prompt: string;
  callsign: string | null;
  planQuestions?: readonly { id: string; prompt: string; answers: string[] }[];
  brief?: BuildBrief;
  backend: BuildBackendId;
  outDir: string;
  summary: string;
  signal: AbortSignal;
  /** Validated mock screens (routes/files that exist) once the meta stage lands. */
  screens?: readonly BuildScreen[];
  /** Deck decision questions suggested by the mock's meta stage. */
  suggestedQuestions?: readonly string[];
}) => Promise<void>;

// GIT SUBSTRATE hooks ("tree = repo", src/server/tree-git.ts) — a STRUCTURAL
// seam, deliberately not an import of the substrate (mirrors the BuildBrief
// no-cross-track convention). `birth` fires once per fan-out start;
// `commitLane` after every landed stage/mock/correction. Both are strictly
// fire-and-forget: a hook that throws/rejects must never fail, block, or slow
// a build (see #fireTreeGit). Default null — every existing orchestrator
// consumer/test stays spawn-free with zero edits.
export interface TreeGitHooks {
  birth(
    upid: string,
    seed: {
      ideaId: string;
      pitch: string;
      callsign: string | null;
      brief?: BuildBrief;
      planQuestions?: readonly { id: string; prompt: string; answers: string[] }[];
    },
  ): void | Promise<void>;
  commitLane(upid: string, lane: BuildBackendId, laneDir: string, message: string): void | Promise<void>;
}

export interface BuildOrchestratorOptions {
  selector: BackendSelector;
  // Root the per-UPID build directories live under. Defaults to <cwd>/builds.
  buildsRoot?: string;
  // Hostname the per-UPID preview server binds to. Always loopback in practice.
  host?: string;
  // Preview-server seam (tests inject; default is the real idea-builder server).
  serve?: (dir: string, host?: string) => Promise<PreviewServer>;
  slideshow?: SlideshowHook | null;
  // Git-substrate hooks (above). Default null = substrate off.
  treeGit?: TreeGitHooks | null;
  // Republish hook: fired on every status/progress transition so the runtime
  // can push a fresh snapshot.
  onUpdate?: () => void;
  // Hard ceiling abortAll waits for aborted builds to settle. Default 2s.
  abortBudgetMs?: number;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_ABORT_BUDGET_MS = 2_000;
// Revision history riding every snapshot is bounded (snapshot bloat guard).
const REVISION_HISTORY_CAP = 8;

// The in-flight run of one lane: `enriching` flips true at the hero ratchet —
// from then on an incoming revision may abort this run (freshest intent wins).
interface TrackedRun {
  controller: AbortController;
  enriching: boolean;
  settled: Promise<void>;
}

interface TrackedBuild {
  backend: BuildBackendId;
  label: string;
  status: OrchestratorBuildStatus;
  progressLabel?: string;
  percent?: number;
  summary: string | null;
  // Non-null once the backend has EVER completed successfully — the previewUrl
  // stays visible through a steer re-run (old content serves until rewritten).
  entrypoint: string | null;
  hasSlideshow: boolean;
  // Bumped on every successful build/correction AND on every ladder stage;
  // previewUrl carries ?v=<version> so the wall's iframe cache-busts.
  version: number;
  error?: string;
  phase?: OrchestratorBuildPhase;
  // Validated mock screens ({path,title} — URLs derived in builds()).
  screens?: readonly BuildScreen[];
  // Applied revisions, most recent last, capped at REVISION_HISTORY_CAP.
  revisions: BuildRevision[];
  run?: TrackedRun;
}

interface TrackedProcess {
  input: OrchestratorStartInput;
  // Per-kickoff cache-bust nonce: preview ports are ephemeral and recycled
  // across UPIDs/sessions, and two lanes both at ?v=1 on a reused port make
  // the wall's iframe src byte-identical — it never re-navigates, serving the
  // PREVIOUS idea's mock/deck. version stays a small per-lane counter (steer
  // bumps), the nonce makes the URL globally unique.
  nonce: string;
  dir: string;
  server: PreviewServer | null;
  order: BuildBackendId[];
  builds: Map<BuildBackendId, TrackedBuild>;
  controllers: Set<AbortController>;
  tasks: Set<Promise<unknown>>;
  aborted: boolean;
  // Monotonic revision counter — assigns Revision.seq when the caller didn't.
  revisionSeq: number;
}

export class BuildOrchestrator {
  readonly #selector: BackendSelector;
  readonly #buildsRoot: string;
  readonly #host: string;
  readonly #serve: (dir: string, host?: string) => Promise<PreviewServer>;
  readonly #slideshow: SlideshowHook | null;
  readonly #treeGit: TreeGitHooks | null;
  readonly #onUpdate: () => void;
  readonly #abortBudgetMs: number;
  readonly #processes = new Map<string, TrackedProcess>();

  constructor(options: BuildOrchestratorOptions) {
    this.#selector = options.selector;
    this.#buildsRoot = options.buildsRoot ?? resolve(process.cwd(), "builds");
    this.#host = options.host ?? DEFAULT_HOST;
    this.#serve = options.serve ?? servePreviewDirectory;
    this.#slideshow = options.slideshow ?? null;
    this.#treeGit = options.treeGit ?? null;
    this.#onUpdate = options.onUpdate ?? (() => undefined);
    this.#abortBudgetMs = options.abortBudgetMs ?? DEFAULT_ABORT_BUDGET_MS;
  }

  // Fan one accepted idea out to every enabled+available backend concurrently.
  // Resolves when every backend build has settled (the runtime typically
  // fire-and-forgets this and watches builds[] via onUpdate).
  async start(input: OrchestratorStartInput): Promise<void> {
    // A re-accept for a live UPID replaces the previous fan-out entirely.
    if (this.#processes.has(input.upid)) {
      await this.abortAll(input.upid);
    }
    const state: TrackedProcess = {
      input,
      nonce: Date.now().toString(36),
      dir: join(this.#buildsRoot, safeSegment(input.upid)),
      server: null,
      order: [],
      builds: new Map(),
      controllers: new Set(),
      tasks: new Set(),
      aborted: false,
      revisionSeq: 0,
    };
    this.#processes.set(input.upid, state);

    await this.#selector.probeAll();
    const targets = this.#selector
      .enabledBackends()
      .filter((backend) => this.#selector.availability(backend.id)?.ok === true);
    if (state.aborted) {
      return;
    }
    if (targets.length === 0) {
      this.#onUpdate();
      return;
    }

    await mkdir(state.dir, { recursive: true });
    // GIT SUBSTRATE birth: the tree's repo seeds (README + seed.json on main)
    // the moment the fan-out has a directory. Fire-and-forget — the substrate
    // self-detects GitHub-import clones (repo/.git) and never inits over them.
    this.#fireTreeGit(() =>
      this.#treeGit?.birth(input.upid, {
        ideaId: input.ideaId,
        pitch: input.prompt,
        callsign: input.callsign,
        ...(input.brief === undefined ? {} : { brief: input.brief }),
        ...(input.planQuestions === undefined ? {} : { planQuestions: input.planQuestions }),
      }),
    );
    // ONE preview server per UPID serving builds/<upid>/ — each backend's app is
    // a subdirectory, so each gets its own previewUrl off the same port.
    const server = await this.#serve(state.dir, this.#host);
    if (state.aborted) {
      await server.stop().catch(() => undefined);
      return;
    }
    state.server = server;

    for (const backend of targets) {
      state.order.push(backend.id);
      state.builds.set(backend.id, {
        backend: backend.id,
        label: backend.label,
        status: "building",
        summary: null,
        entrypoint: null,
        hasSlideshow: false,
        version: 0,
        revisions: [],
      });
    }
    this.#onUpdate();
    await Promise.allSettled(targets.map((backend) => this.#track(state, this.#runFreshWithRetry(state, backend))));
  }

  // Fresh fan-out with ONE automatic retry: a mock lane that fails its first
  // pass (quota blip, transient timeout) gets exactly one clean re-run before
  // it is surfaced as failed. Corrections (steer) never retry — and a
  // hero-ready lane whose ENRICHMENT failed reads "ready", so it is never
  // rebuilt from scratch either (retry only from status "failed").
  async #runFreshWithRetry(state: TrackedProcess, backend: BuildBackend): Promise<void> {
    await this.#runBuild(state, backend, null);
    const build = state.builds.get(backend.id)!;
    if (state.aborted || build.status !== "failed") {
      return;
    }
    console.warn(`[buildloop] ${state.input.upid}/${backend.id} mock failed (${build.error ?? "unknown"}) — retrying once`);
    build.status = "building";
    build.progressLabel = "retrying mock";
    build.percent = 0;
    this.#onUpdate();
    await this.#runBuild(state, backend, null);
    const settled = state.builds.get(backend.id)!;
    if (!state.aborted && settled.status === "failed") {
      console.warn(`[buildloop] ${state.input.upid}/${backend.id} mock failed after retry: ${settled.error ?? "unknown"}`);
    }
  }

  // The snapshot builds[] fragment for one process (display order = fan-out
  // order). Empty for a UPID that never fanned out.
  builds(upid: string): ProcessBuildSnapshot[] {
    const state = this.#processes.get(upid);
    if (state === undefined) {
      return [];
    }
    return state.order.map((id) => {
      const build = state.builds.get(id)!;
      const base = state.server === null || build.entrypoint === null ? null : this.#backendBaseUrl(state, id);
      return {
        backend: build.backend,
        label: build.label,
        status: build.status,
        previewUrl: base === null ? null : `${base}?v=${state.nonce}.${build.version}`,
        summary: build.summary,
        slideshowUrl: base !== null && build.hasSlideshow ? `${base}slideshow/?v=${state.nonce}.${build.version}` : null,
        ...(build.progressLabel === undefined ? {} : { progressLabel: build.progressLabel }),
        ...(build.percent === undefined ? {} : { percent: build.percent }),
        ...(build.error === undefined ? {} : { error: build.error }),
        ...(build.phase === undefined ? {} : { phase: build.phase }),
        ...(build.screens === undefined || build.screens.length === 0 || base === null
          ? {}
          : {
              screens: build.screens.map((screen) => ({
                title: screen.title,
                url: screenPreviewUrl(base, state.nonce, build.version, screen.path),
              })),
            }),
        ...(build.revisions.length === 0 ? {} : { revisions: [...build.revisions] }),
      };
    });
  }

  // Spoken/structured steering: normalize the input to a Revision, abort any
  // in-flight ENRICHMENT (freshest human intent wins), then re-run every
  // backend whose build is ready with the revision, concurrently, rewriting
  // each app in place. Version bumps on success so the previewUrl cache-busts.
  // A FAILED lane has nothing coherent to rewrite — steering revives it with a
  // fresh fan-out run instead of leaving it dead for the rest of the kickoff.
  // Resolves when the re-runs settle.
  async steer(upid: string, input: string | OrchestratorRevisionInput): Promise<void> {
    const state = this.#processes.get(upid);
    if (state === undefined || state.aborted) {
      return;
    }
    const revision = normalizeRevision(state, input);
    if (revision === null) {
      return;
    }
    const correctionTargets: BuildBackend[] = [];
    const freshTargets: BuildBackend[] = [];
    const supersededRuns: Promise<void>[] = [];
    for (const id of state.order) {
      const build = state.builds.get(id)!;
      const backend = this.#selector.backend(id);
      if (backend === undefined) {
        continue;
      }
      if (build.status === "ready" && build.entrypoint !== null) {
        // RULE: an incoming revision aborts in-flight enrichment stages — the
        // hero already serves, and the human's correction outranks bonus work.
        if (build.run !== undefined && build.run.enriching) {
          build.run.controller.abort();
          supersededRuns.push(build.run.settled);
        }
        recordRevision(build, revision);
        build.status = "building";
        build.progressLabel = "applying correction";
        build.percent = 0;
        correctionTargets.push(backend);
      } else if (build.status === "failed") {
        recordRevision(build, revision);
        build.status = "building";
        build.progressLabel = "restarting mock";
        build.percent = 0;
        build.error = undefined;
        freshTargets.push(backend);
      }
    }
    if (correctionTargets.length === 0 && freshTargets.length === 0) {
      return;
    }
    this.#onUpdate();
    if (supersededRuns.length > 0) {
      // Let the aborted enrichment runs settle (bounded) before the correction
      // rewrites the same files — the backends SIGKILL fast.
      await settleWithin(supersededRuns, this.#abortBudgetMs);
    }
    await Promise.allSettled([
      ...correctionTargets.map((backend) => this.#track(state, this.#runBuild(state, backend, revision))),
      ...freshTargets.map((backend) => this.#track(state, this.#runBuild(state, backend, null))),
    ]);
  }

  // Emergency path for one UPID: abort every in-flight build (backends SIGKILL
  // their subprocesses), stop the preview server, and forget the state — all
  // inside the ~2s budget (a build that ignores its signal is abandoned, not
  // awaited past the budget).
  async abortAll(upid: string): Promise<void> {
    const state = this.#processes.get(upid);
    if (state === undefined) {
      return;
    }
    this.#processes.delete(upid);
    state.aborted = true;
    for (const controller of state.controllers) {
      controller.abort();
    }
    await settleWithin([...state.tasks], this.#abortBudgetMs);
    await state.server?.stop().catch(() => undefined);
    state.server = null;
    this.#onUpdate();
  }

  // Emergency stop: abort every UPID's builds concurrently.
  async abortEverything(): Promise<void> {
    await Promise.all([...this.#processes.keys()].map((upid) => this.abortAll(upid)));
  }

  #backendBaseUrl(state: TrackedProcess, id: BuildBackendId): string | null {
    if (state.server === null) {
      return null;
    }
    return `http://${this.#host}:${state.server.port}/${id}/`;
  }

  async #runBuild(state: TrackedProcess, backend: BuildBackend, revision: BuildRevision | null): Promise<void> {
    const build = state.builds.get(backend.id)!;
    const controller = new AbortController();
    state.controllers.add(controller);
    const outDir = join(state.dir, backend.id);
    let settleRun!: () => void;
    const run: TrackedRun = {
      controller,
      enriching: false,
      settled: new Promise<void>((resolveSettled) => {
        settleRun = resolveSettled;
      }),
    };
    build.run = run;
    // Hook calls are chained so a hero-stage deck generation and the meta-stage
    // re-fire never interleave on the same outDir.
    let hookChain: Promise<void> = Promise.resolve();
    const queueHook = (extra?: { screens?: readonly BuildScreen[]; suggestedQuestions?: readonly string[] }): Promise<void> => {
      hookChain = hookChain.then(() => this.#generateSlideshow(state, backend.id, outDir, controller.signal, extra));
      return this.#track(state, hookChain);
    };
    let heroSeen = false;
    try {
      if (revision === null) {
        // Fresh fan-out: the backend starts from an empty per-backend directory.
        await rm(outDir, { recursive: true, force: true });
        await mkdir(outDir, { recursive: true });
      }
      const result = await backend.build({
        upid: state.input.upid,
        ideaId: state.input.ideaId,
        prompt: state.input.prompt,
        callsign: state.input.callsign,
        ...(state.input.brief === undefined ? {} : { brief: state.input.brief }),
        outDir,
        ...(revision === null ? {} : { correction: revision.text, revision }),
        signal: controller.signal,
        onProgress: (update) => {
          if (state.aborted || controller.signal.aborted) {
            return; // a superseded/aborted run must not clobber the successor's labels
          }
          build.progressLabel = update.label;
          build.percent = update.percent;
          this.#onUpdate();
        },
        onStage: (event) => {
          if (state.aborted || controller.signal.aborted) {
            return;
          }
          if (event.stage === "hero") {
            // READY-RATCHET: the lane goes live the moment the hero lands.
            heroSeen = true;
            run.enriching = true;
            build.status = "ready";
            build.entrypoint = event.entrypoint;
            if (event.summary !== undefined && event.summary.length > 0) {
              build.summary = event.summary;
            }
            build.version += 1;
            build.error = undefined;
            build.phase = "enriching";
            this.#onUpdate();
            void queueHook();
            this.#commitLane(state, backend.id, outDir, `${backend.id}: hero mock`);
          } else if (event.stage === "flows") {
            build.version += 1; // iframe cache-bust: the filled screens serve now
            this.#onUpdate();
            this.#commitLane(state, backend.id, outDir, `${backend.id}: flow screens`);
          } else {
            build.version += 1;
            if (event.screens !== undefined) {
              build.screens = event.screens;
            }
            this.#onUpdate();
            // Re-fire the deck hook with the validated mock.json facts.
            void queueHook({ screens: event.screens, suggestedQuestions: event.suggestedQuestions });
            this.#commitLane(state, backend.id, outDir, `${backend.id}: meta sidecar (mock.json)`);
          }
        },
      });
      if (state.aborted || controller.signal.aborted) {
        // Aborted fan-out, or superseded by a fresher revision — the successor
        // run owns the lane's fields now.
        return;
      }
      if (result.ok) {
        if (heroSeen) {
          // Ladder path: the per-stage events already ratcheted status/version;
          // the resolution only settles the final facts (no extra bump).
          build.status = "ready";
          if (result.summary.length > 0) {
            build.summary = result.summary;
          }
          if (result.entrypoint !== null) {
            build.entrypoint = result.entrypoint;
          }
          if (result.screens !== undefined) {
            build.screens = result.screens;
          }
          build.phase = result.completedStages?.includes("meta") === true ? "complete" : "hero";
          build.error = undefined;
          build.percent = 100;
          this.#onUpdate();
        } else {
          build.status = "ready";
          build.summary = result.summary;
          build.entrypoint = result.entrypoint;
          build.version += 1;
          build.error = undefined;
          build.progressLabel = revision === null ? "mock ready" : "correction applied";
          build.percent = 100;
          if (result.screens !== undefined) {
            build.screens = result.screens;
          }
          if (result.completedStages !== undefined) {
            build.phase = result.completedStages.includes("meta") ? "complete" : "hero";
          }
          this.#onUpdate();
          // Single-shot mock or a landed correction (ladder correction runs
          // fire no stage events, so smithers revisions resolve here too; a
          // ladder FRESH run already committed per stage and takes the
          // heroSeen branch above — no double commit).
          this.#commitLane(
            state,
            backend.id,
            outDir,
            revision === null
              ? `${backend.id}: concept mock`
              : `${backend.id}: revision ${revision.seq} — ${clampMessage(revision.text, 50)}`,
          );
          void queueHook(
            result.screens === undefined && result.suggestedQuestions === undefined
              ? undefined
              : { screens: result.screens, suggestedQuestions: result.suggestedQuestions },
          );
        }
        await hookChain;
      } else if (heroSeen || (revision !== null && build.entrypoint !== null)) {
        // NEVER regress: a hero-ready lane survives enrichment failure, and a
        // failed correction leaves the previous working app in place — the
        // build stays ready (old version serves) instead of going dark.
        build.status = "ready";
        build.error = result.error;
        if (heroSeen) {
          build.phase = "hero";
        } else {
          build.progressLabel = "correction failed";
        }
        build.percent = 100;
      } else {
        build.status = "failed";
        build.error = result.error;
        build.summary = result.summary.length > 0 ? result.summary : build.summary;
        build.progressLabel = "failed";
      }
    } catch (error) {
      if (!state.aborted && !controller.signal.aborted) {
        if (heroSeen || (revision !== null && build.entrypoint !== null)) {
          build.status = "ready";
          if (heroSeen) {
            build.phase = "hero";
            build.progressLabel = "enrichment failed — hero mock stands";
          } else {
            build.progressLabel = "correction failed";
          }
        } else {
          build.status = "failed";
        }
        build.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      state.controllers.delete(controller);
      if (build.run === run) {
        build.run = undefined;
      }
      settleRun();
      this.#onUpdate();
    }
  }

  async #generateSlideshow(
    state: TrackedProcess,
    id: BuildBackendId,
    outDir: string,
    signal: AbortSignal,
    extra?: { screens?: readonly BuildScreen[]; suggestedQuestions?: readonly string[] },
  ): Promise<void> {
    if (this.#slideshow === null || signal.aborted) {
      return;
    }
    const build = state.builds.get(id)!;
    try {
      await this.#slideshow({
        upid: state.input.upid,
        ideaId: state.input.ideaId,
        prompt: state.input.prompt,
        callsign: state.input.callsign,
        ...(state.input.planQuestions === undefined ? {} : { planQuestions: state.input.planQuestions }),
        ...(state.input.brief === undefined ? {} : { brief: state.input.brief }),
        backend: id,
        outDir,
        summary: build.summary ?? "",
        signal,
        ...(extra?.screens === undefined ? {} : { screens: extra.screens }),
        ...(extra?.suggestedQuestions === undefined ? {} : { suggestedQuestions: extra.suggestedQuestions }),
      });
      build.hasSlideshow = true;
    } catch {
      // Slideshow is garnish — never a build failure, never a stall.
    }
  }

  // GIT SUBSTRATE stage commit: snapshot this lane's dir onto its
  // concept/<lane> branch. Guarded on abort (a superseded run must not commit
  // over the successor) and strictly fire-and-forget via #fireTreeGit.
  #commitLane(state: TrackedProcess, id: BuildBackendId, outDir: string, message: string): void {
    if (state.aborted || this.#treeGit === null) {
      return;
    }
    this.#fireTreeGit(() => this.#treeGit?.commitLane(state.input.upid, id, outDir, message));
  }

  // Fire-and-forget even against a throwing injected fake: a git-substrate
  // failure must NEVER fail, block, or slow a build.
  #fireTreeGit(fn: () => void | Promise<void>): void {
    try {
      void Promise.resolve(fn()).catch(() => undefined);
    } catch {
      // Synchronous throw from the hook itself — swallowed by the same contract.
    }
  }

  #track(state: TrackedProcess, task: Promise<void>): Promise<void> {
    state.tasks.add(task);
    return task.finally(() => {
      state.tasks.delete(task);
    });
  }
}

// Legacy snapshot fields (per-process previewUrl/buildStatus) derived from the
// multi-backend builds[]: the first ready build's preview wins; else building
// while anything is in flight; else failed once everything failed. Pure — the
// composition merge point calls this next to the builds[] merge.
export function mergeLegacyBuildState(
  builds: readonly ProcessBuildSnapshot[],
): { status: OrchestratorBuildStatus; previewUrl: string | null } | null {
  if (builds.length === 0) {
    return null;
  }
  const ready = builds.find((build) => build.status === "ready");
  if (ready !== undefined) {
    return { status: "ready", previewUrl: ready.previewUrl };
  }
  if (builds.some((build) => build.status === "building")) {
    return { status: "building", previewUrl: null };
  }
  return { status: "failed", previewUrl: null };
}

// Normalize steer()'s union input to a full Revision. A bare string is a plain
// steer; a structured input keeps its typed intent. `seq` is assigned from the
// per-process monotonic counter when absent (and the counter always advances
// past an explicit seq so later revisions still order after it). Empty text →
// null (nothing to apply).
function normalizeRevision(state: TrackedProcess, input: string | OrchestratorRevisionInput): BuildRevision | null {
  if (typeof input === "string") {
    const text = input.trim();
    if (text.length === 0) {
      return null;
    }
    state.revisionSeq += 1;
    return { kind: "steer", text, seq: state.revisionSeq };
  }
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (text.length === 0) {
    return null;
  }
  const seq =
    typeof input.seq === "number" && Number.isFinite(input.seq) && input.seq > state.revisionSeq
      ? input.seq
      : state.revisionSeq + 1;
  state.revisionSeq = seq;
  const targetScreens = (input.targetScreens ?? [])
    .filter((screen): screen is string => typeof screen === "string" && screen.trim().length > 0)
    .map((screen) => screen.trim());
  return {
    kind: input.kind === "answer" ? "answer" : "steer",
    text,
    ...(typeof input.questionId === "string" && input.questionId.length > 0 ? { questionId: input.questionId } : {}),
    ...(typeof input.answer === "string" && input.answer.length > 0 ? { answer: input.answer } : {}),
    ...(targetScreens.length > 0 ? { targetScreens } : {}),
    seq,
  };
}

// One-line clamp for git-substrate commit messages (whitespace collapsed so a
// spoken multi-line correction never breaks the -m subject).
function clampMessage(text: string, max: number): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length <= max ? line : line.slice(0, max);
}

function recordRevision(build: TrackedBuild, revision: BuildRevision): void {
  build.revisions.push(revision);
  if (build.revisions.length > REVISION_HISTORY_CAP) {
    build.revisions.splice(0, build.revisions.length - REVISION_HISTORY_CAP);
  }
}

// A screen's directly-openable URL: hash routes ride the entrypoint URL's
// fragment; file screens get their own path (both keep the cache-bust query).
function screenPreviewUrl(base: string, nonce: string, version: number, path: string): string {
  return path.startsWith("#") ? `${base}?v=${nonce}.${version}${path}` : `${base}${path}?v=${nonce}.${version}`;
}

async function settleWithin(tasks: readonly Promise<unknown>[], budgetMs: number): Promise<void> {
  if (tasks.length === 0) {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(tasks),
      new Promise<void>((resolveTimeout) => {
        timer = setTimeout(resolveTimeout, budgetMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function safeSegment(upid: string): string {
  const cleaned = upid.replace(/[^a-zA-Z0-9_-]/gu, "-");
  return cleaned.length > 0 ? cleaned : "build";
}
