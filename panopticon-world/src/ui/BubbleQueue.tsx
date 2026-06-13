import { BUILDING_META, VIS_TO_BUILDING } from "../world/itemMapping.ts";
import { engine, useWorld } from "../world/mockEngine.ts";
import type { WorldBubble } from "../world/types.ts";

// The suggestion sidebar (§5.5): a session-long queue of idea bubbles, each
// shipping a live demo + multiple-choice clarifying questions. Mirrors the real
// Pro UI. Accept → spawn a process (a building rises / a seed sprouts).
export function BubbleQueue() {
  const w = useWorld();
  return (
    <div className="queue">
      <div className="snes-panel" style={{ padding: "8px 12px" }}>
        <div className="snes-title" style={{ margin: 0 }}>
          🫧 IDEA BUBBLES <span style={{ color: "var(--text-dim)", fontSize: 7 }}>({w.bubbles.length})</span>
        </div>
      </div>
      <div className="queue-scroll">
        {w.bubbles.length === 0 && (
          <div className="snes-panel" style={{ fontSize: 15, color: "var(--text-dim)" }}>
            The room is quiet. As people talk, ideas well up from the spring…
          </div>
        )}
        {w.bubbles.map((b) => (
          <BubbleCard key={b.id} b={b} />
        ))}
      </div>
    </div>
  );
}

function BubbleCard({ b }: { b: WorldBubble }) {
  const meta = BUILDING_META[VIS_TO_BUILDING[b.visualizer]];
  const frac = Math.max(0, Math.min(1, 1 - (Date.now() - b.createdAt) / b.ttlMs));
  return (
    <div className={"snes-panel bubble-card" + (b.modelInitiated ? " model" : "")}>
      <h4>
        {meta.icon} {b.title}
        {b.modelInitiated && <span className="tag">MODEL</span>}
      </h4>
      <div className="rationale">{b.rationale}</div>
      <div className="preview">
        {b.demo.html ? (
          <iframe sandbox="allow-scripts" srcDoc={b.demo.html} title={b.id} />
        ) : (
          <pre style={{ margin: 0, padding: 8, font: "11px ui-monospace", color: "#cfe", overflow: "auto", height: "100%" }}>
            {b.demo.content}
          </pre>
        )}
      </div>
      {b.questions.map((q) => (
        <div className="q" key={q.id}>
          <div className="qp">{q.prompt}</div>
          <div className="choices">
            {q.choices.map((c) => (
              <button
                key={c}
                className={"chip" + (b.answers[q.id] === c ? " sel" : "")}
                onClick={() => engine.answer(b.id, q.id, c)}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="ttl">
        <span style={{ width: `${frac * 100}%` }} />
      </div>
      <div className="row">
        <button className="snes-btn" onClick={() => engine.acceptBubble(b.id)}>
          Accept → spawn
        </button>
        <button className="snes-btn ghost" onClick={() => engine.dismissBubble(b.id)}>
          Pop
        </button>
      </div>
    </div>
  );
}
