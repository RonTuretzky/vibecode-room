import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ProjectorProcess } from "./types";
import type { SceneDwellRect } from "./gesture/scene-source";
import { treeMenuPlacement } from "./TreeMenu";
import "./TreePopups.css";

/**
 * Branch popup — the contextual glass that opens when a LIMB TIP is picked on
 * an adopted tree (RoomScene routes the pick through onPickBranch with the
 * limb tip's own projected rect, so the card opens beside the limb, not the
 * whole tree).
 *
 * Same glass family + clamped placement as TreeMenu (treeMenuPlacement), a
 * dwell shield over the whole rect, plain enabled buttons only:
 *   - 🎙 Steer this branch → POST /api/process/:upid/select {branch}, close —
 *     the record path, scoped to this branch.
 *   - ⬆ Open PR ▸ → POST /api/process/:upid/branch/<branch>/pr; the returned
 *     URL (or the honest error) shows INLINE — in-room text, never a new tab.
 *   - ✕ close.
 */

export const BRANCH_POPUP_WIDTH = 380;
export const BRANCH_POPUP_EST_HEIGHT = 300;

export interface BranchPopupModel {
  // Full branch ref ("room/spoken-changes") — the POST path segment.
  branch: string;
  // Display name without the room/ rail prefix.
  short: string;
  commits: number;
  prUrl: string | null;
}

// Pure: resolve the picked branch against the LIVE snapshot's treeRepo. Null
// when the branch left the snapshot (force-deleted upstream) — the caller
// closes rather than rendering a dead card.
export function branchPopupModel(process: ProjectorProcess, branch: string): BranchPopupModel | null {
  const entry = process.treeRepo?.branches.find((candidate) => candidate.name === branch);
  if (entry === undefined) {
    return null;
  }
  return {
    branch: entry.name,
    short: entry.name.startsWith("room/") ? entry.name.slice("room/".length) : entry.name,
    commits: Math.max(0, Math.round(entry.commits)),
    prUrl: typeof entry.prUrl === "string" && entry.prUrl.length > 0 ? entry.prUrl : null,
  };
}

// SSR-safe measure (TreeMenu's pattern): layout effect in the browser, plain
// effect on the server so renderToStaticMarkup stays quiet.
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export interface BranchPopupProps {
  process: ProjectorProcess;
  branch: string;
  // The LIMB TIP's projected screen rect at pick time (the sub-object rect,
  // not the whole-tree bbox); null → edge resting, same contract as TreeMenu.
  anchor: SceneDwellRect | null;
  onClose: () => void;
}

export function BranchPopup({ process, branch, anchor, onClose }: BranchPopupProps) {
  const model = branchPopupModel(process, branch);
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
    measured ?? { width: BRANCH_POPUP_WIDTH, height: BRANCH_POPUP_EST_HEIGHT },
  );

  // ⬆ Open PR state: in-flight disables the button; the result (URL or the
  // honest error) shows inline. Reset when the popup moves to another branch.
  const [prBusy, setPrBusy] = useState(false);
  const [prResult, setPrResult] = useState<{ url: string | null; error: string | null }>({ url: null, error: null });
  useEffect(() => {
    setPrBusy(false);
    setPrResult({ url: null, error: null });
  }, [process.upid, branch]);

  if (model === null) {
    return null;
  }

  // The record path, scoped: this branch becomes the steering target and
  // everything spoken routes into it (the server slugs/validates the branch).
  const steerBranch = (): void => {
    void fetch(`/api/process/${encodeURIComponent(process.upid)}/select`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ branch: model.branch }),
    }).catch(() => undefined);
    onClose();
  };

  const openPr = async (): Promise<void> => {
    setPrBusy(true);
    setPrResult({ url: null, error: null });
    try {
      const response = await fetch(
        `/api/process/${encodeURIComponent(process.upid)}/branch/${encodeURIComponent(model.branch)}/pr`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) },
      );
      const payload = (await response.json().catch(() => null)) as { url?: unknown; error?: unknown } | null;
      if (response.ok && typeof payload?.url === "string") {
        setPrResult({ url: payload.url, error: null });
      } else {
        setPrResult({
          url: null,
          error: typeof payload?.error === "string" && payload.error.length > 0 ? payload.error : `PR failed (HTTP ${response.status})`,
        });
      }
    } catch {
      setPrResult({ url: null, error: "PR request failed — is the room server up?" });
    } finally {
      setPrBusy(false);
    }
  };

  const shownPrUrl = prResult.url ?? model.prUrl;

  return (
    <section
      ref={panelRef}
      className="tree-popup branch-popup"
      data-testid="branch-popup"
      data-upid={process.upid}
      data-branch={model.branch}
      // Dwell-miss dismissal shield: reading the card never closes it.
      data-dwell-shield="1"
      role="dialog"
      aria-label={`Branch ${model.branch} on ${process.callsign}`}
      style={{ left: `${Math.round(placement.left)}px`, top: `${Math.round(placement.top)}px` }}
      onClick={(clickEvent) => clickEvent.stopPropagation()}
    >
      <header className="tree-popup-head">
        <div>
          <span className="tree-popup-eyebrow">🌿 branch</span>
          <h2 className="tree-popup-title" data-testid="branch-popup-title">
            {model.short}
          </h2>
          <span className="tree-popup-sub" data-testid="branch-popup-commits">
            {model.commits} commit{model.commits === 1 ? "" : "s"}
            {model.prUrl !== null ? " · PR ✓" : ""}
          </span>
        </div>
        <button
          type="button"
          className="ctl-button tree-popup-close"
          data-testid="branch-popup-close"
          title="Close this branch card"
          onClick={onClose}
        >
          ✕
        </button>
      </header>

      {/* The PR URL rides in-room (projector text, no target=_blank jump). */}
      {shownPrUrl !== null ? (
        <div className="tree-popup-link" data-testid="branch-popup-pr-url">
          ⬆ {shownPrUrl}
        </div>
      ) : null}
      {prResult.error !== null ? (
        <div className="tree-popup-error" data-testid="branch-popup-pr-error">
          {prResult.error}
        </div>
      ) : null}

      <div className="tree-popup-actions">
        <button
          type="button"
          className="ctl-button branch-popup-steer"
          data-testid="branch-popup-steer"
          title="Press, then talk — everything you say routes into THIS branch until you stop."
          onClick={steerBranch}
        >
          🎙 Steer this branch
        </button>
        <button
          type="button"
          className="ctl-button branch-popup-pr"
          data-testid="branch-popup-pr"
          title="Open a real PR from this branch against the import's own origin."
          disabled={prBusy}
          onClick={() => void openPr()}
        >
          {prBusy ? "⬆ Opening PR…" : "⬆ Open PR ▸"}
        </button>
      </div>
    </section>
  );
}
