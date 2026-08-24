import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SceneDwellRect } from "./gesture/scene-source";
import { treeMenuPlacement } from "./TreeMenu";
import {
  linePage,
  memoryLine,
  pageOfLine,
  spanLine,
  summaryBlock,
  type TopicCardDetail,
} from "./sky/topic-card";
import "./TreePopups.css";

/**
 * Topic card — the glass that opens when a CONSTELLATION is picked on the
 * ceiling: what this thread was about, in its own words.
 *
 * Before this card, picking a constellation POSTed a research quest at its
 * freshest utterance and showed nothing. A pick reads as "tell me about this",
 * so that is what it does now; researching the thread is a verb on the card.
 *
 * Same glass family and clamped placement as the tree popups, dwell-shielded
 * so reading it never dismisses it, and PAGED rather than scrolled — the wall
 * has no wheel and no drag.
 *
 * What it will not do: invent a recap. The abstract is the relate agent's or
 * the card says which silence this is and shows the lines instead (see
 * sky/topic-card.ts).
 */

export const TOPIC_CARD_WIDTH = 420;
export const TOPIC_CARD_EST_HEIGHT = 340;

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export interface TopicCardProps {
  detail: TopicCardDetail;
  // The star that was picked, when a single star was — the card opens on its
  // page and marks it. Null for a whole-constellation pick.
  focusTurnId?: string | null;
  anchor: SceneDwellRect | null;
  // 🔭 Research this thread — what the bare pick used to do, now deliberate.
  onResearch?: (() => void) | undefined;
  researchBusy?: boolean;
  onClose: () => void;
}

function clockOf(atMs: number): string {
  const date = new Date(atMs);
  const hh = `${date.getHours()}`.padStart(2, "0");
  const mm = `${date.getMinutes()}`.padStart(2, "0");
  return `${hh}:${mm}`;
}

export function TopicCard({ detail, focusTurnId = null, anchor, onResearch, researchBusy = false, onClose }: TopicCardProps) {
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
  const placement = treeMenuPlacement(anchor, viewport, measured ?? { width: TOPIC_CARD_WIDTH, height: TOPIC_CARD_EST_HEIGHT });

  // Opening on the picked star's page beats opening at the top of a long
  // thread; re-picking a different star (or another constellation) re-seeks.
  const [page, setPage] = useState(() => pageOfLine(detail.lines, focusTurnId));
  useEffect(() => {
    setPage(pageOfLine(detail.lines, focusTurnId));
  }, [detail.id, detail.lines, focusTurnId]);

  const summary = summaryBlock(detail);
  const view = linePage(detail.lines, page);

  return (
    <section
      ref={panelRef}
      className="tree-popup topic-card"
      data-testid="topic-card"
      data-topic={detail.id}
      data-summary-kind={summary.kind}
      data-page={view.page}
      data-page-count={view.pageCount}
      // Dwell-miss dismissal shield: reading the card never closes it.
      data-dwell-shield="1"
      role="dialog"
      aria-label={`Topic ${detail.label}`}
      style={{ left: `${Math.round(placement.left)}px`, top: `${Math.round(placement.top)}px` }}
      onClick={(clickEvent) => clickEvent.stopPropagation()}
    >
      <header className="tree-popup-head">
        <div>
          <span className="tree-popup-eyebrow">
            ✦ topic{detail.labelSource === "agent" ? " · named by the model" : ""}
          </span>
          <h2 className="tree-popup-title" data-testid="topic-card-title">
            {detail.label}
          </h2>
        </div>
        <button
          type="button"
          className="ctl-button tree-popup-close"
          data-testid="topic-card-close"
          title="Close this topic card"
          onClick={onClose}
        >
          ✕
        </button>
      </header>

      <div className="tree-popup-chips" data-testid="topic-card-chips">
        <span className="tree-popup-chip">{spanLine(detail, clockOf)}</span>
        <span className="tree-popup-chip">{memoryLine(detail)}</span>
        {detail.dominantSpeaker !== null ? (
          <span className="tree-popup-chip">mostly {detail.dominantSpeaker}</span>
        ) : null}
        {detail.live ? <span className="tree-popup-chip topic-card-live">still live</span> : null}
      </div>

      <p className={`topic-card-summary topic-card-summary-${summary.kind}`} data-testid="topic-card-summary">
        {summary.text}
      </p>

      <ol className="topic-card-lines" data-testid="topic-card-lines">
        {view.lines.map((line) => (
          <li
            key={line.id}
            className={`topic-card-line${line.id === focusTurnId ? " topic-card-line-focus" : ""}`}
            data-source={line.source}
            data-testid="topic-card-line"
          >
            <span className="topic-card-line-meta">
              {clockOf(line.atMs)}
              {line.speaker !== null ? ` · ${line.speaker}` : ""}
              {line.source === "recalled" ? " · recalled" : ""}
            </span>
            <span className="topic-card-line-text">
              {line.text}
              {line.source === "recalled" ? "…" : ""}
            </span>
          </li>
        ))}
        {view.lines.length === 0 ? (
          <li className="topic-card-line topic-card-line-empty" data-testid="topic-card-line">
            <span className="topic-card-line-text">Nothing from this thread is still kept.</span>
          </li>
        ) : null}
      </ol>

      {view.pageCount > 1 ? (
        <div className="topic-card-pager" data-testid="topic-card-pager">
          <button
            type="button"
            className="ctl-button"
            data-testid="topic-card-prev"
            title="Earlier in this thread"
            disabled={view.page === 0}
            onClick={() => setPage(view.page - 1)}
          >
            ◀
          </button>
          <span className="topic-card-pager-count">
            {view.page + 1}/{view.pageCount}
          </span>
          <button
            type="button"
            className="ctl-button"
            data-testid="topic-card-next"
            title="Later in this thread"
            disabled={view.page >= view.pageCount - 1}
            onClick={() => setPage(view.page + 1)}
          >
            ▶
          </button>
        </div>
      ) : null}

      {detail.related.length > 0 ? (
        <ul className="topic-card-related" data-testid="topic-card-related">
          {detail.related.map((related) => (
            <li key={related.id} className="topic-card-related-row" data-source={related.source}>
              <span className="topic-card-related-label">↔ {related.label}</span>
              {related.reason.length > 0 ? (
                <span className="topic-card-related-reason">
                  {related.reason}
                  {related.source === "lexical" ? " (shared words)" : ""}
                </span>
              ) : (
                <span className="topic-card-related-reason">
                  {related.source === "lexical" ? "shared words" : "related by the model"}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {onResearch !== undefined ? (
        <div className="tree-popup-actions">
          <button
            type="button"
            className="ctl-button"
            data-testid="topic-card-research"
            title="Send this thread to a research agent — sources, fact-check, dossier."
            disabled={researchBusy}
            onClick={onResearch}
          >
            {researchBusy ? "🔭 Researching…" : "🔭 Research this thread"}
          </button>
        </div>
      ) : null}
    </section>
  );
}
