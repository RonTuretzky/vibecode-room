import { Hono } from "hono";
import { resolve } from "node:path";
import { withUnmuted } from "../ui/demo-data";
import type { ProjectorSnapshot } from "../ui/types";
import type { ProjectorRuntime } from "./composition";
import { healthPayload } from "./degradation-notice";
import { corsEnabledWarning, vibersynCors } from "./cors";
import { importPageHtml } from "./import-page";
import { resolveImportInfo, type InterfaceAddresses } from "./project-import";
import { createSeamApp } from "../seam/dispatcher";

export interface ProjectorAppOptions {
  env?: Record<string, string | undefined>;
  // The host/port the HTTP server is bound to. /api/import/info derives the
  // phone-reachable submit URL (and the lanReachable flag) from them.
  host?: string;
  port?: number;
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
  // QR import: body { url } — a validated GitHub repo URL joins the fleet as a
  // project in progress (source: github-import). Invalid input → 400 { ok:false }.
  // Success is { ok: true }; the snapshot reaches walls via the SSE push.
  app.post("/api/projects/import", async (context) => {
    if (isOfflineDemoRequest(context.req.header("referer"))) {
      return context.json({ ok: true });
    }
    let url: unknown;
    try {
      url = ((await context.req.json()) as { url?: unknown })?.url;
    } catch {
      url = undefined;
    }
    const result = await runtime.importProject(typeof url === "string" ? url : "");
    if (!result.ok) {
      return context.json({ ok: false, error: result.error }, 400);
    }
    return context.json({ ok: true });
  });
  // The QR overlay's payload: where a phone must go to reach GET /submit. Bound
  // to loopback (the default HOST) the server is unreachable from a phone, so
  // lanReachable is false and the UI warns to restart with HOST=0.0.0.0.
  app.get("/api/import/info", (context) => context.json(resolveImportInfo({ host, port, interfaces: options.interfaces })));
  // The phone-side submit page — self-contained HTML served straight from the
  // API process (works with no Vite build).
  app.get("/submit", (context) => context.html(importPageHtml()));
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
  app.get("*", async (context) => serveStatic(context.req.url));

  return app;
}

function eventsResponse(source: { subscribe(subscriber: (snapshot: ProjectorSnapshot) => void): () => void }): Response {
  let unsubscribe: (() => void) | undefined;
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      unsubscribe = source.subscribe((next: ProjectorSnapshot) => {
        controller.enqueue(encoder.encode(`event: snapshot\ndata: ${JSON.stringify(next)}\n\n`));
      });
    },
    cancel() {
      unsubscribe?.();
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
