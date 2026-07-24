import { Hono } from "hono";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LogEvent } from "../types";

export interface BoardProcess {
  upid: string;
  runId: string;
  callsign: string;
  state: "planning" | "active" | "paused" | "halted" | "completed" | "blocked";
  selected: boolean;
  lastOutput: string;
  lastAction: string;
}

export interface BoardSnapshot {
  listening: boolean;
  globalState: string;
  activeCue: string;
  emergencyStopTriggered: boolean;
  processes: BoardProcess[];
  trace: LogEvent[];
}

export class BoardEventBus {
  #snapshot: BoardSnapshot;
  readonly #subscribers = new Set<(snapshot: BoardSnapshot) => void>();

  constructor(initial: Partial<BoardSnapshot> = {}) {
    this.#snapshot = {
      listening: initial.listening ?? true,
      globalState: initial.globalState ?? "ready",
      activeCue: initial.activeCue ?? "none",
      emergencyStopTriggered: initial.emergencyStopTriggered ?? false,
      processes: initial.processes ?? [],
      trace: initial.trace ?? [],
    };
  }

  snapshot(): BoardSnapshot {
    return {
      ...this.#snapshot,
      processes: this.#snapshot.processes.map((process) => ({ ...process })),
      trace: [...this.#snapshot.trace],
    };
  }

  update(partial: Partial<BoardSnapshot>): void {
    this.#snapshot = {
      ...this.#snapshot,
      ...partial,
      processes: partial.processes ?? this.#snapshot.processes,
      trace: partial.trace ?? this.#snapshot.trace,
    };
    this.publish();
  }

  appendTrace(event: LogEvent): void {
    this.#snapshot = {
      ...this.#snapshot,
      trace: [...this.#snapshot.trace.slice(-199), event],
    };
    this.publish();
  }

  subscribe(callback: (snapshot: BoardSnapshot) => void): () => void {
    this.#subscribers.add(callback);
    callback(this.snapshot());
    return () => this.#subscribers.delete(callback);
  }

  subscriberCount(): number {
    return this.#subscribers.size;
  }

  private publish(): void {
    const snapshot = this.snapshot();
    for (const subscriber of this.#subscribers) {
      subscriber(snapshot);
    }
  }
}

export function createBoardApp(bus = new BoardEventBus()): Hono {
  const app = new Hono();

  app.get("/", (context) => context.html(renderBoardHtml(bus.snapshot())));
  app.get("/health", (context) => context.json({ ok: true, readonly: true, authoritative: false }));
  app.get("/state", (context) => context.json(bus.snapshot()));
  app.get("/events", () => boardSseResponse(bus));

  if (process.env.VIBERSYN_RBG_BOARD_MUTATING_ROUTE === "1") {
    app.post("/actions", (context) => context.json({ mutated: true }));
  }

  return app;
}

export async function runBoardIndependentVoiceFlow(options: { boardUrl?: string; requireBoard?: boolean } = {}) {
  if (options.requireBoard ?? process.env.VIBERSYN_RBG_REQUIRE_BOARD === "1") {
    if (options.boardUrl === undefined) {
      throw new Error("voice flow incorrectly waited for the optional board");
    }
    await fetch(options.boardUrl, { signal: AbortSignal.timeout(100) });
  }

  return {
    ok: true,
    correlationId: "corr-board-e2e-001",
    stages: ["observation", "decision", "action", "outcome"] as const,
  };
}

function boardSseResponse(bus: BoardEventBus): Response {
  // Hoisted so cancel() can reach it: a value returned from start() is only
  // awaited as the startup promise, never invoked as a cleanup callback.
  let unsubscribe = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (snapshot: BoardSnapshot) => {
        try {
          controller.enqueue(encoder.encode(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`));
        } catch {
          // Client is gone but cancel() never fired; drop the subscription.
          unsubscribe();
        }
      };
      unsubscribe = bus.subscribe(send);
    },
    cancel() {
      unsubscribe();
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

function renderBoardHtml(snapshot: BoardSnapshot): string {
  const app = renderToStaticMarkup(React.createElement(BoardView, { snapshot }));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vibersyn Observability Board</title><style>${BOARD_CSS}</style></head><body><div id="root">${app}</div><script>${BOARD_JS}</script></body></html>`;
}

function BoardView({ snapshot }: { snapshot: BoardSnapshot }) {
  return React.createElement(
    "main",
    { className: "board", "data-readonly": "true" },
    React.createElement(
      "header",
      { className: "topbar" },
      React.createElement("strong", null, "VIBERSYN"),
      React.createElement("span", { className: "badge" }, "READ-ONLY / NON-AUTHORITATIVE / OFF-PATH"),
      React.createElement("span", { className: snapshot.listening ? "listen on" : "listen" }, snapshot.listening ? "Listening" : "Muted"),
    ),
    React.createElement(
      "section",
      { className: "status" },
      React.createElement("div", null, React.createElement("b", null, "Global"), React.createElement("span", null, snapshot.globalState)),
      React.createElement("div", null, React.createElement("b", null, "Active Cue"), React.createElement("span", null, snapshot.activeCue)),
      React.createElement("div", null, React.createElement("b", null, "Emergency"), React.createElement("span", null, snapshot.emergencyStopTriggered ? "triggered" : "clear")),
    ),
    React.createElement(
      "section",
      { className: "processes" },
      snapshot.processes.length === 0
        ? React.createElement("article", { className: "process empty" }, "No process running")
        : snapshot.processes.map((process) =>
            React.createElement(
              "article",
              { className: `process ${process.selected ? "selected" : ""}`, key: process.upid },
              React.createElement("div", { className: "processHead" }, React.createElement("b", null, process.callsign), React.createElement("span", null, process.state)),
              React.createElement("p", null, process.lastOutput || "No output yet"),
              React.createElement("code", null, `${process.upid} / ${process.runId}`),
              React.createElement("small", null, process.lastAction),
            ),
          ),
    ),
    React.createElement(
      "section",
      { className: "trace" },
      React.createElement("h1", null, "Trace"),
      snapshot.trace.slice(-50).map((event, index) =>
        React.createElement(
          "div",
          { className: "traceRow", key: `${event.correlationId ?? "none"}-${index}` },
          React.createElement("span", null, event.event),
          React.createElement("code", null, event.correlationId ?? ""),
          React.createElement("p", null, summarizeMeta(event.meta)),
        ),
      ),
    ),
  );
}

function summarizeMeta(meta: Record<string, unknown>): string {
  const text = JSON.stringify(meta);
  return text.length > 140 ? `${text.slice(0, 137)}...` : text;
}

const BOARD_CSS = `
:root{--bg:#0a0a0a;--panel:#111621;--ink:#e0e0e0;--muted:#8b98a9;--active:#00ff88;--pending:#f5a623;--error:#ff3b30;--selected:#00bcd4;--line:#202938}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}.board{min-height:100vh}.topbar{display:flex;align-items:center;gap:14px;padding:12px 18px;border-bottom:1px solid var(--line);background:var(--panel)}.badge{font-size:11px;color:var(--pending);border:1px solid #4c3411;padding:3px 8px}.listen{margin-left:auto;color:var(--muted)}.listen.on{color:var(--active)}.status{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--line)}.status div{background:#0e131c;padding:12px 18px}.status b{display:block;font-size:11px;color:var(--muted);text-transform:uppercase}.processes{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;padding:16px}.process{border:1px solid var(--line);background:var(--panel);padding:12px;border-radius:8px}.process.selected{border-color:var(--selected)}.process.empty{color:var(--muted)}.processHead{display:flex;justify-content:space-between}.processHead span{color:var(--active)}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#9fb0c2}.process small{display:block;color:var(--muted);margin-top:8px}.trace{border-top:1px solid var(--line);padding:14px 18px}.trace h1{font-size:12px;text-transform:uppercase;color:var(--muted);letter-spacing:.12em}.traceRow{display:grid;grid-template-columns:160px 190px 1fr;gap:8px;border-bottom:1px solid #151c28;padding:4px 0}.traceRow span{color:var(--selected);font-weight:600}.traceRow p{margin:0;color:#b8c2d0;overflow-wrap:anywhere}@media(max-width:760px){.status{grid-template-columns:1fr}.traceRow{grid-template-columns:1fr}.topbar{flex-wrap:wrap}.listen{margin-left:0}}
`;

const BOARD_JS = `
const source = new EventSource('/events');
source.addEventListener('snapshot', (event) => {
  window.__VIBERSYN_LAST_SNAPSHOT__ = JSON.parse(event.data);
});
`;
