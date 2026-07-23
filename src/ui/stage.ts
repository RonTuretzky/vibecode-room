import type { ProjectorProcess } from "./types";

/**
 * Two-stage kickoff/commission seam for the wall UI.
 *
 * THE PIVOT CONTRACT (server side, src/buildloop + composition):
 *   - KICKOFF: an accepted idea fans out to the framework backends which now
 *     produce fast CONCEPT MOCKS — builds[] lanes race to "ready" in seconds
 *     and each ready lane is a mock preview + pitch deck, not a full app.
 *   - COMMISSION: an explicit POST /api/process/:upid/execute starts the real
 *     subscription execution lane; the process gains execution telemetry that
 *     runs "executing" → "built" (full-app previewUrl) or "failed".
 *
 * This module is the wall-side seam for that contract: tolerant extractors so
 * the wall renders the new surfaces when a two-stage server publishes them and
 * degrades to plain CONCEPT rendering — never a white screen — against an old
 * server or a malformed frame. Like buildloop.ts, everything here reads
 * unknown-shaped snapshot fields defensively (never trusts the wire).
 */

// Which stage of its life a project is in. Everything starts as a CONCEPT
// (mock lanes racing / mock ready); an explicit commission transforms it.
// SELF is the one standing exception: the pinned mirror project in self-
// hosting mode (VIBERSYN_SELF_MODE=1) — the room's own source, steered rather
// than commissioned.
export type ProcessStage = "concept" | "commissioned" | "self";

// The subscription execution lane's lifecycle.
export type ExecutionStatus = "executing" | "built" | "failed";

// Normalized execution telemetry for a commissioned process.
export interface ProcessExecution {
  status: ExecutionStatus;
  previewUrl: string | null;
  progressLabel: string | null;
  percent: number | null;
  summary: string | null;
}

// The process as a two-stage server publishes it. types.ts stays untouched
// (projector contract, owned elsewhere); the widening lives here.
export type StagedProcess = ProjectorProcess & {
  execution?: unknown;
  stage?: unknown;
};

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function clampPercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.min(100, Math.max(0, value));
}

// Tolerant status words → the normalized ExecutionStatus. Accepts the obvious
// synonyms a server iteration might publish; anything else is unreadable.
function normalizeExecutionStatus(value: unknown): ExecutionStatus | null {
  if (typeof value !== "string") {
    return null;
  }
  switch (value) {
    case "executing":
    case "running":
    case "building":
      return "executing";
    case "built":
    case "ready":
    case "complete":
    case "completed":
      return "built";
    case "failed":
    case "error":
      return "failed";
    default:
      return null;
  }
}

function normalizeExecution(record: Record<string, unknown>, status: ExecutionStatus): ProcessExecution {
  return {
    status,
    previewUrl: asNonEmptyString(record.previewUrl),
    progressLabel: asNonEmptyString(record.progressLabel) ?? asNonEmptyString(record.label),
    percent: clampPercent(record.percent),
    // The server's ExecutionSnapshot has no summary; its `error` carries the
    // failure reason, surfaced here so a failed lane can say why.
    summary: asNonEmptyString(record.summary) ?? asNonEmptyString(record.error),
  };
}

// Backend ids that mark a builds[] entry as the EXECUTION lane rather than a
// concept mock lane (in case the server publishes execution through builds[]).
const EXECUTION_LANE_IDS: ReadonlySet<string> = new Set(["execution", "subscription", "commissioned"]);
// Statuses only the execution lane uses — a builds[] entry carrying one is the
// execution lane regardless of its backend id.
const EXECUTION_ONLY_STATUSES: ReadonlySet<string> = new Set(["executing", "built"]);

// The subscription execution telemetry of a process, or null while it is still
// a concept (or against a pre-pivot server). Reads BOTH candidate shapes:
//   1. process.execution — the dedicated object (preferred), and
//   2. a builds[] entry whose backend id or status marks it as the execution
//      lane (fallback, so the wall never hides a real run).
export function executionOf(process: ProjectorProcess): ProcessExecution | null {
  const raw = (process as StagedProcess).execution;
  if (typeof raw === "object" && raw !== null) {
    const record = raw as Record<string, unknown>;
    const status = normalizeExecutionStatus(record.status);
    if (status !== null) {
      return normalizeExecution(record, status);
    }
  }
  const builds = (process as { builds?: unknown }).builds;
  if (Array.isArray(builds)) {
    for (const entry of builds) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const backend = asNonEmptyString(record.backend) ?? asNonEmptyString(record.id);
      const rawStatus = record.status;
      const isExecutionLane =
        (backend !== null && EXECUTION_LANE_IDS.has(backend)) ||
        (typeof rawStatus === "string" && EXECUTION_ONLY_STATUSES.has(rawStatus));
      if (!isExecutionLane) {
        continue;
      }
      const status = normalizeExecutionStatus(rawStatus);
      if (status !== null) {
        return normalizeExecution(record, status);
      }
    }
  }
  return null;
}

// A project's stage. COMMISSIONED when execution telemetry exists or the
// server says so explicitly; CONCEPT otherwise (including every pre-pivot
// process — under the two-stage language, everything un-commissioned is a
// concept).
export function stageOf(process: ProjectorProcess): ProcessStage {
  const declared = (process as StagedProcess).stage;
  if (typeof declared === "string") {
    if (declared === "self" || declared === "mirror") {
      return "self";
    }
    if (declared === "commissioned" || declared === "executing" || declared === "built" || declared === "execution") {
      return "commissioned";
    }
    if (declared === "concept" || declared === "mock" || declared === "kickoff") {
      return "concept";
    }
  }
  return executionOf(process) !== null ? "commissioned" : "concept";
}

// The 3D scene only knows saplings (concept) and full trees (commissioned).
// The SELF project folds onto that axis by whether a self-run is live: an
// idle mirror is a sapling; one mid-change (or freshly green) shows the tree.
export function sceneStageOf(process: ProjectorProcess): "concept" | "commissioned" {
  const stage = stageOf(process);
  if (stage === "self") {
    return executionOf(process) !== null ? "commissioned" : "concept";
  }
  return stage;
}

// ── deck decision bridge ─────────────────────────────────────────────────────

// The three "How should we continue?" choices on a concept's pitch deck.
export type DecisionChoice = "commission" | "iterate" | "done";

// Alias table covers the generated deck's decision ids (execute / steer /
// dismiss — see src/slideshow/generator.ts decisionButtons) plus the obvious
// synonyms, so either side can evolve wording without breaking the bridge.
const CHOICE_ALIASES: Record<string, DecisionChoice> = {
  // build it for real → commission the subscription execution
  commission: "commission",
  execute: "commission",
  build: "commission",
  "build-real": "commission",
  "build-it-for-real": "commission",
  real: "commission",
  // keep shaping the idea
  iterate: "iterate",
  remix: "iterate",
  steer: "iterate",
  refine: "iterate",
  // keep it as a concept / stop here
  done: "done",
  concept: "done",
  keep: "done",
  dismiss: "done",
  stop: "done",
  later: "done",
};

// DECK DWELL BRIDGE, half 2 (see Slideshow.tsx for half 1, the room-native
// decision bar): the generated deck (src/slideshow) renders its own decision
// slide with data-dwell buttons INSIDE an iframe, where the room's dwell layer
// cannot reach (querySelectorAll/elementFromPoint stop at the frame boundary).
// Today those buttons POST their /api endpoints directly on click/tap (the
// room then sees the commission through the snapshot — see the App's
// decide-step commission watcher); a deck iteration may instead/also post
// `{ type: "vibersyn:decision", choice }` to the parent, which this parser
// validates. Anything else → null. The caller (App) additionally only acts
// while a deck is actually open, so a stray message from an arbitrary
// embedded page can never fire a commission.
export function parseDeckDecisionMessage(data: unknown): DecisionChoice | null {
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const record = data as Record<string, unknown>;
  if (record.type !== "vibersyn:decision") {
    return null;
  }
  const choice = record.choice;
  if (typeof choice !== "string") {
    return null;
  }
  return CHOICE_ALIASES[choice] ?? null;
}
