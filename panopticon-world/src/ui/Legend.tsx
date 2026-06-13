import { BUILDING_META, LEGEND, VIS_TO_BUILDING } from "../world/itemMapping.ts";
import type { VisualizerKind } from "../world/types.ts";

const KINDS: VisualizerKind[] = ["code", "web", "art", "book", "text", "data"];

export function Legend({ onClose }: { onClose: () => void }) {
  return (
    <div className="legend" onClick={onClose}>
      <div className="legend-inner snes-panel" onClick={(e) => e.stopPropagation()}>
        <div className="snes-title" style={{ fontSize: 12, justifyContent: "space-between" }}>
          <span>🗺 PANOPTICON, AS A WORLD — what each item means</span>
          <button className="snes-btn" onClick={onClose}>
            ✕ Close
          </button>
        </div>

        <p style={{ fontSize: 16, color: "var(--text-dim)", margin: "0 0 12px", lineHeight: 1.15 }}>
          Every Panopticon feature is mapped to an in-game item. Talk in the <b style={{ color: "var(--gold)" }}>ROOM</b>{" "}
          box (or 🎤) → ideas bubble from the spring → <b style={{ color: "var(--gold)" }}>Accept</b> one to raise a
          building. Click a building to steer it. Toggle <b style={{ color: "var(--gold)" }}>🌳 Grove</b> to see the same
          processes as a growing lineage tree you can re-graft.
        </p>

        <div className="legend-grid">
          {LEGEND.map((e, i) => (
            <div className="legend-item" key={i}>
              <div className="ico">{e.icon}</div>
              <div>
                <div className="lt">{e.title}</div>
                <div className="lf" dangerouslySetInnerHTML={{ __html: e.feature }} />
              </div>
            </div>
          ))}
        </div>

        <div className="snes-title" style={{ marginTop: 16 }}>
          🏗 PROCESS BUILDINGS — auto-picked by the artifact a process produces (G5)
        </div>
        <div className="legend-grid">
          {KINDS.map((k) => {
            const m = BUILDING_META[VIS_TO_BUILDING[k]];
            return (
              <div className="legend-item" key={k}>
                <div className="ico">{m.icon}</div>
                <div>
                  <div className="lt">
                    {m.label} <span style={{ color: "var(--cyan)" }}>· {k}</span>
                  </div>
                  <div className="lf">Produces {m.produces}.</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
