// EXECUTION lane for the commissioned full build (the second stage of the
// two-stage pivot: kickoff = fast Cerebras concept MOCKS, commission = the
// durable subscription run). When the room explicitly commissions a process
// (POST /api/process/:upid/execute → ProcessRegistry.execute), the durable
// `vibersyn-process` gateway run builds the REAL app on the claude
// subscription into artifacts/vibersyn-runs/<upid>/ (see
// .smithers/workflows/vibersyn-process.tsx — that workflow writes ONLY there).
//
// This registry tracks the per-UPID execution lane the snapshot exposes:
//   executing  — the durable run was launched; percent/label fold in from the
//                live gateway run events (RunEventDriver overlay).
//   built      — the run completed AND artifacts/vibersyn-runs/<upid>/ holds an
//                index.html; the directory is served through the same preview
//                server seam the mock lanes use, and previewUrl points at it.
//   failed     — the run completed with no usable artifacts (or the launch
//                failed after the lane opened).
//
// NO Cerebras anywhere on this path — the commission stage runs entirely on
// the claude subscription via the gateway workflow. Abort semantics mirror the
// mock orchestrator: stop(upid) tears the preview server down and forgets the
// lane (registry.halt / emergency stop call it), so a halted commission never
// leaves a reachable preview up.

import { existsSync, readdirSync } from "node:fs";
import { archiveArtifacts } from "./artifact-history";
import { join, resolve } from "node:path";
import { servePreviewDirectory, type PreviewServer } from "../server/idea-builder";

export type ExecutionStatus = "executing" | "built" | "failed";

// The snapshot fragment the wall consumes as the process's `execution` lane.
export interface ExecutionSnapshot {
  status: ExecutionStatus;
  runId: string;
  // 0-100; from live run events while executing, 100 once built.
  percent: number;
  // Human progress line: "commissioned" at launch, then the latest run-event
  // output line, then "built"/the failure reason.
  label: string;
  // The full-app preview served from artifacts/vibersyn-runs/<upid>/ once the
  // run's artifacts land; null while executing or after a failure.
  previewUrl: string | null;
  startedAtMs: number;
  error: string | null;
  // WORKING-TREE FOOTPRINT (the honest-indicator pattern): the number of real
  // files currently on disk under artifacts/vibersyn-runs/<upid>/, probed on
  // an interval while the lane executes. This is progress derived from what
  // the run has ACTUALLY written — never a timer invention. null = the probe
  // has not looked yet (or the lane settled before it ran).
  filesWritten: number | null;
}

export const EXECUTION_ENTRYPOINT = "index.html";
const DEFAULT_HOST = "127.0.0.1";
// Footprint probe cadence: how often an executing lane counts the real files
// its durable run has written so far. Cheap (one recursive readdir of a small
// artifacts dir), and only while status === "executing".
const DEFAULT_FOOTPRINT_POLL_MS = 1_500;

export interface ExecutionRegistryOptions {
  // Root the durable runs write under. Defaults to <cwd>/artifacts/vibersyn-runs
  // (the vibersyn-process workflow's contract-fixed output root).
  artifactsRoot?: string;
  host?: string;
  // Preview-server seam (tests inject; default is the real idea-builder server).
  serve?: (dir: string, host?: string) => Promise<PreviewServer>;
  now?: () => number;
  // Republish hook: fired on every lane transition so the runtime can push a
  // fresh snapshot.
  onUpdate?: () => void;
  // Footprint probe cadence (tests may shrink it); <= 0 disables the probe.
  footprintPollMs?: number;
}

interface ExecutionLane {
  status: ExecutionStatus;
  runId: string;
  percent: number;
  label: string;
  server: PreviewServer | null;
  version: number;
  startedAtMs: number;
  error: string | null;
  // Guards complete() against double entry (a replayed completed frame must not
  // start a second preview server).
  completing: boolean;
  // Latest working-tree footprint (real files under the artifacts dir); null
  // until the first probe runs.
  filesWritten: number | null;
  // The footprint probe interval while executing; cleared on settle/stop.
  probe: ReturnType<typeof setInterval> | null;
}

export class ExecutionRegistry {
  readonly #artifactsRoot: string;
  readonly #host: string;
  readonly #serve: (dir: string, host?: string) => Promise<PreviewServer>;
  readonly #now: () => number;
  readonly #onUpdate: () => void;
  readonly #footprintPollMs: number;
  readonly #lanes = new Map<string, ExecutionLane>();

  constructor(options: ExecutionRegistryOptions = {}) {
    this.#artifactsRoot = options.artifactsRoot ?? resolve(process.cwd(), "artifacts", "vibersyn-runs");
    this.#host = options.host ?? DEFAULT_HOST;
    this.#serve = options.serve ?? servePreviewDirectory;
    this.#now = options.now ?? (() => Date.now());
    this.#onUpdate = options.onUpdate ?? (() => undefined);
    this.#footprintPollMs = options.footprintPollMs ?? DEFAULT_FOOTPRINT_POLL_MS;
  }

  // The artifacts directory the durable run writes for one UPID.
  artifactsDir(upid: string): string {
    return join(this.#artifactsRoot, safeSegment(upid));
  }

  // Called BEFORE the durable run is launched: a fresh commission must not
  // inherit a previous session's artifacts under the same UPID (the artifacts
  // root outlives room restarts, so a stale index.html would make complete()
  // claim "built" with last session's app). A live/settled lane for this UPID
  // owns its artifacts and is left alone — execute() reports already-executing
  // or already-built for those without launching.
  async prepare(upid: string): Promise<void> {
    if (this.#lanes.has(upid)) {
      return;
    }
    await archiveArtifacts(this.artifactsDir(upid));
  }

  // Open the lane at commission time: the durable run has been launched. The
  // footprint probe starts here: while the lane executes, the number of REAL
  // files under artifacts/vibersyn-runs/<upid>/ is re-counted on an interval,
  // so the wall's "progress" includes what the run has actually written.
  start(upid: string, runId: string): ExecutionSnapshot {
    const previous = this.#lanes.get(upid);
    if (previous?.probe != null) {
      clearInterval(previous.probe);
    }
    const lane: ExecutionLane = {
      status: "executing",
      runId,
      percent: 0,
      label: "commissioned",
      server: previous?.server ?? null,
      version: previous?.version ?? 0,
      startedAtMs: this.#now(),
      error: null,
      completing: false,
      filesWritten: null,
      probe: null,
    };
    this.#lanes.set(upid, lane);
    this.#startFootprintProbe(upid, lane);
    this.#onUpdate();
    return this.snapshot(upid)!;
  }

  // The working-tree footprint probe: count real files under the artifacts dir
  // while the lane executes; republish only when the count changes. The timer
  // is unref'd so a forgotten lane can never hold the process open.
  #startFootprintProbe(upid: string, lane: ExecutionLane): void {
    if (this.#footprintPollMs <= 0) {
      return;
    }
    const dir = this.artifactsDir(upid);
    const probe = setInterval(() => {
      if (this.#lanes.get(upid) !== lane || lane.status !== "executing") {
        clearInterval(probe);
        return;
      }
      const count = countFiles(dir);
      if (count !== lane.filesWritten) {
        lane.filesWritten = count;
        this.#onUpdate();
      }
    }, this.#footprintPollMs);
    (probe as { unref?: () => void }).unref?.();
    lane.probe = probe;
  }

  // Stop a lane's footprint probe (settle/teardown) and take one FINAL count so
  // the settled snapshot reports the run's true footprint, not a stale one.
  #settleFootprint(lane: ExecutionLane, upid: string): void {
    if (lane.probe !== null) {
      clearInterval(lane.probe);
      lane.probe = null;
    }
    lane.filesWritten = countFiles(this.artifactsDir(upid));
  }

  // Fold live run-event progress into an executing lane (the RunEventDriver
  // overlay feeds this). Ignored once the lane is built/failed/forgotten.
  progress(upid: string, update: { percent?: number; label?: string }): void {
    const lane = this.#lanes.get(upid);
    if (lane === undefined || lane.status !== "executing") {
      return;
    }
    if (typeof update.percent === "number" && Number.isFinite(update.percent)) {
      // The run is not built until its artifacts are served — cap live progress.
      lane.percent = Math.min(99, Math.max(lane.percent, Math.max(0, Math.round(update.percent))));
    }
    if (typeof update.label === "string" && update.label.trim().length > 0) {
      lane.label = update.label.trim();
    }
    this.#onUpdate();
  }

  // The run completed: if its artifacts landed (index.html under
  // artifacts/vibersyn-runs/<upid>/), serve them and flip to built; otherwise
  // the commission failed honestly. Idempotent — a replayed completion frame
  // neither restarts the server nor regresses a settled lane.
  async complete(upid: string): Promise<ExecutionSnapshot | null> {
    const lane = this.#lanes.get(upid);
    if (lane === undefined || lane.status !== "executing" || lane.completing) {
      return this.snapshot(upid);
    }
    lane.completing = true;
    try {
      const dir = this.artifactsDir(upid);
      if (!existsSync(join(dir, EXECUTION_ENTRYPOINT))) {
        lane.status = "failed";
        lane.label = "no artifacts";
        lane.error = `the run completed but left no ${EXECUTION_ENTRYPOINT} under ${dir}`;
        this.#settleFootprint(lane, upid);
        return this.snapshot(upid);
      }
      if (lane.server === null) {
        lane.server = await this.#serve(dir, this.#host);
      }
      // The lane may have been stopped (halt/emergency) while the server came up.
      if (this.#lanes.get(upid) !== lane) {
        await lane.server.stop().catch(() => undefined);
        return null;
      }
      lane.status = "built";
      lane.percent = 100;
      lane.label = "built";
      lane.version += 1;
      lane.error = null;
      this.#settleFootprint(lane, upid);
      return this.snapshot(upid);
    } finally {
      lane.completing = false;
      this.#onUpdate();
    }
  }

  // Mark an executing lane failed (launch error after open, stream failure...).
  fail(upid: string, error: string): void {
    const lane = this.#lanes.get(upid);
    if (lane === undefined || lane.status !== "executing") {
      return;
    }
    lane.status = "failed";
    lane.label = "failed";
    lane.error = error;
    this.#settleFootprint(lane, upid);
    this.#onUpdate();
  }

  isExecuting(upid: string): boolean {
    return this.#lanes.get(upid)?.status === "executing";
  }

  snapshot(upid: string): ExecutionSnapshot | null {
    const lane = this.#lanes.get(upid);
    if (lane === undefined) {
      return null;
    }
    return {
      status: lane.status,
      runId: lane.runId,
      percent: lane.percent,
      label: lane.label,
      previewUrl:
        lane.status === "built" && lane.server !== null
          ? `http://${this.#host}:${lane.server.port}/?v=${lane.runId}.${lane.version}`
          : null,
      startedAtMs: lane.startedAtMs,
      error: lane.error,
      filesWritten: lane.filesWritten,
    };
  }

  // Abort/teardown for one UPID (halt / emergency stop): stop the preview
  // server and forget the lane. The durable run itself is cancelled by the
  // registry through the gateway client — this only owns the local surface.
  async stop(upid: string): Promise<void> {
    const lane = this.#lanes.get(upid);
    if (lane === undefined) {
      return;
    }
    this.#lanes.delete(upid);
    if (lane.probe !== null) {
      clearInterval(lane.probe);
      lane.probe = null;
    }
    await lane.server?.stop().catch(() => undefined);
    lane.server = null;
    this.#onUpdate();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#lanes.keys()].map((upid) => this.stop(upid)));
  }
}

function safeSegment(upid: string): string {
  const cleaned = upid.replace(/[^a-zA-Z0-9_-]/gu, "-");
  return cleaned.length > 0 ? cleaned : "run";
}

// Count the REAL regular files under a directory (recursive, sync — the
// artifacts dirs are small). A directory that does not exist yet counts 0:
// "the run has written nothing" is exactly what the wall should say then.
export function countFiles(dir: string): number {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    let count = 0;
    for (const entry of entries) {
      if (entry.isDirectory()) {
        count += countFiles(join(dir, entry.name));
      } else if (entry.isFile()) {
        count += 1;
      }
    }
    return count;
  } catch {
    return 0;
  }
}
