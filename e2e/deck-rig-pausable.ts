// VERIFIER PROBE RIG — a pausable variant of e2e/deck-rig.ts (same protocol,
// same scripted files) whose scripted implementation can be HELD after N files
// so a spec can assert the room's progress FREEZES (footprint + percent) while
// the runner is genuinely idle, instead of inventing motion.
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
  frames: Array<{ seq: number; event: string; summary: string }>;
}

interface Subscriber {
  ws: WebSocket;
  runId: string;
  streamId: string;
}

export interface PausableDeckRigOptions {
  repoRoot: string;
  /** Scripted run length scale (launch → finished). Default 900ms per step. */
  stepMs?: number;
}

export interface PausableDeckRig {
  gatewayPort: number;
  claudePath: string;
  launches: FakeLaunch[];
  signals: Array<Record<string, unknown>>;
  artifactDirs: string[];
  /** Arm a hold: the scripted implementation PAUSES after `files` files. */
  armHold(files: number): void;
  /** Resolves once the runner is parked at the armed hold. */
  whenHeld(): Promise<void>;
  /** Let a held runner continue to completion. */
  release(): void;
  stop(): Promise<void>;
}

const FAKE_CLAUDE_SOURCE = `// scripted claude for the adversarial deck probes (see e2e/deck-rig-pausable.ts)
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

const sleep = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));

export async function startPausableDeckRig(options: PausableDeckRigOptions): Promise<PausableDeckRig> {
  const stepMs = options.stepMs ?? 900;
  const rigDir = mkdtempSync(join(tmpdir(), "vibersyn-deck-probe-rig-"));

  const scriptPath = join(rigDir, "fake-claude.cjs");
  const claudePath = join(rigDir, "claude");
  writeFileSync(scriptPath, FAKE_CLAUDE_SOURCE);
  writeFileSync(claudePath, `#!/bin/sh\nexec bun ${JSON.stringify(scriptPath)} "$@"\n`);
  chmodSync(claudePath, 0o755);

  const runs = new Map<string, RunState>();
  const launches: FakeLaunch[] = [];
  const signals: Array<Record<string, unknown>> = [];
  const subscribers: Subscriber[] = [];
  const artifactDirs: string[] = [];
  let stopped = false;
  let streamSeq = 0;

  // --- hold gate -------------------------------------------------------------
  let holdAfterFiles: number | null = null;
  let heldResolve: (() => void) | null = null;
  let heldPromise: Promise<void> = new Promise((res) => {
    heldResolve = res;
  });
  let releaseResolve: (() => void) | null = null;
  let releasePromise: Promise<void> = new Promise((res) => {
    releaseResolve = res;
  });

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

  async function runImplementation(run: RunState, input: Record<string, unknown>): Promise<void> {
    const upid = typeof input.upid === "string" && input.upid.length > 0 ? input.upid : "upid-unknown";
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    const dir = join(options.repoRoot, "artifacts", "vibersyn-runs", upid);
    artifactDirs.push(dir);
    const alive = () => !stopped && run.status === "running";
    const steps: Array<{ waitMs: number; write: () => Promise<void>; summary: string }> = [
      {
        waitMs: stepMs * 0.4,
        write: async () => {
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, "app.js"), `// FAKE-RUN real interaction code for: ${prompt}\ndocument.body.dataset.appReady = "1";\n`);
        },
        summary: "wrote app.js",
      },
      {
        waitMs: stepMs,
        write: async () => {
          await writeFile(join(dir, "style.css"), "body { font: 16px/1.5 sans-serif; margin: 2rem; }\n");
        },
        summary: "wrote style.css",
      },
      {
        waitMs: stepMs,
        write: async () => {
          await writeFile(
            join(dir, "index.html"),
            [
              "<!doctype html>",
              '<html><head><meta charset="utf-8" /><link rel="stylesheet" href="style.css" /><title>FAKE-RUN-APP</title></head>',
              '<body data-fake-run-app="1"><h1>FAKE-RUN-APP — built for real</h1>',
              `<p>${prompt.replace(/</gu, "&lt;")}</p>`,
              '<script src="app.js"></script></body></html>',
            ].join("\n"),
          );
        },
        summary: "wrote index.html",
      },
    ];
    for (let index = 0; index < steps.length; index += 1) {
      if (holdAfterFiles !== null && index === holdAfterFiles) {
        heldResolve?.();
        await releasePromise;
      }
      await sleep(steps[index]!.waitMs);
      if (!alive()) {
        return;
      }
      await steps[index]!.write();
      pushFrame(run, "task.progress", steps[index]!.summary);
    }
    if (holdAfterFiles !== null && holdAfterFiles >= steps.length) {
      heldResolve?.();
      await releasePromise;
    }
    await sleep(stepMs * 1.6);
    if (!alive()) {
      return;
    }
    run.status = "finished";
    pushFrame(run, "run.completed", "run finished");
  }

  function rpcPayload(method: string, params: Record<string, unknown>): Record<string, unknown> {
    switch (method) {
      case "launchRun": {
        const opts = (params.options ?? {}) as Record<string, unknown>;
        const runId = typeof opts.runId === "string" && opts.runId.length > 0 ? opts.runId : `run-${runs.size + 1}`;
        const existing = runs.get(runId);
        if (existing !== undefined) {
          return { runId, status: existing.status };
        }
        const workflow = typeof params.workflow === "string" ? params.workflow : "";
        const input = (params.input ?? {}) as Record<string, unknown>;
        const run: RunState = { runId, status: "running", seq: 0, frames: [] };
        runs.set(runId, run);
        launches.push({ runId, workflow, input });
        if (workflow === "vibersyn-process") {
          void runImplementation(run, input);
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
    armHold(files: number): void {
      holdAfterFiles = files;
      heldPromise = new Promise((res) => {
        heldResolve = res;
      });
      releasePromise = new Promise((res) => {
        releaseResolve = res;
      });
    },
    whenHeld(): Promise<void> {
      return heldPromise;
    },
    release(): void {
      releaseResolve?.();
    },
    async stop(): Promise<void> {
      stopped = true;
      releaseResolve?.();
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
