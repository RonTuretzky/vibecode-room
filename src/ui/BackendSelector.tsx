import type { BackendChip } from "./buildloop";

/**
 * Backend selector — toggle chips for the build backends (smithers/eliza/native).
 *
 * Rendered from snapshot.backends; each click asks App to POST /api/backends
 * {id, enabled} so the NEXT accepted idea fans out to the chosen set. An
 * unavailable backend renders dimmed with its reason as the tooltip — it stays
 * clickable (enabled is config; availability is the backend's health), so the
 * room can pre-arm a backend that is still coming up. Renders nothing at all
 * when the roster is empty (old servers), keeping the wall backward-compatible.
 */

export interface BackendSelectorProps {
  backends: BackendChip[];
  // App owns the POST + snapshot application (and the offline-demo fallback).
  onToggle: (id: string, enabled: boolean) => void;
}

export function BackendSelector({ backends: allBackends, onToggle }: BackendSelectorProps) {
  // The eliza backend is legacy — hidden from the wall entirely (the server
  // may still report it; it just can't be toggled from the room UI).
  const backends = allBackends.filter((backend) => backend.id !== "eliza");
  if (backends.length === 0) {
    return null;
  }
  const enabledCount = backends.filter((backend) => backend.enabled).length;
  return (
    <section className="rail-card backend-card" data-testid="backend-selector" aria-label="Build backends">
      <div className="rail-title-row">
        <h3 className="rail-title">Backends</h3>
        <span className="trace-count">
          {enabledCount}/{backends.length} on
        </span>
      </div>
      <div className="backend-chips">
        {backends.map((backend) => {
          const hint = !backend.available
            ? `Unavailable: ${backend.reason ?? "backend not reachable"}`
            : backend.enabled
              ? `Disable ${backend.label} builds.`
              : `Enable ${backend.label} builds.`;
          return (
            <button
              key={backend.id}
              type="button"
              className={`backend-chip${backend.enabled ? " on" : ""}${backend.available ? "" : " unavailable"}`}
              data-testid="backend-chip"
              data-backend={backend.id}
              data-enabled={backend.enabled ? "true" : "false"}
              data-available={backend.available ? "true" : "false"}
              aria-pressed={backend.enabled}
              title={hint}
              onClick={() => onToggle(backend.id, !backend.enabled)}
            >
              <span className="backend-dot" aria-hidden="true" />
              {backend.label}
            </button>
          );
        })}
      </div>
    </section>
  );
}
