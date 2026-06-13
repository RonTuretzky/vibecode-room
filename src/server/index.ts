import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { MetaSession } from "../core/meta-session.ts";
import type { ProcessMode, VisualizerKind } from "../core/types.ts";

const PORT = Number(process.env.PORT ?? 7777);
const WEB = join(import.meta.dir, "..", "web");

const session = new MetaSession();
session.start();

// ── WebSocket fan-out of the event bus → all connected clients ────────────────
const sockets = new Set<ServerWebSocket<unknown>>();
session.bus.subscribe((e) => {
  const msg = JSON.stringify(e);
  for (const ws of sockets) {
    try {
      ws.send(msg);
    } catch {
      /* ignore */
    }
  }
});

// ── helpers ───────────────────────────────────────────────────────────────────
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const notFound = () => new Response("not found", { status: 404 });
const bad = (msg: string) => json({ error: msg }, 400);

async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}

async function file(path: string): Promise<Response> {
  const f = Bun.file(path);
  if (await f.exists()) return new Response(f);
  return notFound();
}

// ── HTTP routing ────────────────────────────────────────────────────────────
async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  const seg = p.split("/").filter(Boolean); // e.g. ["api","processes","id","prompt"]

  // static + pages
  if (p === "/" || p === "/index.html") return file(join(WEB, "index.html"));
  if (p === "/style.css") return file(join(WEB, "style.css"));
  if (p === "/app.js") return file(join(WEB, "app.js"));
  if (p === "/mobile.js") return file(join(WEB, "mobile.js"));

  // mobile pairing: /m/:qrToken  (§5.7)
  if (seg[0] === "m" && seg[1]) {
    const proc = session.pm.list().find((m) => m.qrToken === seg[1]);
    if (!proc) return new Response("unknown or expired process pairing", { status: 404 });
    return file(join(WEB, "mobile.html"));
  }

  // ── API ──────────────────────────────────────────────────────────────────
  if (seg[0] === "api") {
    // GET /api/snapshot
    if (req.method === "GET" && seg[1] === "snapshot") return json(session.snapshot());

    // GET/POST /api/config
    if (seg[1] === "config") {
      if (req.method === "GET") return json(session.config);
      if (req.method === "POST") return json(session.setConfig(await body(req)));
    }

    // POST /api/select  { id | null }
    if (req.method === "POST" && seg[1] === "select") {
      const { id } = await body<{ id: string | null }>(req);
      session.select(id ?? null);
      return json({ selected: session.selected() });
    }

    // POST /api/transcript  { text, source }  → ambient suggestion channel
    if (req.method === "POST" && seg[1] === "transcript") {
      const { text, source } = await body<{ text: string; source?: string }>(req);
      if (!text) return bad("text required");
      session.observe(text, source ?? "room");
      return json({ ok: true });
    }

    // /api/suggestions ...
    if (seg[1] === "suggestions") {
      if (req.method === "GET" && !seg[2]) return json(session.suggestions.getAll());
      if (req.method === "POST" && seg[2] && seg[3] === "accept") {
        const { answers } = await body<{ answers?: Record<string, string> }>(req);
        const meta = await session.acceptSuggestion(seg[2], answers ?? {});
        return meta ? json(meta) : bad("no such suggestion");
      }
      if (req.method === "POST" && seg[2] && seg[3] === "dismiss") {
        return json({ ok: session.suggestions.dismiss(seg[2]) });
      }
    }

    // /api/processes ...
    if (seg[1] === "processes") {
      if (req.method === "GET" && !seg[2]) return json(session.pm.list());
      if (req.method === "POST" && !seg[2]) {
        const b = await body<{
          title: string;
          visualizer?: VisualizerKind;
          mode?: Partial<ProcessMode>;
          model?: string;
          agent?: string;
        }>(req);
        if (!b.title) return bad("title required");
        return json(await session.pm.create(b));
      }
      const id = seg[2];
      const action = seg[3];
      if (id && req.method === "POST") {
        switch (action) {
          case "prompt": {
            const { text } = await body<{ text: string }>(req);
            if (!text) return bad("text required");
            return json(session.prompt(id, text));
          }
          case "pause":
            return json({ ok: session.pm.pause(id) });
          case "resume":
            return json({ ok: session.pm.resume(id) });
          case "kill":
            return json({ ok: await session.pm.kill(id) });
          case "fork": {
            const child = await session.pm.fork(id);
            return child ? json(child) : bad("no such process");
          }
          case "mode": {
            const mode = await body<Partial<ProcessMode>>(req);
            const m = session.pm.switchMode(id, mode);
            return m ? json(m) : bad("no such process");
          }
          case "modify": {
            const patch = await body<{ title?: string; visualizer?: VisualizerKind }>(req);
            const m = session.pm.modify(id, patch);
            return m ? json(m) : bad("no such process");
          }
          case "merge": {
            const { from } = await body<{ from: string }>(req);
            const m = session.pm.merge(id, from);
            return m ? json(m) : bad("merge failed");
          }
        }
      }
      if (id && action === "export" && req.method === "GET") {
        const e = session.pm.export(id);
        return e ? json(e) : notFound();
      }
      // mobile pairing token → process info (for the mobile page)
      if (id === "by-token" && action && req.method === "GET") {
        const m = session.pm.list().find((x) => x.qrToken === action);
        return m ? json(m) : notFound();
      }
    }

    return notFound();
  }

  return notFound();
}

// ── serve ──────────────────────────────────────────────────────────────────
const server = Bun.serve({
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (srv.upgrade(req)) return undefined as unknown as Response;
      return new Response("expected websocket", { status: 426 });
    }
    try {
      return await handle(req);
    } catch (err) {
      console.error("[server] error", err);
      return json({ error: (err as Error).message }, 500);
    }
  },
  websocket: {
    open(ws) {
      sockets.add(ws);
      // cold-start priming: snapshot + recent events
      ws.send(JSON.stringify({ type: "snapshot", ...session.snapshot() }));
      for (const e of session.bus.recent()) ws.send(JSON.stringify(e));
    },
    close(ws) {
      sockets.delete(ws);
    },
    message() {
      /* clients drive via REST; ws is read-only event stream */
    },
  },
});

console.log(`\n  Panopticon — OS for AI-agent work`);
console.log(`  Pro UI:  http://localhost:${server.port}`);
console.log(`  brain:   ${session.brain.name}\n`);
