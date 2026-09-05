import type { ProjectorProcess } from "./types";
import { buildsOf } from "./buildloop";
import { executionOf } from "./stage";
import type { BranchJob } from "../server/branch-jobs";
export interface ProjectStatus {
  label: string;
  detail: string;
  percent: number | null;
  retry: boolean;
  active: boolean;
}
export function projectStatus(
  process: ProjectorProcess,
  jobs: BranchJob[] = [],
  nowMs = Date.now(),
): ProjectStatus {
  const status = (
    label: string,
    detail = "",
    percent: number | null = null,
    retry = false,
    active = false,
  ) => ({ label, detail, percent, retry, active });
  if (process.state === "halted") return status("Stopped", process.lastOutput);
  if (process.recovery)
    return status(
      "Interrupted",
      "Work was interrupted. Review saved work and retry when ready.",
      null,
      true,
    );
  if (process.progressLabel.startsWith("clone failed"))
    return status(
      "Import failed",
      "The repository could not be cloned. Retry the import before making branch changes.",
      null,
      true,
    );
  const projectJobs = jobs.filter((job) => job.upid === process.upid);
  const job =
    projectJobs.find((job) =>
      ["queued", "implementing", "validating", "committing"].includes(
        job.status,
      ),
    ) ?? projectJobs.at(-1);
  if (job)
    return status(
      {
        queued: "Queued",
        implementing: "Implementing",
        validating: "Validating",
        committing: "Committing",
        ready: "Changes committed",
        failed: "Failed",
        cancelled: "Cancelled",
        interrupted: "Interrupted",
      }[job.status],
      job.error ??
        `${job.branch} · ${job.files.length} changed file${job.files.length === 1 ? "" : "s"}`,
      null,
      false,
      ["queued", "implementing", "validating", "committing"].includes(
        job.status,
      ),
    );
  const execution = executionOf(process);
  if (execution)
    return status(
      execution.status === "built"
        ? "App ready"
        : execution.status === "failed"
          ? "Build failed"
          : "Implementing",
      execution.summary ?? execution.progressLabel ?? "",
      execution.percent,
      execution.status === "failed",
      execution.status === "executing",
    );
  const builds = buildsOf(process);
  const building = builds.find((build) => build.status === "building");
  if (building) {
    const stalled =
      building.lastProgressAtMs !== undefined &&
      nowMs - building.lastProgressAtMs > 15_000;
    return status(
      stalled ? "Waiting for concept provider" : "Concept generating",
      stalled
        ? `No progress update for ${Math.floor((nowMs - building.lastProgressAtMs!) / 1000)}s. ${building.progressLabel ?? ""} You can cancel this work and retry.`
        : (building.progressLabel ?? ""),
      null,
      false,
      true,
    );
  }
  if (builds.some((build) => build.status === "ready"))
    return status(
      "Concept ready",
      "Open the deck to refine or commission the app.",
    );
  if (builds.some((build) => build.status === "failed"))
    return status(
      "Concept failed",
      builds.find((build) => build.status === "failed")?.error ??
        "No preview was produced.",
      null,
      true,
    );
  if (process.source?.kind === "github-import")
    return status(
      process.progressLabel.includes("cloning")
        ? "Studying repository"
        : "Project ready",
      process.progressLabel,
    );
  return status(
    "Waiting for a concept provider",
    "Check provider availability, then retry.",
    null,
    true,
  );
}
