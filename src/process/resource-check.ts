import type { LogEvent } from "../types";

export const DEFAULT_MAX_CONCURRENT_PROCESSES = 2;
export const DEFAULT_MIN_RUN_SLOTS = 1;
export const DEFAULT_MIN_MEMORY_MB = 256;
export const CAPACITY_REFUSAL_ACK = "At capacity — stop a process first.";
export const HEADROOM_REFUSAL_ACK = "Host headroom low — try again later.";

export type SpawnRefusalReason = "capacity" | "headroom";

export interface HostHeadroom {
  runSlotsAvailable: number;
  memoryAvailableMB: number;
}

export interface ResourceCheckInput {
  activeProcessCount: number;
  correlationId: string;
  sessionId?: string;
  maxConcurrentProcesses?: number;
  minRunSlots?: number;
  minMemoryMB?: number;
  headroom?: HostHeadroom | (() => HostHeadroom | Promise<HostHeadroom>);
  now?: () => number;
}

export type ResourceCheckResult =
  | {
      ok: true;
      headroom: HostHeadroom;
      maxConcurrentProcesses: number;
    }
  | {
      ok: false;
      reason: SpawnRefusalReason;
      spokenAck: string;
      event: LogEvent;
      headroom: HostHeadroom;
      maxConcurrentProcesses: number;
    };

export async function checkPreSpawnResources(input: ResourceCheckInput): Promise<ResourceCheckResult> {
  const maxConcurrentProcesses = input.maxConcurrentProcesses ?? DEFAULT_MAX_CONCURRENT_PROCESSES;
  const minRunSlots = input.minRunSlots ?? envNumber("VIBERSYN_MIN_RUN_SLOTS", DEFAULT_MIN_RUN_SLOTS);
  const minMemoryMB = input.minMemoryMB ?? envNumber("VIBERSYN_MIN_MEMORY_MB", DEFAULT_MIN_MEMORY_MB);
  const headroom = await resolveHeadroom(input.headroom);

  if (
    input.activeProcessCount >= maxConcurrentProcesses &&
    process.env.VIBERSYN_RBG_DISABLE_CAPACITY_CHECK !== "1"
  ) {
    return refused("capacity", CAPACITY_REFUSAL_ACK, input, headroom, maxConcurrentProcesses, {
      activeProcessCount: input.activeProcessCount,
      minRunSlots,
      minMemoryMB,
    });
  }

  const belowHeadroom =
    headroom.runSlotsAvailable < minRunSlots || headroom.memoryAvailableMB < minMemoryMB;
  if (belowHeadroom && process.env.VIBERSYN_RBG_DISABLE_HEADROOM_CHECK !== "1") {
    return refused("headroom", HEADROOM_REFUSAL_ACK, input, headroom, maxConcurrentProcesses, {
      activeProcessCount: input.activeProcessCount,
      minRunSlots,
      minMemoryMB,
    });
  }

  return { ok: true, headroom, maxConcurrentProcesses };
}

function refused(
  reason: SpawnRefusalReason,
  spokenAck: string,
  input: ResourceCheckInput,
  headroom: HostHeadroom,
  maxConcurrentProcesses: number,
  meta: Record<string, unknown>,
): Extract<ResourceCheckResult, { ok: false }> {
  return {
    ok: false,
    reason,
    spokenAck,
    headroom,
    maxConcurrentProcesses,
    event: {
      level: "warn",
      event: "spawn.refused",
      sessionId: input.sessionId ?? "vibersyn-process",
      correlationId: input.correlationId,
      latencyMs: 0,
      meta: {
        reason,
        spokenAck,
        // Default headroom is Infinity (no probe wired). Infinity is not JSON —
        // the trace recorder rejects it, which turned this graceful refusal into
        // a hard suggestion.accept.error that lost the idea AND the spoken ack.
        // null in the trace means "unbounded/unprobed".
        runSlotsAvailable: jsonSafeNumber(headroom.runSlotsAvailable),
        memoryAvailableMB: jsonSafeNumber(headroom.memoryAvailableMB),
        maxConcurrentProcesses,
        ...meta,
      },
    },
  };
}

async function resolveHeadroom(
  source: ResourceCheckInput["headroom"],
): Promise<HostHeadroom> {
  if (typeof source === "function") {
    return source();
  }
  return source ?? { runSlotsAvailable: Number.POSITIVE_INFINITY, memoryAvailableMB: Number.POSITIVE_INFINITY };
}

function jsonSafeNumber(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}
