// Projector window configuration parsed from the URL query string.
//
// Desk mode is the default: mouse + keyboard + voice, NO gesture layer. The
// gesture wall is legacy/opt-in — it mounts ONLY on an explicit `?gesture=1` or
// `?fusion=` param. A bare `?wall=A` is just the wall identity badge so a
// two-wall projection can label its windows without cameras or a fusion server.

export type ProjectorView = "ideas" | "builds" | "full";

export interface ProjectorUrlConfig {
  // Per-wall PANEL PLACEMENT. The two walls are ONE continuous room — neither
  // is "the idea wall" or "the build wall". ?view only decides which
  // single-instance persistent panels a window carries (?view=ideas: idea tray
  // + capture cluster; ?view=builds: fleet rail + QR button + transcript); the
  // default full view renders everything (single-window desk mode). The 3D
  // room scene always stays full on every window, and on-demand overlays
  // (detail/deck/QR/guided) open on whichever wall summons them.
  view: ProjectorView;
  // Wall identity (e.g. "A"), or null when this is not a wall-bound window.
  wall: string | null;
  // The subtle corner badge text ("WALL A"), or null to hide the badge.
  badge: string | null;
  // Gesture layer config, non-null ONLY when explicitly requested via the URL.
  gesture: { wall: string; fusionUrl: string } | null;
  // ?dwell=mouse — testing/accessibility fallback: the mouse drives the SAME
  // point→highlight→dwell-select mechanic (no cameras needed). The OS cursor
  // stays visible; only pure gesture mode hides it.
  dwell: "mouse" | null;
  // ?demo=guided — auto-enter the coached guided-demo flow on load (the HUD
  // "Guided Demo" button enters the same flow interactively).
  demo: "guided" | null;
  // ?mock=1 — expose the Mock Room fixture toggle. OFF by default so the live
  // wall never offers canned content; run-room.sh appends it only when
  // VIBERSYN_MOCK_ROOM=1 is set in the environment.
  mock: boolean;
}

export function parseProjectorUrl(search: string, hostname: string): ProjectorUrlConfig {
  const params = new URLSearchParams(search);

  const wallParam = params.get("wall");
  const wall = wallParam !== null && wallParam.trim().length > 0 ? wallParam.trim() : null;

  const viewParam = params.get("view");
  const viewExplicit = viewParam === "ideas" || viewParam === "builds" || viewParam === "full";
  const view: ProjectorView = viewParam === "ideas" || viewParam === "builds" ? viewParam : "full";

  // Gesture wall (legacy): ?gesture=1 opts in with the default fusion URL;
  // ?fusion= present (even empty) is an explicit request too, so old links keep
  // working. The wall id defaults to "A" when only the gesture flag is given.
  const fusionParam = params.get("fusion");
  const gestureRequested = params.get("gesture") === "1" || fusionParam !== null;
  const gesture = gestureRequested
    ? {
        wall: wall ?? "A",
        fusionUrl:
          fusionParam !== null && fusionParam.trim().length > 0
            ? fusionParam
            : `ws://${hostname || "localhost"}:8770`,
      }
    : null;

  // Mouse-dwell fallback (?dwell=mouse): desk testing / accessibility path for
  // the gesture interaction — independent of gesture mode.
  const dwell = params.get("dwell") === "mouse" ? ("mouse" as const) : null;

  // Guided demo auto-entry + the env-gated Mock Room toggle.
  const demo = params.get("demo") === "guided" ? ("guided" as const) : null;
  const mock = params.get("mock") === "1";

  // Corner identity badge: shown whenever the window is wall- or view-scoped so
  // an operator glancing across the room knows which projection they're facing.
  // DE-THEMED: a wall badge is just "WALL A" — the walls are one continuous
  // room, not an idea wall and a build wall, so the view never brands a wall.
  const badge =
    wall !== null
      ? `WALL ${wall.toUpperCase()}`
      : viewExplicit
        ? view.toUpperCase()
        : null;

  return { view, wall, badge, gesture, dwell, demo, mock };
}
