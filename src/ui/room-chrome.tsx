import { useEffect, useState } from "react";
import type { TranscriptLine } from "./types";
import "./buildloop.css";


// A live wall clock (top-right): the room forgets what time it is once the
// projector's been running for hours, so ambient minutes read at a glance.
// Ticks once a second; chrome-less like the rest of the corner furniture.
export function WallClock() {
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const label = now.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return (
    <div className="wall-clock" data-testid="wall-clock" role="status" aria-live="off">
      🕐 {label}
    </div>
  );
}


// Live-mic control: toggles browser capture and shows a real-time input level
// meter so the room can confirm the mic is actually feeding the server. When the
// server reports ASR mode "replay" (no DEEPGRAM_API_KEY), audio still streams and
// the meter moves, but words are not transcribed — surfaced via the title hint.
// Placement-time fullscreen affordance: browsers only honor requestFullscreen
// from a real user gesture, so this is a mouse/trackpad button for when the
// operator drags a wall window onto its projector. It hides once the window
// is fullscreen (or effectively fullscreen, e.g. Chrome --kiosk).
export function FullscreenButton() {
  const [visible, setVisible] = useState<boolean>(() => needsFullscreenHint());
  useEffect(() => {
    const update = () => setVisible(needsFullscreenHint());
    // Keyboard path: plain "f" toggles fullscreen (keydown counts as a real
    // user gesture, so requestFullscreen is honored). Stays bound while the
    // button is hidden so "f" also EXITS fullscreen. Ignored with modifiers
    // held or while typing into a field.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "f" && event.key !== "F") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target !== null &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
      if (document.fullscreenElement !== null) {
        void document.exitFullscreen?.();
      } else {
        void document.documentElement.requestFullscreen?.();
      }
    };
    document.addEventListener("fullscreenchange", update);
    window.addEventListener("resize", update);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("fullscreenchange", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  if (!visible) {
    return null;
  }
  return (
    <button
      type="button"
      className="ctl-button fullscreen-button"
      data-testid="fullscreen-button"
      // Dwell-exempt: requestFullscreen only works from a TRUSTED gesture
      // (real mouse/keyboard). A dwell cursor "clicking" this would silently
      // no-op — use the keyboard F, or a real mouse click.
      data-dwell-exempt="true"
      title="Fullscreen this wall on its projector (or press F)"
      onClick={() => {
        void document.documentElement.requestFullscreen?.();
      }}
    >
      ⛶ Fullscreen <span className="fullscreen-key-hint">(F)</span>
    </button>
  );
}


export function needsFullscreenHint(): boolean {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return false;
  }
  if (document.fullscreenElement !== null) {
    return false;
  }
  // Kiosk/native-fullscreen windows report no fullscreenElement but already
  // cover the screen — no hint needed there.
  const screenH = window.screen?.height ?? 0;
  return screenH === 0 || window.innerHeight < screenH - 2;
}


// ONE button for mic + Idea Capture (live-room request): "mic on" and
// "capturing" were two adjacent controls; a visitor should hit a single
// target. Inactive it invites ("🎤 Capture idea"); active it shows a live
// capturing indicator — the pulsing dot plus the mic level meter (the RMS the
// mic capture already reports) — and deactivating stops BOTH mic and capture.
export function MicCaptureControl({
  active,
  micState,
  level,
  error,
  mode,
  bytesReceived,
  onToggle,
  deviceLabel = null,
}: {
  active: boolean;
  micState: "off" | "connecting" | "live";
  level: number;
  error: string | null;
  mode?: "deepgram" | "voxterm" | "replay";
  bytesReceived: number;
  onToggle: () => void;
  // The physical device feeding the capture, once known ("Wireless GO RX").
  deviceLabel?: string | null;
}) {
  // Map RMS (~0–0.3 for speech) onto a 0–100% bar with mild gain.
  const levelPercent = Math.min(100, Math.round(level * 320));
  const label = micState === "connecting" ? "Starting" : active ? "● Capturing" : "🎤 Capture idea";
  const hint = active
    ? mode === "replay"
      ? "Capturing. Audio streams to the server, but transcription needs DEEPGRAM_API_KEY."
      : `Capturing${deviceLabel !== null ? ` via ${deviceLabel}` : ""}: live mic → server ASR → ideas. Click to stop the mic and Idea Capture together.`
    : "One button: unmute + mic on + Idea Capture on. Click again to stop both.";

  return (
    <div className="mic-control" data-testid="mic-capture-control" data-state={micState}>
      <button
        type="button"
        className={`ctl-button mic-capture mic-${micState}${active ? " on" : ""}`}
        data-testid="mic-capture-button"
        data-state={active ? "on" : "off"}
        aria-pressed={active}
        onClick={onToggle}
        disabled={micState === "connecting"}
        title={error ?? hint}
      >
        <span className="mic-dot" aria-hidden="true" />
        {label}
      </button>
      {micState === "live" ? (
        <>
          {deviceLabel !== null ? (
            <span className="mic-device" data-testid="mic-device-label" title="The physical microphone the room is hearing.">
              {deviceLabel}
            </span>
          ) : null}
          <span className="mic-meter" aria-label="Microphone input level">
            <span className="mic-meter-fill" data-testid="mic-meter-fill" style={{ width: `${levelPercent}%` }} />
          </span>
          <span className="mic-stats" data-testid="mic-stats">
            {mode === "replay" ? "replay · " : "deepgram · "}
            {formatBytes(bytesReceived)} in
          </span>
        </>
      ) : null}
      {error ? <span className="mic-error" data-testid="mic-error">{error}</span> : null}
    </div>
  );
}


export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}


// NOTE: the FleetPanel rail is GONE (operator-directed redesign): its
// per-process controls now live in the anchored per-tree menu (TreeMenu.tsx),
// opened by picking a tree in the garden. FleetScroll.tsx / BuildChips.tsx
// stay as components — the deck HUD still composes BuildChips/ProcessControls.

export function TranscriptStream({ lines }: { lines: TranscriptLine[] }) {
  // Newest line FIRST: this is a passive wall display with no scroll
  // interaction, and appending at the bottom of an overflowing card meant new
  // lines landed below the fold — the transcript looked permanently frozen.
  const newestFirst = [...lines].reverse();
  return (
    <section className="rail-card transcript-card" data-region="transcript">
      <h3 className="rail-title">Transcript</h3>
      <div className="transcript-scroll">
        {newestFirst.map((line) => (
          <div key={`${line.time}-${line.speaker}-${line.text}`} className={`tx-line tx-${line.kind}`}>
            <span className="tx-meta">
              <time>{line.time}</time>
              <strong>{line.speaker}</strong>
            </span>
            <p>{line.text}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
