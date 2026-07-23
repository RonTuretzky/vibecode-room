import type { MouseEvent } from "react";
import type { ProjectorProcessState } from "./types";
import { lifecycleActionsFor } from "./buildloop";
import type { LifecycleAction, ProcessBuild } from "./buildloop";
import type { ProcessExecution, ProcessStage } from "./stage";

/**
 * Build chips + lifecycle controls — the per-process build-loop surface on the
 * fleet cards.
 *
 * TWO-STAGE LANGUAGE: under the kickoff/commission pivot the builds[] lanes
 * are CONCEPT MOCKS — a ready lane's chip says "mock ready" so the wall never
 * oversells a mock as a built app. The commissioned surface is separate: the
 * ExecutionChip (executing → BUILT with the full-app preview link) plus the
 * CommissionButton that fires the explicit POST /api/process/:upid/execute.
 *
 * Each backend mocking this process gets one chip: BUILDING pulses (the race
 * must visibly read as alive) and carries the live progress label/percent;
 * READY turns green ("mock ready") and exposes Preview/Slides links that open
 * in new windows; FAILED turns red. Everything renders inside the clickable
 * fleet panel (whose click steers/selects), so every interactive element here
 * stops propagation.
 */

function stopClick(clickEvent: MouseEvent) {
  clickEvent.stopPropagation();
}

export interface BuildChipsProps {
  builds: ProcessBuild[];
  // The process's stage. "concept" labels ready lanes as MOCK READY (the
  // two-stage language); omitted = legacy rendering (plain ready links).
  stage?: ProcessStage;
}

export function BuildChips({ builds, stage }: BuildChipsProps) {
  if (builds.length === 0) {
    return null;
  }
  return (
    <div className="build-chips" data-testid="build-chips">
      {builds.map((build) => (
        <BuildChip key={build.backend} build={build} mock={stage === "concept"} />
      ))}
    </div>
  );
}

function BuildChip({ build, mock }: { build: ProcessBuild; mock: boolean }) {
  const percent = typeof build.percent === "number" ? Math.round(build.percent) : null;
  return (
    <div
      className={`build-chip status-${build.status}${mock ? " mock" : ""}`}
      data-testid="build-chip"
      data-backend={build.backend}
      data-status={build.status}
      title={build.summary ?? undefined}
    >
      <span className="build-chip-dot" aria-hidden="true" />
      <span className="build-chip-label">{build.label}</span>
      {build.status === "building" ? (
        <span className="build-chip-progress" data-testid="build-chip-progress">
          {build.progressLabel ?? "building…"}
          {percent !== null ? ` · ${percent}%` : ""}
        </span>
      ) : null}
      {build.status === "ready" && mock ? (
        <span className="build-chip-mock" data-testid="build-chip-mock">
          mock ready
        </span>
      ) : null}
      {build.status === "building" && percent !== null ? (
        <span className="build-chip-track" aria-hidden="true">
          <span className="build-chip-fill" style={{ width: `${percent}%` }} />
        </span>
      ) : null}
      {build.status === "failed" ? <span className="build-chip-failed">failed</span> : null}
      {build.status === "ready" ? (
        <span className="build-chip-links">
          {build.previewUrl !== null ? (
            <a
              className="build-chip-link"
              data-testid="build-preview-link"
              href={build.previewUrl}
              target="_blank"
              rel="noreferrer"
              onClick={stopClick}
            >
              Preview ↗
            </a>
          ) : null}
          {build.slideshowUrl !== null ? (
            <a
              className="build-chip-link"
              data-testid="build-slides-link"
              href={build.slideshowUrl}
              target="_blank"
              rel="noreferrer"
              onClick={stopClick}
            >
              Slides ↗
            </a>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

// The COMMISSIONED surface: the subscription execution lane's live telemetry.
// EXECUTING pulses with real run progress; BUILT turns gold and links the
// full-app preview; FAILED says so. Rendered wherever the process HUD lives
// (fleet card + deck head) so the concept→commissioned transformation is
// legible at projector distance.
export function ExecutionChip({ execution }: { execution: ProcessExecution }) {
  const percent = execution.percent !== null ? Math.round(execution.percent) : null;
  return (
    <div
      className={`execution-chip status-${execution.status}`}
      data-testid="execution-chip"
      data-status={execution.status}
      title={execution.summary ?? undefined}
    >
      <span className="execution-chip-dot" aria-hidden="true" />
      {execution.status === "executing" ? (
        <>
          <span className="execution-chip-label">COMMISSIONED · executing</span>
          <span className="execution-chip-progress" data-testid="execution-chip-progress">
            {execution.progressLabel ?? "running…"}
            {percent !== null ? ` · ${percent}%` : ""}
          </span>
          {percent !== null ? (
            <span className="execution-chip-track" aria-hidden="true">
              <span className="execution-chip-fill" style={{ width: `${percent}%` }} />
            </span>
          ) : null}
        </>
      ) : execution.status === "built" ? (
        <>
          <span className="execution-chip-label">BUILT ✓</span>
          {execution.previewUrl !== null ? (
            <a
              className="build-chip-link execution-chip-link"
              data-testid="execution-preview-link"
              href={execution.previewUrl}
              target="_blank"
              rel="noreferrer"
              onClick={stopClick}
            >
              Open the app ↗
            </a>
          ) : null}
        </>
      ) : (
        <>
          <span className="execution-chip-label">execution failed</span>
          {execution.summary !== null || execution.progressLabel !== null ? (
            <span className="execution-chip-progress">
              {execution.summary ?? execution.progressLabel}
            </span>
          ) : null}
        </>
      )}
    </div>
  );
}

// The explicit commission control: turns a CONCEPT into a COMMISSIONED build
// (POST /api/process/:upid/execute via the App-owned callback). A plain
// <button>, so the gesture dwell layer targets it automatically.
export function CommissionButton({
  upid,
  onCommission,
}: {
  upid: string;
  onCommission: (upid: string) => void;
}) {
  return (
    <button
      type="button"
      className="fleet-ctl fleet-ctl-commission"
      data-testid="commission-button"
      title="Commission this concept: start the real subscription build (POST execute)."
      onClick={(clickEvent) => {
        clickEvent.stopPropagation();
        onCommission(upid);
      }}
    >
      ⚡ Build for real
    </button>
  );
}

const ACTION_WORD: Record<LifecycleAction, string> = {
  pause: "Pause",
  resume: "Resume",
  halt: "Halt",
};

const ACTION_HINT: Record<LifecycleAction, string> = {
  pause: "Pause this process (POST pause).",
  resume: "Resume this process (POST resume).",
  halt: "Halt this process — also on the 'k' key when selected.",
};

export interface ProcessControlsProps {
  upid: string;
  state: ProjectorProcessState;
  // App owns the POST + snapshot application (and the offline-demo fallback).
  onLifecycle: (upid: string, action: LifecycleAction) => void;
}

export function ProcessControls({ upid, state, onLifecycle }: ProcessControlsProps) {
  const actions = lifecycleActionsFor(state);
  if (actions.length === 0) {
    return null;
  }
  return (
    <div className="fleet-controls" data-testid="fleet-controls">
      {actions.map((action) => (
        <button
          key={action}
          type="button"
          className={`fleet-ctl fleet-ctl-${action}`}
          data-testid={`process-${action}-button`}
          title={ACTION_HINT[action]}
          onClick={(clickEvent) => {
            clickEvent.stopPropagation();
            onLifecycle(upid, action);
          }}
        >
          {ACTION_WORD[action]}
        </button>
      ))}
    </div>
  );
}
