import { websocket as honoWebsocket } from "hono/bun";
import { createProjectorRuntime } from "./composition";
import { createProjectorApp } from "./app";
import { formatDegradationNotice } from "./degradation-notice";
import { GenAiOtlpExporter } from "../obs/otel";

const runtime = await createProjectorRuntime(process.env);
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

const host = process.env.HOST ?? "127.0.0.1";
const port = parsePort(process.env.VIBERSYN_PORT ?? process.env.PORT ?? "8787");

// The HTTP routes live in createProjectorApp (app.ts) so endpoint behavior is
// testable without a bound port; this entry only owns process-level wiring —
// the runtime boot, the listening socket, and the /api/mic WebSocket upgrade.
const app = createProjectorApp(runtime, { env: process.env, host, port });

// Per-connection state for the live-mic WebSocket.
interface MicSocketData {
  kind?: "mic";
  session?: import("./composition").MicSession;
}

Bun.serve<MicSocketData>({
  hostname: host,
  port,
  fetch(request, server) {
    // The live microphone path is a WebSocket so the browser can stream raw PCM
    // continuously. Everything else stays on the Hono app.
    if (new URL(request.url).pathname === "/api/mic") {
      const upgraded = server.upgrade(request, { data: { kind: "mic" } });
      if (upgraded) {
        return undefined;
      }
      return new Response("Expected a WebSocket upgrade for /api/mic", { status: 426 });
    }
    // Pass the server handle so hono/bun's upgradeWebSocket (the /api/seam/ws
    // route) can perform its own upgrade.
    return app.fetch(request, server);
  },
  websocket: {
    open(ws) {
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
    const events = exportingRuntime.trace.events();
    const fresh = events.slice(cursor);
    cursor = events.length;
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

function parsePort(value: string): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 8787;
}
