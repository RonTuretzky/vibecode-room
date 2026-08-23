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
  // ?mic=<label substring> — pin the room's capture to a specific microphone
  // (e.g. ?mic=wireless for a RØDE Wireless GO receiver). Absent → the
  // capture's room-mic policy (external over builtin) decides.
  mic: string | null;
  // TouchDesigner hand-pinch camera control, non-null ONLY on explicit opt-in.
  // ?hands=1 → default TD URL on the page's hostname (port 9980);
  // ?hands=ws://td-mac:9980 → explicit remote source; absent/"0"/"" → off.
  // Independent of the dwell gesture layer — composes with desk, ?dwell=mouse
  // and ?gesture=1.
  hands: { url: string } | null;
  // GUEST HANDS (?remote=): people on the room LAN drive this wall's
  // dwell-to-click layer from their own computers and phones (GET /hands on
  // the server). DEFAULT ON — the wall always listens and carries the
  // 🖐 Guests button that pops the QR; a guest layer with no guests costs
  // nothing (the overlay idles until a cursor exists). ?remote=0 opts out;
  // ?remote=ws://… names an explicit subscription URL (split-origin dev).
  // url null = same-origin default, resolved in App where window.location
  // exists (SSR therefore never mounts the layer).
  remote: { url: string | null } | null;
  // ?demo=guided — auto-enter the coached guided-demo flow on load (the HUD
  // "Guided Demo" button enters the same flow interactively).
  demo: "guided" | null;
  // ?mock=1 — expose the Mock Room fixture toggle. OFF by default so the live
  // wall never offers canned content; run-room.sh appends it only when
  // VIBERSYN_MOCK_ROOM=1 is set in the environment.
  mock: boolean;
  // ?flat=1 — the two wall windows sit side by side on ONE flat wall (no 90°
  // corner): lock them into the rigid split-frustum pair (see flat-lock.ts)
  // so the projections tile one continuous picture. run-room.sh appends it
  // via --flat. Needs ?wall= to pick this window's half; wins over the
  // corner lock.
  flat: boolean;
  // ?dots — per-window cursor-dot override: true (?dots=1) / false (?dots=0) /
  // the persisted hidden-by-default preference (GestureLayer). run-room.sh
  // appends it in gesture mode so pointing always has visible feedback.
  // null = unspecified (the stored preference — default visible — decides).
  dots: boolean | null;
  // ?stick=1 — the fusion cursor source is a JOYSTICK (run-room.sh --arcade,
  // no cameras): the guided demo's coaching says lever+button instead of
  // "point with your hand". Both sources speak the same ws protocol, so the
  // wall cannot tell them apart on its own — the launcher says which it wired.
  stick: boolean;
  // ?research=1 — force THIS window into the research-mode scene (the 3D
  // conversation tree + crystals) regardless of the room-wide toggle: a
  // dedicated display (e.g. a ceiling projector) always shows the tree while
  // the walls follow the shared mode. Local only — never writes the server.
  research: boolean;
  // ?zen=1 — boot with the zen (chrome-less) presentation on, same as the Z
  // key: just the scene, no trays/status chrome. For dedicated displays.
  zen: boolean;
  // ?park=1 — lay the REAL Central Park under the garden as a stylized
  // diorama (baked OSM data: water bodies, lawns, every footpath, and the
  // surveyed trees at their true positions — see src/ui/central-park.ts).
  park: boolean;
  // ?autofit= — continuous auto-framing override (the camera re-fits itself
  // to keep the whole scene in view as it grows): "1" forces it on for any
  // unlocked window, "0" forces it off, absent/unknown → null so App applies
  // the default (ON for research-pinned windows — the ceiling projector).
  // Corner/flat-locked pairs ignore it entirely: rigid pairs may not move.
  autoFit: boolean | null;
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
  const micParam = params.get("mic");
  const mic = micParam !== null && micParam.trim().length > 0 ? micParam.trim() : null;

  // TouchDesigner pinch camera (?hands=): camera CONTROL only, independent of
  // the dwell/gesture layers; ?hands=1 defaults to the TD port on this host.
  // Trimmed ONCE up front so "0 "/" " stay off and "1 " still opts in.
  const handsParam = params.get("hands")?.trim() ?? null;
  const hands =
    handsParam !== null && handsParam !== "" && handsParam !== "0"
      ? { url: handsParam !== "1" ? handsParam : `ws://${hostname || "localhost"}:9980` }
      : null;

  // Guest hands (?remote=): dwell control from other computers/phones on the
  // LAN. DEFAULT ON (absent/""/"1" → the same-origin relay); only an explicit
  // "0" opts out; a ws(s) URL names an explicit source.
  const remoteParam = params.get("remote")?.trim() ?? null;
  const remote =
    remoteParam === "0"
      ? null
      : { url: remoteParam !== null && remoteParam !== "" && remoteParam !== "1" ? remoteParam : null };

  // Guided demo auto-entry + the env-gated Mock Room toggle.
  const demo = params.get("demo") === "guided" ? ("guided" as const) : null;
  const mock = params.get("mock") === "1";

  // Flat-wall rig (?flat=1): the wall pair renders one continuous picture as
  // halves of a single wide frustum instead of the corner-locked yawed pair.
  const flat = params.get("flat") === "1";

  // Cursor dots: VISIBLE unless this window explicitly opts out with ?dots=0
  // (?dots=1 still forces on over a stored "0"). The old hidden-default made a
  // healthy joystick look dead — the default is never an invisible cursor.
  const dotsParam = params.get("dots");
  const dots = dotsParam === "0" ? false : dotsParam === "1" ? true : null;

  // Joystick-as-cursor flag (?stick=1): copy-only — the gesture layer itself
  // is source-agnostic; only the guided demo's wording keys on it.
  const stick = params.get("stick") === "1";

  // Dedicated-display extras: window-local research view + boot-into-zen.
  const research = params.get("research") === "1";
  const zen = params.get("zen") === "1";

  // Central Park diorama layer under the garden (?park=1).
  const park = params.get("park") === "1";

  // Continuous auto-framing tri-state: explicit "1"/"0" override, anything
  // else defers (null) to App's default (on for research-pinned windows).
  const autoFitParam = params.get("autofit");
  const autoFit = autoFitParam === "1" ? true : autoFitParam === "0" ? false : null;

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

  return { view, wall, badge, gesture, dwell,
    mic, hands, remote, demo, mock, flat, dots, stick, research, zen, park, autoFit };
}
