import { useCallback, useEffect, useState } from "react";

// PROJECTOR AUTO-CALIBRATION overlay: the walls flip into calibration mode by
// themselves. The calibrator (gesturewall.autocal, its own python server on
// port 8801) sweeps bright discs across each projector while the Kinects
// difference OFF/ON frames of them; historically the operator had to open
// autocal.html fullscreen on every projector by hand. Now every wall-bound
// room window (?wall=A|B) polls the room server's /api/autocal proxy — same
// origin, so no CORS and it works when the wall browser is not on the
// calibrator's host — and, whenever a calibrator is up, flips itself into a
// fullscreen calibration surface. When the calibrator exits (proxy answers
// {up:false}) the overlay unmounts and the room comes back untouched.
//
// MEASUREMENT FIDELITY: while phase=running this surface must be EXACTLY what
// the calibrator solved against — pure #000 with a single flat #fff disc at
// showDot's geometry (see gesture-wall/web/autocal.html), no shadows, no
// animation, no other visible chrome.

export type AutocalPhase = "idle" | "running" | "done" | "error";

export interface AutocalMarker {
  wall: string;
  u: number;
  v: number;
  // Radius FRACTION of min(viewport W,H) — the same contract autocal.html's
  // showDot takes (the server sends ~0.11, bigger on retry passes). Null =
  // fall back to the default fraction.
  r?: number | null;
}

export interface AutocalState {
  phase: AutocalPhase;
  marker: AutocalMarker | null;
  msg?: string;
}

// Poll cadences: a calibrator is almost never running, so the resting probe
// stays cheap (3s, forever); once one is up the marker sequence moves fast,
// so the overlay tracks at 150ms — near autocal.html's own 120ms tick.
export const AUTOCAL_POLL_ABSENT_MS = 3_000;
export const AUTOCAL_POLL_ACTIVE_MS = 150;
// A finished sweep flips the wall back to the room by itself after this long
// on the ✓ screen — the calibrator process may keep serving its "done" state
// (the legacy operator contract was Ctrl-C), and the room must not wait on
// it. Errors do NOT auto-dismiss: a failed calibration stays visible until
// the calibrator exits.
export const AUTOCAL_DONE_LINGER_MS = 8_000;

// Parse a /api/autocal/state proxy body. Null = no calibrator: the proxy's
// {up:false} answer, or anything that is not a calibrator state — the overlay
// stays down and the window remains a room.
export function parseAutocalState(body: unknown): AutocalState | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const record = body as { phase?: unknown; marker?: unknown; msg?: unknown };
  if (
    record.phase !== "idle" &&
    record.phase !== "running" &&
    record.phase !== "done" &&
    record.phase !== "error"
  ) {
    return null;
  }
  let marker: AutocalMarker | null = null;
  const rawMarker = record.marker as { wall?: unknown; u?: unknown; v?: unknown; r?: unknown } | null | undefined;
  if (
    typeof rawMarker === "object" &&
    rawMarker !== null &&
    typeof rawMarker.wall === "string" &&
    typeof rawMarker.u === "number" &&
    typeof rawMarker.v === "number"
  ) {
    marker = {
      wall: rawMarker.wall,
      u: rawMarker.u,
      v: rawMarker.v,
      r: typeof rawMarker.r === "number" ? rawMarker.r : null,
    };
  }
  return { phase: record.phase, marker, msg: typeof record.msg === "string" ? record.msg : undefined };
}

// EXACT parity with autocal.html's showDot(u, v, rf): the cameras measured
// discs with THIS geometry when the config was solved, so the room overlay
// must reproduce it bit-for-bit — radius is a fraction of min(W,H) with a
// 46px floor (survives 512x424 depth frames + oblique angles), and the disc
// is CENTERED on (u*W, v*H).
export function discGeometry(
  marker: AutocalMarker,
  width: number,
  height: number,
): { left: number; top: number; radius: number } {
  const radius = Math.max(46, Math.min(width, height) * (marker.r || 0.11));
  return { left: marker.u * width - radius, top: marker.v * height - radius, radius };
}

export function CalibrationOverlay({
  wall,
  initialState,
  onActiveChange,
}: {
  // This window's wall identity: the measurement disc renders ONLY for markers
  // addressed to this wall (each projector sweeps its own marker sequence).
  wall: string;
  // Test seam (the initialOverlay pattern): boot with a calibrator state so
  // the static, effect-free test renderer can assert the idle/running/done/
  // error surfaces without a network.
  initialState?: AutocalState | null;
  // Lets App suppress the build-stamp auto-reload while a calibration is live
  // (a mid-sweep reload would blank the disc the camera is measuring).
  onActiveChange?: (active: boolean) => void;
}) {
  const [state, setState] = useState<AutocalState | null>(initialState ?? null);
  // Viewport for the disc geometry (kept in state so a resize re-renders the
  // disc). The SSR fallback never reaches a camera — effects re-measure on
  // mount in a real browser.
  const [viewport, setViewport] = useState(() =>
    typeof window === "undefined"
      ? { width: 1920, height: 1080 }
      : { width: window.innerWidth, height: window.innerHeight },
  );

  // Poll the same-origin proxy on a self-rescheduling timeout: 3s while no
  // calibrator exists (cheap, forever), 150ms while one is up. A failed fetch
  // counts as "gone" so a killed calibrator always returns the room.
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let doneSince: number | null = null;
    const poll = async () => {
      let next: AutocalState | null = null;
      try {
        const response = await fetch("/api/autocal/state", { headers: { accept: "application/json" } });
        if (response.ok && response.headers.get("content-type")?.includes("application/json")) {
          next = parseAutocalState(await response.json());
        }
      } catch {
        next = null; // proxy unreachable — same as no calibrator
      }
      if (closed) {
        return;
      }
      // Auto-return after a completed sweep even while the calibrator still
      // serves "done" — the wall's job is finished once the ✓ has been seen.
      if (next !== null && next.phase === "done") {
        if (doneSince === null) {
          doneSince = Date.now();
        } else if (Date.now() - doneSince > AUTOCAL_DONE_LINGER_MS) {
          next = null;
        }
      } else {
        doneSince = null;
      }
      setState(next);
      timer = setTimeout(poll, next === null ? AUTOCAL_POLL_ABSENT_MS : AUTOCAL_POLL_ACTIVE_MS);
    };
    void poll();
    return () => {
      closed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const update = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  // Report activity to App (the auto-reload guard) whenever presence flips.
  const active = state !== null;
  useEffect(() => {
    onActiveChange?.(active);
  }, [active, onActiveChange]);

  // ANY wall may start the sweep — the calibrator runs every wall's marker
  // sequence in one pass, so the button is just "go" for the whole room.
  const startSweep = useCallback(() => {
    void fetch("/api/autocal/start", { method: "POST" }).catch(() => {
      // The next state poll tells the truth; a failed start never wedges the overlay.
    });
  }, []);

  if (state === null) {
    return null;
  }

  const marker = state.marker;
  const showDisc =
    state.phase === "running" && marker !== null && marker.wall.toUpperCase() === wall.toUpperCase();
  const geometry = showDisc && marker !== null ? discGeometry(marker, viewport.width, viewport.height) : null;

  return (
    <div
      className="calibration-overlay"
      data-testid="calibration-overlay"
      data-phase={state.phase}
      data-wall={wall}
    >
      {state.phase === "idle" ? (
        <>
          <div className="calibration-letter" data-testid="calibration-letter">
            {wall.toUpperCase()}
          </div>
          <p className="calibration-ready">calibration ready</p>
          <button
            type="button"
            className="ctl-button calibration-start"
            data-testid="calibration-start-button"
            onClick={startSweep}
            title="Start the auto-calibration sweep — every wall flips into its calibration surface. Keep out of the cameras' view once it starts."
          >
            ▶ Start sweep
          </button>
        </>
      ) : null}
      {geometry !== null && marker !== null ? (
        <div
          className="calibration-disc"
          data-testid="calibration-disc"
          data-u={marker.u}
          data-v={marker.v}
          data-r={marker.r ?? ""}
          style={{
            left: `${geometry.left}px`,
            top: `${geometry.top}px`,
            width: `${geometry.radius * 2}px`,
            height: `${geometry.radius * 2}px`,
          }}
        />
      ) : null}
      {state.phase === "done" ? (
        <div className="calibration-done" data-testid="calibration-done">
          ✓
        </div>
      ) : null}
      {state.phase === "error" ? (
        <p className="calibration-error" data-testid="calibration-error">
          CALIBRATION FAILED: {state.msg ?? "unknown"}
        </p>
      ) : null}
    </div>
  );
}
