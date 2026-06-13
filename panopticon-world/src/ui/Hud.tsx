import { engine, useWorld } from "../world/mockEngine.ts";

export function Hud({ onLegend }: { onLegend: () => void }) {
  const w = useWorld();
  const alive = w.processes.filter((p) => p.state !== "dead").length;
  return (
    <div className="hud">
      <div className="snes-panel" style={{ padding: "10px 14px" }}>
        <div className="brand">
          PANOPTICON
          <small>OVERWORLD · an OS for AI-agent work</small>
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <div className="snes-panel hud-stats">
          <div className="stat day">
            <b>{engine.elapsedDays()}</b>
            DAY
          </div>
          <div className="stat">
            <b>{alive}</b>
            PROCESSES
          </div>
          <div className="stat">
            <b>{w.bubbles.length}</b>
            IDEAS
          </div>
        </div>

        <div className="snes-panel" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div className="toggle-row" style={{ margin: 0 }}>
            <button
              className={"snes-btn " + (w.viewMode === "overworld" ? "sel" : "ghost")}
              onClick={() => engine.setViewMode("overworld")}
            >
              🏘 Village
            </button>
            <button
              className={"snes-btn " + (w.viewMode === "grove" ? "sel" : "ghost")}
              onClick={() => engine.setViewMode("grove")}
            >
              🌳 Grove
            </button>
          </div>
          <div className="toggle-row" style={{ margin: 0 }}>
            <button className="snes-btn ghost help-btn" onClick={() => engine.toggleSim()}>
              {w.paused ? "▶ Resume" : "⏸ Pause"}
            </button>
            <button className="snes-btn help-btn" onClick={onLegend}>
              ? Legend
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
