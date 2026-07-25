import type { ResearchTrayItem } from "./types";

/**
 * Research dossier overlay: the completed quest's self-contained deck
 * (findings with verdicts, bias notes, QR-coded sources) in a fullscreen
 * iframe — the same overlay pattern as the pitch-deck Slideshow, opened from
 * the 3D crystal or the tray's "Dossier ▸" button on WHICHEVER wall summons
 * it. Close via the button, click-away, or Escape (handled in App).
 */

export interface ResearchDeckOverlayProps {
  quest: ResearchTrayItem;
  onClose: () => void;
}

export function ResearchDeckOverlay({ quest, onClose }: ResearchDeckOverlayProps) {
  const deckUrl = quest.deckUrl ?? null;
  return (
    <div className="research-deck-overlay" data-testid="research-deck-overlay" onClick={onClose}>
      <div className="research-deck-frame" onClick={(clickEvent) => clickEvent.stopPropagation()}>
        <header className="research-deck-head">
          <span className="research-deck-title">
            {quest.topic} · {quest.kind}
          </span>
          <button
            type="button"
            className="ctl-button research-deck-close"
            data-testid="research-deck-close"
            onClick={onClose}
            title="Close the dossier (Esc)"
          >
            ✕ Close
          </button>
        </header>
        {deckUrl !== null ? (
          <iframe className="research-deck-iframe" src={deckUrl} title={`Research dossier: ${quest.topic}`} />
        ) : (
          <p className="research-deck-missing" data-testid="research-deck-missing">
            The dossier is not available — the server may be offline.
          </p>
        )}
      </div>
    </div>
  );
}
