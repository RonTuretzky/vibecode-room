import { Hono } from "hono";
import { resolve } from "node:path";
import { withUnmuted } from "../ui/demo-data";
import type { ProjectorSnapshot } from "../ui/types";
import type { ProjectorRuntime } from "./composition";
import { healthPayload } from "./degradation-notice";
import { corsEnabledWarning, vibersynCors } from "./cors";
import { importPageHtml } from "./import-page";
import { handsPageHtml } from "./hands-page";
import { RemoteHandsHub, resolveHandsInfo } from "./remote-hands";
import { resolveImportInfo, type InterfaceAddresses } from "./project-import";
import { createSeamApp } from "../seam/dispatcher";

export interface ProjectorAppOptions {
  env?: Record<string, string | undefined>;
  // The host/port the HTTP server is bound to. /api/import/info derives the
  // phone-reachable submit URL (and the lanReachable flag) from them.
  host?: string;
  port?: number;
  // The dedicated phone-import listener's port (a second 0.0.0.0 socket bound
  // in index.ts serving ONLY the import surface). When set, /api/import/info
  // advertises it via the best LAN IPv4 regardless of the main bind — the QR
  // works without HOST=0.0.0.0. Null/absent = listener disabled or bind
  // failed: fall back to deriving reachability from the main host/port.
  phonePort?: number | null;
  // The optional TLS listener's port (guest camera hand-tracking needs a
  // secure origin). Null/absent = TLS listener off; /api/hands/info then omits
  // the https URL and the guest page degrades to trackpad-only off-host.
  tlsPort?: number | null;
  // The guest-hands relay hub, SHARED with the WS upgrade paths in index.ts so
  // /api/hands/info reports the live guest count. Absent (tests) = own hub.
  hands?: RemoteHandsHub;
  // Test seam for os.networkInterfaces (LAN IPv4 discovery).
  interfaces?: () => InterfaceAddresses;
}

// Build the projector's HTTP app over a live runtime. Extracted from the boot
// entry (index.ts) so endpoint behavior — referer guards, validation, response
// shapes — is testable via app.request() with no server or port.
export function createProjectorApp(runtime: ProjectorRuntime, options: ProjectorAppOptions = {}): Hono {
  const env = options.env ?? process.env;
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;
  const app = new Hono();
  // Cross-origin access for the API (off unless VIBERSYN_CORS_ORIGIN is set). Lets an
  // external control surface — e.g. a phone-side helper — POST /api/capture,
  // /api/suggestion/accept, /api/emergency-stop from its own origin. Mounted before
  // the routes so preflight (OPTIONS) is handled.
  const corsMiddleware = vibersynCors(env);
  if (corsMiddleware !== null) {
    app.use("/api/*", corsMiddleware);
    const warning = corsEnabledWarning(env);
    if (warning !== null) {
      console.warn(`[cors] ${warning}`);
    }
  }

  // Seam action API (Cue<->Smithers seam over the LIVE runtime): POST
  // /api/seam/actions and WS /api/seam/ws accept DispatchedActions, GET
  // /api/seam/status returns the real fleet summary, GET /api/seam/health pings.
  // Wired to the same registry as the voice/click paths via runtime.seamDispatcher.
  app.route("/api/seam", createSeamApp(runtime.seamDispatcher));
  app.get("/api/health", (context) => context.json(healthPayload(runtime)));
  app.get("/api/state", (context) => context.json(runtime.snapshot()));
  app.get("/api/events", () => eventsResponse(runtime));
  // REQ-2 / REQ-14: in the real (live) projector path these controls ALWAYS drive
  // the real MuteController / EmergencyStopController — see runtime.unmute() /
  // runtime.emergencyStop(). A client explicitly loaded in OFFLINE-DEMO mode
  // (?live=0) is not bound to the live pipeline (it ignores /api/state + SSE and
  // renders static fixtures), so its control presses must not mutate the shared
  // runtime; we return a purely cosmetic snapshot for those instead.
  app.post("/api/unmute", async (context) => {
    if (isOfflineDemoRequest(context.req.header("referer"))) {
      return context.json(withUnmuted(runtime.snapshot()));
    }

    const snapshot = await runtime.unmute();
    return context.json(snapshot);
  });
  app.post("/api/emergency-stop", async (context) => {
    if (isOfflineDemoRequest(context.req.header("referer"))) {
      return context.json(emergencyDemoSnapshot(runtime.snapshot()));
    }

    const snapshot = await runtime.emergencyStop();
    return context.json(snapshot);
  });
  // CLICK THE IDEA BUBBLE -> BUILD. Accept the current pending suggestion directly
  // (no spoken "yes"): spawns through the same accept path so the idea-builder runs
  // and a process with previewUrl/buildStatus appears on the returned snapshot. A
  // no-op returning the current snapshot when there is no pending suggestion.
  app.post("/api/suggestion/accept", async (context) => {
    if (isOfflineDemoRequest(context.req.header("referer"))) {
      return context.json(runtime.snapshot());
    }
    const snapshot = await runtime.acceptPendingSuggestion();
    return context.json(snapshot);
  });
  // IDEA TRAY: accept a SPECIFIC ledger candidate by id — the same spawn/build
  // path as /api/suggestion/accept takes for the primary. 404-free by contract:
  // an unknown id returns the current snapshot unchanged.
  app.post("/api/idea/:id/accept", async (context) => {
    if (isOfflineDemoRequest(context.req.header("referer"))) {
      return context.json(runtime.snapshot());
    }
    const snapshot = await runtime.acceptIdea(context.req.param("id"));
    return context.json(snapshot);
  });
  // IDEA TRAY: explicitly dismiss a candidate — dropped from the ledger and its
  // pitch suppressed for the accept-cooldown window. Unknown id → snapshot unchanged.
  app.post("/api/idea/:id/dismiss", (context) => {
    if (isOfflineDemoRequest(context.req.header("referer"))) {
      return context.json(runtime.snapshot());
    }
    return context.json(runtime.dismissIdea(context.req.param("id")));
  });
  // Phone import surface (shared with the dedicated 0.0.0.0 phone listener —
  // see createPhoneImportApp): POST /api/projects/import, GET /api/import/info,
  // GET /submit.
  registerImportSurface(app, runtime, {
    host,
    port,
    phonePort: options.phonePort ?? null,
    interfaces: options.interfaces,
  });
  // Guest-hands surface (shared with the LAN listeners — see
  // registerHandsSurface): GET /hands, GET /api/hands/info. The WS legs
  // (/hands/ws guest ingest, /api/hands/room wall subscription) upgrade in
  // index.ts against the same hub.
  registerHandsSurface(app, options.hands ?? new RemoteHandsHub(), {
    host,
    port,
    phonePort: options.phonePort ?? null,
    tlsPort: options.tlsPort ?? null,
    interfaces: options.interfaces,
  });
  // AUTO-BUILD toggle (no click required). Body `{ on: boolean }` sets it
  // explicitly; absent body flips the current state. Returns the fresh snapshot.
  app.post("/api/auto-accept", async (context) => {
    if (isOfflineDemoRequest(context.req.header("referer"))) {
      return context.json(runtime.snapshot());
    }
    let on = !runtime.autoAccept();
    try {
      const body = (await context.req.json()) as { on?: unknown };
      if (typeof body?.on === "boolean") {
        on = body.on;
      }
    } catch {
      // no/!invalid body -> toggle current state
    }
    return context.json(runtime.setAutoAccept(on));
  });
  // IDEA CAPTURE mode toggle (alternative to passive auto-detect). Body `{ on: boolean }`
  // sets it explicitly; absent body flips the current state. When on, detection runs
  // eagerly (a rate-limited force-detect per final); building still requires an explicit
  // accept or the AUTO-BUILD toggle. Returns the snapshot.
  app.post("/api/capture", async (context) => {
    if (isOfflineDemoRequest(context.req.header("referer"))) {
      return context.json(runtime.snapshot());
    }
    let on = !runtime.captureMode();
    try {
      const body = (await context.req.json()) as { on?: unknown };
      if (typeof body?.on === "boolean") {
        on = body.on;
      }
    } catch {
      // no/invalid body -> toggle current state
    }
    return context.json(runtime.setCaptureMode(on));
  });
  // RESEARCH MODE toggle. Body `{ on: boolean }` sets it explicitly; absent
  // body flips the current state. When on, the research suggester watches the
  // conversation and proposes quests (fact-checks / deep-dives / bias scans);
  // researching still requires an explicit accept. Returns the snapshot.
  app.post("/api/research-mode", async (context) => {
    if (isOfflineDemoRequest(context.req.header("referer"))) {
      return context.json(runtime.snapshot());
    }
    let on = !runtime.researchMode();
    try {
      const body = (await context.req.json()) as { on?: unknown };
      if (typeof body?.on === "boolean") {
        on = body.on;
      }
    } catch {
      // no/invalid body -> toggle current state
    }
    return context.json(runtime.setResearchMode(on));
  });
  // RESEARCH TRAY: accept a PROPOSED quest — spawns the research agent (web
  // research + adversarial fact-check + bias scan) in the background. 404-free
  // by contract: an unknown id returns the current snapshot unchanged.
  app.post("/api/research/:id/accept", (context) => {
    if (isOfflineDemoRequest(context.req.header("referer"))) {
      return context.json(runtime.snapshot());
    }
    return context.json(runtime.acceptResearch(context.req.param("id")));
  });
  // DIALOGUE TREE: research a TURN directly — clicking/dwelling a turn node on
  // the wall spawns the quest+agent in one step (no proposal round needed).
  app.post("/api/research/turn/:id", (context) => {
    if (isOfflineDemoRequest(context.req.header("referer"))) {
      return context.json(runtime.snapshot());
    }
    return context.json(runtime.researchTurn(context.req.param("id")));
  });
  // FOLLOW-UP: spawn one of a completed dossier's open questions as its own
  // quest (body: {index}). Bad input degrades to a no-op current snapshot.
  app.post("/api/research/:id/followup", async (context) => {
    if (isOfflineDemoRequest(context.req.header("referer"))) {
      return context.json(runtime.snapshot());
    }
    let index = Number.NaN;
    try {
      const body = (await context.req.json()) as { index?: unknown };
      index = Number(body?.index);
    } catch {
      // Malformed body → NaN → the runtime no-ops.
    }
    if (!Number.isInteger(index) || index < 0) {
      return context.json(runtime.snapshot());
    }
    return context.json(runtime.researchFollowUp(context.req.param("id"), index));
  });
  // RESEARCH-TREE RESET: full clean slate — quests, dossiers, dialogue window
  // and topics all cleared; in-flight agents aborted.
  app.post("/api/research/tree/reset", (context) => {
    if (isOfflineDemoRequest(context.req.header("referer"))) {
      return context.json(runtime.snapshot());
    }
    return context.json(runtime.resetResearchTree());
  });
  // RESEARCH TRAY: dismiss a quest (proposed → suppressed for the cooldown;
  // researching → cancelled; complete/failed → cleared from the wall).
  app.post("/api/research/:id/dismiss", (context) => {
    if (isOfflineDemoRequest(context.req.header("referer"))) {
      return context.json(runtime.snapshot());
    }
    return context.json(runtime.dismissResearch(context.req.param("id")));
  });
  // The completed quest's dossier deck: a self-contained HTML slideshow —
  // findings with verdicts, bias notes, and a scannable QR code per source.
  app.get("/api/research/:id/deck", async (context) => {
    const html = await runtime.researchDeckHtml(context.req.param("id"));
    if (html === null) {
      return context.text("Research deck not ready.", 404);
    }
    return context.html(html);
  });
  // CLICK A PROJECT -> STEER IT. Set the steering target so subsequent FINAL
  // transcript lines route to that process's agent loop. Returns the snapshot.
  app.post("/api/process/:upid/select", (context) => {
    if (isOfflineDemoRequest(context.req.header("referer"))) {
      return context.json(runtime.snapshot());
    }
    const upid = context.req.param("upid");
    const snapshot = runtime.setSteeringTarget(upid);
    return context.json(snapshot);
  });
  // Clear the steering target (both POST and DELETE) so transcript returns to
  // ambient suggestion + click-to-build behavior. Returns the snapshot.
  app.post("/api/process/select/clear", (context) => {
    if (isOfflineDemoRequest(context.req.header("referer"))) {
      return context.json(runtime.snapshot());
    }
    return context.json(runtime.clearSteeringTarget());
  });
  app.delete("/api/process/select", (context) => {
    if (isOfflineDemoRequest(context.req.header("referer"))) {
      return context.json(runtime.snapshot());
    }
    return context.json(runtime.clearSteeringTarget());
  });
  // BUILD LOOP: toggle a registered build backend at runtime. Body
  // {"id": "smithers"|"eliza"|"native", "enabled": bool}; an unregistered id or
  // malformed body is a 400. Enabling re-probes availability in the background
  // and republishes when the probe lands, so the chip flips available/reason
  // without waiting out the probe here.
  app.post("/api/backends", async (context) => {
    if (isOfflineDemoRequest(context.req.header("referer"))) {
      return context.json(runtime.snapshot());
    }
    const body = (await context.req.json().catch(() => null)) as { id?: unknown; enabled?: unknown } | null;
    if (
      body === null ||
      typeof body.id !== "string" ||
      typeof body.enabled !== "boolean" ||
      !runtime.buildSelector.setEnabled(body.id, body.enabled)
    ) {
      return context.json({ ok: false, error: "body must be {id: <registered backend id>, enabled: boolean}" }, 400);
    }
    if (body.enabled && runtime.buildSelector.isKnown(body.id)) {
      void runtime.buildSelector
        .probe(body.id)
        .then(() => {
          runtime.publishNow();
        })
        .catch(() => undefined);
    }
    return context.json(runtime.publishNow());
  });
  // Per-process lifecycle + steering (the wall's card buttons). 404-free idiom
  // (matches /api/idea/:id/accept): an unknown/dead UPID is a no-op returning
  // the current snapshot. publishNow() republishes over SSE too — the registry
  // does not republish on its own for pause/resume/steer (only halt does).
  app.post("/api/process/:upid/halt", async (context) => {
    if (isOfflineDemoRequest(context.req.header("referer"))) {
      return context.json(runtime.snapshot());
    }
    const upid = context.req.param("upid");
    try {
      await runtime.registry.halt(upid, `corr-api-halt-${crypto.randomUUID()}`);
    } catch {
      // Unknown or already-dead UPID — return the current snapshot unchanged.
    }
    return context.json(runtime.publishNow());
  });
  app.post("/api/process/:upid/pause", async (context) => {
    if (isOfflineDemoRequest(context.req.header("referer"))) {
      return context.json(runtime.snapshot());
    }
    const upid = context.req.param("upid");
    try {
      await runtime.registry.pause(upid, `corr-api-pause-${crypto.randomUUID()}`);
    } catch {
      // Unknown or dead UPID.
    }
    return context.json(runtime.publishNow());
  });
  app.post("/api/process/:upid/resume", async (context) => {
    if (isOfflineDemoRequest(context.req.header("referer"))) {
      return context.json(runtime.snapshot());
    }
    const upid = context.req.param("upid");
    try {
      await runtime.registry.resume(upid, `corr-api-resume-${crypto.randomUUID()}`);
    } catch {
      // Not paused / unknown UPID.
    }
    return context.json(runtime.publishNow());
  });
  // COMMISSION (two-stage pivot): explicitly launch the heavyweight full build
  // for a kicked-off process — the durable `vibersyn-process` subscription run.
  // Kickoff (accept) only produced concept mocks + deck; THIS is the moment the
  // room commits. Success returns the fresh snapshot (the process entry carries
  // the `execution` lane: status executing/percent from live run events →
  // 'built' with the full-app previewUrl once artifacts land under
  // artifacts/vibersyn-runs/<upid>/). 400 when already executing/built (or the
  // emergency stop is active); 404 for an unknown/dead UPID.
  app.post("/api/process/:upid/execute", async (context) => {
    if (isOfflineDemoRequest(context.req.header("referer"))) {
      return context.json(runtime.snapshot());
    }
    const upid = context.req.param("upid");
    const result = await runtime.executeProcess(upid);
    if (!result.ok) {
      return context.json({ ok: false, error: result.error, execution: result.execution ?? null }, result.status);
    }
    return context.json(runtime.publishNow());
  });
  // SELF-HOSTING (VIBERSYN_SELF_MODE=1): the guarded internal reload trigger.
  // Only honored in self mode (404 otherwise — the endpoint effectively does
  // not exist). The runtime re-verifies the last self-run reported green and
  // serializes reloads; a refused trigger is a 409 with the reason. On success
  // the server publishes reloadPending, drains briefly, and exits 87 — the
  // run-room --self supervisor rebuilds and relaunches it.
  app.post("/api/self/reload", (context) => {
    if (env.VIBERSYN_SELF_MODE !== "1" && env.VIBERSYN_SELF_MODE !== "true") {
      return context.json({ ok: false, error: "self mode is off" }, 404);
    }
    const result = runtime.requestSelfReload(`corr-self-reload-api-${crypto.randomUUID()}`);
    if (!result.ok) {
      return context.json({ ok: false, error: result.reason }, 409);
    }
    return context.json({ ok: true, bootId: runtime.bootId, exitCode: 87 });
  });
  // Text steering — the SAME path spoken steering takes (registry.steer forwards
  // to the smithers client AND fires the build orchestrator's correction re-run
  // on every ready build). Body {"text": string}; empty/malformed is a 400.
  app.post("/api/process/:upid/steer", async (context) => {
    if (isOfflineDemoRequest(context.req.header("referer"))) {
      return context.json(runtime.snapshot());
    }
    const upid = context.req.param("upid");
    const body = (await context.req.json().catch(() => null)) as { text?: unknown } | null;
    if (body === null || typeof body.text !== "string" || body.text.trim().length === 0) {
      return context.json({ ok: false, error: "body must be {text: string}" }, 400);
    }
    try {
      await runtime.registry.steer(upid, { text: body.text, source: "api" }, `corr-api-steer-${crypto.randomUUID()}`);
    } catch {
      // Unknown or dead UPID.
    }
    return context.json(runtime.publishNow());
  });
  // Swipe-deck answers: a chosen answer to a build-forking question is forwarded
  // as a framed steer so the fleet incorporates the decision. Offline/published
  // deck copies short-circuit (no room to reach).
  app.post("/api/process/:upid/answer", async (context) => {
    if (isOfflineDemoRequest(context.req.header("referer"))) {
      return context.json(runtime.snapshot());
    }
    const upid = context.req.param("upid");
    const body = (await context.req.json().catch(() => null)) as { questionId?: unknown; answer?: unknown; prompt?: unknown } | null;
    if (
      body === null ||
      typeof body.answer !== "string" || body.answer.trim().length === 0 ||
      typeof body.questionId !== "string" || body.questionId.trim().length === 0
    ) {
      return context.json({ ok: false, error: "body must be {questionId: string, answer: string}" }, 400);
    }
    const question = typeof body.prompt === "string" && body.prompt.trim().length > 0 ? body.prompt.trim() : body.questionId;
    try {
      await runtime.registry.steer(
        upid,
        { text: `Decision — for "${question}", the choice is "${body.answer.trim()}". Build accordingly.`, source: "api" },
        `corr-api-answer-${crypto.randomUUID()}`,
      );
    } catch {
      // Unknown or dead UPID.
    }
    return context.json(runtime.publishNow());
  });
  app.get("*", async (context) => serveStatic(context.req.url));

  return app;
}

interface ImportSurfaceConfig {
  host: string;
  port: number;
  phonePort: number | null;
  interfaces?: () => InterfaceAddresses;
}

// The phone import surface, registered on BOTH the main projector app and the
// dedicated phone listener so the QR flow works whichever socket the phone
// reaches. POST /api/projects/import takes { context?, url? } — context is the
// primary field (what should the fleet build), the link is optional and may be
// any http(s) URL; a github.com/<owner>/<repo> link additionally runs the
// clone routine. Success returns the spawned project's identity so the phone
// can show "CALLSIGN is on the wall".
function registerImportSurface(app: Hono, runtime: ProjectorRuntime, config: ImportSurfaceConfig): void {
  app.post("/api/projects/import", async (context) => {
    if (isOfflineDemoRequest(context.req.header("referer"))) {
      return context.json({ ok: true });
    }
    let body: { url?: unknown; context?: unknown };
    try {
      body = (await context.req.json()) as { url?: unknown; context?: unknown };
    } catch {
      body = {};
    }
    const result = await runtime.importProject({ url: body?.url, context: body?.context });
    if (!result.ok) {
      return context.json({ ok: false, error: result.error }, 400);
    }
    return context.json({ ok: true, upid: result.upid, callsign: result.callsign, title: result.title });
  });
  // The QR overlay's payload: where a phone must go to reach GET /submit. With
  // the dedicated phone listener bound this is always the best LAN IPv4 +
  // phone port; lanReachable only goes false when no LAN interface exists (or,
  // in the legacy no-listener fallback, when the main bind is loopback).
  app.get("/api/import/info", (context) =>
    context.json(
      resolveImportInfo({
        host: config.host,
        port: config.port,
        phonePort: config.phonePort,
        interfaces: config.interfaces,
      }),
    ),
  );
  // The phone-side submit page — self-contained HTML served straight from the
  // API process (works with no Vite build).
  app.get("/submit", (context) => context.html(importPageHtml()));
}

interface HandsSurfaceConfig {
  host: string;
  port: number;
  phonePort: number | null;
  tlsPort: number | null;
  interfaces?: () => InterfaceAddresses;
}

// The guest-hands HTTP surface, registered on the main projector app AND every
// LAN listener (phone + TLS) so guests reach the page on whichever socket their
// browser can see. Self-contained HTML (no Vite build), same contract as the
// phone import page.
function registerHandsSurface(app: Hono, hub: RemoteHandsHub, config: HandsSurfaceConfig): void {
  app.get("/hands", (context) => context.html(handsPageHtml()));
  // SELF-HOSTED hand tracker: guest phones are often on a LAN with no
  // internet, so the MediaPipe bundle + wasm + model must come from THIS
  // server, never a CDN. Bundle/wasm resolve from the installed
  // @mediapipe/tasks-vision package; the model ships in gesture-wall/models.
  const mediapipeDir = new URL("../../node_modules/@mediapipe/tasks-vision/", import.meta.url).pathname;
  const handModelPath = new URL("../../gesture-wall/models/hand_landmarker.task", import.meta.url).pathname;
  const HANDS_ASSETS: Record<string, { path: string; type: string }> = {
    "vision_bundle.mjs": { path: `${mediapipeDir}vision_bundle.mjs`, type: "text/javascript" },
    "wasm/vision_wasm_internal.js": { path: `${mediapipeDir}wasm/vision_wasm_internal.js`, type: "text/javascript" },
    "wasm/vision_wasm_internal.wasm": { path: `${mediapipeDir}wasm/vision_wasm_internal.wasm`, type: "application/wasm" },
    "wasm/vision_wasm_nosimd_internal.js": { path: `${mediapipeDir}wasm/vision_wasm_nosimd_internal.js`, type: "text/javascript" },
    "wasm/vision_wasm_nosimd_internal.wasm": { path: `${mediapipeDir}wasm/vision_wasm_nosimd_internal.wasm`, type: "application/wasm" },
    "hand_landmarker.task": { path: handModelPath, type: "application/octet-stream" },
  };
  app.get("/hands/assets/:name{.+}", async (context) => {
    const asset = HANDS_ASSETS[context.req.param("name")];
    if (asset === undefined) {
      return context.text("not found", 404);
    }
    const file = Bun.file(asset.path);
    if (!(await file.exists())) {
      return context.text("asset missing on the room server", 404);
    }
    return new Response(file, { headers: { "content-type": asset.type } });
  });
  // What the wall's Guests overlay renders (QR + URL + live count) and what the
  // guest page itself polls for the https upgrade hint.
  app.get("/api/hands/info", (context) =>
    context.json(
      resolveHandsInfo({
        host: config.host,
        port: config.port,
        phonePort: config.phonePort,
        tlsPort: config.tlsPort,
        interfaces: config.interfaces,
        guestCount: hub.guestCount(),
        walls: hub.walls(),
      }),
    ),
  );
}

// The dedicated phone-facing app: ONLY the import surface. index.ts binds it
// on 0.0.0.0:<phonePort> so phones can always reach /submit, while the main
// app (emergency stop, seam API, mic WS — all unauthenticated) can stay on
// loopback. Convenience redirect: / → /submit, so typing just host:port works.
export function createPhoneImportApp(
  runtime: ProjectorRuntime,
  options: {
    host?: string;
    port?: number;
    // Null when the phone bind failed but the TLS listener still needs the app.
    phonePort: number | null;
    tlsPort?: number | null;
    hands?: RemoteHandsHub;
    interfaces?: () => InterfaceAddresses;
  },
): Hono {
  const app = new Hono();
  registerImportSurface(app, runtime, {
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 8787,
    phonePort: options.phonePort,
    interfaces: options.interfaces,
  });
  // Guests reach /hands on the LAN listener(s) too — the guest WS (/hands/ws)
  // upgrades on those sockets in index.ts against the same shared hub.
  registerHandsSurface(app, options.hands ?? new RemoteHandsHub(), {
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 8787,
    phonePort: options.phonePort,
    tlsPort: options.tlsPort ?? null,
    interfaces: options.interfaces,
  });
  app.get("/", (context) => context.redirect("/submit"));
  return app;
}

function eventsResponse(source: {
  subscribe(subscriber: (snapshot: ProjectorSnapshot, serialized: string) => void): () => void;
  subscribeMic(subscriber: (serialized: string) => void): () => void;
}): Response {
  let unsubscribe: (() => void) | undefined;
  let unsubscribeMic: (() => void) | undefined;
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      // The runtime serializes each broadcast snapshot ONCE; every connected
      // client shares that string instead of re-stringifying per connection.
      unsubscribe = source.subscribe((_next: ProjectorSnapshot, serialized: string) => {
        controller.enqueue(encoder.encode(`event: snapshot\ndata: ${serialized}\n\n`));
      });
      // Tiny mic byte-counter ticks (~60 bytes at 1 Hz) ride their own event so
      // an open mic no longer streams full snapshots to every client.
      unsubscribeMic = source.subscribeMic((serialized: string) => {
        controller.enqueue(encoder.encode(`event: mic\ndata: ${serialized}\n\n`));
      });
    },
    cancel() {
      unsubscribe?.();
      unsubscribeMic?.();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

async function serveStatic(requestUrl: string): Promise<Response> {
  const distRoot = resolve(process.cwd(), "dist");
  const pathname = new URL(requestUrl).pathname;
  const candidate = resolve(distRoot, pathname === "/" ? "index.html" : `.${pathname}`);

  if (!candidate.startsWith(distRoot)) {
    return new Response("Forbidden", { status: 403 });
  }

  const file = Bun.file(candidate);
  if (await file.exists()) {
    return new Response(file, { headers: { "content-type": contentType(candidate) } });
  }

  const index = Bun.file(resolve(distRoot, "index.html"));
  if (await index.exists()) {
    return new Response(index, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  return new Response("Projector build not found. Run `bun run build` first, or use `bun run dev` for Vite.", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function contentType(pathname: string): string {
  if (pathname.endsWith(".html")) return "text/html; charset=utf-8";
  if (pathname.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (pathname.endsWith(".css")) return "text/css; charset=utf-8";
  if (pathname.endsWith(".svg")) return "image/svg+xml";
  if (pathname.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

// True only for clients explicitly loaded in offline-demo mode (?live=0), which
// render static fixtures and never bind to the live runtime. Their control
// presses are cosmetic so they cannot perturb the shared live pipeline.
function isOfflineDemoRequest(referer: string | undefined): boolean {
  if (referer === undefined) {
    return false;
  }

  try {
    return new URL(referer).searchParams.get("live") === "0";
  } catch {
    return false;
  }
}

function emergencyDemoSnapshot(snapshot: ProjectorSnapshot): ProjectorSnapshot {
  return {
    ...snapshot,
    listening: false,
    muted: true,
    globalState: "emergency stopped",
    activeCue: "none",
    emergencyStopTriggered: true,
    updatedAt: new Date().toISOString(),
  };
}
