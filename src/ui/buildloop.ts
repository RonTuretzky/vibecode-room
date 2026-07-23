import type { ProcessBuildStatus, ProjectorProcess, ProjectorProcessState, ProjectorSnapshot } from "./types";

/**
 * Build-loop seam for the wall UI: the multi-backend build fan-out.
 *
 * The server contract (src/buildloop/types.ts) fans one accepted idea out to
 * several build backends; each snapshot process entry GAINS `builds[]` and the
 * snapshot GAINS a top-level `backends[]`. This module is the wall-side seam:
 * local mirrors of those shapes plus tolerant extractors, so the wall renders
 * the new surfaces when a build-loop server publishes them and degrades to
 * NOTHING — never a white screen — against an old server or a malformed frame.
 */

// Mirror of the server contract's BuildBackendId. A deliberate copy (not an
// import) so the browser bundle never reaches into server code; ids outside the
// union still normalize through (cast at the seam) and render as plain chips.
export type BuildBackendId = "smithers" | "eliza" | "native";

// One backend's build of a process (contract: process.builds[] entry).
export interface ProcessBuild {
  backend: BuildBackendId;
  label: string;
  status: ProcessBuildStatus;
  previewUrl: string | null;
  summary: string | null;
  slideshowUrl: string | null;
  progressLabel?: string;
  percent?: number;
}

// One toggleable backend chip (contract: snapshot.backends[] entry).
export interface BackendChip {
  id: BuildBackendId;
  label: string;
  enabled: boolean;
  available: boolean;
  reason?: string;
}

// The process/snapshot as a build-loop server publishes them. types.ts stays
// untouched (it is the projector contract, owned elsewhere); the widening for
// the new optional fields lives here instead.
export type BuildloopProcess = ProjectorProcess & { builds?: ProcessBuild[] };
export type BuildloopSnapshot = ProjectorSnapshot & { backends?: BackendChip[] };

// Per-card lifecycle verbs -> POST /api/process/:upid/{pause|resume|halt}.
export type LifecycleAction = "pause" | "resume" | "halt";

const BUILD_STATUSES: ReadonlySet<string> = new Set(["building", "ready", "failed"]);

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// Normalize ONE raw builds[] entry. Requires a backend id + known status (a chip
// without those is unreadable); everything else is optional and defaulted so a
// partial frame mid-build still renders.
function normalizeBuild(value: unknown): ProcessBuild | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const backend = asNonEmptyString(record.backend);
  const status = record.status;
  if (backend === null || typeof status !== "string" || !BUILD_STATUSES.has(status)) {
    return null;
  }
  return {
    backend: backend as BuildBackendId,
    label: asNonEmptyString(record.label) ?? backend,
    status: status as ProcessBuildStatus,
    previewUrl: asNonEmptyString(record.previewUrl),
    summary: asNonEmptyString(record.summary),
    slideshowUrl: asNonEmptyString(record.slideshowUrl),
    progressLabel: asNonEmptyString(record.progressLabel) ?? undefined,
    percent:
      typeof record.percent === "number" && Number.isFinite(record.percent)
        ? clampPercent(record.percent)
        : undefined,
  };
}

// The per-backend builds of a process. [] for old servers / malformed frames.
export function buildsOf(process: ProjectorProcess): ProcessBuild[] {
  const raw = (process as BuildloopProcess).builds as unknown;
  if (!Array.isArray(raw)) {
    return [];
  }
  const builds: ProcessBuild[] = [];
  for (const entry of raw) {
    const build = normalizeBuild(entry);
    if (build !== null) {
      builds.push(build);
    }
  }
  return builds;
}

function normalizeBackend(value: unknown): BackendChip | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = asNonEmptyString(record.id);
  if (id === null) {
    return null;
  }
  return {
    id: id as BuildBackendId,
    label: asNonEmptyString(record.label) ?? id,
    enabled: record.enabled === true,
    available: record.available === true,
    reason: asNonEmptyString(record.reason) ?? undefined,
  };
}

// The toggleable backend roster. [] for old servers / malformed frames.
export function backendsOf(snapshot: ProjectorSnapshot): BackendChip[] {
  const raw = (snapshot as BuildloopSnapshot).backends as unknown;
  if (!Array.isArray(raw)) {
    return [];
  }
  const backends: BackendChip[] = [];
  for (const entry of raw) {
    const backend = normalizeBackend(entry);
    if (backend !== null) {
      backends.push(backend);
    }
  }
  return backends;
}

// Response guard for the NEW control POSTs (/api/backends, /api/process/:upid/*):
// only a body that is recognizably a full projector snapshot is applied, so a
// thin {"ok":true} acknowledgment (or an error object) can never wipe the wall.
export function looksLikeSnapshot(value: unknown): value is ProjectorSnapshot {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.sessionId === "string" &&
    Array.isArray(record.processes) &&
    typeof record.suggestion === "object" &&
    record.suggestion !== null
  );
}

// Which lifecycle buttons a card in `state` offers. Terminal states offer none.
export function lifecycleActionsFor(state: ProjectorProcessState): LifecycleAction[] {
  switch (state) {
    case "active":
    case "planning":
      return ["pause", "halt"];
    case "paused":
    case "blocked":
      return ["resume", "halt"];
    case "halted":
    case "completed":
      return [];
  }
}
