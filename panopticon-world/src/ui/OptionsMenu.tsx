import { engine, useWorld } from "../world/mockEngine.ts";

// The tunable knobs from the spec (§4): bubbles/min ("idea diarrhea" at the high
// end), suggestion TTL, and the optimistic/explicit · safe/dangerous flags.
export function OptionsMenu() {
  const w = useWorld();
  const c = w.config;
  return (
    <div className="options snes-panel">
      <div className="snes-title">🎛 OPTIONS</div>

      <div className="knob">
        <label>
          bubbles / min <b>{c.bubblesPerMinute}</b>
        </label>
        <input
          type="range"
          min={1}
          max={30}
          value={c.bubblesPerMinute}
          onChange={(e) => engine.setConfig({ bubblesPerMinute: Number(e.target.value) })}
        />
      </div>

      <div className="knob">
        <label>
          suggestion TTL <b>{Math.round(c.suggestionTtlMs / 1000)}s</b>
        </label>
        <input
          type="range"
          min={6}
          max={60}
          value={Math.round(c.suggestionTtlMs / 1000)}
          onChange={(e) => engine.setConfig({ suggestionTtlMs: Number(e.target.value) * 1000 })}
        />
      </div>

      <div className="toggle-row">
        <button
          className={"snes-btn " + (c.execution === "optimistic" ? "sel" : "ghost")}
          onClick={() => engine.setConfig({ execution: "optimistic" })}
        >
          Optimistic
        </button>
        <button
          className={"snes-btn " + (c.execution === "explicit" ? "sel" : "ghost")}
          onClick={() => engine.setConfig({ execution: "explicit" })}
        >
          Explicit
        </button>
      </div>
      <div className="toggle-row">
        <button
          className={"snes-btn " + (c.safety === "safe" ? "sel" : "ghost")}
          onClick={() => engine.setConfig({ safety: "safe" })}
        >
          Safe
        </button>
        <button
          className={"snes-btn " + (c.safety === "dangerous" ? "danger" : "ghost")}
          onClick={() => engine.setConfig({ safety: "dangerous" })}
        >
          Dangerous
        </button>
      </div>
    </div>
  );
}
