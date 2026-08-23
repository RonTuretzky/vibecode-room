import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ProjectorProcess } from "./types";
import type { SceneDwellRect } from "./gesture/scene-source";
import { treeMenuPlacement } from "./TreeMenu";
import { fruitColor, type IssueInfo } from "./tree-limbs";
import "./TreePopups.css";

/**
 * Issue popup — the contextual glass that opens when a FRUIT is picked on an
 * adopted tree's holo branch (RoomScene routes the pick through onPickIssue
 * with the fruit's own projected rect).
 *
 * Same glass family + clamped placement as TreeMenu, dwell-shielded, plain
 * enabled buttons only:
 *   - 🌱 Take this issue → POST /api/process/:upid/branch {name:"issue-<n>"}
 *     then POST select {branch: <returned branch>} — grows the limb AND arms
 *     branch-scoped steer in one press — then close.
 *   - ✕ close.
 */

export const ISSUE_POPUP_WIDTH = 380;
export const ISSUE_POPUP_EST_HEIGHT = 260;

export interface IssuePopupModel {
  number: number;
  title: string;
  heading: string;
  // One chip per label, tinted by the same palette the fruit wears.
  chips: Array<{ label: string; color: number }>;
}

// Pure: the fetched issue → everything the card renders. Falls back to the
// bare number when the poller has not surfaced a title (e.g. the issue list
// refreshed between pick and open).
export function issuePopupModel(issue: IssueInfo): IssuePopupModel {
  return {
    number: issue.number,
    title: issue.title,
    heading: `#${issue.number}${issue.title.length > 0 ? ` ${issue.title}` : ""}`,
    chips: issue.labels.map((label) => ({ label, color: fruitColor([label]) })),
  };
}

function cssHex(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

// SSR-safe measure (TreeMenu's pattern).
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export interface IssuePopupProps {
  process: ProjectorProcess;
  issue: IssueInfo;
  // The FRUIT's projected screen rect at pick time (sub-object, not the
  // whole-tree bbox); null → edge resting, same contract as TreeMenu.
  anchor: SceneDwellRect | null;
  onClose: () => void;
}

export function IssuePopup({ process, issue, anchor, onClose }: IssuePopupProps) {
  const model = issuePopupModel(issue);
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
  const placement = treeMenuPlacement(
    anchor,
    viewport,
    measured ?? { width: ISSUE_POPUP_WIDTH, height: ISSUE_POPUP_EST_HEIGHT },
  );

  // 🌱 Take: two sequential POSTs (grow the branch, then arm branch-scoped
  // steer on it), then close. In-flight disables the button; a failure shows
  // the honest error inline and leaves the card open.
  const [takeBusy, setTakeBusy] = useState(false);
  const [takeError, setTakeError] = useState<string | null>(null);
  useEffect(() => {
    setTakeBusy(false);
    setTakeError(null);
  }, [process.upid, issue.number]);

  const takeIssue = async (): Promise<void> => {
    setTakeBusy(true);
    setTakeError(null);
    try {
      const grow = await fetch(`/api/process/${encodeURIComponent(process.upid)}/branch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `issue-${model.number}` }),
      });
      const grown = (await grow.json().catch(() => null)) as { branch?: unknown; error?: unknown } | null;
      if (!grow.ok || typeof grown?.branch !== "string") {
        setTakeError(
          typeof grown?.error === "string" && grown.error.length > 0
            ? grown.error
            : `Branch failed (HTTP ${grow.status})`,
        );
        return;
      }
      await fetch(`/api/process/${encodeURIComponent(process.upid)}/select`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ branch: grown.branch }),
      }).catch(() => undefined);
      onClose();
    } catch {
      setTakeError("Take failed — is the room server up?");
    } finally {
      setTakeBusy(false);
    }
  };

  return (
    <section
      ref={panelRef}
      className="tree-popup issue-popup"
      data-testid="issue-popup"
      data-upid={process.upid}
      data-issue={model.number}
      // Dwell-miss dismissal shield: reading the card never closes it.
      data-dwell-shield="1"
      role="dialog"
      aria-label={`Issue #${model.number} on ${process.callsign}`}
      style={{ left: `${Math.round(placement.left)}px`, top: `${Math.round(placement.top)}px` }}
      onClick={(clickEvent) => clickEvent.stopPropagation()}
    >
      <header className="tree-popup-head">
        <div>
          <span className="tree-popup-eyebrow">🍒 issue</span>
          <h2 className="tree-popup-title" data-testid="issue-popup-title">
            {model.heading}
          </h2>
        </div>
        <button
          type="button"
          className="ctl-button tree-popup-close"
          data-testid="issue-popup-close"
          title="Close this issue card"
          onClick={onClose}
        >
          ✕
        </button>
      </header>

      {model.chips.length > 0 ? (
        <div className="tree-popup-chips" data-testid="issue-popup-chips">
          {model.chips.map((chip) => (
            <span
              key={chip.label}
              className="tree-popup-chip"
              data-testid="issue-popup-chip"
              style={{ color: cssHex(chip.color), borderColor: cssHex(chip.color) }}
            >
              {chip.label}
            </span>
          ))}
        </div>
      ) : null}

      {takeError !== null ? (
        <div className="tree-popup-error" data-testid="issue-popup-error">
          {takeError}
        </div>
      ) : null}

      <div className="tree-popup-actions">
        <button
          type="button"
          className="ctl-button issue-popup-take"
          data-testid="issue-popup-take"
          title="Grow a real branch for this issue and route everything you say into it."
          disabled={takeBusy}
          onClick={() => void takeIssue()}
        >
          {takeBusy ? "🌱 Taking…" : "🌱 Take this issue"}
        </button>
      </div>
    </section>
  );
}
