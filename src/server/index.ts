import { Hono } from "hono";
import { resolve } from "node:path";
import { withUnmuted } from "../ui/demo-data";
import type { ProjectorSnapshot } from "../ui/types";
import { createProjectorRuntime } from "./composition";
import { formatDegradationNotice, healthPayload } from "./degradation-notice";

const runtime = await createProjectorRuntime(process.env);
// Start polling the room-idle gap so a suggestion deferred for interrupt cost is
// delivered once the room falls quiet (ISSUE-0024). Tests drive the tick off an
// injected clock instead; this is the single live tick hook.
runtime.idleCueDriver.start();
// Start the idea-detection background tick so a detection scheduled by a SPEECH
// PAUSE still fires while the room is quiet (no new turns arriving). Tests drive
// detection synchronously via ingestTurn/flush and never start this tick.
runtime.detection.start();
const app = new Hono();

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
app.get("*", async (context) => serveStatic(context.req.url));

const host = process.env.HOST ?? "127.0.0.1";
const port = parsePort(process.env.VIBERSYN_PORT ?? process.env.PORT ?? "8787");

// Per-connection state for the live-mic WebSocket.
interface MicSocketData {
  session?: import("./composition").MicSession;
}

Bun.serve<MicSocketData>({
  hostname: host,
  port,
  fetch(request, server) {
    // The live microphone path is a WebSocket so the browser can stream raw PCM
    // continuously. Everything else stays on the Hono app.
    if (new URL(request.url).pathname === "/api/mic") {
      const upgraded = server.upgrade(request, { data: {} });
      if (upgraded) {
        return undefined;
      }
      return new Response("Expected a WebSocket upgrade for /api/mic", { status: 426 });
    }
    return app.fetch(request);
  },
  websocket: {
    open(ws) {
      // Safety: never open a cloud-ASR mic session while the room is muted. The
      // browser unmutes first, so a muted socket is a client-side ordering bug.
      if (runtime.snapshot().muted) {
        ws.send(JSON.stringify({ type: "error", reason: "muted" }));
        ws.close(1008, "muted");
        return;
      }
      ws.data.session = runtime.startMicSession();
      ws.send(JSON.stringify({ type: "ready", mode: runtime.micMode, sessionId: ws.data.session.id }));
    },
    message(ws, message) {
      const session = ws.data.session;
      if (session === undefined || typeof message === "string") {
        return; // Control text frames are ignored; only binary PCM is consumed.
      }
      const bytes = message instanceof Uint8Array ? message : new Uint8Array(message);
      session.pushAudio(bytes);
    },
    close(ws) {
      void ws.data.session?.stop();
    },
  },
});

console.log(`Vibersyn projector server listening on http://${host}:${port}`);
// Structured startup degradation notice (ISSUE-0003): one line per stubbed leg
// with the env var that upgrades it, computed from the resolved runtime.
console.warn(formatDegradationNotice(runtime.degradation));

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

function parsePort(value: string): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 8787;
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
