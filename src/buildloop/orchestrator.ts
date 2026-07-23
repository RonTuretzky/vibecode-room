// Multi-backend build orchestrator: for one accepted idea, fan build() out to
// every enabled+available backend CONCURRENTLY, each into its own
// builds/<upid>/<backendId>/ subdirectory, all served off ONE per-UPID preview
// server (idea-builder's servePreviewDirectory — no-cache headers, per-backend
// subdir index resolution) so every backend gets its own previewUrl.
//
// Per-(upid,backend) status/progress is tracked live and exposed as the
// snapshot builds[] fragment the wall consumes. steer(upid, text) re-runs every
// backend that has a ready build with the spoken correction (concurrent,
// rewritten in place) and bumps a per-build version so the previewUrl changes
// (?v=N) and the wall's iframe cache-busts. abortAll(upid)/abortEverything()
// abort every in-flight build via its AbortSignal (backends SIGKILL their
// subprocesses) inside the ~2s emergency-stop budget.

import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { servePreviewDirectory, type PreviewServer } from "../server/idea-builder";
import type { BackendSelector } from "./selector";
import type { BuildBackend, BuildBackendId } from "./types";

export type OrchestratorBuildStatus = "building" | "ready" | "failed";

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
}

export interface OrchestratorStartInput {
  upid: string;
  ideaId: string;
  prompt: string;
  callsign: string | null;
}

// Optional per-build slideshow hook (the slideshow track's generateSlideshow,
// wired by the integrator). Called after a successful build/correction; a
// resolved hook flips the build's slideshowUrl on (previewUrl + "slideshow/").
// Failures are swallowed — the slideshow is garnish, never a build failure.
export type SlideshowHook = (input: {
  upid: string;
  ideaId: string;
  prompt: string;
  callsign: string | null;
  backend: BuildBackendId;
  outDir: string;
  summary: string;
  signal: AbortSignal;
}) => Promise<void>;

export interface BuildOrchestratorOptions {
  selector: BackendSelector;
  // Root the per-UPID build directories live under. Defaults to <cwd>/builds.
  buildsRoot?: string;
  // Hostname the per-UPID preview server binds to. Always loopback in practice.
  host?: string;
  // Preview-server seam (tests inject; default is the real idea-builder server).
  serve?: (dir: string, host?: string) => Promise<PreviewServer>;
  slideshow?: SlideshowHook | null;
  // Republish hook: fired on every status/progress transition so the runtime
  // can push a fresh snapshot.
  onUpdate?: () => void;
  // Hard ceiling abortAll waits for aborted builds to settle. Default 2s.
  abortBudgetMs?: number;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_ABORT_BUDGET_MS = 2_000;

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
  // Bumped on every successful build/correction; previewUrl carries ?v=<version>
  // so the wall's iframe cache-busts on steer.
  version: number;
  error?: string;
}

interface TrackedProcess {
  input: OrchestratorStartInput;
  dir: string;
  server: PreviewServer | null;
  order: BuildBackendId[];
  builds: Map<BuildBackendId, TrackedBuild>;
  controllers: Set<AbortController>;
  tasks: Set<Promise<unknown>>;
  aborted: boolean;
}

export class BuildOrchestrator {
  readonly #selector: BackendSelector;
  readonly #buildsRoot: string;
  readonly #host: string;
  readonly #serve: (dir: string, host?: string) => Promise<PreviewServer>;
  readonly #slideshow: SlideshowHook | null;
  readonly #onUpdate: () => void;
  readonly #abortBudgetMs: number;
  readonly #processes = new Map<string, TrackedProcess>();

  constructor(options: BuildOrchestratorOptions) {
    this.#selector = options.selector;
    this.#buildsRoot = options.buildsRoot ?? resolve(process.cwd(), "builds");
    this.#host = options.host ?? DEFAULT_HOST;
    this.#serve = options.serve ?? servePreviewDirectory;
    this.#slideshow = options.slideshow ?? null;
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
      dir: join(this.#buildsRoot, safeSegment(input.upid)),
      server: null,
      order: [],
      builds: new Map(),
      controllers: new Set(),
      tasks: new Set(),
      aborted: false,
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
      });
    }
    this.#onUpdate();
    await Promise.allSettled(targets.map((backend) => this.#track(state, this.#runBuild(state, backend, null))));
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
        previewUrl: base === null ? null : `${base}?v=${build.version}`,
        summary: build.summary,
        slideshowUrl: base !== null && build.hasSlideshow ? `${base}slideshow/?v=${build.version}` : null,
        ...(build.progressLabel === undefined ? {} : { progressLabel: build.progressLabel }),
        ...(build.percent === undefined ? {} : { percent: build.percent }),
      };
    });
  }

  // Spoken steering: re-run every backend whose build is ready with the
  // correction, concurrently, rewriting each app in place. Version bumps on
  // success so the previewUrl cache-busts. Resolves when corrections settle.
  async steer(upid: string, text: string): Promise<void> {
    const state = this.#processes.get(upid);
    const correction = text.trim();
    if (state === undefined || state.aborted || correction.length === 0) {
      return;
    }
    const targets: BuildBackend[] = [];
    for (const id of state.order) {
      const build = state.builds.get(id)!;
      const backend = this.#selector.backend(id);
      // Only builds that are READY take a correction — a still-building or
      // failed backend has nothing coherent to rewrite in place.
      if (backend !== undefined && build.status === "ready" && build.entrypoint !== null) {
        build.status = "building";
        build.progressLabel = "applying correction";
        build.percent = 0;
        targets.push(backend);
      }
    }
    if (targets.length === 0) {
      return;
    }
    this.#onUpdate();
    await Promise.allSettled(targets.map((backend) => this.#track(state, this.#runBuild(state, backend, correction))));
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

  async #runBuild(state: TrackedProcess, backend: BuildBackend, correction: string | null): Promise<void> {
    const build = state.builds.get(backend.id)!;
    const controller = new AbortController();
    state.controllers.add(controller);
    const outDir = join(state.dir, backend.id);
    try {
      if (correction === null) {
        // Fresh fan-out: the backend starts from an empty per-backend directory.
        await rm(outDir, { recursive: true, force: true });
        await mkdir(outDir, { recursive: true });
      }
      const result = await backend.build({
        upid: state.input.upid,
        ideaId: state.input.ideaId,
        prompt: state.input.prompt,
        callsign: state.input.callsign,
        outDir,
        ...(correction === null ? {} : { correction }),
        signal: controller.signal,
        onProgress: (update) => {
          build.progressLabel = update.label;
          build.percent = update.percent;
          this.#onUpdate();
        },
      });
      if (state.aborted) {
        return;
      }
      if (result.ok) {
        build.status = "ready";
        build.summary = result.summary;
        build.entrypoint = result.entrypoint;
        build.version += 1;
        build.error = undefined;
        build.progressLabel = correction === null ? "ready" : "correction applied";
        build.percent = 100;
        this.#onUpdate();
        await this.#generateSlideshow(state, backend.id, outDir, controller.signal);
      } else if (correction !== null && build.entrypoint !== null) {
        // A failed correction leaves the previous working app in place — the
        // build stays ready (old version serves) instead of going dark.
        build.status = "ready";
        build.error = result.error;
        build.progressLabel = "correction failed";
        build.percent = 100;
      } else {
        build.status = "failed";
        build.error = result.error;
        build.summary = result.summary.length > 0 ? result.summary : build.summary;
        build.progressLabel = "failed";
      }
    } catch (error) {
      if (!state.aborted) {
        if (correction !== null && build.entrypoint !== null) {
          build.status = "ready";
          build.progressLabel = "correction failed";
        } else {
          build.status = "failed";
        }
        build.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      state.controllers.delete(controller);
      this.#onUpdate();
    }
  }

  async #generateSlideshow(state: TrackedProcess, id: BuildBackendId, outDir: string, signal: AbortSignal): Promise<void> {
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
        backend: id,
        outDir,
        summary: build.summary ?? "",
        signal,
      });
      build.hasSlideshow = true;
    } catch {
      // Slideshow is garnish — never a build failure, never a stall.
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
