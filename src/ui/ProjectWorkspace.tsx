import { useEffect, useRef, useState } from "react";
import type { ProjectorSnapshot } from "./types";
import { projectStatus } from "./project-status";
import { ProjectRecorder } from "./ProjectRecorder";
import { TextChange } from "./TextChange";
import { backendsOf, buildsOf } from "./buildloop";
import { executionOf } from "./stage";

export function ProjectWorkspace({
  snapshot,
  onSelect,
  onAdd,
  onHelp,
  planting,
  onStartMic,
  micError,
}: {
  snapshot: ProjectorSnapshot;
  onSelect: (callsign: string) => void;
  onAdd: () => void;
  onHelp: () => void;
  planting: boolean;
  onStartMic: () => void;
  micError: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [branch, setBranch] = useState("");
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open]);
  const inputRef = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);
  useEffect(() => {
    if (planting) setOpen(false);
  }, [planting]);
  const close = () => {
    setOpen(false);
    opener.current?.focus();
  };
  const post = async (path: string) => {
    setError("");
    try {
      const response = await fetch(path, { method: "POST" });
      if (!response.ok)
        throw new Error((await response.json()).error ?? "Action failed");
    } catch (error) {
      setError(String(error));
    }
  };
  const recorder = snapshot.processes.find(
    (process) => process.upid === snapshot.steeringUpid,
  );
  const process = snapshot.processes.find(
    (process) => process.upid === selected,
  );
  const jobs = snapshot.branchJobs ?? [];
  const status = process ? projectStatus(process, jobs, now) : null;
  const latest = jobs.filter((job) => job.upid === selected).at(-1);
  const interrupted = snapshot.recovery?.interrupted.length ?? 0;
  const activeJobs = jobs.filter((job) =>
    ["queued", "implementing", "validating", "committing"].includes(job.status),
  ).length;
  const adopted = process?.source?.kind === "github-import";
  const branches = process?.treeRepo?.branches ?? [];
  return (
    <>
      {!planting && (
        <nav className="workspace-nav" aria-label="Room actions">
          <button
            ref={opener}
            className="ctl-button"
            aria-expanded={open}
            aria-controls="project-workspace"
            onClick={() => setOpen(!open)}
          >
            Projects ({snapshot.processes.length})
            {activeJobs ? ` · ${activeJobs} running` : ""}
          </button>
          <button className="ctl-button" onClick={onAdd}>
            Add project
          </button>
          <button className="ctl-button" onClick={onHelp}>
            Help
          </button>
        </nav>
      )}
      {snapshot.recovery?.error && (
        <div className="recovery-banner" role="alert">
          {snapshot.recovery.error}
        </div>
      )}
      {interrupted > 0 && !open && !planting && (
        <button className="recovery-banner" onClick={() => setOpen(true)}>
          {interrupted} interrupted project{interrupted === 1 ? "" : "s"} —
          review recovery
        </button>
      )}
      {recorder && (
        <aside className="persistent-recording" aria-label="Active recording">
          <strong>
            {snapshot.mic?.active ? "Recording for " : "Recording target: "}
            {recorder.callsign}
            {snapshot.steeringBranch
              ? ` · ${snapshot.steeringBranch}`
              : recorder.steeringMode === "grow"
                ? " · new branch"
                : ""}
          </strong>
          <ProjectRecorder
            process={recorder}
            snapshot={snapshot}
            branch={snapshot.steeringBranch}
          />
          {!snapshot.mic?.active && (
            <div role="status">
              <p>The microphone is off. Start it before speaking.</p>
              <button className="ctl-button" onClick={onStartMic}>
                Start microphone
              </button>
              {micError && <p role="alert">{micError}</p>}
            </div>
          )}
          <button
            className="ctl-button"
            onClick={() => void post("/api/process/select/cancel")}
          >
            Cancel recording
          </button>
          <p className="recording-echo">
            {snapshot.transcript
              .filter(
                (line) =>
                  !recorder.steeringSince ||
                  line.time >= recorder.steeringSince,
              )
              .slice(-3)
              .map((line) => line.text)
              .join(" ") ||
              (snapshot.mic?.active
                ? "Listening for your change…"
                : "Waiting for microphone…")}
          </p>
        </aside>
      )}
      {open && !planting && (
        <section
          id="project-workspace"
          className="project-workspace"
          aria-label="Projects"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              close();
            }
          }}
        >
          <header>
            <h2>Projects</h2>
            <button
              className="ctl-button"
              onClick={close}
              aria-label="Close projects"
            >
              Close
            </button>
          </header>
          <input
            ref={inputRef}
            aria-label="Search projects"
            placeholder="Search projects…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <details>
            <summary>
              Providers
              {snapshot.providers && !snapshot.providers.allReal
                ? " · fallback services active"
                : ""}
            </summary>
            {snapshot.providers?.degraded.map((leg, i) => (
              <p key={i}>
                {leg.leg}: {leg.mode} — {leg.detail}
              </p>
            ))}
            {backendsOf(snapshot).map((provider) => (
              <p key={provider.id}>
                {provider.label}:{" "}
                {provider.enabled
                  ? provider.available
                    ? "available"
                    : "unavailable"
                  : "disabled"}
                {provider.reason ? ` — ${provider.reason}` : ""}
              </p>
            ))}
          </details>
          <div className="project-list">
            {snapshot.processes
              .filter((process) =>
                `${process.callsign} ${process.task}`
                  .toLowerCase()
                  .includes(query.toLowerCase()),
              )
              .map((process) => (
                <button
                  className="project-row"
                  key={process.upid}
                  aria-pressed={selected === process.upid}
                  onClick={() => {
                    setSelected(process.upid);
                    setBranch("");
                  }}
                >
                  <strong>{process.callsign}</strong>
                  <span>{process.task}</span>
                  <small>{projectStatus(process, jobs, now).label}</small>
                </button>
              ))}
          </div>
          {process && status && (
            <article
              className="project-detail"
              aria-label={`${process.callsign} work`}
            >
              <h3>
                {process.callsign}: {status.label}
              </h3>
              <p role="status">{status.detail}</p>
              <button
                className="ctl-button"
                onClick={() => {
                  onSelect(process.callsign);
                  close();
                }}
              >
                Show in garden
              </button>
              {status.retry && (
                <button
                  className="ctl-button"
                  onClick={() =>
                    void post(`/api/process/${process.upid}/retry`)
                  }
                >
                  Retry project
                </button>
              )}
              {status.active && !latest && (
                <button
                  className="ctl-button"
                  onClick={() =>
                    void post(`/api/process/${process.upid}/cancel-work`)
                  }
                >
                  Cancel work
                </button>
              )}
              {process.previewUrl && (
                <a href={process.previewUrl} target="_blank" rel="noreferrer">
                  {process.previewUrl === process.treeRepo?.remoteUrl
                    ? "Open repository"
                    : "Open preview"}
                </a>
              )}
              {buildsOf(process)
                .filter((build) => build.slideshowUrl)
                .map((build) => (
                  <a
                    key={build.backend}
                    href={build.slideshowUrl!}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {build.label} deck
                  </a>
                ))}
              {executionOf(process)?.status === "built" && (
                <p>Full application build completed.</p>
              )}
              {adopted && (
                <label>
                  Change target
                  <select
                    aria-label="Change target"
                    value={branch}
                    onChange={(event) => setBranch(event.target.value)}
                  >
                    <option value="">Grow a new branch</option>
                    {branches
                      .filter((branch) => branch.name.startsWith("room/"))
                      .map((branch) => (
                        <option key={branch.name}>{branch.name}</option>
                      ))}
                  </select>
                </label>
              )}
              {process.state !== "halted" && (
                <ProjectRecorder
                  process={process}
                  snapshot={snapshot}
                  branch={branch}
                  grow={adopted && !branch}
                />
              )}
              {process.state !== "halted" && (
                <TextChange
                  key={`${process.upid}/${branch}`}
                  upid={process.upid}
                  grow={adopted && !branch}
                  {...(branch ? { branch } : {})}
                />
              )}
              {jobs
                .filter((job) => job.upid === selected)
                .slice(-8)
                .reverse()
                .map((job) => (
                  <section
                    className="branch-job"
                    key={job.id}
                    aria-label={`Branch job ${job.branch}`}
                  >
                    <strong>
                      {job.branch} · {job.status}
                    </strong>
                    <p>{job.request}</p>
                    {job.error && <p role="alert">{job.error}</p>}
                    {job.files.length > 0 && (
                      <p>Changed: {job.files.join(", ")}</p>
                    )}
                    {job.checks.length > 0 && (
                      <p>Passed: {job.checks.join("; ")}</p>
                    )}
                    {job.previewUrl ? (
                      <a href={job.previewUrl} target="_blank" rel="noreferrer">
                        Open branch preview
                      </a>
                    ) : job.status === "ready" ? (
                      <p>
                        Changes committed. No static browser entry point was
                        found; run the project using its own instructions.
                      </p>
                    ) : null}
                    {["failed", "cancelled", "interrupted"].includes(
                      job.status,
                    ) && (
                      <button
                        className="ctl-button"
                        onClick={() =>
                          void post(`/api/branch-job/${job.id}/retry`)
                        }
                      >
                        Retry branch change
                      </button>
                    )}
                    {["queued", "implementing", "validating"].includes(
                      job.status,
                    ) && (
                      <button
                        className="ctl-button"
                        onClick={() =>
                          void post(`/api/branch-job/${job.id}/cancel`)
                        }
                      >
                        Cancel change
                      </button>
                    )}
                  </section>
                ))}
            </article>
          )}
          {snapshot.processes.length === 0 && (
            <p>No projects yet. Add a project or plant an idea to begin.</p>
          )}
          {snapshot.steerLanding?.error && (
            <p role="alert">{snapshot.steerLanding.error}</p>
          )}
          {error && <p role="alert">{error}</p>}
        </section>
      )}
    </>
  );
}
