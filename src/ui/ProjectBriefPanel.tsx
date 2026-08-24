import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SceneDwellRect } from "./gesture/scene-source";
import { treeMenuPlacement } from "./TreeMenu";
import type { ProjectBrief } from "../server/project-brief";
import "./TreePopups.css";

/**
 * 📖 ABOUT THIS PROJECT — what the room learned by reading an imported repo.
 *
 * Importing a repo used to go straight to building it, and clicking the tree
 * showed build controls and not one fact about the project. You could pick an
 * issue off a codebase the room had never told you anything about. An import
 * that asks to be studied (or a repo imported with no instruction at all) now
 * produces this instead: what it appears to be, what it is built out of, the
 * README's opening, and the ask it came in with.
 *
 * Everything shown is derived from the real checkout. The digest's own
 * hedged phrasing ("appears to be…") is kept rather than upgraded into a
 * statement, and a repo the room could not clone says THAT instead of
 * rendering an empty card.
 *
 * Building is one press from here — the study is the first step, not a dead
 * end.
 */

export const BRIEF_PANEL_WIDTH = 440;
export const BRIEF_PANEL_EST_HEIGHT = 360;

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export interface ProjectBriefPanelProps {
  brief: ProjectBrief;
  anchor: SceneDwellRect | null;
  // Absent once the project has already been sent to the build backends.
  onBuild?: (() => void) | undefined;
  buildBusy?: boolean;
  onClose: () => void;
}

export function ProjectBriefPanel({ brief, anchor, onBuild, buildBusy = false, onClose }: ProjectBriefPanelProps) {
  const viewport =
    typeof window !== "undefined"
      ? { width: window.innerWidth, height: window.innerHeight }
      : { width: 1920, height: 1080 };
  const panelRef = useRef<HTMLElement | null>(null);
  const [measured, setMeasured] = useState<{ width: number; height: number } | null>(null);
  useIsomorphicLayoutEffect(() => {
    const panel = panelRef.current;
    if (panel === null) {
      return;
    }
    const rect = panel.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }
    setMeasured((current) =>
      current !== null && Math.abs(current.width - rect.width) < 1 && Math.abs(current.height - rect.height) < 1
        ? current
        : { width: rect.width, height: rect.height },
    );
  });
  const placement = treeMenuPlacement(anchor, viewport, measured ?? { width: BRIEF_PANEL_WIDTH, height: BRIEF_PANEL_EST_HEIGHT });

  return (
    <section
      ref={panelRef}
      className="tree-popup brief-panel"
      data-testid="project-brief"
      data-repo={brief.repo}
      data-dwell-shield="1"
      role="dialog"
      aria-label={`About ${brief.repo}`}
      style={{ left: `${Math.round(placement.left)}px`, top: `${Math.round(placement.top)}px` }}
      onClick={(clickEvent) => clickEvent.stopPropagation()}
    >
      <header className="tree-popup-head">
        <div>
          <span className="tree-popup-eyebrow">📖 studied — nothing has been built</span>
          <h2 className="tree-popup-title" data-testid="project-brief-title">
            {brief.repo}
          </h2>
        </div>
        <button
          type="button"
          className="ctl-button tree-popup-close"
          data-testid="project-brief-close"
          title="Close this project card"
          onClick={onClose}
        >
          ✕
        </button>
      </header>

      {brief.unavailable !== null ? (
        <p className="brief-unavailable" data-testid="project-brief-unavailable">
          {brief.unavailable}
        </p>
      ) : null}

      {brief.summary !== null ? (
        <p className="brief-summary" data-testid="project-brief-summary">
          {brief.summary}
        </p>
      ) : null}

      {brief.readme !== null ? (
        <p className="brief-readme" data-testid="project-brief-readme">
          {brief.readme}
        </p>
      ) : null}

      {brief.facts.length > 0 ? (
        <ul className="brief-facts" data-testid="project-brief-facts">
          {brief.facts.map((fact) => (
            <li key={fact} className="brief-fact">
              {fact}
            </li>
          ))}
        </ul>
      ) : null}

      {brief.ask !== null ? (
        <p className="brief-ask" data-testid="project-brief-ask">
          you asked: “{brief.ask}”
        </p>
      ) : null}

      {onBuild !== undefined ? (
        <div className="tree-popup-actions">
          <button
            type="button"
            className="ctl-button"
            data-testid="project-brief-build"
            title="Send this project to the build backends now that you have read it."
            disabled={buildBusy}
            onClick={onBuild}
          >
            {buildBusy ? "🌱 Planting…" : "🌱 Now plant something here"}
          </button>
        </div>
      ) : null}
    </section>
  );
}
