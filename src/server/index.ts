import { Hono } from "hono";
import { resolve } from "node:path";
import { withUnmuted } from "../ui/demo-data";
import type { ProjectorSnapshot } from "../ui/types";
import { createProjectorRuntime } from "./composition";

const runtime = await createProjectorRuntime(process.env);
const app = new Hono();

app.get("/api/health", (context) => context.json({ ok: true, app: "panopticon-projector" }));
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
app.get("*", async (context) => serveStatic(context.req.url));

const host = process.env.HOST ?? "127.0.0.1";
const port = parsePort(process.env.PANOP_PORT ?? process.env.PORT ?? "8787");

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

console.log(`Panopticon projector server listening on http://${host}:${port}`);
console.log(`Live mic ASR mode: ${runtime.micMode}${runtime.micMode === "replay" ? " (set DEEPGRAM_API_KEY for real transcription)" : ""}`);

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
