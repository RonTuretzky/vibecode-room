import type { LogEvent } from "../types";
import type { ProjectorProcess } from "./types";
import { traceClass, summarizeMeta } from "./trace-utils";

/**
 * Build detail — the glass card a bubble expands into.
 *
 * The rest of the field dims + blurs behind it (depth of field, handled in App).
 * Shows the full build context: task, state, model, last output, last action,
 * UPID/runId, the per-process action log (process.events) and the trace
 * breadcrumbs scoped to this process.
 */

export interface BuildDetailProps {
  process: ProjectorProcess;
  trace: LogEvent[];
  onClose: () => void;
}

export function BuildDetail({ process, trace, onClose }: BuildDetailProps) {
  // Breadcrumbs for this build: traces tagged with this UPID, falling back to a
  // run-name match so a glance still shows "how the build is going".
  const breadcrumbs = trace.filter(
    (event) => event.upid === process.upid || summarizeMeta(event.meta).includes(process.runId),
  );

  return (
    <div
      className={`build-detail state-${process.state}`}
      data-testid="build-detail"
      role="dialog"
      aria-modal="true"
      aria-label={`Build detail for ${process.callsign}`}
      onClick={(clickEvent) => clickEvent.stopPropagation()}
    >
      <div className="detail-glass" aria-hidden="true" />

      <header className="detail-head">
        <div className="detail-identity">
          <span className="detail-eyebrow">build detail</span>
          <h2 className="detail-callsign" data-testid="detail-callsign">
            {process.callsign}
          </h2>
          <p className="detail-task">{process.task}</p>
        </div>
        <div className="detail-head-right">
          <span className={`detail-state badge state-${process.state}`} data-testid="detail-state">
            {process.state}
          </span>
          <button type="button" className="detail-back" onClick={onClose} aria-label="Close build detail">
            <span aria-hidden="true">←</span> back
          </button>
        </div>
      </header>

      <div className="detail-grid">
        <DetailField label="Model" value={process.model} />
        <DetailField label="Progress" value={`${process.progress}% · ${process.progressLabel}`} />
        <DetailField label="Last action" value={process.lastAction} />
        <DetailField label="UPID" value={process.upid} mono />
        <DetailField label="Run ID" value={process.runId} mono />
        <PreviewField previewUrl={process.previewUrl} buildStatus={process.buildStatus} />
      </div>

      <section className="detail-output">
        <span className="detail-label">Last spoken output</span>
        <p>{process.lastOutput}</p>
      </section>

      <div className="detail-columns">
        <section className="detail-log" data-testid="detail-action-log">
          <span className="detail-label">Action log</span>
          <ol>
            {process.events.slice(-5).map((entry, index) => (
              <li key={`${entry}-${index}`}>
                <span className="log-dot" aria-hidden="true" />
                {entry}
              </li>
            ))}
          </ol>
        </section>

        <section className="detail-trace" data-testid="detail-trace">
          <span className="detail-label">Trace breadcrumbs</span>
          {breadcrumbs.length > 0 ? (
            <ol>
              {breadcrumbs.map((event, index) => (
                <li key={`${event.event}-${event.correlationId ?? index}`} className={traceClass(event.event)}>
                  <code className="bc-event">{event.event}</code>
                  <span className="bc-meta">{summarizeMeta(event.meta)}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="detail-empty">No trace events scoped to this build yet.</p>
          )}
        </section>
      </div>
    </div>
  );
}

// The real accept->build->preview surface in the detail card. While the build is
// in flight it shows a "building" hint; once the scaffolded page is served it
// shows a clickable "Preview ->" to the live http://127.0.0.1:<port>/ URL. Absent
// entirely for processes that never triggered a build (the seeded demo fleet).
function PreviewField({
  previewUrl,
  buildStatus,
}: {
  previewUrl?: string | null;
  buildStatus?: ProjectorProcess["buildStatus"];
}) {
  if (buildStatus === undefined || buildStatus === null) {
    return null;
  }
  return (
    <div className="detail-field detail-preview" data-testid="detail-preview" data-build-status={buildStatus}>
      <span className="detail-label">Preview</span>
      {buildStatus === "ready" && previewUrl ? (
        <a
          className="detail-value detail-preview-link"
          data-testid="detail-preview-link"
          href={previewUrl}
          target="_blank"
          rel="noreferrer"
        >
          Preview →
        </a>
      ) : (
        <span className="detail-value">{buildStatus === "failed" ? "build failed" : "building…"}</span>
      )}
    </div>
  );
}

function DetailField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="detail-field">
      <span className="detail-label">{label}</span>
      <span className={mono ? "detail-value mono" : "detail-value"}>{value}</span>
    </div>
  );
}
