import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ProjectorProcess } from "./types";
import type { SceneDwellRect } from "./gesture/scene-source";
import { executionOf } from "./stage";
import { treeMenuPlacement } from "./TreeMenu";
import "./HoloPanel.css";

/**
 * Holo panel — a tree's LIVE app, floating beside the tree. TWO sources:
 *
 *   • an imported tree's confirmed deployment (process.deployUrl) — shown via
 *     the room server's OWN /salem reverse proxy (the authenticated labor.fun
 *     board): same-origin by construction, so the page rows + scroll buttons
 *     can drive it directly;
 *   • a COMMISSIONED build that finished — the execution lane's served
 *     full-app preview (executionOf(process).previewUrl, the real artifacts
 *     under artifacts/vibersyn-runs/<upid>/). This is the loop's promised
 *     ending on the wall: "Build it for real" ends in a browsable app here.
 *     The preview is another loopback origin (cross-origin to the wall), so
 *     the salem page rows are hidden and scrollBy degrades to a guarded no-op;
 *     ⟳ and ✕ still work.
 *
 * Screen-anchored glass like TreeMenu (the same clamped placement math), NOT a
 * CSS3DRenderer object: the panel is a fixed-position card with perspective +
 * a slight rotateY tilt toward screen center, a cyan glow border and a cheap
 * CSS scanline overlay — it READS as a hologram without costing a render pass.
 * Every control is a plain enabled <button> (GestureLayer's collectDomTargets
 * makes them dwell targets automatically) and the panel root carries
 * data-dwell-shield so READING the app never counts as a dwell-miss dismissal.
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
  // Content source (see the header): a confirmed deployment rides the /salem
  // proxy; otherwise a BUILT commission's served preview is the live app.
  const deployUrl = typeof process.deployUrl === "string" && process.deployUrl.length > 0 ? process.deployUrl : null;
  const execution = executionOf(process);
  const builtPreviewUrl =
    deployUrl === null && execution?.status === "built" && execution.previewUrl !== null ? execution.previewUrl : null;
  const frameSrc = builtPreviewUrl ?? src;
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
          🌐 {title} — {builtPreviewUrl !== null ? "built app, live" : "live"}
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
      {/* The salem page rows only make sense for the proxied board — a built
          commission preview is its own app with its own nav. */}
      {builtPreviewUrl === null ? (
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
      ) : null}
      <div className="holo-frame-wrap">
        <iframe
          key={`${frameSrc}#${reloadNonce}`}
          ref={iframeRef}
          className="holo-frame"
          data-testid="holo-frame"
          data-holo-source={builtPreviewUrl !== null ? "execution" : "deploy"}
          src={frameSrc}
          title={`Live app for ${process.callsign}`}
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
