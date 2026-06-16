import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const processLifecycleStates = ["planning", "active", "paused", "dead"] as const;
export type ProcessLifecycleState = (typeof processLifecycleStates)[number];

export interface ProcessSnapshot {
  upid: string;
  runId: string;
  state: ProcessLifecycleState;
  checkpointSeq: number;
  context: Record<string, unknown>;
  updatedAtMs: number;
}

export interface ContextArchiveRecord {
  upid: string;
  runId: string;
  archivedAtMs: number;
  snapshot: ProcessSnapshot;
}

export interface CheckpointStore {
  save(snapshot: ProcessSnapshot): Promise<void>;
  load(upid: string): Promise<ProcessSnapshot | null>;
}

export interface ContextArchiveStore {
  archive(record: ContextArchiveRecord): Promise<void>;
  load(upid: string): Promise<ContextArchiveRecord | null>;
}

export class MemoryCheckpointStore implements CheckpointStore {
  readonly snapshots = new Map<string, ProcessSnapshot>();

  async save(snapshot: ProcessSnapshot): Promise<void> {
    this.snapshots.set(snapshot.upid, cloneSnapshot(snapshot));
  }

  async load(upid: string): Promise<ProcessSnapshot | null> {
    const snapshot = this.snapshots.get(upid);
    return snapshot === undefined ? null : cloneSnapshot(snapshot);
  }
}

export class MemoryContextArchiveStore implements ContextArchiveStore {
  readonly records = new Map<string, ContextArchiveRecord>();

  async archive(record: ContextArchiveRecord): Promise<void> {
    this.records.set(record.upid, {
      ...record,
      snapshot: cloneSnapshot(record.snapshot),
    });
  }

  async load(upid: string): Promise<ContextArchiveRecord | null> {
    const record = this.records.get(upid);
    return record === undefined
      ? null
      : { ...record, snapshot: cloneSnapshot(record.snapshot) };
  }
}

export class FileCheckpointStore implements CheckpointStore {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async save(snapshot: ProcessSnapshot): Promise<void> {
    const existing = await this.loadAll();
    existing[snapshot.upid] = cloneSnapshot(snapshot);
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify({ version: 1, snapshots: existing }, null, 2) + "\n");
  }

  async load(upid: string): Promise<ProcessSnapshot | null> {
    const existing = await this.loadAll();
    const snapshot = existing[upid];
    return snapshot === undefined ? null : cloneSnapshot(snapshot);
  }

  private async loadAll(): Promise<Record<string, ProcessSnapshot>> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as { snapshots?: Record<string, ProcessSnapshot> };
      return parsed.snapshots ?? {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      throw error;
    }
  }
}

export interface ProcessLifecycleOptions {
  upid: string;
  runId: string;
  state?: ProcessLifecycleState;
  context?: Record<string, unknown>;
  checkpointSeq?: number;
  now?: () => number;
  checkpoints?: CheckpointStore;
  archive?: ContextArchiveStore;
}

export class ProcessLifecycle {
  readonly upid: string;
  readonly runId: string;
  readonly now: () => number;
  readonly checkpoints: CheckpointStore;
  readonly archiveStore: ContextArchiveStore;
  #state: ProcessLifecycleState;
  #context: Record<string, unknown>;
  #checkpointSeq: number;
  #updatedAtMs: number;

  constructor(options: ProcessLifecycleOptions) {
    this.upid = options.upid;
    this.runId = options.runId;
    this.now = options.now ?? (() => Date.now());
    this.checkpoints = options.checkpoints ?? new MemoryCheckpointStore();
    this.archiveStore = options.archive ?? new MemoryContextArchiveStore();
    this.#state = options.state ?? "planning";
    this.#context = cloneContext(options.context ?? {});
    this.#checkpointSeq = options.checkpointSeq ?? 0;
    this.#updatedAtMs = this.now();
  }

  snapshot(): ProcessSnapshot {
    return {
      upid: this.upid,
      runId: this.runId,
      state: this.#state,
      checkpointSeq: this.#checkpointSeq,
      context: cloneContext(this.#context),
      updatedAtMs: this.#updatedAtMs,
    };
  }

  async activate(contextPatch: Record<string, unknown> = {}): Promise<ProcessSnapshot> {
    this.assertEdge("active", ["planning", "paused"]);
    return this.transition("active", contextPatch);
  }

  async pause(contextPatch: Record<string, unknown> = {}): Promise<ProcessSnapshot> {
    this.assertEdge("paused", ["active"]);
    return this.transition("paused", contextPatch);
  }

  async resume(contextPatch: Record<string, unknown> = {}): Promise<ProcessSnapshot> {
    this.assertEdge("active", ["paused"]);
    return this.transition("active", contextPatch);
  }

  async checkpoint(contextPatch: Record<string, unknown> = {}): Promise<ProcessSnapshot> {
    this.#context = { ...this.#context, ...cloneContext(contextPatch) };
    this.#checkpointSeq += 1;
    this.#updatedAtMs = this.now();
    const snapshot = this.snapshot();
    if (process.env.PANOP_RBG_DISABLE_CHECKPOINTING !== "1") {
      await this.checkpoints.save(snapshot);
    }
    return snapshot;
  }

  async archiveBeforeKill(): Promise<ContextArchiveRecord> {
    const snapshot = this.snapshot();
    const record = {
      upid: this.upid,
      runId: this.runId,
      archivedAtMs: this.now(),
      snapshot,
    };
    if (process.env.PANOP_RBG_SKIP_PREKILL_ARCHIVE !== "1") {
      await this.archiveStore.archive(record);
    }
    return record;
  }

  async kill(contextPatch: Record<string, unknown> = {}): Promise<ProcessSnapshot> {
    this.assertEdge("dead", ["planning", "active", "paused"]);
    await this.archiveBeforeKill();
    return this.transition("dead", contextPatch, { saveCheckpoint: false });
  }

  async recover(): Promise<ProcessSnapshot> {
    const snapshot = await this.checkpoints.load(this.upid);
    if (snapshot === null) {
      throw new Error(`No durable checkpoint exists for ${this.upid}.`);
    }
    this.#state = snapshot.state;
    this.#context = cloneContext(snapshot.context);
    this.#checkpointSeq = snapshot.checkpointSeq;
    this.#updatedAtMs = snapshot.updatedAtMs;
    return this.snapshot();
  }

  private async transition(
    state: ProcessLifecycleState,
    contextPatch: Record<string, unknown>,
    options: { saveCheckpoint?: boolean } = {},
  ): Promise<ProcessSnapshot> {
    this.#state = state;
    this.#context = { ...this.#context, ...cloneContext(contextPatch) };
    this.#updatedAtMs = this.now();
    const snapshot = this.snapshot();
    if (options.saveCheckpoint !== false && process.env.PANOP_RBG_DISABLE_CHECKPOINTING !== "1") {
      await this.checkpoints.save(snapshot);
    }
    return snapshot;
  }

  private assertEdge(next: ProcessLifecycleState, allowedFrom: readonly ProcessLifecycleState[]): void {
    if (!allowedFrom.includes(this.#state)) {
      throw new Error(`Invalid process lifecycle edge ${this.#state} -> ${next}.`);
    }
  }
}

export function cloneSnapshot(snapshot: ProcessSnapshot): ProcessSnapshot {
  return {
    ...snapshot,
    context: cloneContext(snapshot.context),
  };
}

function cloneContext(context: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(context)) as Record<string, unknown>;
}
