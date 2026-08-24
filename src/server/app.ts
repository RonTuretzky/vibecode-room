import { Hono } from "hono";
import type { Context } from "hono";
import { stat } from "node:fs/promises";
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
import { registerForestSurface, sharedForestLoader } from "./github-org";
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
  // Test seam for the /api/autocal proxy's upstream fetch (the local python
  // calibrator on VIBERSYN_AUTOCAL_PORT). Tests inject a fake — no real
  // network ever.
  autocalFetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  // Test seam for the /salem authenticated app proxy's upstream fetch (the
  // labor.fun house board behind Caddy). Tests inject a fake — no real
  // network ever.
  salemFetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  // Test seam for the /api/build-stamp stat of the served dist/index.html.
  distIndexStat?: () => Promise<{ mtimeMs: number }>;
  // Test seam for the forest loader the self-rebuild toggle kicks (the repo
  // tree the wall shows while armed). Absent = the shared module loader.
  forestLoader?: { load: (org: string) => Promise<void> };
}

// The autocal proxy's upstream budget: the calibrator is local (127.0.0.1),
// so anything slower than this is down/wedged — answer {up:false} instead of
// pinning the wall's poll.
const AUTOCAL_PROXY_TIMEOUT_MS = 800;

// /api/build-stamp caches its fs.stat this long: many windows poll every 20s,
// and the stamp only ever changes when a build lands.
const BUILD_STAMP_CACHE_MS = 5_000;

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
  // /api/health carries the boot-time degradation notice PLUS the recurrent
  // Cerebras agents' live miss streaks (sky relate + topic refiner) — a
  // persistent 402/timeout surfaces here instead of failing silently forever.
  // ASYNC because one leg cannot be answered from configuration: the Smithers
  // gateway is a separate process on a port, so the room has to ASK. Bounded
  // and cached in gateway-probe.ts — a status page must not become a load
  // generator, and must never hang on a dead port.
  app.get("/api/health", async (context) =>
    context.json(
      healthPayload({
        degradation: await runtime.degradationNow(),
        bootId: runtime.bootId,
        selfMode: runtime.selfMode,
        skyAgent: runtime.research.cloudGraph().agentHealth(),
        topicRefiner: runtime.research.refinerHealth(),
      }),
    ),
  );
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
  // GITHUB FOREST surface: POST /api/org/import {org} kicks the gh-CLI org
  // loader (disk-cached, ~5-minute refresh) and 202s; GET /api/forest serves
  // the current payload (or {org:null}) for the grove window. One process-wide
  // loader — every app instance shares the same org state, and nothing spawns
  // until the first import.
  registerForestSurface(app, { loader: sharedForestLoader() });
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
  // SELF-REBUILD toggle ("the room rebuilds itself"). Body `{ on: boolean }`
  // sets it explicitly; absent body flips the current state. Governs the
  // green-self-commit → exit-87 rebuild trigger at RUNTIME (requestSelfReload
  // consults it); the supervisor wrapper itself is boot-time (--self), so
  // without one the flag only records intent — snapshot.selfSupervisor says
  // which. Returns the fresh snapshot.
  // The room's own repository — the tree the wall shows while self-rebuild is
  // armed ("watch the room grow itself"). Owner half feeds the forest loader.
  const selfRepo = env.VIBERSYN_SELF_REPO ?? "RonTuretzky/vibecode-room";
  app.get("/api/self-repo", (context) => {
    // The wall's self-repo garden tree names the repo through this route before it polls
    // /api/forest — so an armed room (including one that BOOTED armed under the
    // supervisor, where no toggle press ever fires) warms the loader here.
    // Fire-and-forget; app creation itself stays side-effect-free.
    if (runtime.selfRebuild()) {
      void (options.forestLoader ?? sharedForestLoader()).load(selfRepo.split("/")[0]).catch(() => undefined);
    }
    return context.json({ repo: selfRepo });
  });
  app.post("/api/self-rebuild", async (context) => {
    if (isOfflineDemoRequest(context.req.header("referer"))) {
      return context.json(runtime.snapshot());
    }
    let on = !runtime.selfRebuild();
    try {
      const body = (await context.req.json()) as { on?: unknown };
      if (typeof body?.on === "boolean") {
        on = body.on;
      }
    } catch {
      // no/invalid body -> toggle current state
    }
    if (on) {
      // Arming self-rebuild kicks the repo-tree data: the wall's self-repo garden
      // tree reads /api/forest, which the loader fills (cache-first, 5-min
      // refresh). Fire-and-forget — the toggle must never wait on GitHub.
      void (options.forestLoader ?? sharedForestLoader()).load(selfRepo.split("/")[0]).catch(() => undefined);
    }
    return context.json(runtime.setSelfRebuild(on));
  });
  // SELF VERSION RAILS: the room's own branches (every record window cuts
  // one) and click-a-branch-to-load. Loading checks the branch out and hands
  // the process to the supervisor (exit 87 → rebuild → relaunch ON it).
  app.get("/api/self/branches", async (context) => context.json(await runtime.selfBranches()));
  app.post("/api/self/checkout", async (context) => {
    if (isOfflineDemoRequest(context.req.header("referer"))) {
      return context.json({ ok: false, error: "offline demo" }, 400);
    }
    let branch = "";
    try {
      const body = (await context.req.json()) as { branch?: unknown };
      if (typeof body?.branch === "string") {
        branch = body.branch;
      }
    } catch {
      // fall through to the empty-name refusal
    }
    if (branch.length === 0) {
      return context.json({ ok: false, error: "branch required" }, 400);
    }
    const result = await runtime.checkoutSelfBranch(branch);
    return context.json(result, result.ok ? 200 : 400);
  });
  // STOP GROWING: abort the EXECUTING self-run without touching the pinned
  // mirror record. Distinct from POST /api/process/self/halt (the emergency
  // path), which registry-halts the record — marking it dead and orphaning
  // the mirror until reboot. This route only cancels the durable run and
  // settles the lane failed·"aborted"; the next steer is accepted. Idempotent:
  // nothing executing answers 200 {halted:false}.
  app.post("/api/self/run/halt", async (context) => {
    if (isOfflineDemoRequest(context.req.header("referer"))) {
      return context.json({ ok: false, error: "offline demo" }, 400);
    }
    const result = await runtime.haltSelfRun(`corr-self-halt-api-${crypto.randomUUID()}`);
    return context.json(result, result.ok ? 200 : 400);
  });
  // TEND A LIMB: archive, delete, or merge (finalize) one of the room's own
  // branches — the tree-menu's per-branch lifecycle actions POST here. Every
  // ok response carries the FRESH rails payload (current + branches[]) so the
  // wall re-renders without a second GET (the tend refresh contract).
  app.post("/api/self/branch", async (context) => {
    if (isOfflineDemoRequest(context.req.header("referer"))) {
      return context.json({ ok: false, error: "offline demo" }, 400);
    }
    let branch = "";
    let action: "archive" | "delete" | "merge" | "" = "";
    // Delete's excise scope: "branch" (default — today's label-only prune) or
    // "everywhere" (revert the graft on every branch carrying it). Anything
    // else reads as the safe default so old clients stay valid.
    let scope: "branch" | "everywhere" = "branch";
    try {
      const body = (await context.req.json()) as { branch?: unknown; action?: unknown; scope?: unknown };
      if (typeof body?.branch === "string") {
        branch = body.branch;
      }
      if (body?.action === "archive" || body?.action === "delete" || body?.action === "merge") {
        action = body.action;
      }
      if (body?.scope === "branch" || body?.scope === "everywhere") {
        scope = body.scope;
      }
    } catch {
      // fall through to the empty-field refusals
    }
    if (branch.length === 0) {
      return context.json({ ok: false, error: "branch required" }, 400);
    }
    if (action === "") {
      return context.json({ ok: false, error: "action must be archive, delete, or merge" }, 400);
    }
    const result =
      action === "merge" ? await runtime.mergeSelfBranch(branch) : await runtime.manageSelfBranch(branch, action, scope);
    if (!result.ok) {
      return context.json(result, 400);
    }
    return context.json({ ...result, ...(await runtime.selfBranches()) });
  });
  // GUIDED-DEMO HOLD: the wall posts {on:true} entering the demo's "describe
  // your idea" step and {on:false} leaving it — while held, an armed auto-build
  // never fires on its own (Done is the only trigger). TTL'd server-side so a
  // crashed wall cannot wedge the room. Absent body = arm.
  app.post("/api/guided/hold", async (context) => {
    if (isOfflineDemoRequest(context.req.header("referer"))) {
      return context.json(runtime.snapshot());
    }
    let on = true;
    try {
      const body = (await context.req.json()) as { on?: unknown };
      if (typeof body?.on === "boolean") {
        on = body.on;
      }
    } catch {
      // no/invalid body -> arm the hold
    }
    return context.json(runtime.setGuidedHold(on));
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
  // PROJECT BRIEF: what the room learned by STUDYING an imported repo — the
  // tree's "📖 About this project" card. 404 for trees that were never
  // studied (a build-intent import, a local concept, the room itself), which
  // is how the wall decides whether to offer the row at all.
  app.get("/api/process/:upid/brief", (context) => {
    const brief = runtime.projectBrief(context.req.param("upid"));
    if (brief === null) {
      return context.json({ error: "this tree has no study to read" }, 404);
    }
    return context.json({ brief, intent: runtime.projectIntent(context.req.param("upid")) });
  });
  // BUILD IT AFTER ALL: the brief's one press forward — a studied project
  // someone now wants worked on fans out like a build-intent import would
  // have. The study was the first step, not a dead end.
  app.post("/api/process/:upid/build", (context) => {
    if (isOfflineDemoRequest(context.req.header("referer"))) {
      return context.json(runtime.snapshot());
    }
    return context.json(runtime.buildStudiedProject(context.req.param("upid")));
  });
  // TOPIC CARD: read ONE constellation in full — its abstract (when the relate
  // agent has written one), the thread's lines in spoken order, what it relates
  // to, and how much history has been elided. Off the snapshot on purpose: the
  // ceiling shows a card for one constellation at a time, so this rides a fetch
  // instead of every SSE frame. 404 for an unknown/evicted topic id.
  app.get("/api/research/sky/topic/:id", (context) => {
    const detail = runtime.research.cloudGraph().cloudDetail(context.req.param("id"));
    if (detail === null) {
      return context.json({ error: "no such constellation" }, 404);
    }
    return context.json(detail);
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
  // Optional body {branch: "room/<slug>"} scopes the record toggle's
  // spoken-change window to a specific room branch of an adopted tree — the
  // scope rides the snapshot as steeringBranch and clears with the target.
  // No/malformed body = the pre-existing unscoped select.
  app.post("/api/process/:upid/select", async (context) => {
    if (isOfflineDemoRequest(context.req.header("referer"))) {
      return context.json(runtime.snapshot());
    }
    const upid = context.req.param("upid");
    const body = (await context.req.json().catch(() => null)) as { branch?: unknown } | null;
    const branch = body !== null && typeof body.branch === "string" && body.branch.trim().length > 0 ? body.branch.trim() : null;
    const snapshot = runtime.setSteeringTarget(upid, undefined, branch);
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
  // PER-PROCESS DISMISS (the tree menu's 🗑 remove, behind its two-stage
  // confirm): stop the process's builds AND remove it from the snapshot —
  // unlike halt, no dead card stays behind. Builds bookkeeping only (registry
  // dismiss = halt teardown + record delete); never GitHub, never files
  // outside the build registries. The pinned SELF project is refused — the
  // room must not dismiss itself. 404-free idiom otherwise: an unknown UPID
  // is a no-op returning the current snapshot.
  app.post("/api/process/:upid/dismiss", async (context) => {
    if (isOfflineDemoRequest(context.req.header("referer"))) {
      return context.json(runtime.snapshot());
    }
    const upid = context.req.param("upid");
    if (upid === "self") {
      return context.json({ ok: false, error: "the room cannot dismiss itself" }, 400);
    }
    try {
      await runtime.registry.dismiss(upid, `corr-api-dismiss-${crypto.randomUUID()}`);
    } catch {
      // Unknown UPID — return the current snapshot unchanged.
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
  // GIT SUBSTRATE explicit publish: push this tree's repo to GitHub NOW
  // (private repo + one draft PR per concept branch) without waiting for a
  // commission. Idempotent — a published tree returns its existing URL. 400
  // when the substrate is disabled/unknown UPID/adopted GitHub import.
  app.post("/api/process/:upid/publish-repo", async (context) => {
    if (isOfflineDemoRequest(context.req.header("referer"))) {
      return context.json(runtime.snapshot());
    }
    const upid = context.req.param("upid");
    const result = await runtime.publishTreeRepo(upid);
    if (!result.ok) {
      return context.json({ ok: false, error: result.error }, 400);
    }
    return context.json({ ok: true, url: result.url });
  });
  // ADOPTED-TREE BRANCH RAILS (the PR engine for GitHub imports). Create a
  // real room/<slug> branch off the FRESHLY FETCHED origin/main tip (the
  // substrate fetches before resolving the base). Adopted trees only — local
  // trees 400 honestly (they publish whole via publish-repo) — and the pinned
  // SELF process is refused outright.
  app.post("/api/process/:upid/branch", async (context) => {
    if (isOfflineDemoRequest(context.req.header("referer"))) {
      return context.json(runtime.snapshot());
    }
    const upid = context.req.param("upid");
    if (upid === "self") {
      return context.json({ ok: false, error: "the room does not branch itself" }, 400);
    }
    const body = (await context.req.json().catch(() => null)) as { name?: unknown } | null;
    if (body === null || typeof body.name !== "string" || body.name.trim().length === 0) {
      return context.json({ ok: false, error: "body must be {name: string}" }, 400);
    }
    const result = await runtime.createTreeBranch(upid, body.name.trim());
    if (!result.ok) {
      return context.json({ ok: false, error: result.error }, 400);
    }
    return context.json({ ok: true, branch: result.branch });
  });
  // Ride the branch's spoken changes to a REAL PR against the import's own
  // origin: commit the clone's current working tree if dirty ("room: spoken
  // changes"), push ONLY room/<slug>, gh pr create (idempotent — a second
  // call returns the stored PR URL).
  app.post("/api/process/:upid/branch/:branch/pr", async (context) => {
    if (isOfflineDemoRequest(context.req.header("referer"))) {
      return context.json(runtime.snapshot());
    }
    const upid = context.req.param("upid");
    if (upid === "self") {
      return context.json({ ok: false, error: "the room does not open PRs against itself here" }, 400);
    }
    const body = (await context.req.json().catch(() => null)) as { title?: unknown; body?: unknown } | null;
    const result = await runtime.openTreeBranchPr(upid, context.req.param("branch"), {
      ...(typeof body?.title === "string" && body.title.trim().length > 0 ? { title: body.title.trim() } : {}),
      ...(typeof body?.body === "string" && body.body.trim().length > 0 ? { body: body.body.trim() } : {}),
    });
    if (!result.ok) {
      return context.json({ ok: false, error: result.error }, 400);
    }
    return context.json({ ok: true, url: result.url });
  });
  // The last rail: squash-merge the branch's open PR (gh pr merge --squash).
  // For an import whose host deploys latest main, merging IS the deploy — the
  // popup asks twice before it posts here. Idempotent: a PR already merged
  // upstream answers ok rather than erroring on the second press.
  app.post("/api/process/:upid/branch/:branch/merge", async (context) => {
    if (isOfflineDemoRequest(context.req.header("referer"))) {
      return context.json(runtime.snapshot());
    }
    const upid = context.req.param("upid");
    if (upid === "self") {
      return context.json({ ok: false, error: "the room does not merge its own PRs here" }, 400);
    }
    const result = await runtime.mergeTreeBranch(upid, context.req.param("branch"));
    if (!result.ok) {
      return context.json({ ok: false, error: result.error }, 400);
    }
    return context.json({ ok: true, merged: true });
  });
  // The tree's repo facts for menus/popups: recorded origin, branch list
  // (per-branch prUrl once open), and the published deploy URL when one
  // confirmed. 404 when this UPID has no tree repo at all.
  app.get("/api/process/:upid/repo", (context) => {
    const upid = context.req.param("upid");
    const info = runtime.treeRepoInfo(upid);
    if (info === null) {
      return context.json({ ok: false, error: `No tree repo for UPID ${upid}.` }, 404);
    }
    return context.json(info);
  });
  // The ADOPTED tree's origin-repo open issues (the wall's issue fruit):
  // {issues: [{number, title, labels}]} via the gh seam, 60s-cached per upid.
  // Local/self trees answer {issues: []}; so does EVERY failure — never a 500.
  app.get("/api/process/:upid/issues", async (context) => {
    const payload = await runtime.treeIssues(context.req.param("upid")).catch(() => ({ issues: [] }));
    return context.json(payload);
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
  // Swipe-deck answers: a chosen answer to a build-forking question is
  // RECORDED in the runtime's answer ledger (so every regenerated deck renders
  // the card pre-decided) and then forwarded as a framed steer so the fleet
  // incorporates the decision. The deck sends the question `prompt` alongside
  // questionId/answer; the steer framing uses it (falling back to the id) so
  // the correction reads as the actual question, not an opaque hash.
  // Offline/published deck copies short-circuit (no room to reach).
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
    const questionId = body.questionId.trim();
    const answer = body.answer.trim();
    const question = typeof body.prompt === "string" && body.prompt.trim().length > 0 ? body.prompt.trim() : questionId;
    // Ledger first: the steer below regenerates the deck, and the regeneration
    // must already see this decision to render the card pre-decided.
    runtime.recordAnswer(upid, { questionId, prompt: question, answer });
    try {
      await runtime.registry.steer(
        upid,
        { text: `Decision — for "${question}", the choice is "${answer}". Build accordingly.`, source: "api" },
        `corr-api-answer-${crypto.randomUUID()}`,
      );
    } catch {
      // Unknown or dead UPID.
    }
    return context.json(runtime.publishNow());
  });
  // PROJECTOR AUTO-CALIBRATION proxy (walls flip into calibration mode by
  // themselves). The calibrator (gesturewall.autocal) is a separate python
  // server on VIBERSYN_AUTOCAL_PORT (default 8801); the wall windows poll THIS
  // same-origin proxy instead of it directly — no CORS, and it works when the
  // wall browser is not on the calibrator's host. An absent calibrator is the
  // NORMAL resting state, never an error: {up:false} with a 200.
  const autocalPort = Number.parseInt(env.VIBERSYN_AUTOCAL_PORT ?? "", 10) || 8801;
  const autocalFetch = options.autocalFetch ?? fetch;
  const autocalProxy = async (path: "/calib/state" | "/calib/start", method: "GET" | "POST"): Promise<unknown> => {
    try {
      const response = await autocalFetch(`http://127.0.0.1:${autocalPort}${path}`, {
        method,
        signal: AbortSignal.timeout(AUTOCAL_PROXY_TIMEOUT_MS),
      });
      if (!response.ok) {
        return { up: false };
      }
      return (await response.json()) as unknown;
    } catch {
      return { up: false }; // down, wedged, or non-JSON — the walls stay rooms
    }
  };
  app.get("/api/autocal/state", async (context) => context.json(await autocalProxy("/calib/state", "GET")));
  app.post("/api/autocal/start", async (context) => context.json(await autocalProxy("/calib/start", "POST")));

  // BUILD STAMP (walls auto-reload when a new UI build lands): the identity of
  // the served dist build — dist/index.html's mtime, from the SAME dist root
  // serveStatic resolves (process.cwd()/dist). Cached ~5s so many windows on a
  // 20s cadence never stat-storm; no build yet is {stamp:null}, which the UI
  // treats as "nothing to compare".
  const distIndexStat = options.distIndexStat ?? (() => stat(resolve(process.cwd(), "dist", "index.html")));
  let buildStampCache: { at: number; stamp: string | null } | null = null;
  app.get("/api/build-stamp", async (context) => {
    const now = Date.now();
    if (buildStampCache === null || now - buildStampCache.at > BUILD_STAMP_CACHE_MS) {
      let stamp: string | null = null;
      try {
        stamp = String((await distIndexStat()).mtimeMs);
      } catch {
        stamp = null; // no dist build yet (dev / first boot)
      }
      buildStampCache = { at: now, stamp };
    }
    return context.json({ stamp: buildStampCache.stamp });
  });

  // /salem — AUTHENTICATED APP PROXY (the holo panel's window into the live
  // labor.fun house board). The board sits behind Caddy with an HttpOnly
  // SameSite=Lax salem_session cookie, so a cross-origin iframe would show the
  // login page forever; this same-origin reverse proxy injects the session
  // server-side, strips the frame-blocking headers, and rewrites root-relative
  // HTML references so the app lives happily under /salem/.
  registerSalemSurface(app, { env, salemFetch: options.salemFetch ?? fetch });

  app.get("*", async (context) => serveStatic(context.req.url));

  return app;
}

// ── /salem authenticated app proxy ───────────────────────────────────────────

const SALEM_DEFAULT_UPSTREAM = "https://residency.convent.fun";
// Upstream budget: the board is a small remote app — 8s covers a cold Caddy
// hop, and the fallback page beats a spinner pinned to a dead upstream.
const SALEM_PROXY_TIMEOUT_MS = 8_000;
// Response headers that must never reach the wall's iframe: an upstream
// X-Frame-Options / CSP (frame-ancestors) would blank our SAME-ORIGIN frame.
// Encoding/length go too — fetch already decoded the body, and a stale
// content-length over a rewritten HTML body would truncate it.
const SALEM_STRIPPED_HEADERS = [
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
  "content-encoding",
  "content-length",
  "transfer-encoding",
  // The room's sid is injected SERVER-side; an upstream session-refresh
  // Set-Cookie must not land cookies under the room's own origin.
  "set-cookie",
];
// healthz reads at most this much of the upstream body for the login marker.
const SALEM_HEALTH_SLICE = 16_384;

// One conservative pass over text/html ONLY: root-relative references
// (href="/… src="/… action="/… and url(/… in inline styles) become /salem/…
// so the board's own links/assets stay inside the proxy. Protocol-relative
// (//cdn…) and already-rewritten (/salem/…) references are left alone.
export function rewriteSalemHtml(html: string): string {
  return html
    .replace(/(href|src|action)=(["'])\/(?!\/|salem\/)/gi, "$1=$2/salem/")
    .replace(/url\((['"]?)\/(?!\/|salem\/)/gi, "url($1/salem/");
}

// 3xx Location rewrite: a root-relative or same-upstream-origin redirect stays
// under /salem (the login POST bounce must land back in the frame); foreign
// origins pass through untouched.
export function rewriteSalemLocation(location: string, upstreamOrigin: string): string {
  if (location.startsWith("/") && !location.startsWith("//")) {
    return location === "/salem" || location.startsWith("/salem/") ? location : `/salem${location}`;
  }
  try {
    const url = new URL(location);
    if (url.origin === upstreamOrigin) {
      return `/salem${url.pathname}${url.search}`;
    }
  } catch {
    // Relative/opaque Location — leave it for the browser to resolve in-frame.
  }
  return location;
}

// The branded 502: the room's dark palette, never a blank frame.
function salemFallbackHtml(): string {
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>the board is napping</title><style>",
    "html,body{margin:0;height:100%;background:linear-gradient(180deg,#05070d,#070e16);color:#e8f2f5;",
    "font-family:Inter,ui-sans-serif,system-ui,sans-serif;display:flex;align-items:center;justify-content:center}",
    ".nap{text-align:center;padding:36px 44px;border:1px solid rgba(0,229,255,0.35);border-radius:18px;",
    "background:rgba(16,30,40,0.42);box-shadow:0 0 32px rgba(0,229,255,0.12)}",
    "h1{font-size:22px;margin:0 0 10px;color:#9ee2ff;font-weight:600}p{margin:0;color:#aebfc8}",
    "</style></head><body><div class=\"nap\"><h1>the board is napping</h1>",
    "<p>the garden keeps growing — try again in a moment.</p></div></body></html>",
  ].join("");
}

// The /salem surface: GET/POST proxy + healthz. NOT the 8-line autocal idiom —
// a real reverse proxy with cookie injection, header stripping and HTML
// rewriting, degrading gracefully to the upstream login page when
// VIBERSYN_SALEM_SID is unset and to the branded fallback when the upstream
// is down. Never throws.
function registerSalemSurface(
  app: Hono,
  options: {
    env: Record<string, string | undefined>;
    salemFetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  },
): void {
  const upstreamOrigin = ((): string => {
    try {
      return new URL(options.env.VIBERSYN_SALEM_UPSTREAM ?? SALEM_DEFAULT_UPSTREAM).origin;
    } catch {
      return new URL(SALEM_DEFAULT_UPSTREAM).origin;
    }
  })();
  // The salem_session cookie VALUE. May be unset tonight: every request then
  // goes up cookie-less and the board honestly serves its login page.
  const sid = (options.env.VIBERSYN_SALEM_SID ?? "").trim();
  const salemFetch = options.salemFetch;

  // Synthetic health check — MUST register before the /salem/* wildcard.
  // authed uses the pragmatic marker: the board's 401 login HTML says "login"
  // (form action, heading, title); a 200 without it on a bounded slice means
  // the session cookie is doing its job.
  app.get("/salem/healthz", async (context) => {
    try {
      const response = await salemFetch(`${upstreamOrigin}/`, {
        method: "GET",
        headers: sid.length > 0 ? { cookie: `salem_session=${sid}` } : {},
        redirect: "manual",
        signal: AbortSignal.timeout(SALEM_PROXY_TIMEOUT_MS),
      });
      const slice = (await response.text()).slice(0, SALEM_HEALTH_SLICE).toLowerCase();
      // The login/expired pages carry the bot sign-in instructions; the real
      // board never does. (The word "login" alone false-positived: the authed
      // board mentions it in nav copy — live-room finding with a valid sid.)
      const authed = response.status === 200 && !slice.includes("salemconventbot");
      return context.json({ ok: true, authed, status: response.status });
    } catch {
      return context.json({ ok: false, authed: false, status: 0 });
    }
  });

  const proxy = async (context: Context): Promise<Response> => {
    const requestUrl = new URL(context.req.url);
    // /salem and /salem/ are the board's root; deeper paths map 1:1.
    const upstreamPath = requestUrl.pathname === "/salem" ? "/" : requestUrl.pathname.slice("/salem".length) || "/";
    const upstreamUrl = `${upstreamOrigin}${upstreamPath}${requestUrl.search}`;
    const method = context.req.method === "POST" ? "POST" : "GET";
    const headers: Record<string, string> = { accept: context.req.header("accept") ?? "*/*" };
    if (sid.length > 0) {
      headers.cookie = `salem_session=${sid}`;
    }
    let body: ArrayBuffer | undefined;
    if (method === "POST") {
      // The board's CSRF-ish checks see the UPSTREAM origin, not the room's.
      headers.origin = upstreamOrigin;
      headers.referer = `${upstreamOrigin}/`;
      const contentType = context.req.header("content-type");
      if (contentType !== undefined) {
        headers["content-type"] = contentType;
      }
      body = await context.req.arrayBuffer();
    }
    let upstream: Response;
    try {
      upstream = await salemFetch(upstreamUrl, {
        method,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(SALEM_PROXY_TIMEOUT_MS),
        ...(body === undefined ? {} : { body }),
      });
    } catch {
      // Down / timed out — the branded nap page, never a blank frame.
      return new Response(salemFallbackHtml(), { status: 502, headers: { "content-type": "text/html; charset=utf-8" } });
    }
    const responseHeaders = new Headers(upstream.headers);
    for (const name of SALEM_STRIPPED_HEADERS) {
      responseHeaders.delete(name);
    }
    const location = responseHeaders.get("location");
    if (location !== null) {
      responseHeaders.set("location", rewriteSalemLocation(location, upstreamOrigin));
    }
    const contentType = (responseHeaders.get("content-type") ?? "").toLowerCase();
    if (contentType.includes("text/html")) {
      let html: string;
      try {
        html = await upstream.text();
      } catch {
        return new Response(salemFallbackHtml(), { status: 502, headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return new Response(rewriteSalemHtml(html), { status: upstream.status, headers: responseHeaders });
    }
    // Binary/asset content-types stream through untouched.
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  };

  app.get("/salem", proxy);
  app.post("/salem", proxy);
  app.get("/salem/*", proxy);
  app.post("/salem/*", proxy);
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
