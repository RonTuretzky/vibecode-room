// Production steering is an agent implementation job. The deterministic notes
// writer remains available only as an explicit demo/test mode; never a fallback.
import type { BranchJobs } from "./branch-jobs";
import {
  steerApplierEnabled,
  applySteerEdit as writeNotes,
  type ApplySteerEditInput,
  type ApplySteerEditResult,
} from "./notes-writer";
export { steerApplierEnabled } from "./notes-writer";
export type {
  ApplySteerEditInput,
  ApplySteerEditResult,
  SteerApplierGit,
} from "./notes-writer";
export async function applySteerEdit(
  input: ApplySteerEditInput & { jobs?: BranchJobs },
): Promise<ApplySteerEditResult> {
  if (!steerApplierEnabled(input.env ?? process.env))
    return { ok: false, error: "The branch writer is disabled" };
  if (input.env?.VIBERSYN_BRANCH_WRITER === "notes") return writeNotes(input);
  if (!input.jobs)
    return {
      ok: false,
      error:
        "Agent branch writer unavailable. The request was not implemented.",
    };
  const job = await input.jobs.run(input.upid, input.branch, input.text);
  return job.status === "ready"
    ? { ok: true, branch: job.branch, unchanged: false }
    : { ok: false, error: job.error ?? job.status };
}
