// DECK-DECIDE RIG — the two outside-world fakes the deck journey needs, both
// injected at EXISTING production seams (no production change):
//
//   1. A SCRIPTED `claude` CLI (VIBERSYN_CLAUDE_CLI): the concept-mock
//      backends spawn it exactly like the real CLI (smithers.ts
//      defaultClaudeRunner: `claude -p <prompt> --output-format json
//      --dangerously-skip-permissions`, cwd = builds/<upid>/<backend>/). The
//      fake writes a REAL index.html into that real directory — hero mode
//      embeds the spoken idea, correction mode appends the decision verbatim
//      as a DOM marker — and prints the {"result": …} envelope the backend
//      parses. Instant and quota-free.
//
//   2. A FAKE SMITHERS GATEWAY (VIBERSYN_SMITHERS_GATEWAY_URL): speaks the
//      real gateway-client protocol —
//        • HTTP RPC: POST /v1/rpc/<method>, body = bare params JSON, reply =
//          a response frame {"type":"res","id":…,"ok":true,"payload":…}
//          (node_modules/@smithers-orchestrator/gateway-client rpcRaw);
//        • WS at ws://<base>/: req frames {type:"req",id,method,params} for
//          "connect" and "streamRunEvents" (reply {streamId}), then pushed
//          event frames {type:"event",event:"run.event",seq,stateVersion,
//          payload:{streamId,runId,seq,event,summary}}.
//      A launchRun for workflow "vibersyn-process" starts the SCRIPTED
//      IMPLEMENTATION: real files written over real seconds into
//      <repoRoot>/artifacts/vibersyn-runs/<upid>/ (the ExecutionRegistry's
//      contract-fixed root), one run event per file, then a run.completed
//      frame + getRun "finished" — so the room's execution lane must derive
//      its progress from REAL working-tree footprint + REAL event frames,
//      exactly like a live commission.
//
// Not named *.live-pw.ts — playwright must not collect this as a spec.

import { createServer, type Server } from "node:http";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";

export interface FakeLaunch {
  runId: string;
  workflow: string;
  input: Record<string, unknown>;
}

interface RunState {
  runId: string;
  status: "running" | "finished" | "cancelled";
  seq: number;
  // Recorded frames for afterSeq replay on (re)subscribe.
  frames: Array<{ seq: number; event: string; summary: string }>;
}

interface Subscriber {
  ws: WebSocket;
  runId: string;
  streamId: string;
}

export interface DeckRigOptions {
  /** The repo the room server runs from — artifacts land under it. */
  repoRoot: string;
  /** Scripted run length (launch → finished). Default ~3.6s. */
  stepMs?: number;
}

export interface DeckRig {
  gatewayPort: number;
  claudePath: string;
  /** Every launchRun the room ever sent — the "gateway DB rows" oracle. */
  launches: FakeLaunch[];
  /** Every submitSignal (steer/pause/resume) the room sent post-commission. */
  signals: Array<Record<string, unknown>>;
  /** artifacts/vibersyn-runs dirs the scripted runs created (cleaned on stop). */
  artifactDirs: string[];
  /** Keep scripted work executing until the test has observed its progress. */
  holdCompletion(): () => void;
  stop(): Promise<void>;
}

// The scripted `claude`: hero mode writes a fresh mock; correction mode
// appends the room's decision to the existing mock as a queryable marker.
const FAKE_CLAUDE_SOURCE = `// scripted claude for the deck-decide journey (see e2e/deck-rig.ts)
const { readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const p = args.indexOf("-p");
const prompt = p >= 0 ? (args[p + 1] || "") : "";
let summary;
if (prompt.includes("CORRECTING an existing concept mock")) {
  const match = prompt.match(/apply it faithfully: ([^\\n]+)/);
  const correction = (match ? match[1] : "correction").trim();
  let html;
  try { html = readFileSync("index.html", "utf8"); } catch (err) { html = "<!doctype html><html><body></body></html>"; }
  const marker = '<p data-decision-applied="1">' + correction + "</p>";
  html = html.includes("</body>") ? html.replace("</body>", marker + "</body>") : html + marker;
  writeFileSync("index.html", html);
  summary = "Correction applied: " + correction;
} else {
  const ideaMatch = prompt.match(/IDEA: ([^\\n]+)/);
  const idea = ideaMatch ? ideaMatch[1] : "the idea";
  writeFileSync(
    "index.html",
    '<!doctype html><html><body data-fake-mock="1"><h1>' + idea + '</h1><p>FAKE-CLAUDE hero concept mock</p></body></html>'
  );
  summary = "Concept mock: " + idea;
}
console.log(JSON.stringify({ result: summary }));
`;

export async function startDeckRig(options: DeckRigOptions): Promise<DeckRig> {
  const stepMs = options.stepMs ?? 900;
  const rigDir = mkdtempSync(join(tmpdir(), "vibersyn-deck-rig-"));

  // --- the scripted claude CLI ---------------------------------------------
  const scriptPath = join(rigDir, "fake-claude.cjs");
  const claudePath = join(rigDir, "claude");
  writeFileSync(scriptPath, FAKE_CLAUDE_SOURCE);
  writeFileSync(claudePath, `#!/bin/sh\nexec bun ${JSON.stringify(scriptPath)} "$@"\n`);
  chmodSync(claudePath, 0o755);

  // --- the fake gateway -----------------------------------------------------
  const runs = new Map<string, RunState>();
  const launches: FakeLaunch[] = [];
  const signals: Array<Record<string, unknown>> = [];
  const subscribers: Subscriber[] = [];
  const artifactDirs: string[] = [];
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  let stopped = false;
  let streamSeq = 0;
  let completionHeld = false;
  const pendingCompletions: Array<() => void> = [];

  function pushFrame(run: RunState, event: string, summary: string): void {
    run.seq += 1;
    run.frames.push({ seq: run.seq, event, summary });
    for (const subscriber of subscribers) {
      if (subscriber.runId !== run.runId || subscriber.ws.readyState !== subscriber.ws.OPEN) {
        continue;
      }
      subscriber.ws.send(
        JSON.stringify({
          type: "event",
          event: "run.event",
          seq: run.seq,
          stateVersion: run.seq,
          payload: { streamId: subscriber.streamId, runId: run.runId, seq: run.seq, event, summary },
        }),
      );
    }
  }

  // The SCRIPTED IMPLEMENTATION: real files over real seconds, one honest
  // event per file, then terminal. The room's footprint probe must see these
  // exact files appear on disk.
  function scheduleImplementation(run: RunState, input: Record<string, unknown>): void {
    const upid = typeof input.upid === "string" && input.upid.length > 0 ? input.upid : "upid-unknown";
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    const dir = join(options.repoRoot, "artifacts", "vibersyn-runs", upid);
    artifactDirs.push(dir);
    const at = (ms: number, fn: () => void): void => {
      timers.push(
        setTimeout(() => {
          if (!stopped && run.status === "running") {
            fn();
          }
        }, ms),
      );
    };
    at(stepMs * 0.4, () => {
      void mkdir(dir, { recursive: true })
        .then(() => writeFile(join(dir, "app.js"), `// FAKE-RUN real interaction code for: ${prompt}\ndocument.body.dataset.appReady = "1";\n`))
        .then(() => pushFrame(run, "task.progress", "wrote app.js"));
    });
    at(stepMs * 1.4, () => {
      void writeFile(join(dir, "style.css"), "body { font: 16px/1.5 sans-serif; margin: 2rem; }\n").then(() =>
        pushFrame(run, "task.progress", "wrote style.css"),
      );
    });
    at(stepMs * 2.4, () => {
      void writeFile(
        join(dir, "index.html"),
        [
          "<!doctype html>",
          '<html><head><meta charset="utf-8" /><link rel="stylesheet" href="style.css" /><title>FAKE-RUN-APP</title></head>',
          '<body data-fake-run-app="1"><h1>FAKE-RUN-APP — built for real</h1>',
          `<p>${prompt.replace(/</gu, "&lt;")}</p>`,
          '<script src="app.js"></script></body></html>',
        ].join("\n"),
      ).then(() => pushFrame(run, "task.progress", "wrote index.html"));
    });
    at(stepMs * 4, () => {
      const finish = () => {
        if (stopped || run.status !== "running") return;
        run.status = "finished";
        pushFrame(run, "run.completed", "run finished");
      };
      if (completionHeld) pendingCompletions.push(finish);
      else finish();
    });
  }

  function rpcPayload(method: string, params: Record<string, unknown>): Record<string, unknown> {
    switch (method) {
      case "launchRun": {
        const opts = (params.options ?? {}) as Record<string, unknown>;
        const runId = typeof opts.runId === "string" && opts.runId.length > 0 ? opts.runId : `run-${runs.size + 1}`;
        const existing = runs.get(runId);
        if (existing !== undefined) {
          return { runId, status: existing.status }; // idempotencyKey semantics
        }
        const workflow = typeof params.workflow === "string" ? params.workflow : "";
        const input = (params.input ?? {}) as Record<string, unknown>;
        const run: RunState = { runId, status: "running", seq: 0, frames: [] };
        runs.set(runId, run);
        launches.push({ runId, workflow, input });
        if (workflow === "vibersyn-process") {
          scheduleImplementation(run, input);
        }
        return { runId, status: "running" };
      }
      case "getRun": {
        const runId = typeof params.runId === "string" ? params.runId : "";
        const run = runs.get(runId);
        return { runId, status: run?.status ?? "running" };
      }
      case "submitSignal": {
        signals.push(params);
        return { ok: true };
      }
      case "cancelRun": {
        const runId = typeof params.runId === "string" ? params.runId : "";
        const run = runs.get(runId);
        if (run !== undefined) {
          run.status = "cancelled";
        }
        return { ok: true };
      }
      default:
        return {};
    }
  }

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const match = /^\/v1\/rpc\/([\w.]+)/u.exec(request.url ?? "");
      if (match === null) {
        response.statusCode = 404;
        response.end("not an rpc path");
        return;
      }
      let params: Record<string, unknown> = {};
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        params = body.length > 0 ? (JSON.parse(body) as Record<string, unknown>) : {};
      } catch {
        // Bare/empty params.
      }
      const payload = rpcPayload(match[1]!, params);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ type: "res", id: "rpc", ok: true, payload }));
    });
  });

  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (frame.type !== "req" || typeof frame.id !== "string" || typeof frame.method !== "string") {
        return;
      }
      const params = (frame.params ?? {}) as Record<string, unknown>;
      if (frame.method === "connect") {
        ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { protocol: 1 } }));
        return;
      }
      if (frame.method === "streamRunEvents") {
        const runId = typeof params.runId === "string" ? params.runId : "";
        const afterSeq = typeof params.afterSeq === "number" ? params.afterSeq : 0;
        streamSeq += 1;
        const streamId = `s-${streamSeq}`;
        subscribers.push({ ws, runId, streamId });
        ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { streamId } }));
        const run = runs.get(runId);
        if (run !== undefined) {
          for (const recorded of run.frames) {
            if (recorded.seq > afterSeq) {
              ws.send(
                JSON.stringify({
                  type: "event",
                  event: "run.event",
                  seq: recorded.seq,
                  stateVersion: recorded.seq,
                  payload: { streamId, runId, seq: recorded.seq, event: recorded.event, summary: recorded.summary },
                }),
              );
            }
          }
        }
        return;
      }
      ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: {} }));
    });
  });

  const gatewayPort = await new Promise<number>((resolvePort, rejectPort) => {
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        rejectPort(new Error("fake gateway bound no port"));
        return;
      }
      resolvePort(address.port);
    });
  });

  return {
    gatewayPort,
    claudePath,
    launches,
    signals,
    artifactDirs,
    holdCompletion() {
      completionHeld = true;
      return () => {
        completionHeld = false;
        for (const finish of pendingCompletions.splice(0)) finish();
      };
    },
    async stop(): Promise<void> {
      stopped = true;
      pendingCompletions.length = 0;
      for (const timer of timers) {
        clearTimeout(timer);
      }
      for (const client of wss.clients) {
        client.close();
      }
      await new Promise<void>((resolveClose) => wss.close(() => resolveClose()));
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      for (const dir of artifactDirs) {
        rmSync(dir, { recursive: true, force: true });
      }
      rmSync(rigDir, { recursive: true, force: true });
    },
  };
}
