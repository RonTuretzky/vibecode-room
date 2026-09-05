import { websocket as honoWebsocket } from "hono/bun";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Hono } from "hono";
import { createProjectorRuntime } from "./composition";
import { createPhoneImportApp, createProjectorApp } from "./app";
import { formatDegradationNotice } from "./degradation-notice";
import { RemoteHandsHub, resolveHandsInfo, type HubConnection } from "./remote-hands";
import { createLanFetch, createLanWebsocket, resolvePhonePort, resolveTlsPort, type LanSocketData } from "./lan-listener";
import { GenAiOtlpExporter } from "../obs/otel";
import { TRANSCRIPT_ARCHIVE_DEFAULT_DIR, resolveTranscriptArchiveDir } from "./transcript-archive";
import { resolveRoomPort } from "../config/network";
import { resolveRoomEnv } from "../config/profiles";

Object.assign(process.env, await resolveRoomEnv(process.env));

// THE TRANSCRIPT ARCHIVE IS ON BY DEFAULT, and the default lives HERE.
//
// Commit 6a1d228 gated the old store behind an env marker because self-mode
// TEST runtimes were writing the LIVE store and polluting the operator's
// record. Putting the default in the runtime constructor would reintroduce
// exactly that — every `bun test` that builds a runtime would append to the
// real archive. This entry is the only REAL server process, so the default
// belongs at this boundary: `bun run start`, run-room.sh and the self
// supervisor all get an archive; a directly-constructed runtime never does.
// (The one other thing that boots this file is src/testing/room-harness.ts,
// which spawns it with scripted fake speech — its serverEnv redirects
// VIBERSYN_TRANSCRIPT_ARCHIVE into the scratch room's tmp dir.)
const transcriptArchiveDir = resolveTranscriptArchiveDir(
  process.env,
  process.env.VIBERSYN_TRANSCRIPT_ARCHIVE === undefined ? resolve(process.cwd(), TRANSCRIPT_ARCHIVE_DEFAULT_DIR) : undefined,
);
const runtime = await createProjectorRuntime(process.env, { buildsRoot: process.env.VIBERSYN_BUILDS_ROOT, executionArtifactsRoot: process.env.VIBERSYN_EXECUTION_ROOT, transcriptArchiveDir, stateFile: process.env.VIBERSYN_STATE_FILE === "off" || process.env.VIBERSYN_ROOM_PROFILE === "demo" ? null : resolve(process.env.VIBERSYN_STATE_FILE || "builds/.room-state.json") });
if (transcriptArchiveDir === null) {
  console.warn(
    "[transcript] archive DISABLED by VIBERSYN_TRANSCRIPT_ARCHIVE — this room is keeping no record of what is said. Unset it (or point it at a directory) to save transcripts.",
  );
} else {
  console.log(`[transcript] archive: ${transcriptArchiveDir} (one YYYY-MM-DD.jsonl per day, kept forever) — read it with \`bun run transcript\`.`);
}
// Start the idea-detection background tick so a detection scheduled by a SPEECH
// PAUSE still fires while the room is quiet (no new turns arriving). Tests drive
// detection synchronously via ingestTurn/flush and never start this tick.
runtime.detection.start();
// OTel/Langfuse trace export (env-gated): when LANGFUSE_OTLP_ENDPOINT is set,
// mirror every runtime trace event to the OTLP endpoint as a gen-ai span.
// LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY (optional) become Basic auth. The
// TraceProcessor buffer is append-only, so a cursor slice exports each event
// exactly once; export failures are swallowed and never touch the runtime.
startOtelTraceExport(runtime);

// Optional resident projects, configured by the room profile or environment.
// Comma-separated GitHub URLs;
// fire-and-forget through the exact same import path the QR uses — clone
// (reused when already on disk), adopt, deploy-resolve, tree.
const pinnedImports = (process.env.VIBERSYN_PINNED_IMPORTS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);
for (const pinnedUrl of pinnedImports) {
  if (runtime.snapshot().processes.some(process => process.state !== "halted" && process.source?.url === pinnedUrl)) continue;
  void runtime
    .importProject({ url: pinnedUrl, context: "pinned resident of the garden" }, `corr-pinned-import-${Date.now().toString(36)}`)
    .catch(() => undefined);
}

const host = process.env.HOST ?? "127.0.0.1";
const port = resolveRoomPort(process.env);

// GUEST HANDS relay hub — shared by every listener: LAN guests stream cursors
// in over WS /hands/ws (any listener), wall windows subscribe on WS
// /api/hands/room (main listener), and /api/hands/info reports the live count.
const handsHub = new RemoteHandsHub();

// The LAN listeners (phone + TLS) share one app instance; it is created AFTER
// the binds resolve so /api/import/info + /api/hands/info always advertise the
// ports that actually bound, never the ones we merely wanted. Routing and
// socket handlers live in lan-listener.ts (unit-tested).
let lanApp: Hono | null = null;
const lanFetch = createLanFetch(() => lanApp);
const lanWebsocket = createLanWebsocket(handsHub);

// Dedicated PHONE IMPORT listener: a second socket on 0.0.0.0 serving ONLY the
// import + guest-hands surfaces, so the QR flow works from phones on the room
// LAN no matter how the main server is bound — the unauthenticated control
// APIs (emergency stop, seam, mic WS) can stay on loopback. Default port: main
// port + 1; override with VIBERSYN_PHONE_PORT; disable with
// VIBERSYN_PHONE_LISTENER=0. A failed bind (port in use) degrades to the
// legacy main-bind-derived QR URL instead of crashing the room.
const phonePortWanted = process.env.VIBERSYN_PHONE_LISTENER === "0" ? null : resolvePhonePort(process.env.VIBERSYN_PHONE_PORT, port);
let phonePort: number | null = null;
if (phonePortWanted !== null) {
  try {
    Bun.serve<LanSocketData>({
      hostname: "0.0.0.0",
      port: phonePortWanted,
      fetch: lanFetch,
      websocket: lanWebsocket,
    });
    phonePort = phonePortWanted;
  } catch (error) {
    console.warn(
      `[import] phone listener failed to bind 0.0.0.0:${phonePortWanted} (${error instanceof Error ? error.message : String(error)}) — QR falls back to the main bind.`,
    );
  }
}

// Optional GUEST-HANDS TLS listener: browsers only allow getUserMedia (camera
// hand tracking on the guest's laptop) on secure origins, so run-room.sh
// --guests generates a self-signed cert and points VIBERSYN_HANDS_TLS_CERT/KEY
// here — a third socket on 0.0.0.0 serving the same LAN surface over https +
// wss. Missing/unbindable cert degrades to trackpad-only guests, never a crash.
const tlsCertPath = process.env.VIBERSYN_HANDS_TLS_CERT?.trim() ?? "";
const tlsKeyPath = process.env.VIBERSYN_HANDS_TLS_KEY?.trim() ?? "";
let tlsPort: number | null = null;
if (tlsCertPath.length > 0 && tlsKeyPath.length > 0) {
  const tlsPortWanted = resolveTlsPort(process.env.VIBERSYN_HANDS_TLS_PORT, port, phonePort);
  if (!existsSync(tlsCertPath) || !existsSync(tlsKeyPath)) {
    console.warn(`[hands] TLS cert/key not found (${tlsCertPath}, ${tlsKeyPath}) — https guest listener disabled.`);
  } else {
    try {
      Bun.serve<LanSocketData>({
        hostname: "0.0.0.0",
        port: tlsPortWanted,
        tls: { cert: Bun.file(tlsCertPath), key: Bun.file(tlsKeyPath) },
        fetch: lanFetch,
        websocket: lanWebsocket,
      });
      tlsPort = tlsPortWanted;
    } catch (error) {
      console.warn(
        `[hands] TLS listener failed to bind 0.0.0.0:${tlsPortWanted} (${error instanceof Error ? error.message : String(error)}) — camera hand-tracking for guests needs it; the trackpad still works over http.`,
      );
    }
  }
}

if (phonePort !== null || tlsPort !== null) {
  lanApp = createPhoneImportApp(runtime, { host, port, phonePort, tlsPort, hands: handsHub });
}

// The HTTP routes live in createProjectorApp (app.ts) so endpoint behavior is
// testable without a bound port; this entry only owns process-level wiring —
// the runtime boot, the listening socket, and the WebSocket upgrades
// (/api/mic, /api/hands/room, /hands/ws).
const app = createProjectorApp(runtime, { env: process.env, host, port, phonePort, tlsPort, hands: handsHub });

// Per-connection state for the main listener's WebSockets.
interface MicSocketData {
  kind?: "mic" | "hands-room" | "hands-guest";
  session?: import("./composition").MicSession;
  hands?: HubConnection;
}

Bun.serve<MicSocketData>({
  hostname: host,
  port,
  fetch(request, server) {
    const pathname = new URL(request.url).pathname;
    // A quiet room is still connected. Bun's default ten-second idle timeout
    // otherwise repeatedly cuts the event stream and flashes a disconnect warning.
    if (pathname === "/api/events") server.timeout(request, 0);
    // The live microphone path is a WebSocket so the browser can stream raw PCM
    // continuously. Everything else stays on the Hono app.
    if (pathname === "/api/mic") {
      const upgraded = server.upgrade(request, { data: { kind: "mic" } });
      if (upgraded) {
        return undefined;
      }
      return new Response("Expected a WebSocket upgrade for /api/mic", { status: 426 });
    }
    // Guest hands: the wall subscribes to merged guest cursors here (the
    // GestureWallClient fusion protocol), and guests on the same origin (main
    // bind on 0.0.0.0, or the host machine's own browser) stream cursors in.
    if (pathname === "/api/hands/room" || pathname === "/hands/ws") {
      const kind = pathname === "/api/hands/room" ? "hands-room" : "hands-guest";
      if (server.upgrade(request, { data: { kind } })) {
        return undefined;
      }
      return new Response(`Expected a WebSocket upgrade for ${pathname}`, { status: 426 });
    }
    // Pass the server handle so hono/bun's upgradeWebSocket (the /api/seam/ws
    // route) can perform its own upgrade.
    return app.fetch(request, server);
  },
  websocket: {
    open(ws) {
      if (ws.data?.kind === "hands-room") {
        ws.data.hands = handsHub.addRoom((raw) => ws.send(raw));
        return;
      }
      if (ws.data?.kind === "hands-guest") {
        ws.data.hands = handsHub.addGuest((raw) => ws.send(raw));
        return;
      }
      // Non-mic sockets (e.g. /api/seam/ws) belong to hono/bun's adapter.
      if (ws.data?.kind !== "mic") {
        (honoWebsocket as { open?: (ws: unknown) => unknown }).open?.(ws as unknown);
        return;
      }
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
      if (ws.data?.kind === "hands-room" || ws.data?.kind === "hands-guest") {
        if (typeof message === "string") {
          ws.data.hands?.message(message);
        }
        return;
      }
      if (ws.data?.kind !== "mic") {
        (honoWebsocket as { message?: (ws: unknown, message: unknown) => unknown }).message?.(ws as unknown, message);
        return;
      }
      const session = ws.data.session;
      if (session === undefined || typeof message === "string") {
        return; // Control text frames are ignored; only binary PCM is consumed.
      }
      const bytes = message instanceof Uint8Array ? message : new Uint8Array(message);
      session.pushAudio(bytes);
    },
    close(ws, code, reason) {
      if (ws.data?.kind === "hands-room" || ws.data?.kind === "hands-guest") {
        ws.data.hands?.close();
        return;
      }
      if (ws.data?.kind !== "mic") {
        (honoWebsocket as { close?: (ws: unknown, code?: number, reason?: string) => unknown }).close?.(
          ws as unknown,
          code,
          reason,
        );
        return;
      }
      void ws.data.session?.stop();
    },
  },
});

console.log(`Vibersyn projector server listening on http://${host}:${port}`);
if (phonePort !== null) {
  console.log(`[import] phone submit listener on http://0.0.0.0:${phonePort}/submit (QR points here)`);
}
{
  // Where guests point their own computers/phones for hand controls (walls
  // listen by default; ?remote=0 opts a window out).
  const handsInfo = resolveHandsInfo({ host, port, phonePort, tlsPort, guestCount: 0, walls: [] });
  console.log(
    `[hands] guest hand-controls page: ${handsInfo.url}${handsInfo.httpsUrl !== null ? ` (camera tracking: ${handsInfo.httpsUrl})` : " (trackpad only — no TLS listener; run-room.sh sets one up for camera tracking)"}`,
  );
}
// Structured startup degradation notice (ISSUE-0003): one line per stubbed leg
// with the env var that upgrades it, computed from the resolved runtime.
console.warn(formatDegradationNotice(runtime.degradation));

function startOtelTraceExport(exportingRuntime: Awaited<ReturnType<typeof createProjectorRuntime>>): void {
  const endpoint = process.env.LANGFUSE_OTLP_ENDPOINT?.trim() ?? "";
  if (endpoint.length === 0) {
    return;
  }
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY ?? "";
  const secretKey = process.env.LANGFUSE_SECRET_KEY ?? "";
  const headers: Record<string, string> =
    publicKey.length > 0 && secretKey.length > 0
      ? { authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}` }
      : {};
  const exporter = new GenAiOtlpExporter({ endpoint, headers, serviceName: "vibersyn-projector" });
  let cursor = 0;
  const timer = setInterval(() => {
    // Incremental read against the trace's monotonic cursor: the buffer is a
    // bounded ring now, so index-based slicing (and copying the whole array
    // every tick) would drift once eviction starts.
    const { events: fresh, nextSeq } = exportingRuntime.trace.eventsSince(cursor);
    cursor = nextSeq;
    for (const event of fresh) {
      void exporter
        .exportCall({
          correlationId: event.correlationId ?? "corr-runtime",
          upid: event.upid ?? "runtime",
          runId: "live",
          provider: "vibersyn",
          model: event.event,
          operation: "agent",
          startedAtMs: Date.now() - (event.latencyMs ?? 0),
          endedAtMs: Date.now(),
          attributes: { "vibersyn.event": event.event, "vibersyn.level": event.level ?? "info" },
        })
        .catch(() => undefined);
    }
  }, 3_000);
  (timer as { unref?: () => void }).unref?.();
  console.log(`[otel] Langfuse OTLP trace export enabled -> ${endpoint}`);
}

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const deadline = setTimeout(() => process.exit(0), 2500);
    deadline.unref();
    void runtime.shutdownWork().finally(() => process.exit(0));
  });
}
