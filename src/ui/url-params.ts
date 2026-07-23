// Projector window configuration parsed from the URL query string.
//
// Desk mode is the default: mouse + keyboard + voice, NO gesture layer. The
// gesture wall is legacy/opt-in — it mounts ONLY on an explicit `?gesture=1` or
// `?fusion=` param. A bare `?wall=A` is just the wall identity badge so a
// two-wall projection can label its windows without cameras or a fusion server.

export type ProjectorView = "ideas" | "builds" | "full";

export interface ProjectorUrlConfig {
  // LEGACY view param. Still parsed so old two-wall URLs (?view=ideas|builds)
  // keep working and the wall badge still reads "WALL A · IDEAS", but it is
  // INERT for content: every window renders the FULL room (all ideas AND all
  // builds) regardless of this value.
  view: ProjectorView;
  // Wall identity (e.g. "A"), or null when this is not a wall-bound window.
  wall: string | null;
  // The subtle corner badge text ("WALL A · IDEAS"), or null to hide the badge.
  badge: string | null;
  // Gesture layer config, non-null ONLY when explicitly requested via the URL.
  gesture: { wall: string; fusionUrl: string } | null;
  // ?dwell=mouse — testing/accessibility fallback: the mouse drives the SAME
  // point→highlight→dwell-select mechanic (no cameras needed). The OS cursor
  // stays visible; only pure gesture mode hides it.
  dwell: "mouse" | null;
  // TouchDesigner hand-pinch camera control, non-null ONLY on explicit opt-in.
  // ?hands=1 → default TD URL on the page's hostname (port 9980);
  // ?hands=ws://td-mac:9980 → explicit remote source; absent/"0"/"" → off.
  // Independent of the dwell gesture layer — composes with desk, ?dwell=mouse
  // and ?gesture=1.
  hands: { url: string } | null;
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

  // TouchDesigner pinch camera (?hands=): camera CONTROL only, independent of
  // the dwell/gesture layers; ?hands=1 defaults to the TD port on this host.
  // Trimmed ONCE up front so "0 "/" " stay off and "1 " still opts in.
  const handsParam = params.get("hands")?.trim() ?? null;
  const hands =
    handsParam !== null && handsParam !== "" && handsParam !== "0"
      ? { url: handsParam !== "1" ? handsParam : `ws://${hostname || "localhost"}:9980` }
      : null;

  // Guided demo auto-entry + the env-gated Mock Room toggle.
  const demo = params.get("demo") === "guided" ? ("guided" as const) : null;
  const mock = params.get("mock") === "1";

  // Corner identity badge: shown whenever the window is wall- or view-scoped so
  // an operator glancing across the room knows which projection they're facing.
  const badge =
    wall !== null
      ? `WALL ${wall.toUpperCase()} · ${view.toUpperCase()}`
      : viewExplicit
        ? view.toUpperCase()
        : null;

  return { view, wall, badge, gesture, dwell, hands, demo, mock };
}
