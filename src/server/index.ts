import { Hono } from "hono";
import { resolve } from "node:path";
import { demoProjectorSnapshot, withUnmuted } from "../ui/demo-data";
import type { ProjectorSnapshot } from "../ui/types";

const app = new Hono();
const subscribers = new Set<(snapshot: ProjectorSnapshot) => void>();
let snapshot = demoProjectorSnapshot;

app.get("/api/health", (context) => context.json({ ok: true, app: "panopticon-projector" }));
app.get("/api/state", (context) => context.json(snapshot));
app.get("/api/events", () => eventsResponse());
app.post("/api/unmute", (context) => {
  snapshot = withUnmuted(snapshot);
  publish();
  return context.json(snapshot);
});
app.post("/api/emergency-stop", (context) => {
  snapshot = {
    ...snapshot,
    listening: false,
    muted: true,
    globalState: "emergency stopped",
    activeCue: "none",
    emergencyStopTriggered: true,
    updatedAt: new Date().toISOString(),
  };
  publish();
  return context.json(snapshot);
});
app.get("*", async (context) => serveStatic(context.req.url));

const host = process.env.HOST ?? "127.0.0.1";
const port = parsePort(process.env.PORT ?? "8787");

Bun.serve({
  hostname: host,
  port,
  fetch: app.fetch,
});

console.log(`Panopticon projector server listening on http://${host}:${port}`);

function eventsResponse(): Response {
  let send: ((next: ProjectorSnapshot) => void) | undefined;
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      send = (next: ProjectorSnapshot) => {
        controller.enqueue(encoder.encode(`event: snapshot\ndata: ${JSON.stringify(next)}\n\n`));
      };
      subscribers.add(send);
      send(snapshot);
    },
    cancel() {
      if (send !== undefined) {
        subscribers.delete(send);
      }
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

function publish(): void {
  for (const subscriber of subscribers) {
    try {
      subscriber(snapshot);
    } catch {
      // A closed/errored stream must not abort the whole broadcast — prune it.
      subscribers.delete(subscriber);
    }
  }
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
