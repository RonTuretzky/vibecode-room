import type { CSSProperties } from "react";
import type { ProjectorProcess, ProjectorProcessState, SuggestionState } from "./types";

/**
 * A bubble — a translucent glass sphere rising through the abyss.
 *
 * Two kinds:
 *  - "process": a full glass sphere; size scales with significance; active builds
 *    carry a thin progress ring driven by process.progress.
 *  - "idea": a smaller, lighter "forming" bubble with a shimmering dashed aura,
 *    representing a pending suggestion not yet committed.
 *
 * Float motion (bob + drift + breathe) is driven entirely by CSS using per-bubble
 * --phase / --dur custom properties so the field feels alive but calm, and freezes
 * under prefers-reduced-motion.
 */

type BubbleStyle = CSSProperties & {
  "--bloom": string;
  "--rim": string;
  "--phase": string;
  "--dur": string;
  "--size": string;
};

const STATE_COLOR: Record<ProjectorProcessState, string> = {
  active: "var(--c-active)",
  paused: "var(--c-paused)",
  halted: "var(--c-halted)",
  completed: "var(--c-completed)",
  planning: "var(--c-planning)",
  blocked: "var(--c-halted)",
};

const STATE_WORD: Record<ProjectorProcessState, string> = {
  active: "active",
  paused: "paused",
  halted: "halted",
  completed: "completed",
  planning: "planning",
  blocked: "blocked",
};

// Selected bubbles always read as cyan focus regardless of underlying state.
function bloomColor(state: ProjectorProcessState, selected: boolean): string {
  if (selected) {
    return "var(--c-selected)";
  }
  return STATE_COLOR[state];
}

export interface ProcessBubbleProps {
  process: ProjectorProcess;
  index: number;
  size: number;
  hotkey: number | null;
  // Primary click: in the live projector this steers the process (routes
  // subsequent transcript to it); in offline demo it opens the build detail.
  onSelect: () => void;
}

export function ProcessBubble({ process, index, size, hotkey, onSelect }: ProcessBubbleProps) {
  // The current steering target reads as cyan focus and carries a "steering ->"
  // indicator, the same way a selected bubble does.
  const steering = process.steering === true;
  const bloom = bloomColor(process.state, process.selected || steering);
  const showRing = process.state === "active" || process.state === "planning";
  // Progress ring geometry (SVG circle, normalized 0–100).
  const radius = 46;
  const circumference = 2 * Math.PI * radius;
  const dash = circumference * (1 - Math.min(100, Math.max(0, process.progress)) / 100);

  const style: BubbleStyle = {
    "--bloom": bloom,
    "--rim": STATE_COLOR[process.state],
    "--phase": `${index * 1.37}s`,
    "--dur": `${9 + (index % 3) * 1.6}s`,
    "--size": `${size}px`,
  };

  return (
    <button
      type="button"
      className={`bubble bubble-process state-${process.state}${process.selected ? " is-selected" : ""}${steering ? " is-steering" : ""}`}
      style={style}
      data-testid="bubble"
      data-callsign={process.callsign}
      data-kind="process"
      data-state={process.state}
      data-selected={process.selected ? "true" : "false"}
      data-steering={steering ? "true" : "false"}
      onClick={() => onSelect()}
      aria-label={`${process.callsign}, ${STATE_WORD[process.state]}.${steering ? " Steering target." : ""} ${process.task}.`}
    >
      <span className="bubble-bloom" aria-hidden="true" />
      <span className="bubble-glass" aria-hidden="true">
        <span className="bubble-specular" />
        <span className="bubble-rimlight" />
      </span>

      {showRing ? (
        <svg className="bubble-ring" viewBox="0 0 100 100" aria-hidden="true">
          <circle className="ring-track" cx="50" cy="50" r={radius} />
          <circle
            className="ring-fill"
            cx="50"
            cy="50"
            r={radius}
            strokeDasharray={circumference}
            strokeDashoffset={dash}
          />
        </svg>
      ) : null}

      <span className="bubble-content">
        <span className="bubble-callsign">{process.callsign}</span>
        <span className="bubble-state">{STATE_WORD[process.state]}</span>
        {steering ? (
          <span className="bubble-steering" data-testid="bubble-steering">
            steering →
          </span>
        ) : null}
        <span className="bubble-progress">{process.progress}% · {process.progressLabel}</span>
        <span className="bubble-id">{process.upid}</span>
        {process.buildStatus === "ready" && process.previewUrl ? (
          // A bubble is a <button>, so the live link can't be a nested <a> (invalid
          // interactive nesting). Surface a "preview ready" marker carrying the URL
          // here; the clickable "Preview ->" anchor lives in the BuildDetail card.
          <span
            className="bubble-preview-ready"
            data-testid="bubble-preview-ready"
            data-preview-url={process.previewUrl}
          >
            Preview ready →
          </span>
        ) : process.buildStatus === "building" ? (
          <span className="bubble-preview-pending" data-testid="bubble-preview-pending">
            building…
          </span>
        ) : null}
      </span>

      {hotkey !== null ? <span className="bubble-hotkey" aria-hidden="true">{hotkey}</span> : null}
    </button>
  );
}

export interface IdeaBubbleProps {
  state: SuggestionState;
  pitch: string;
  confidence: number;
  gatePercent: number;
  selected: boolean;
  size: number;
  // Provenance: the verbatim span of conversation this idea was grounded in (from
  // idea detection). Shown as a short evidence line so the operator can see WHY the
  // idea surfaced. Absent for the neutral idle bubble / legacy gate-driven bubbles.
  evidence?: string;
  // Primary click: in the live projector this accepts the pending suggestion and
  // starts the real build; in offline demo it opens the idea detail.
  onSelect: () => void;
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

export function IdeaBubble({ state, pitch, confidence, gatePercent, selected, size, evidence, onSelect }: IdeaBubbleProps) {
  const style: BubbleStyle = {
    "--bloom": selected ? "var(--c-selected)" : "var(--c-planning)",
    "--rim": "var(--c-planning)",
    "--phase": "0.6s",
    "--dur": "11s",
    "--size": `${size}px`,
  };

  return (
    <button
      type="button"
      className={`bubble bubble-idea${selected ? " is-selected" : ""}`}
      style={style}
      data-testid="bubble"
      data-callsign="idea"
      data-kind="idea"
      data-state={state}
      data-selected={selected ? "true" : "false"}
      onClick={() => onSelect()}
      aria-label={`Forming idea: ${pitch}`}
    >
      <span className="bubble-bloom" aria-hidden="true" />
      <span className="idea-aura" aria-hidden="true" />
      <span className="bubble-glass idea-glass" aria-hidden="true">
        <span className="bubble-specular" />
        <span className="bubble-rimlight" />
      </span>
      <span className="bubble-content">
        <span className="idea-eyebrow">forming idea</span>
        <span className="idea-pitch">{pitch}</span>
        {selected && evidence !== undefined && evidence.length > 0 ? (
          <span className="idea-evidence" title={evidence}>“{truncate(evidence, 120)}”</span>
        ) : null}
        <span className="bubble-state">{state}</span>
        <span className="bubble-progress">{Math.round(confidence * 100)}% conf · gate {Math.round(gatePercent)}%</span>
      </span>
    </button>
  );
}
