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

import { existsSync } from "node:fs";
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
}

export const EXECUTION_ENTRYPOINT = "index.html";
const DEFAULT_HOST = "127.0.0.1";

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
}

export class ExecutionRegistry {
  readonly #artifactsRoot: string;
  readonly #host: string;
  readonly #serve: (dir: string, host?: string) => Promise<PreviewServer>;
  readonly #now: () => number;
  readonly #onUpdate: () => void;
  readonly #lanes = new Map<string, ExecutionLane>();

  constructor(options: ExecutionRegistryOptions = {}) {
    this.#artifactsRoot = options.artifactsRoot ?? resolve(process.cwd(), "artifacts", "vibersyn-runs");
    this.#host = options.host ?? DEFAULT_HOST;
    this.#serve = options.serve ?? servePreviewDirectory;
    this.#now = options.now ?? (() => Date.now());
    this.#onUpdate = options.onUpdate ?? (() => undefined);
  }

  // The artifacts directory the durable run writes for one UPID.
  artifactsDir(upid: string): string {
    return join(this.#artifactsRoot, safeSegment(upid));
  }

  // Open the lane at commission time: the durable run has been launched.
  start(upid: string, runId: string): ExecutionSnapshot {
    const lane: ExecutionLane = {
      status: "executing",
      runId,
      percent: 0,
      label: "commissioned",
      server: this.#lanes.get(upid)?.server ?? null,
      version: this.#lanes.get(upid)?.version ?? 0,
      startedAtMs: this.#now(),
      error: null,
      completing: false,
    };
    this.#lanes.set(upid, lane);
    this.#onUpdate();
    return this.snapshot(upid)!;
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
          ? `http://${this.#host}:${lane.server.port}/?v=${lane.version}`
          : null,
      startedAtMs: lane.startedAtMs,
      error: lane.error,
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
