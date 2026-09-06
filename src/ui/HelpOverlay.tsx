import { useEffect, useRef } from "react";
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
  ["c", "mic + Idea Capture on / off (one control)"],
  ["W A S D", "move forward / back / left / right"],
  ["arrow keys", "turn left / right · look up / down"],
  ["Q / E", "lower / raise the camera"],
  ["= / −", "zoom in / out"],
  ["Controls → Explore", "hold a direction, or enable Dwell to move"],
  ["Shift+A", "toggle Auto-Build"],
  ["r", "toggle background research; open its view from Controls"],
  ["k", "halt the selected build"],
  ["m", "same as c — mic + Idea Capture"],
  ["u", "unmute the room"],
  ["Shift+Q", "QR import overlay"],
  ["g", "garden ↔ orbit scene"],
  ["l", "layout: radial / ball / disk"],
  ["z", "zen mode (hide all chrome)"],
  ["f / Home", "return to projects and fit them in view"],
  ["Shift+F", "enter / exit fullscreen"],
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
  ["“Vibersyn, research on / off”", "toggle background research"],
  ["“Vibersyn, research it” / “fact check”", "research the top suggested quest"],
  ["“Vibersyn, emergency”", "EMERGENCY STOP"],
];

// Gesture walls use the same Controls pad through sustained dwell. A rigid
// corner projector keeps its fixed camera; flat pairs share their moving pose.
const GESTURE_MOVES: ReadonlyArray<readonly [move: string, effect: string]> = [
  ["point at a project or button", "it grows + glows (your colored dot follows; toggle it with the Cursor button)"],
  ["hold ≈0.8 s", "the ring fills, then selects (idea → build, build → steer/deck)"],
  ["move away", "cancels the dwell; re-point to try again"],
  ["two hands / people", "first on a target owns it — first-to-dwell wins"],
  ["camera", "Controls → Explore: dwell on a direction to move; leave it to stop. Corner projector views stay fixed."],
  ["?dwell=mouse", "desk testing: the mouse drives the same dwell-select"],
];

export interface HelpOverlayProps {
  onClose: () => void;
  // True when this window runs the gesture wall (fusion cursors, no OS cursor);
  // the gesture section leads with a "you are here" note.
  gestureMode?: boolean;
}

export function HelpOverlay({ onClose, gestureMode = false }: HelpOverlayProps) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeButton.current?.focus();
    return () => { document.querySelector<HTMLButtonElement>('[data-testid="control-dock-button"]')?.focus(); };
  }, []);
  return (
    <div className="detail-overlay help-overlay" data-testid="help-overlay" onClick={onClose}>
      <div
        className="help-card"
        onKeyDown={event => { if (event.key === "Tab") { event.preventDefault(); closeButton.current?.focus(); } }}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard and voice controls"
        onClick={(clickEvent) => clickEvent.stopPropagation()}
      >
        <header className="qr-head">
          <div>
            <span className="detail-eyebrow">controls</span>
            <h2 className="qr-title">VIBERSYN ROOM — SELF-HOSTED</h2>
          </div>
          <button type="button" className="detail-back" ref={closeButton} onClick={onClose} aria-label="Close help">
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

          <section className="help-section" data-testid="help-gesture">
            <h3 className="rail-title">Gesture wall</h3>
            <p className="help-voice-intro">
              {gestureMode
                ? "This window is in gesture mode: point, hold, select — your colored dot shows where you point."
                : "On the camera wall: point, hold, select — a colored dot per person shows where you point."}
            </p>
            <dl className="help-list">
              {GESTURE_MOVES.map(([move, effect]) => (
                <div className="help-row" key={move}>
                  <dt className="help-phrase">{move}</dt>
                  <dd>{effect}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>

        <footer className="help-footer" data-testid="help-signoff">
          <span className="help-signoff-text">Okay — see you. The room rests when you do.</span>
        </footer>
      </div>
    </div>
  );
}
