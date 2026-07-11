import type { IdeaTrayItem } from "./types";

/**
 * Idea tray — the WHOLE detection ledger made visible, not just one bubble.
 *
 * Autodetection proved too unreliable to trust with auto-building, so the tray
 * gives the room explicit control: every candidate renders as a card (ready
 * first, per the snapshot contract), and ready candidates carry Build/Dismiss
 * buttons wired to /api/idea/:id/accept | /api/idea/:id/dismiss. Forming
 * candidates are dimmed context — visible so the room sees ideas maturing, but
 * not yet actionable.
 */

export interface IdeaTrayProps {
  ideas: IdeaTrayItem[];
  // Build/Dismiss a SPECIFIC candidate. The handlers own the POST + snapshot
  // application (App keeps the "a failed POST must never block the UI" contract).
  onBuild: (id: string) => void;
  onDismiss: (id: string) => void;
}

export function IdeaTray({ ideas, onBuild, onDismiss }: IdeaTrayProps) {
  return (
    <section className="idea-tray" data-testid="idea-tray" aria-label="Idea tray">
      <div className="rail-title-row">
        <h3 className="rail-title">Idea Tray</h3>
        <span className="trace-count">
          {ideas.length} {ideas.length === 1 ? "candidate" : "candidates"}
        </span>
      </div>
      {ideas.length === 0 ? (
        <p className="idea-tray-empty" data-testid="idea-tray-empty">
          No ideas yet — keep talking, or say “Vibersyn” to start capturing.
        </p>
      ) : (
        <div className="idea-tray-items">
          {ideas.map((idea) => (
            <IdeaCard key={idea.id} idea={idea} onBuild={onBuild} onDismiss={onDismiss} />
          ))}
        </div>
      )}
    </section>
  );
}

function IdeaCard({
  idea,
  onBuild,
  onDismiss,
}: {
  idea: IdeaTrayItem;
  onBuild: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const ready = idea.status === "ready";
  return (
    <article
      className={`idea-item ${idea.status}`}
      data-testid="idea-item"
      data-idea-id={idea.id}
      data-status={idea.status}
      data-maturity={idea.maturity}
    >
      <div className="idea-item-head">
        <span className={`idea-maturity maturity-${idea.maturity}`}>{idea.maturity}</span>
        <span className="idea-confidence">{Math.round(idea.confidence * 100)}%</span>
        {idea.verified ? (
          <span className="idea-verified" title="Verified by the skeptic pass" aria-label="Verified">
            ✓
          </span>
        ) : null}
      </div>
      <p className="idea-item-pitch" title={idea.rationale}>
        {idea.pitch}
      </p>
      {idea.evidence !== undefined && idea.evidence.length > 0 ? (
        <p className="idea-item-evidence" title={idea.evidence}>
          “{idea.evidence}”
        </p>
      ) : null}
      {ready ? (
        <div className="idea-item-actions">
          <button
            type="button"
            className="ctl-button idea-build"
            data-testid="idea-build-button"
            onClick={() => onBuild(idea.id)}
            title="Accept this idea and start the build."
          >
            Build
          </button>
          <button
            type="button"
            className="ctl-button idea-dismiss"
            data-testid="idea-dismiss-button"
            onClick={() => onDismiss(idea.id)}
            title="Drop this idea and suppress its pitch for a while."
          >
            Dismiss
          </button>
        </div>
      ) : null}
    </article>
  );
}
