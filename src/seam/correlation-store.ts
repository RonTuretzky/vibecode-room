import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const correlationRecordSchema = z
  .object({
    upid: z.string().min(1),
    runId: z.string().min(1),
    steeringWindowId: z.string().min(1).nullable(),
    callsign: z.string().min(1).nullable(),
    correlationId: z.string().min(1),
    parentId: z.string().min(1).nullable(),
    lastSeq: z.number().int().nonnegative(),
    state: z.enum(["planning", "active", "paused", "halting", "halted", "completed", "unknown"]),
    updatedAtMs: z.number().finite(),
  })
  .strict();

const correlationSnapshotSchema = z
  .object({
    version: z.literal(1),
    records: z.array(correlationRecordSchema),
  })
  .strict();

export type ProcessState = z.infer<typeof correlationRecordSchema>["state"];

export type CorrelationRecord = z.infer<typeof correlationRecordSchema>;

export interface CorrelationStore {
  load(): Promise<CorrelationRecord[]>;
  upsert(record: CorrelationRecord): Promise<void>;
  findByUPID(upid: string): Promise<CorrelationRecord | undefined>;
  findByRunId(runId: string): Promise<CorrelationRecord | undefined>;
  update(upid: string, patch: Partial<Omit<CorrelationRecord, "upid">>): Promise<CorrelationRecord>;
  allActive(): Promise<CorrelationRecord[]>;
}

export class MemoryCorrelationStore implements CorrelationStore {
  protected records = new Map<string, CorrelationRecord>();

  constructor(initialRecords: readonly CorrelationRecord[] = []) {
    for (const record of initialRecords) {
      this.records.set(record.upid, correlationRecordSchema.parse(record));
    }
  }

  async load(): Promise<CorrelationRecord[]> {
    return [...this.records.values()].map((record) => ({ ...record }));
  }

  async upsert(record: CorrelationRecord): Promise<void> {
    this.records.set(record.upid, correlationRecordSchema.parse(record));
  }

  async findByUPID(upid: string): Promise<CorrelationRecord | undefined> {
    const record = this.records.get(upid);
    return record === undefined ? undefined : { ...record };
  }

  async findByRunId(runId: string): Promise<CorrelationRecord | undefined> {
    const record = [...this.records.values()].find((entry) => entry.runId === runId);
    return record === undefined ? undefined : { ...record };
  }

  async update(upid: string, patch: Partial<Omit<CorrelationRecord, "upid">>): Promise<CorrelationRecord> {
    const current = this.records.get(upid);
    if (current === undefined) {
      throw new Error(`No UPID correlation exists for ${upid}.`);
    }
    const next = correlationRecordSchema.parse({ ...current, ...patch, upid });
    this.records.set(upid, next);
    return { ...next };
  }

  async allActive(): Promise<CorrelationRecord[]> {
    return [...this.records.values()]
      .filter((record) => !["halted", "completed"].includes(record.state))
      .map((record) => ({ ...record }));
  }
}

export class FileCorrelationStore extends MemoryCorrelationStore {
  readonly path: string;
  #loaded = false;

  constructor(path: string) {
    super();
    this.path = path;
  }

  override async load(): Promise<CorrelationRecord[]> {
    await this.ensureLoaded();
    return super.load();
  }

  override async upsert(record: CorrelationRecord): Promise<void> {
    await this.ensureLoaded();
    await super.upsert(record);
    await this.persist();
  }

  override async findByUPID(upid: string): Promise<CorrelationRecord | undefined> {
    await this.ensureLoaded();
    return super.findByUPID(upid);
  }

  override async findByRunId(runId: string): Promise<CorrelationRecord | undefined> {
    await this.ensureLoaded();
    return super.findByRunId(runId);
  }

  override async update(upid: string, patch: Partial<Omit<CorrelationRecord, "upid">>): Promise<CorrelationRecord> {
    await this.ensureLoaded();
    const next = await super.update(upid, patch);
    await this.persist();
    return next;
  }

  override async allActive(): Promise<CorrelationRecord[]> {
    await this.ensureLoaded();
    return super.allActive();
  }

  private async ensureLoaded(): Promise<void> {
    if (this.#loaded) {
      return;
    }

    try {
      const raw = await readFile(this.path, "utf8");
      const snapshot = correlationSnapshotSchema.parse(JSON.parse(raw));
      this.records.clear();
      for (const record of snapshot.records) {
        this.records.set(record.upid, record);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    this.#loaded = true;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const records = await super.load();
    await writeFile(this.path, JSON.stringify({ version: 1, records }, null, 2) + "\n");
  }
}

export function createCorrelationRecord(input: {
  upid: string;
  runId: string;
  steeringWindowId?: string | null;
  callsign?: string | null;
  correlationId: string;
  parentId?: string | null;
  state?: ProcessState;
  lastSeq?: number;
  nowMs?: number;
}): CorrelationRecord {
  return correlationRecordSchema.parse({
    upid: input.upid,
    runId: input.runId,
    steeringWindowId: input.steeringWindowId ?? null,
    callsign: input.callsign ?? null,
    correlationId: input.correlationId,
    parentId: input.parentId ?? null,
    state: input.state ?? "planning",
    lastSeq: input.lastSeq ?? 0,
    updatedAtMs: input.nowMs ?? Date.now(),
  });
}
