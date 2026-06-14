/** @jsxImportSource react */
import { useMemo, useState } from "react";
import {
  createGatewayReactRoot,
  useGatewayActions,
  useGatewayApprovals,
  useGatewayNodeOutput,
  useGatewayRun,
  useGatewayRunEvents,
  useGatewayRuns,
} from "smithers-orchestrator/gateway-react";

const WORKFLOW_KEY = "smithering";

type RunSummary = { runId: string; workflowKey?: string; status?: string; createdAtMs?: number };
type ApprovalSummary = {
  runId: string;
  nodeId: string;
  iteration: number;
  requestTitle?: string;
  requestSummary?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function shortRunId(runId: string | undefined) {
  return runId ? runId.slice(0, 18) : "--";
}
function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}

// The full-build pipeline, in order. `prefix` phases match any node id that
// starts with the key (loops / parallel fan-out / monitor ticks).
const PHASES: { key: string; label: string; gate?: boolean; prefix?: boolean }[] = [
  { key: "setup", label: "Setup" },
  { key: "route", label: "Route" },
  { key: "preflight", label: "Preflight" },
  { key: "intake", label: "Intake" },
  { key: "brainstorm", label: "Brainstorm" },
  { key: "research:", label: "Research (domain · prior-art)", prefix: true },
  { key: "questions", label: "Clarifying questions" },
  { key: "answers", label: "Answers" },
  { key: "prd", label: "PRD" },
  { key: "gate:prd", label: "Gate — PRD", gate: true },
  { key: "design:", label: "Design doc loop", prefix: true },
  { key: "eng:", label: "Eng doc loop", prefix: true },
  { key: "gate:eng", label: "Gate — Eng doc", gate: true },
  { key: "backpressure", label: "Backpressure matrix" },
  { key: "probe:", label: "Assumption probes", prefix: true },
  { key: "gate:probes", label: "Gate — Probes (if blocking)", gate: true },
  { key: "tickets", label: "Tickets" },
  { key: "poc", label: "Proof of concept" },
  { key: "orch:design", label: "Orchestration design" },
  { key: "wf:scaffold", label: "Generate impl workflow" },
  { key: "wf:verify", label: "Validate (graph render)", prefix: true },
  { key: "wf:review", label: "Cross-model wf review" },
  { key: "wf:smoke", label: "Smoke run", prefix: true },
  { key: "gate:launch", label: "Gate — Launch", gate: true },
  { key: "launch", label: "Launch build" },
  { key: "monitor:", label: "Monitor build", prefix: true },
  { key: "gate:incomplete", label: "Gate — Incomplete (if unhealthy)", gate: true },
  { key: "review:", label: "Review panel", prefix: true },
  { key: "polish", label: "Polish" },
  { key: "report:", label: "Final report", prefix: true },
  { key: "gate:delivery", label: "Gate — Delivery (opens PR)", gate: true },
  { key: "delivery", label: "Delivery" },
];

type PhaseState = "pending" | "running" | "done" | "failed";

function classifyType(t: string): PhaseState | null {
  if (/fail|error|denied/i.test(t)) return "failed";
  if (/complete|produced|finish|success|approved|skipped/i.test(t)) return "done";
  if (/start|begin|running|attempt|pending/i.test(t)) return "running";
  return null;
}

const styles = [
  ":root { --bg:#0c0c0e; --panel:#151518; --card:#1c1c1f; --text:#eee; --muted:#8a8a8e; --border:#262629; --primary:#5e6ad2; --ok:#4ade80; --err:#f87171; --warn:#fbbf24; color-scheme:dark; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; }",
  "* { box-sizing:border-box; }",
  "body { margin:0; background:var(--bg); color:var(--text); font-size:13px; line-height:1.5; }",
  "button,input { font:inherit; }",
  ".shell { height:100vh; display:flex; flex-direction:column; overflow:hidden; }",
  ".topbar { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:12px 20px; border-bottom:1px solid var(--border); }",
  ".title-group { display:flex; align-items:center; gap:12px; min-width:0; }",
  "h1 { margin:0; font-size:14px; font-weight:600; }",
  ".pill { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--muted); background:var(--panel); padding:4px 10px; border-radius:6px; border:1px solid var(--border); }",
  ".mono { font-family:ui-monospace,monospace; font-size:11px; }",
  ".toolbar { display:flex; align-items:center; gap:8px; flex:1; justify-content:flex-end; }",
  ".prompt { flex:1; max-width:360px; height:30px; padding:0 10px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); }",
  ".button { height:30px; padding:0 12px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); cursor:pointer; font-weight:500; }",
  ".button:hover { background:var(--card); }",
  ".button.primary { background:var(--primary); color:#fff; border-color:var(--primary); }",
  ".button.ok { background:var(--ok); color:#06270f; border-color:var(--ok); }",
  ".button.danger { color:var(--err); border-color:var(--err); }",
  ".button:disabled { opacity:0.4; cursor:not-allowed; }",
  ".main { display:grid; grid-template-columns:1fr 300px; flex:1; overflow:hidden; }",
  ".content { padding:20px; overflow:auto; }",
  ".badge { font-size:11px; font-weight:600; text-transform:uppercase; padding:3px 8px; border-radius:5px; border:1px solid var(--border); }",
  ".badge.running { color:var(--warn); border-color:var(--warn); }",
  ".badge.finished { color:var(--ok); border-color:var(--ok); }",
  ".badge.failed { color:var(--err); border-color:var(--err); }",
  ".card { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:16px 18px; margin-bottom:16px; }",
  ".card h2 { margin:0 0 10px; font-size:12px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); }",
  ".gate { border-color:var(--warn); box-shadow:0 0 0 1px var(--warn) inset; }",
  ".gate h3 { margin:0 0 6px; font-size:15px; }",
  ".gate .sum { color:var(--muted); white-space:pre-wrap; margin-bottom:12px; max-height:220px; overflow:auto; }",
  ".gate-actions { display:flex; gap:8px; align-items:center; }",
  ".note { flex:1; height:30px; padding:0 10px; border:1px solid var(--border); border-radius:6px; background:var(--panel); color:var(--text); }",
  ".phases { list-style:none; margin:0; padding:0; }",
  ".phase { display:flex; align-items:center; gap:10px; padding:7px 0; border-bottom:1px solid var(--border); }",
  ".phase:last-child { border-bottom:0; }",
  ".dot { flex:0 0 10px; width:10px; height:10px; border-radius:50%; background:#34343a; }",
  ".dot.running { background:var(--warn); box-shadow:0 0 6px var(--warn); }",
  ".dot.done { background:var(--ok); }",
  ".dot.failed { background:var(--err); }",
  ".phase.gate .plabel { color:var(--warn); font-weight:600; }",
  ".phase .pstate { margin-left:auto; font-size:11px; color:var(--muted); text-transform:uppercase; }",
  ".err { color:var(--err); white-space:pre-wrap; font-family:ui-monospace,monospace; font-size:11px; max-height:160px; overflow:auto; }",
  ".sidebar { border-left:1px solid var(--border); background:var(--panel); overflow:auto; }",
  ".side-head { padding:12px 16px; font-size:11px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); border-bottom:1px solid var(--border); }",
  ".run-row { width:100%; text-align:left; padding:10px 16px; border:0; border-bottom:1px solid var(--border); background:transparent; color:var(--text); cursor:pointer; display:flex; justify-content:space-between; gap:8px; }",
  ".run-row:hover { background:var(--card); }",
  ".run-row.active { background:var(--card); box-shadow:inset 2px 0 0 var(--primary); }",
  ".log { font-family:ui-monospace,monospace; font-size:11px; color:var(--muted); max-height:220px; overflow:auto; }",
  ".log div { padding:2px 0; border-bottom:1px solid var(--border); }",
  ".empty { color:var(--muted); text-align:center; padding:48px 16px; }",
].join("\n");

function statusClass(status: string | undefined) {
  if (status === "running" || status === "continued" || status === "waiting-approval" || status === "waiting-event")
    return "running";
  if (status === "finished") return "finished";
  if (status === "failed" || status === "cancelled") return "failed";
  return "";
}

function App() {
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(runIdFromUrl());
  const [prompt, setPrompt] = useState("Build the product described in PROMPT.md");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const runsQuery = useGatewayRuns({ filter: { limit: 30 } });
  const actions = useGatewayActions();

  const runs = useMemo(
    () => ((runsQuery.data ?? []) as RunSummary[]).filter((r) => !r.workflowKey || r.workflowKey === WORKFLOW_KEY),
    [runsQuery.data],
  );
  const activeRunId = selectedRunId ?? runs[0]?.runId;
  const activeRun = runs.find((r) => r.runId === activeRunId);

  const runDetail = useGatewayRun(activeRunId);
  const stream = useGatewayRunEvents(activeRunId, { afterSeq: 0 });
  const approvalsQuery = useGatewayApprovals(activeRunId ? { filter: { runId: activeRunId } } : {});
  const finalOutput = useGatewayNodeOutput({ runId: activeRunId, nodeId: "report:final", iteration: 0 });

  const detail = (runDetail.data as Record<string, unknown> | undefined) ?? {};
  const runStatus = asString(detail.status) ?? activeRun?.status;
  const runError = (() => {
    const ej = detail.errorJson;
    if (!ej) return undefined;
    try {
      const o = typeof ej === "string" ? JSON.parse(ej) : ej;
      return isRecord(o) ? asString(o.message) ?? JSON.stringify(o) : String(ej);
    } catch {
      return String(ej);
    }
  })();

  const events = stream.events ?? [];
  const eventCount = events.length;

  // Per-node latest state from the event stream (failed > done > running).
  const nodeState = useMemo(() => {
    const rank: Record<PhaseState, number> = { pending: 0, running: 1, done: 2, failed: 3 };
    const map = new Map<string, PhaseState>();
    for (const ev of events) {
      const rec: Record<string, unknown> = isRecord(ev) ? ev : {};
      const nodeId = asString(rec.nodeId) ?? asString(rec.taskId);
      const t = asString(rec.type) ?? asString(rec.kind) ?? "";
      if (!nodeId) continue;
      const s = classifyType(t);
      if (!s) continue;
      const prev = map.get(nodeId);
      if (!prev || rank[s] >= rank[prev]) map.set(nodeId, s);
    }
    return map;
  }, [events]);

  function phaseState(p: { key: string; prefix?: boolean }): PhaseState {
    let best: PhaseState = "pending";
    const rank: Record<PhaseState, number> = { pending: 0, running: 1, done: 2, failed: 3 };
    for (const [nodeId, st] of nodeState) {
      const match = p.prefix ? nodeId.startsWith(p.key) : nodeId === p.key;
      if (match && rank[st] > rank[best]) best = st;
    }
    return best;
  }

  const pendingApprovals = useMemo(
    () => ((approvalsQuery.data ?? []) as ApprovalSummary[]).filter((a) => a.runId === activeRunId),
    [approvalsQuery.data, activeRunId],
  );

  const finalReport = useMemo(() => {
    const d = finalOutput.data;
    const resp = isRecord(d) ? d : {};
    const row = isRecord(resp.row) ? resp.row : isRecord(resp) ? resp : {};
    if (asString(row.summary) === undefined && asString(row.status) === undefined) return null;
    return {
      status: asString(row.status),
      summary: asString(row.summary),
      artifactPath: asString(row.artifactPath),
    };
  }, [finalOutput.data]);

  async function refresh() {
    await Promise.all([
      runsQuery.refetch(),
      runDetail.refetch?.(),
      approvalsQuery.refetch?.(),
      finalOutput.refetch?.(),
    ].filter(Boolean) as Promise<unknown>[]);
  }
  async function launch() {
    setBusy(true);
    try {
      const run = await actions.launchRun({
        workflow: WORKFLOW_KEY,
        input: { prompt, route: "full-build", review: true, poc: true },
      });
      setSelectedRunId(run.runId);
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  async function decide(a: ApprovalSummary, approved: boolean) {
    setBusy(true);
    try {
      await actions.submitApproval({
        runId: a.runId,
        nodeId: a.nodeId,
        iteration: a.iteration,
        decision: { approved, note: note || undefined },
      });
      setNote("");
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (!activeRunId) return;
    setBusy(true);
    try {
      await actions.cancelRun({ runId: activeRunId });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const recentEvents = events.slice(-40).reverse();

  return (
    <main className="shell" data-testid="smithering-ui">
      <style>{styles}</style>
      <header className="topbar">
        <div className="title-group">
          <h1>Smithering</h1>
          <span className="pill"><span className="mono">{activeRunId ? shortRunId(activeRunId) : "No run"}</span></span>
          {activeRunId ? (
            <span className={"badge " + statusClass(runStatus)} data-testid="smithering-status">{runStatus ?? "idle"}</span>
          ) : null}
          {activeRunId ? <span className="pill">{eventCount} events</span> : null}
          {pendingApprovals.length > 0 ? <span className="badge running">{pendingApprovals.length} gate(s) waiting</span> : null}
        </div>
        <div className="toolbar">
          <input className="prompt" value={prompt} onChange={(e) => setPrompt(e.currentTarget.value)} placeholder="Product request…" />
          <button className="button" onClick={() => void refresh()} disabled={busy}>Refresh</button>
          {statusClass(runStatus) === "running" ? (
            <button className="button danger" onClick={() => void cancel()} disabled={busy}>Cancel</button>
          ) : null}
          <button className="button primary" onClick={() => void launch()} disabled={busy}>New run</button>
        </div>
      </header>

      <div className="main">
        <div className="content">
          {pendingApprovals.map((a) => (
            <div className="card gate" key={a.nodeId + ":" + a.iteration} data-testid="smithering-gate">
              <h3>✋ {a.requestTitle ?? a.nodeId}</h3>
              <div className="sum">{a.requestSummary ?? "(no summary provided)"}</div>
              <div className="gate-actions">
                <input className="note" value={note} onChange={(e) => setNote(e.currentTarget.value)} placeholder="optional note…" />
                <button className="button ok" onClick={() => void decide(a, true)} disabled={busy}>Approve</button>
                <button className="button danger" onClick={() => void decide(a, false)} disabled={busy}>Deny</button>
              </div>
            </div>
          ))}

          {runError ? (
            <div className="card">
              <h2>Run error</h2>
              <div className="err">{runError}</div>
            </div>
          ) : null}

          {finalReport ? (
            <div className="card">
              <h2>Final report{finalReport.status ? " — " + finalReport.status : ""}</h2>
              <div style={{ whiteSpace: "pre-wrap" }}>{finalReport.summary}</div>
              {finalReport.artifactPath ? <div className="mono" style={{ marginTop: 8, color: "var(--muted)" }}>{finalReport.artifactPath}</div> : null}
            </div>
          ) : null}

          <div className="card">
            <h2>Pipeline</h2>
            {activeRunId ? (
              <ul className="phases">
                {PHASES.map((p) => {
                  const st = phaseState(p);
                  return (
                    <li className={"phase" + (p.gate ? " gate" : "")} key={p.key}>
                      <span className={"dot " + st} />
                      <span className="plabel">{p.label}</span>
                      <span className="pstate">{st === "pending" ? "" : st}</span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="empty">No run selected. Start one with “New run”, or launch from the CLI.</div>
            )}
          </div>

          <div className="card">
            <h2>Recent events</h2>
            <div className="log">
              {recentEvents.map((ev, i) => {
                const rec: Record<string, unknown> = isRecord(ev) ? ev : {};
                const node = asString(rec.nodeId) ?? asString(rec.taskId) ?? "";
                const t = asString(rec.type) ?? asString(rec.kind) ?? "event";
                return <div key={i}>{t}{node ? "  ·  " + node : ""}</div>;
              })}
              {recentEvents.length === 0 ? <div>No events yet.</div> : null}
            </div>
          </div>
        </div>

        <aside className="sidebar">
          <div className="side-head">Smithering runs</div>
          {runs.map((r) => (
            <button
              key={r.runId}
              className={"run-row" + (r.runId === activeRunId ? " active" : "")}
              onClick={() => setSelectedRunId(r.runId)}
            >
              <span className="mono">{shortRunId(r.runId)}</span>
              <span className={"badge " + statusClass(r.status)}>{r.status ?? "?"}</span>
            </button>
          ))}
          {runs.length === 0 ? <div className="empty">No runs yet.</div> : null}
        </aside>
      </div>
    </main>
  );
}

createGatewayReactRoot(<App />);
