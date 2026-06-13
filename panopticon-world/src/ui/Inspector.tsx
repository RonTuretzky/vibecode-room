import type { FormEvent } from "react";
import { AGENT_CREATURE, BUILDING_META, MODEL_WORKER, VIS_TO_BUILDING } from "../world/itemMapping.ts";
import { engine, useWorld } from "../world/mockEngine.ts";

// The selected-process panel: the §5.2 metadata column + the steer pathway
// (click → type → Enter → effect) + lifecycle actions. Steering is bound to the
// explicitly selected process only (C2/C3).
export function Inspector() {
  const w = useWorld();
  const p = w.processes.find((x) => x.upid === w.selected);
  if (!p) return null;

  const meta = BUILDING_META[VIS_TO_BUILDING[p.visualizer]];
  const worker = MODEL_WORKER[p.model];
  const grafting = w.graftFrom === p.upid;

  const steer = (e: FormEvent) => {
    e.preventDefault();
    const inp = (e.currentTarget as HTMLFormElement).elements.namedItem("p") as HTMLInputElement;
    const v = inp.value.trim();
    if (!v) return;
    engine.prompt(p.upid, v);
    inp.value = "";
  };

  return (
    <div className="inspector snes-panel">
      <div className="snes-title">
        {meta.icon} {p.title} <span className={"badge " + p.state}>{p.state}</span>
      </div>

      <dl className="meta-grid">
        <dt>building</dt>
        <dd>{meta.label}</dd>
        <dt>worker</dt>
        <dd>
          {worker.icon} {worker.rank}
        </dd>
        <dt>agent</dt>
        <dd>{AGENT_CREATURE[p.agent] ?? p.agent}</dd>
        <dt>UPID</dt>
        <dd style={{ fontSize: 12 }}>{p.upid}</dd>
        {p.parentId && (
          <>
            <dt>forked from</dt>
            <dd style={{ fontSize: 12 }}>{w.processes.find((x) => x.upid === p.parentId)?.title ?? p.parentId}</dd>
          </>
        )}
      </dl>

      <div className="flags">
        <span className="flag">{p.model.replace("claude-", "")}</span>
        <span className="flag">{p.mode.execution}</span>
        <span className={"flag" + (p.mode.safety === "dangerous" ? " live" : "")}>{p.mode.safety}</span>
        <span className="flag">📥 inbox {p.inbox}</span>
      </div>

      <div className="log">
        {p.log.slice(-8).map((l, i) => (
          <div key={i} className={l.role}>
            {l.role === "you" ? "› " : "» "}
            {l.text}
          </div>
        ))}
      </div>

      {p.state !== "dead" && (
        <form onSubmit={steer}>
          <input name="p" placeholder="steer this process…" autoComplete="off" />
          <button type="submit" className="snes-btn">
            ⏎
          </button>
        </form>
      )}

      <div className="row" style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
        {p.state !== "dead" && (
          <button className="snes-btn ghost" onClick={() => engine.pause(p.upid)}>
            {p.state === "paused" ? "▶ Resume" : "⏸ Pause"}
          </button>
        )}
        <button className="snes-btn ghost" onClick={() => engine.fork(p.upid)}>
          ⑂ Fork
        </button>
        {w.viewMode === "grove" && p.state !== "dead" && (
          <button
            className={"snes-btn " + (grafting ? "sel" : "ghost")}
            onClick={() => (grafting ? engine.cancelGraft() : engine.beginGraft(p.upid))}
          >
            ✥ {grafting ? "Cancel" : "Graft"}
          </button>
        )}
        <button
          className="snes-btn ghost"
          onClick={() => alert(`Scan to pair a phone (§5.7):\n\n/m/${p.qrToken}\n\nThe phone becomes a mic + chat device feeding this process's input queue.`)}
        >
          ▦ QR
        </button>
        <button className="snes-btn danger" onClick={() => engine.kill(p.upid)}>
          ✕ Kill
        </button>
      </div>
    </div>
  );
}
