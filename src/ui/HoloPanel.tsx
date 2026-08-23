import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ProjectorProcess } from "./types";
import type { SceneDwellRect } from "./gesture/scene-source";
import { treeMenuPlacement } from "./TreeMenu";
import "./HoloPanel.css";

/**
 * Holo panel — the imported tree's LIVE deployment, floating beside the tree.
 *
 * Screen-anchored glass like TreeMenu (the same clamped placement math), NOT a
 * CSS3DRenderer object: the panel is a fixed-position card with perspective +
 * a slight rotateY tilt toward screen center, a cyan glow border and a cheap
 * CSS scanline overlay — it READS as a hologram without costing a render pass.
 *
 * Content is an iframe onto the room server's OWN /salem reverse proxy (the
 * authenticated labor.fun board): same-origin by construction, so the dwell
 * chrome can drive it directly — page-row buttons swap the iframe src, the
 * ⬆/⬇ buttons call contentWindow.scrollBy (no postMessage handshake needed),
 * ⟳ remounts the frame, ✕ closes. Every control is a plain enabled <button>
 * (GestureLayer's collectDomTargets makes them dwell targets automatically)
 * and the panel root carries data-dwell-shield so READING the board never
 * counts as a dwell-miss dismissal.
 */

export const HOLO_PANEL_WIDTH = 960;
export const HOLO_PANEL_HEIGHT = 600;
// The hologram lean: degrees of rotateY, signed toward screen center.
export const HOLO_TILT_DEG = 7;
// One scroll-button press moves the board this many CSS pixels.
export const HOLO_SCROLL_STEP_PX = 320;

export interface HoloPage {
  label: string;
  path: string;
}

// The board's dwell-navigable pages (the iframe's in-app nav is tiny at
// projector distance — these rows are the gesture-native chrome).
export const HOLO_PAGES: HoloPage[] = [
  { label: "Home", path: "/" },
  { label: "Calendar", path: "/calendar" },
  { label: "Chores", path: "/chores" },
  { label: "Points", path: "/points" },
  { label: "Hearts", path: "/hearts" },
];

// Map a board path onto the /salem proxy: "/" is the proxy root "/salem/",
// deeper paths ride verbatim ("/chores" → "/salem/chores").
export function salemSrc(path: string): string {
  return path === "/" ? "/salem/" : `/salem${path}`;
}

// Pure: the hologram lean, tilted TOWARD screen center. CSS rotateY(+θ) turns
// the right edge away from the viewer — a panel resting on the RIGHT half
// leans +θ to face the center, one on the LEFT half leans -θ.
export function holoPanelTilt(panelLeft: number, panelWidth: number, viewportWidth: number): number {
  return panelLeft + panelWidth / 2 >= viewportWidth / 2 ? HOLO_TILT_DEG : -HOLO_TILT_DEG;
}

// SSR-safe measure (mirrors TreeMenu): layout effect in the browser, plain
// effect on the server so renderToStaticMarkup stays quiet.
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export interface HoloPanelProps {
  process: ProjectorProcess;
  // The tree's screen rect at open time (the TreeMenu's anchor rides along);
  // null = no projection → edge resting, same contract as TreeMenu.
  anchor: SceneDwellRect | null;
  onClose: () => void;
}

export function HoloPanel({ process, anchor, onClose }: HoloPanelProps) {
  const [src, setSrc] = useState(salemSrc("/"));
  // Remount key: ⟳ bumps it so an identical src still reloads the frame.
  const [reloadNonce, setReloadNonce] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const viewport =
    typeof window !== "undefined"
      ? { width: window.innerWidth, height: window.innerHeight }
      : { width: 1920, height: 1080 };
  // REAL-SIZE placement (TreeMenu's pattern): CSS decides the true footprint
  // (gesture mode grows the chrome), so measure and re-place pre-paint.
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
  const size = measured ?? { width: HOLO_PANEL_WIDTH, height: HOLO_PANEL_HEIGHT };
  const placement = treeMenuPlacement(anchor, viewport, size);
  const tilt = holoPanelTilt(placement.left, size.width, viewport.width);

  // Same-origin via the proxy: drive the board's scroll directly. The
  // try/catch is belt and braces for a frame mid-navigation.
  const scrollBoard = (delta: number): void => {
    try {
      iframeRef.current?.contentWindow?.scrollBy(0, delta);
    } catch {
      // Frame not ready — the press is a no-op, never a crash.
    }
  };

  const title = process.task.length > 0 ? process.task : process.callsign;

  return (
    <section
      ref={panelRef}
      className="holo-panel"
      data-testid="holo-panel"
      data-upid={process.upid}
      // Dwell-miss dismissal shield (popup-dismiss.ts): reading the board must
      // never count as pointing at empty ground.
      data-dwell-shield="1"
      role="dialog"
      aria-label={`Live app for ${process.callsign}`}
      style={{
        left: `${Math.round(placement.left)}px`,
        top: `${Math.round(placement.top)}px`,
        transform: `perspective(1600px) rotateY(${tilt}deg)`,
      }}
      onClick={(clickEvent) => clickEvent.stopPropagation()}
    >
      <header className="holo-head">
        <span className="holo-title" data-testid="holo-title">
          🌐 {title} — live
        </span>
        <button
          type="button"
          className="ctl-button holo-close"
          data-testid="holo-close"
          title="Close the live app panel"
          onClick={onClose}
        >
          ✕
        </button>
      </header>
      <nav className="holo-pages" data-testid="holo-pages">
        {HOLO_PAGES.map((page) => (
          <button
            key={page.path}
            type="button"
            className={`holo-page${src === salemSrc(page.path) ? " is-current" : ""}`}
            data-testid="holo-page"
            data-path={page.path}
            title={`Show the board's ${page.label} page`}
            onClick={() => setSrc(salemSrc(page.path))}
          >
            {page.label}
          </button>
        ))}
      </nav>
      <div className="holo-frame-wrap">
        <iframe
          key={`${src}#${reloadNonce}`}
          ref={iframeRef}
          className="holo-frame"
          data-testid="holo-frame"
          src={src}
          title={`Live deployment for ${process.callsign}`}
          sandbox="allow-scripts allow-same-origin allow-forms"
        />
        {/* Cheap hologram dressing: a CSS repeating-gradient scanline sheet. */}
        <div className="holo-scanlines" aria-hidden="true" />
      </div>
      <div className="holo-controls">
        <button
          type="button"
          className="ctl-button holo-scroll"
          data-testid="holo-scroll-up"
          title="Scroll the board up"
          onClick={() => scrollBoard(-HOLO_SCROLL_STEP_PX)}
        >
          ⬆
        </button>
        <button
          type="button"
          className="ctl-button holo-scroll"
          data-testid="holo-scroll-down"
          title="Scroll the board down"
          onClick={() => scrollBoard(HOLO_SCROLL_STEP_PX)}
        >
          ⬇
        </button>
        <button
          type="button"
          className="ctl-button holo-reload"
          data-testid="holo-reload"
          title="Reload the board"
          onClick={() => setReloadNonce((nonce) => nonce + 1)}
        >
          ⟳
        </button>
      </div>
    </section>
  );
}
