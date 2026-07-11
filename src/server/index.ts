import { createProjectorRuntime } from "./composition";
import { createProjectorApp } from "./app";
import { formatDegradationNotice } from "./degradation-notice";

const runtime = await createProjectorRuntime(process.env);
// Start polling the room-idle gap so a suggestion deferred for interrupt cost is
// delivered once the room falls quiet (ISSUE-0024). Tests drive the tick off an
// injected clock instead; this is the single live tick hook.
runtime.idleCueDriver.start();
// Start the idea-detection background tick so a detection scheduled by a SPEECH
// PAUSE still fires while the room is quiet (no new turns arriving). Tests drive
// detection synchronously via ingestTurn/flush and never start this tick.
runtime.detection.start();

const host = process.env.HOST ?? "127.0.0.1";
const port = parsePort(process.env.VIBERSYN_PORT ?? process.env.PORT ?? "8787");

// The HTTP routes live in createProjectorApp (app.ts) so endpoint behavior is
// testable without a bound port; this entry only owns process-level wiring —
// the runtime boot, the listening socket, and the /api/mic WebSocket upgrade.
const app = createProjectorApp(runtime, { env: process.env, host, port });

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

function parsePort(value: string): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 8787;
}
