/**
 * Help overlay — the desk-mode cheat sheet.
 *
 * Desk mode replaced the gesture wall with mouse + keyboard + voice, so this
 * overlay is the single discoverable place listing both control surfaces: the
 * keyboard map and the "Vibersyn" wake-word commands. Opened with ? / h,
 * closed with Esc or a click anywhere outside the card.
 */

const KEYBOARD_SHORTCUTS: ReadonlyArray<readonly [keys: string, action: string]> = [
  ["1–9", "select / steer a build"],
  ["Enter / b", "build the top ready idea"],
  ["x", "dismiss the top ready idea"],
  ["c", "toggle Idea Capture"],
  ["a", "toggle Auto-Build"],
  ["m", "mic on / off"],
  ["u", "unmute the room"],
  ["q", "QR import overlay"],
  ["g", "garden ↔ orbit scene"],
  ["z", "zen mode (hide all chrome)"],
  ["f", "fit everything in view"],
  ["`", "hide/unhide menu (0 clears)"],
  ["drag", "orbit · Shift+drag pan · scroll zoom"],
  ["? / h", "this help"],
  ["Shift+E", "EMERGENCY STOP"],
  ["Esc", "close overlays"],
];

const VOICE_COMMANDS: ReadonlyArray<readonly [phrase: string, effect: string]> = [
  ["“Vibersyn”", "start capturing ideas"],
  ["“Vibersyn, stop capturing”", "stop idea capture"],
  ["“Vibersyn, build it”", "build the top ready idea"],
  ["“Vibersyn, dismiss”", "dismiss the current idea"],
  ["“Vibersyn, auto build on / off”", "toggle Auto-Build"],
  ["“Vibersyn, emergency”", "EMERGENCY STOP"],
];

export interface HelpOverlayProps {
  onClose: () => void;
}

export function HelpOverlay({ onClose }: HelpOverlayProps) {
  return (
    <div className="detail-overlay help-overlay" data-testid="help-overlay" onClick={onClose}>
      <div
        className="help-card"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard and voice controls"
        onClick={(clickEvent) => clickEvent.stopPropagation()}
      >
        <header className="qr-head">
          <div>
            <span className="detail-eyebrow">controls</span>
            <h2 className="qr-title">Keyboard &amp; voice</h2>
          </div>
          <button type="button" className="detail-back" onClick={onClose} aria-label="Close help">
            <span aria-hidden="true">←</span> back
          </button>
        </header>

        <div className="help-columns">
          <section className="help-section" data-testid="help-keyboard">
            <h3 className="rail-title">Keyboard</h3>
            <dl className="help-list">
              {KEYBOARD_SHORTCUTS.map(([keys, action]) => (
                <div className="help-row" key={keys}>
                  <dt>
                    <kbd>{keys}</kbd>
                  </dt>
                  <dd>{action}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="help-section" data-testid="help-voice">
            <h3 className="rail-title">Voice</h3>
            <p className="help-voice-intro">
              Say “Vibersyn” to start capturing; “Vibersyn, build it” to ship the top idea.
            </p>
            <dl className="help-list">
              {VOICE_COMMANDS.map(([phrase, effect]) => (
                <div className="help-row" key={phrase}>
                  <dt className="help-phrase">{phrase}</dt>
                  <dd>{effect}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}
