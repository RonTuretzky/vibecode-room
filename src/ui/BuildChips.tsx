import type { MouseEvent } from "react";
import type { ProjectorProcessState } from "./types";
import { lifecycleActionsFor } from "./buildloop";
import type { LifecycleAction, ProcessBuild } from "./buildloop";

/**
 * Build chips + lifecycle controls — the per-process build-loop surface on the
 * fleet cards.
 *
 * Each backend building this process gets one chip: BUILDING pulses (a 1–2
 * minute build must visibly read as alive) and carries the live progress
 * label/percent; READY turns green and exposes Preview/Slides links that open in
 * new windows; FAILED turns red. Both components render inside the clickable
 * fleet panel (whose click steers/selects), so every interactive element here
 * stops propagation.
 */

function stopClick(clickEvent: MouseEvent) {
  clickEvent.stopPropagation();
}

export interface BuildChipsProps {
  builds: ProcessBuild[];
}

export function BuildChips({ builds }: BuildChipsProps) {
  if (builds.length === 0) {
    return null;
  }
  return (
    <div className="build-chips" data-testid="build-chips">
      {builds.map((build) => (
        <BuildChip key={build.backend} build={build} />
      ))}
    </div>
  );
}

function BuildChip({ build }: { build: ProcessBuild }) {
  const percent = typeof build.percent === "number" ? Math.round(build.percent) : null;
  return (
    <div
      className={`build-chip status-${build.status}`}
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
