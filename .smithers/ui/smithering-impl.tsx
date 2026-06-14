/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createGatewayReactRoot,
  useGatewayNodeOutput,
  useGatewayRunEvents,
  useGatewayRuns,
} from "smithers-orchestrator/gateway-react";

const WORKFLOW_KEY = "smithering-impl";

type RunSummary = { runId: string; workflowKey?: string; status?: string; createdAtMs?: number };
type NodeState = { id: string; status: string; lastSeq: number; outputSeq?: number };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function asString(v: unknown): string | undefined { return typeof v === "string" ? v : undefined; }
function shortRun(id?: string) { return id ? id.slice(0, 20) : "—"; }
function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}

// Normalize a raw event/gateway frame into { type, nodeId, text }.
function frameType(f: any): string {
  return asString(f?.event) ?? asString(f?.type) ?? asString(f?.payload?.type) ?? "event";
}
function frameNode(f: any): string | undefined {
  const p = isRecord(f?.payload) ? f.payload : f;
  return asString(p?.nodeId) ?? asString(p?.taskId);
}
function statusFromType(t: string, prev: string): string {
  if (/fail|error|denied/i.test(t)) return "failed";
  if (/NodeFinished|finished|complete|produced/i.test(t)) return "done";
  if (/NodeOutput|output/i.test(t)) return prev === "done" ? "done" : "running";
  if (/NodeStarted|started|AgentEvent|AgentSession|Heartbeat/i.test(t)) return prev === "done" || prev === "failed" ? prev : "running";
  if (/NodePending|pending|queued/i.test(t)) return prev || "pending";
  return prev || "pending";
}
// Pull human-readable agent text out of an Agent* frame payload (best-effort).
function agentText(f: any): string | null {
  const p = isRecord(f?.payload) ? f.payload : {};
  const cand =
    asString(p.text) ?? asString(p.delta) ?? asString(p.message) ??
    asString((p.data as any)?.text) ?? asString(p.summary) ?? asString(p.content);
  if (cand) return cand;
  // assistant-message shaped { message: { content: [{type:'text',text}] } }
  const msg = (p.message as any) ?? (p.data as any)?.message;
  if (isRecord(msg) && Array.isArray((msg as any).content)) {
    const t = (msg as any).content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("");
    if (t) return t;
  }
  return null;
}

const TICKET_RE = /^build:([a-z0-9-]+):(.+)$/;

const styles = [
  ":root{--bg:#0c0c0e;--panel:#151518;--card:#1c1c1f;--tx:#eee;--mut:#8a8a8e;--bd:#262629;--ac:#5e6ad2;--ok:#4ade80;--err:#f87171;--warn:#fbbf24;color-scheme:dark;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}",
  "*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font-size:13px;line-height:1.5}",
  ".shell{height:100vh;display:flex;flex-direction:column;overflow:hidden}",
  ".top{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--bd)}",
  "h1{margin:0;font-size:14px;font-weight:600}",
  ".pill{font-size:11px;color:var(--mut);background:var(--panel);border:1px solid var(--bd);border-radius:6px;padding:3px 8px}",
  ".mono{font-family:ui-monospace,monospace}",
  ".live{color:var(--ok)} .dead{color:var(--err)}",
  ".sel{margin-left:auto;height:28px;background:var(--panel);color:var(--tx);border:1px solid var(--bd);border-radius:6px}",
  ".main{display:grid;grid-template-columns:380px 1fr;flex:1;overflow:hidden}",
  ".tree{border-right:1px solid var(--bd);overflow:auto;padding:6px 0}",
  ".grp{padding:4px 0}",
  ".row{display:flex;align-items:center;gap:8px;padding:4px 12px;cursor:pointer;border:0;background:transparent;color:var(--tx);width:100%;text-align:left;font:inherit}",
  ".row:hover{background:var(--panel)} .row.sel{background:var(--card);box-shadow:inset 2px 0 0 var(--ac)}",
  ".row.child{padding-left:30px;font-size:12px}",
  ".dot{width:9px;height:9px;border-radius:50%;background:#3a3a42;flex:0 0 9px}",
  ".dot.running{background:var(--warn);box-shadow:0 0 6px var(--warn)} .dot.done{background:var(--ok)} .dot.failed{background:var(--err)}",
  ".nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  ".cnt{font-size:10px;color:var(--mut)}",
  ".detail{overflow:auto;padding:16px 20px}",
  ".detail h2{font-size:13px;margin:0 0 6px;color:var(--mut);text-transform:uppercase;letter-spacing:.04em}",
  ".card{background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:12px 14px;margin:0 0 14px}",
  ".log{font-family:ui-monospace,monospace;font-size:12px;white-space:pre-wrap;word-break:break-word;max-height:62vh;overflow:auto;background:#0e0e11;border:1px solid var(--bd);border-radius:8px;padding:12px}",
  ".log .ev{color:var(--mut)} .log .tx{color:var(--tx)}",
  ".kv{white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,monospace;font-size:12px}",
  ".empty{color:var(--mut);padding:40px;text-align:center}",
].join("\n");

function App() {
  const [selRun, setSelRun] = useState<string | undefined>(runIdFromUrl());
  const [selNode, setSelNode] = useState<string | undefined>(undefined);
  const runsQ = useGatewayRuns({ filter: { limit: 40 } });
  const runs = useMemo(
    () => ((runsQ.data ?? []) as RunSummary[]).filter((r) => !r.workflowKey || r.workflowKey === WORKFLOW_KEY),
    [runsQ.data],
  );
  const runId = selRun ?? runs[0]?.runId;
  const { events, streaming } = useGatewayRunEvents(runId, { maxEvents: 4000 });

  // Build node state + the per-node agent log from the live event stream.
  const { nodes, logByNode } = useMemo(() => {
    const map = new Map<string, NodeState>();
    const logs = new Map<string, { seq: number; type: string; text: string }[]>();
    let seq = 0;
    for (const f of events) {
      seq++;
      const t = frameType(f);
      const id = frameNode(f);
      if (!id) continue;
      const prev = map.get(id);
      const status = statusFromType(t, prev?.status ?? "");
      map.set(id, { id, status, lastSeq: seq, outputSeq: /output/i.test(t) ? seq : prev?.outputSeq });
      const tx = agentText(f);
      if (tx || /Agent/i.test(t)) {
        const arr = logs.get(id) ?? [];
        arr.push({ seq, type: t, text: tx ?? "" });
        logs.set(id, arr);
      }
    }
    return { nodes: map, logByNode: logs };
  }, [events]);

  // Group nodes into ticket → tasks; non-ticket nodes are top-level.
  const groups = useMemo(() => {
    const tickets = new Map<string, NodeState[]>();
    const top: NodeState[] = [];
    for (const n of nodes.values()) {
      const m = n.id.match(TICKET_RE);
      if (m) { const arr = tickets.get(m[1]) ?? []; arr.push(n); tickets.set(m[1], arr); }
      else top.push(n);
    }
    return { tickets, top };
  }, [nodes]);

  const dot = (s: string) => `dot ${s === "running" ? "running" : s === "done" ? "done" : s === "failed" ? "failed" : ""}`;
  const ticketStatus = (ns: NodeState[]) =>
    ns.some((n) => n.status === "running") ? "running"
    : ns.some((n) => n.status === "failed") ? "failed"
    : ns.every((n) => n.status === "done") ? "done" : "pending";

  const out = useGatewayNodeOutput({ runId, nodeId: selNode, iteration: 0 });
  const selLog = (selNode && logByNode.get(selNode)) || [];
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [selLog.length, selNode]);

  const activeRun = runs.find((r) => r.runId === runId);

  return (
    <main className="shell" data-testid="impl-inspector">
      <style>{styles}</style>
      <header className="top">
        <h1>Smithering Build — Live</h1>
        <span className="pill mono">{shortRun(runId)}</span>
        <span className={"pill " + (streaming ? "live" : "dead")}>{streaming ? "● streaming" : "○ idle"}</span>
        <span className="pill">{events.length} events</span>
        <span className="pill">{groups.tickets.size} tickets · {[...groups.tickets.values()].filter((ns) => ticketStatus(ns) === "done").length} done</span>
        {activeRun ? <span className="pill">{activeRun.status}</span> : null}
        <select className="sel" value={runId ?? ""} onChange={(e) => { setSelRun(e.currentTarget.value); setSelNode(undefined); }}>
          {runs.map((r) => <option key={r.runId} value={r.runId}>{shortRun(r.runId)} — {r.status}</option>)}
        </select>
      </header>
      <div className="main">
        <nav className="tree">
          {[...groups.top].sort((a, b) => a.id.localeCompare(b.id)).map((n) => (
            <button key={n.id} className={"row" + (selNode === n.id ? " sel" : "")} onClick={() => setSelNode(n.id)}>
              <span className={dot(n.status)} /><span className="nm">{n.id}</span>
            </button>
          ))}
          {[...groups.tickets.entries()].map(([ticket, ns]) => (
            <div className="grp" key={ticket}>
              <button className={"row" + (selNode === ticket ? " sel" : "")} onClick={() => setSelNode(ns[0]?.id)}>
                <span className={dot(ticketStatus(ns))} /><span className="nm">{ticket}</span>
                <span className="cnt">{ns.filter((x) => x.status === "done").length}/{ns.length}</span>
              </button>
              {ns.sort((a, b) => a.id.localeCompare(b.id)).map((n) => {
                const task = n.id.match(TICKET_RE)?.[2] ?? n.id;
                return (
                  <button key={n.id} className={"row child" + (selNode === n.id ? " sel" : "")} onClick={() => setSelNode(n.id)}>
                    <span className={dot(n.status)} /><span className="nm">{task}</span>
                  </button>
                );
              })}
            </div>
          ))}
          {nodes.size === 0 ? <div className="empty">Waiting for run events…</div> : null}
        </nav>
        <section className="detail">
          {!selNode ? (
            <div className="empty">Select a node to see its live LLM output and result.</div>
          ) : (
            <>
              <h2>{selNode}</h2>
              <div className="card">
                <h2 style={{ marginBottom: 8 }}>Structured output</h2>
                {out.loading ? <span className="mut">loading…</span> :
                  <div className="kv">{(() => { const r = isRecord(out.data) ? ((out.data as any).row ?? out.data) : out.data; const s = r ? JSON.stringify(r, null, 2) : "(no output row yet)"; return s.length > 4000 ? s.slice(0, 4000) + "\n…(truncated)" : s; })()}</div>}
              </div>
              <h2>Live LLM output / agent activity ({selLog.length})</h2>
              <div className="log" ref={logRef}>
                {selLog.length === 0 ? <span className="ev">(no agent output captured for this node)</span> :
                  selLog.slice(-400).map((l, i) => (
                    <div key={i}>{l.text ? <span className="tx">{l.text}</span> : <span className="ev">· {l.type}</span>}</div>
                  ))}
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  );
}

createGatewayReactRoot(<App />);
