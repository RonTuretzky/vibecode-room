import type { ResearchTrayItem } from "./types";

/**
 * Research tray — the quest ledger made visible (mirrors the IdeaTray).
 *
 * Proposed quests carry Research/Dismiss buttons wired to
 * /api/research/:id/accept | /api/research/:id/dismiss; a researching quest
 * shows the agent's live progress; a complete quest opens its dossier deck
 * (findings, bias notes, QR-coded sources). Nothing researches itself — the
 * room explicitly commissions every quest.
 */

export interface ResearchTrayProps {
  quests: ResearchTrayItem[];
  // A suggestion round's inference is in flight — a crystal might be forming.
  thinking?: boolean;
  onAccept: (id: string) => void;
  onDismiss: (id: string) => void;
  onOpenDeck: (id: string) => void;
}

const KIND_GLYPH: Record<ResearchTrayItem["kind"], string> = {
  "fact-check": "✓",
  "deep-dive": "◎",
  "bias-scan": "⚖",
};

export function ResearchTray({ quests, thinking = false, onAccept, onDismiss, onOpenDeck }: ResearchTrayProps) {
  return (
    <section className="research-tray" data-testid="research-tray" aria-label="Research tray">
      <div className="rail-title-row">
        <h3 className="rail-title">Research</h3>
        <span className="trace-count">
          {quests.length} {quests.length === 1 ? "quest" : "quests"}
        </span>
      </div>
      {/* Live inference feedback: without it, a round that finds nothing is
          indistinguishable from a dead feature. */}
      {thinking ? (
        <p className="research-scanning" data-testid="research-scanning" role="status">
          <span className="research-scan-dot" aria-hidden="true" />
          scanning the conversation for researchables…
        </p>
      ) : null}
      {quests.length === 0 ? (
        thinking ? null : (
          <p className="research-tray-empty" data-testid="research-tray-empty">
            Listening for claims worth checking — click any turn on the vine, keep talking, or say “Vibersyn, research it”.
          </p>
        )
      ) : (
        <div className="research-tray-items">
          {quests.map((quest) => (
            <ResearchCard key={quest.id} quest={quest} onAccept={onAccept} onDismiss={onDismiss} onOpenDeck={onOpenDeck} />
          ))}
        </div>
      )}
    </section>
  );
}

function ResearchCard({
  quest,
  onAccept,
  onDismiss,
  onOpenDeck,
}: {
  quest: ResearchTrayItem;
  onAccept: (id: string) => void;
  onDismiss: (id: string) => void;
  onOpenDeck: (id: string) => void;
}) {
  return (
    <article
      className={`research-item ${quest.status}`}
      data-testid="research-item"
      data-research-id={quest.id}
      data-status={quest.status}
      data-kind={quest.kind}
    >
      <div className="research-item-head">
        <span className={`research-kind kind-${quest.kind}`}>
          {KIND_GLYPH[quest.kind]} {quest.kind}
        </span>
        {quest.status === "proposed" ? (
          <span className="research-confidence">{Math.round(quest.confidence * 100)}%</span>
        ) : (
          <span className={`research-status status-${quest.status}`}>{quest.status}</span>
        )}
      </div>
      <p className="research-item-topic" title={quest.rationale}>
        {quest.topic}
      </p>
      <p className="research-item-claim">{quest.claim}</p>
      {quest.evidence !== undefined && quest.evidence.length > 0 ? (
        <p className="research-item-evidence" title={quest.evidence}>
          “{quest.evidence}”
        </p>
      ) : null}
      {quest.status === "researching" ? (
        <div className="research-progress" data-testid="research-progress">
          <span className="research-progress-track">
            <span className="research-progress-fill" style={{ width: `${quest.progress}%` }} />
          </span>
          <span className="research-progress-label">{quest.progressLabel || "researching"}</span>
        </div>
      ) : null}
      {quest.status === "complete" ? (
        <p className="research-item-result" data-testid="research-result">
          {verdictSummary(quest)} · {quest.sourceCount} source{quest.sourceCount === 1 ? "" : "s"}
          {quest.biasCount > 0 ? ` · ${quest.biasCount} bias note${quest.biasCount === 1 ? "" : "s"}` : ""}
        </p>
      ) : null}
      {quest.status === "failed" && quest.error !== undefined ? (
        <p className="research-item-error">{quest.error}</p>
      ) : null}
      <div className="research-item-actions">
        {quest.status === "proposed" ? (
          <button
            type="button"
            className="ctl-button research-accept"
            data-testid="research-accept-button"
            onClick={() => onAccept(quest.id)}
            title="Spawn the research agent: web research, adversarial fact-check, bias scan."
          >
            Research
          </button>
        ) : null}
        {quest.status === "complete" ? (
          <button
            type="button"
            className="ctl-button research-deck"
            data-testid="research-deck-button"
            onClick={() => onOpenDeck(quest.id)}
            title="Open the dossier: findings with verdicts, bias notes, QR-coded sources."
          >
            Dossier ▸
          </button>
        ) : null}
        <button
          type="button"
          className="ctl-button research-dismiss"
          data-testid="research-dismiss-button"
          onClick={() => onDismiss(quest.id)}
          title={quest.status === "researching" ? "Cancel this research run." : "Drop this quest from the wall."}
        >
          {quest.status === "researching" ? "Cancel" : "Dismiss"}
        </button>
      </div>
    </article>
  );
}

function verdictSummary(quest: ResearchTrayItem): string {
  const verdicts = quest.verdicts;
  if (verdicts === undefined) {
    return "report ready";
  }
  const parts: string[] = [];
  if (verdicts.supported > 0) {
    parts.push(`${verdicts.supported} supported`);
  }
  if (verdicts.refuted > 0) {
    parts.push(`${verdicts.refuted} refuted`);
  }
  if (verdicts.mixed > 0) {
    parts.push(`${verdicts.mixed} mixed`);
  }
  if (verdicts.unverified > 0) {
    parts.push(`${verdicts.unverified} unverified`);
  }
  return parts.length > 0 ? parts.join(" · ") : "report ready";
}
