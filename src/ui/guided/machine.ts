import type { ProcessBuildStatus, ProjectorProcess, ProjectorSnapshot } from "../types";
import { backendsOf, buildsOf } from "../buildloop";

/**
 * Guided-demo step machine — the PURE core of the coached wall demo.
 *
 * Every advance condition reads REAL room state (the projector snapshot the
 * live server publishes over /api/state + SSE); nothing here fabricates
 * progress. The React overlay (GuidedDemo.tsx) renders `GuidedState` and the
 * App feeds every new snapshot through `advanceOnSnapshot`.
 *
 * THE STEP CONTRACT (what advances each step):
 *   orientation — 3 practice orbs; `popPracticeOrb` per pop (a local UI event —
 *                 the orbs are practice targets, not room state); all popped →
 *                 "record".
 *   record      — advances when the snapshot shows muted === false AND
 *                 captureMode === true (however achieved: the overlay's big
 *                 Record button POSTs the real /api/unmute + /api/capture +
 *                 /api/auto-accept, but a keyboard u/c or voice command counts
 *                 identically). On advance the process baseline is re-captured.
 *   idea        — advances when a process appears whose upid was NOT in the
 *                 baseline (the real pipeline: mic → ASR → detector →
 *                 auto-accept → spawn). That newcomer becomes `focusUpid`.
 *   build       — advances when the focus process's real builds[] carry any
 *                 entry with status "ready" (legacy fallback: buildStatus ===
 *                 "ready" when builds[] is absent). Failed lanes NEVER advance
 *                 and never wedge — the overlay shows them failed and the skip
 *                 affordance always works.
 *   story       — terminal content step; `skipStep` (Finish) returns null =
 *                 demo complete.
 *
 * Skip is available at every step; re-entering (startGuided) always begins a
 * fresh run with a fresh baseline.
 */

export const PRACTICE_ORB_COUNT = 3;

export type GuidedStep = "orientation" | "record" | "idea" | "build" | "story";

export const GUIDED_STEP_ORDER: readonly GuidedStep[] = [
  "orientation",
  "record",
  "idea",
  "build",
  "story",
];

export interface GuidedState {
  step: GuidedStep;
  // Practice-orb progress (orientation only; a local UI counter, not room state).
  orbsPopped: number;
  // The upids present when the demo (re)entered / when "record" completed —
  // the idea step looks for a process NOT in this set.
  baselineUpids: readonly string[];
  // The project born during the demo (steps build/story focus the camera on it).
  focusUpid: string | null;
  // Which backend's build was FIRST ready (build → story transition) so the
  // deck can open on that framework's real slideshow, whichever one won.
  readyBackend: string | null;
}

function upidsOf(snapshot: ProjectorSnapshot): string[] {
  return snapshot.processes.map((process) => process.upid);
}

export function startGuided(snapshot: ProjectorSnapshot): GuidedState {
  return {
    step: "orientation",
    orbsPopped: 0,
    baselineUpids: upidsOf(snapshot),
    focusUpid: null,
    readyBackend: null,
  };
}

export function stepNumber(step: GuidedStep): number {
  return GUIDED_STEP_ORDER.indexOf(step) + 1;
}

// One practice orb popped (dwell-fired or clicked). All popped → record step.
export function popPracticeOrb(state: GuidedState): GuidedState {
  if (state.step !== "orientation") {
    return state;
  }
  const orbsPopped = Math.min(state.orbsPopped + 1, PRACTICE_ORB_COUNT);
  return {
    ...state,
    orbsPopped,
    step: orbsPopped >= PRACTICE_ORB_COUNT ? "record" : "orientation",
  };
}

export function focusProcess(state: GuidedState, snapshot: ProjectorSnapshot): ProjectorProcess | null {
  if (state.focusUpid === null) {
    return null;
  }
  return snapshot.processes.find((process) => process.upid === state.focusUpid) ?? null;
}

// The FIRST backend whose build is ready, or null. Legacy servers without
// builds[] fall back to the single process-level buildStatus ("build" lane).
function firstReadyBackend(process: ProjectorProcess | null): string | null {
  if (process === null) {
    return null;
  }
  const builds = buildsOf(process);
  const ready = builds.find((build) => build.status === "ready");
  if (ready !== undefined) {
    return ready.backend;
  }
  if (builds.length === 0 && process.buildStatus === "ready") {
    return "build";
  }
  return null;
}

// Feed every fresh snapshot through this. Returns the SAME state object when
// nothing advances, so React setState bails without re-rendering.
export function advanceOnSnapshot(state: GuidedState, snapshot: ProjectorSnapshot): GuidedState {
  switch (state.step) {
    case "record": {
      if (!snapshot.muted && snapshot.captureMode === true) {
        return { ...state, step: "idea", baselineUpids: upidsOf(snapshot) };
      }
      return state;
    }
    case "idea": {
      const newcomer = snapshot.processes.find(
        (process) => !state.baselineUpids.includes(process.upid),
      );
      if (newcomer !== undefined) {
        // A very fast backend may already be ready in this same frame; run the
        // build check immediately so the demo never shows a stale step.
        return advanceOnSnapshot(
          { ...state, step: "build", focusUpid: newcomer.upid },
          snapshot,
        );
      }
      return state;
    }
    case "build": {
      let next = state;
      // A skipped idea step has no focus yet: adopt the first newcomer.
      if (next.focusUpid === null) {
        const newcomer = snapshot.processes.find(
          (process) => !next.baselineUpids.includes(process.upid),
        );
        if (newcomer !== undefined) {
          next = { ...next, focusUpid: newcomer.upid };
        }
      }
      const readyBackend = firstReadyBackend(focusProcess(next, snapshot));
      if (readyBackend !== null) {
        return { ...next, step: "story", readyBackend };
      }
      return next;
    }
    default:
      return state;
  }
}

// Force-advance past the current step (the per-step "Skip ▸" button, always
// available). Returns null when skipping past the final step = demo complete.
export function skipStep(state: GuidedState, snapshot: ProjectorSnapshot): GuidedState | null {
  switch (state.step) {
    case "orientation":
      return { ...state, step: "record" };
    case "record":
      // Same baseline reset the natural advance performs, so a process that
      // appears later still registers as the demo's newcomer.
      return { ...state, step: "idea", baselineUpids: upidsOf(snapshot) };
    case "idea":
      return advanceOnSnapshot({ ...state, step: "build" }, snapshot);
    case "build":
      return {
        ...state,
        step: "story",
        readyBackend: firstReadyBackend(focusProcess(state, snapshot)),
      };
    case "story":
      return null;
  }
}

// ── build lanes (step 4) ─────────────────────────────────────────────────────

export type GuidedLaneStatus = ProcessBuildStatus | "queued";

export interface GuidedLane {
  id: string;
  label: string;
  status: GuidedLaneStatus;
  progressLabel: string | null;
  percent: number | null;
  summary: string | null;
  hasDeck: boolean;
}

// Framework display names for the race lanes. Unknown backend ids fall back to
// the server-provided chip label (never invented).
const LANE_LABELS: Record<string, string> = {
  smithers: "Smithers",
  eliza: "ElizaOS",
  native: "Native · homebrewed",
};

export function laneLabel(id: string, fallback?: string): string {
  return LANE_LABELS[id] ?? fallback ?? id;
}

// One lane per ENABLED backend (snapshot.backends roster), each carrying the
// focus process's REAL builds[] telemetry for that backend — or "queued" until
// the fan-out publishes its entry. Backends missing from the roster but present
// in builds[] still get a lane (never hide a real build). Legacy servers with
// no roster and no builds[] surface the single process-level buildStatus.
export function guidedLanes(state: GuidedState, snapshot: ProjectorSnapshot): GuidedLane[] {
  const process = focusProcess(state, snapshot);
  const builds = process !== null ? buildsOf(process) : [];
  const roster = backendsOf(snapshot).filter((backend) => backend.enabled);

  const laneIds: { id: string; label: string }[] = roster.map((backend) => ({
    id: backend.id as string,
    label: laneLabel(backend.id, backend.label),
  }));
  for (const build of builds) {
    if (!laneIds.some((lane) => lane.id === (build.backend as string))) {
      laneIds.push({ id: build.backend as string, label: laneLabel(build.backend, build.label) });
    }
  }
  if (laneIds.length === 0 && process !== null && typeof process.buildStatus === "string") {
    return [
      {
        id: "build",
        label: "Build",
        status: process.buildStatus,
        progressLabel: process.progressLabel.length > 0 ? process.progressLabel : null,
        percent: Number.isFinite(process.progress) ? process.progress : null,
        summary: null,
        hasDeck: false,
      },
    ];
  }

  return laneIds.map(({ id, label }) => {
    const build = builds.find((candidate) => (candidate.backend as string) === id);
    if (build === undefined) {
      return { id, label, status: "queued" as const, progressLabel: null, percent: null, summary: null, hasDeck: false };
    }
    return {
      id,
      label,
      status: build.status,
      progressLabel: build.progressLabel ?? null,
      percent: build.percent ?? null,
      summary: build.summary,
      hasDeck: build.slideshowUrl !== null,
    };
  });
}

// Honest failure state: every lane exists and every lane failed. The overlay
// says so instead of spinning forever; skip/exit stay available regardless.
export function lanesAllFailed(lanes: readonly GuidedLane[]): boolean {
  return lanes.length > 0 && lanes.every((lane) => lane.status === "failed");
}

// ── resilience notices ───────────────────────────────────────────────────────

// A blocking/degraded room condition the overlay must SAY instead of wedging
// on. Null when the current step can proceed normally.
export function guidedNotice(state: GuidedState, snapshot: ProjectorSnapshot): string | null {
  if (snapshot.emergencyStopTriggered) {
    return "EMERGENCY STOP is active — the room is halted, so the demo cannot proceed. Clear the stop (or exit the demo).";
  }
  if ((state.step === "idea" || state.step === "build") && snapshot.muted) {
    return "The room went muted, so nothing can be heard. Unmute (the Unmute button or the U key) to continue, or skip ahead.";
  }
  if (state.step === "idea" && snapshot.mic?.mode === "replay") {
    return "Audio is reaching the server but ASR is in replay mode (no DEEPGRAM_API_KEY) — speech will not transcribe. Fix the key or skip ahead.";
  }
  return null;
}
