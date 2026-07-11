// Projector window configuration parsed from the URL query string.
//
// Desk mode is the default: mouse + keyboard + voice, NO gesture layer. The
// gesture wall is legacy/opt-in — it mounts ONLY on an explicit `?gesture=1` or
// `?fusion=` param. A bare `?wall=A` is just the wall identity badge so a
// two-wall projection can label its windows without cameras or a fusion server.

export type ProjectorView = "ideas" | "builds" | "full";

export interface ProjectorUrlConfig {
  // Which slice of the board this window shows. "ideas" = idea bubble + tray +
  // transcript (fleet hidden); "builds" = process bubbles + fleet rail (idea
  // surfaces hidden); "full" (default) = everything.
  view: ProjectorView;
  // Wall identity (e.g. "A"), or null when this is not a wall-bound window.
  wall: string | null;
  // The subtle corner badge text ("WALL A · IDEAS"), or null to hide the badge.
  badge: string | null;
  // Gesture layer config, non-null ONLY when explicitly requested via the URL.
  gesture: { wall: string; fusionUrl: string } | null;
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

  // Corner identity badge: shown whenever the window is wall- or view-scoped so
  // an operator glancing across the room knows which projection they're facing.
  const badge =
    wall !== null
      ? `WALL ${wall.toUpperCase()} · ${view.toUpperCase()}`
      : viewExplicit
        ? view.toUpperCase()
        : null;

  return { view, wall, badge, gesture };
}
