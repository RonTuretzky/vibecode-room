// Vibersyn bridge — maps a completed dwell on the gesture wall to a Vibersyn
// projector action (the "2 wall" setup: wall A is the gesture control surface,
// wall B is the Vibersyn idea projector).
//
// OPT-IN and NON-BREAKING: does nothing unless the wall client is opened with
// ?vibersyn=<vibersyn-base-url>. wall.js calls window.__vibersynBridge.onDwell(...)
// at its dwell seam; when the param is absent this is a no-op.
//
// URL params (on wall.html):
//   vibersyn     Vibersyn API base, e.g. http://localhost:8788   (enables the bridge)
//   vibersynmap  optional override, e.g. r0c0:capture,r1c2:emergency
//
// Vibersyn must allow this origin for cross-origin POSTs — run it with
//   VIBERSYN_CORS_ORIGIN=http://<gesture-wall-host>:8000
//
// Default zone→action map for a 2x3 control grid (zone ids are `r{row}c{col}`):
//   r0c0  Idea Capture   (toggle)   -> POST /api/capture      {on}
//   r0c1  Build idea      (oneshot)  -> POST /api/suggestion/accept
//   r0c2  Auto-Build      (toggle)   -> POST /api/auto-accept  {on}
//   r1c2  Emergency stop  (oneshot)  -> POST /api/emergency-stop

const ACTIONS = {
  capture: { endpoint: "/api/capture", kind: "toggle" },
  accept: { endpoint: "/api/suggestion/accept", kind: "oneshot" },
  build: { endpoint: "/api/suggestion/accept", kind: "oneshot" },
  autobuild: { endpoint: "/api/auto-accept", kind: "toggle" },
  emergency: { endpoint: "/api/emergency-stop", kind: "oneshot" },
};

const DEFAULT_MAP = {
  r0c0: "capture",
  r0c1: "accept",
  r0c2: "autobuild",
  r1c2: "emergency",
};

// Parse `zoneId:action,zoneId:action` into a { zoneId -> actionName } map.
export function parseZoneMap(spec) {
  if (!spec) return { ...DEFAULT_MAP };
  const map = {};
  for (const pair of spec.split(",")) {
    const [zone, action] = pair.split(":").map((s) => (s || "").trim());
    if (zone && action && ACTIONS[action]) map[zone] = action;
  }
  return Object.keys(map).length > 0 ? map : { ...DEFAULT_MAP };
}

// Build the bridge from a query string. Returns a bridge with onDwell(event, wall).
// `fetchImpl` is injectable for tests.
export function createBridge(search, fetchImpl) {
  const p = new URLSearchParams(search || "");
  const base = (p.get("vibersyn") || "").replace(/\/+$/, "");
  const enabled = base.length > 0;
  const zoneMap = parseZoneMap(p.get("vibersynmap"));
  const doFetch = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);

  async function post(endpoint, body) {
    if (!doFetch) return { ok: false, skipped: "no-fetch" };
    try {
      const res = await doFetch(base + endpoint, {
        method: "POST",
        mode: "cors",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      return { ok: res.ok, status: res.status };
    } catch (err) {
      // Non-authoritative control surface: a failed POST must never break the wall.
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  // NOTE (open-loop): a toggle tile mirrors the WALL's dwell-selected state to the
  // server as { on: selected }. This is a fire-and-forget TRIGGER, not a live
  // mirror of Vibersyn state — if capture/auto-build is changed elsewhere (e.g.
  // cleared by an emergency stop) the wall tile can transiently disagree until the
  // next dwell re-syncs it. Wall B (the Vibersyn projector) shows the authoritative
  // state; the wall-A tile color is only a local hint.

  // Resolve a dwell event to a POST (or null when the zone is unmapped or the
  // action is a oneshot being deselected). Pure — exported for tests.
  function resolve(event) {
    if (!enabled) return null;
    const actionName = zoneMap[event.zoneId];
    if (!actionName) return null;
    const action = ACTIONS[actionName];
    if (!action) return null;
    if (action.kind === "oneshot") {
      // Fire only on the "select" edge, never on deselect.
      return event.selected ? { endpoint: action.endpoint, body: undefined, actionName } : null;
    }
    return { endpoint: action.endpoint, body: { on: !!event.selected }, actionName };
  }

  return {
    enabled,
    base,
    zoneMap,
    resolve,
    onDwell(event) {
      const plan = resolve(event);
      if (!plan) return Promise.resolve(null);
      return post(plan.endpoint, plan.body);
    },
  };
}

// Auto-install on window when loaded in a browser. wall.js calls
// window.__vibersynBridge.onDwell(event, wall) — always defined (no-op if disabled).
if (typeof window !== "undefined") {
  const search = typeof location !== "undefined" ? location.search : "";
  window.__vibersynBridge = createBridge(search);
  if (window.__vibersynBridge.enabled) {
    // eslint-disable-next-line no-console
    console.log("[vibersyn-bridge] enabled →", window.__vibersynBridge.base, window.__vibersynBridge.zoneMap);
  }
}
