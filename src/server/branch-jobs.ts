import { localAiEnabled } from "../config/local";
import { runLocalAgent } from "../providers/local-agent";
import { runCommand as runBranchCommand } from "../process/run-command";
export { runCommand as runBranchCommand } from "../process/run-command";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { servePreviewDirectory, type PreviewServer } from "./idea-builder";
import type { TreeGitSubstrate } from "./tree-git";

export type BranchJobStatus =
  | "queued"
  | "implementing"
  | "validating"
  | "committing"
  | "ready"
  | "failed"
  | "cancelled"
  | "interrupted";
export interface BranchJob {
  id: string;
  upid: string;
  branch: string;
  request: string;
  status: BranchJobStatus;
  updatedAtMs: number;
  files: string[];
  checks: string[];
  error: string | null;
  previewUrl: string | null;
  workspace: string;
  previewDir: string | null;
}
export type BranchAgent = (
  dir: string,
  request: string,
  signal: AbortSignal,
) => Promise<void>;

export function branchAgent(
  env: Record<string, string | undefined>,
): BranchAgent {
  if (localAiEnabled(env)) return async (dir, request, signal) => { await runLocalAgent(dir, request, { env, signal }); };
  return async (dir, request, signal) => {
    const prompt = `Implement this user's change in the existing repository. Read its instructions and understand its structure first. Preserve unrelated behavior. Add appropriate tests and run available checks. Do not commit, push, publish, deploy, or modify Git configuration. Do not substitute a notes entry for working code. Work only in this checkout. Report what changed and any remaining limitations.\n\nRequested change:\n${request}`;
    const output = await runBranchCommand(
      [
        env.VIBERSYN_CLAUDE_CLI || "claude",
        "-p",
        prompt,
        "--model",
        env.VIBERSYN_BRANCH_MODEL || "sonnet",
        "--output-format",
        "json",
        "--dangerously-skip-permissions",
      ],
      dir,
      signal,
      { ...process.env, ...env },
      600_000,
    );
    try {
      const result = JSON.parse(output);
      if (result.is_error)
        throw new Error(result.result || "Agent reported a failure");
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  };
}

export class BranchJobs {
  readonly jobs = new Map<string, BranchJob>();
  readonly #controllers = new Map<string, AbortController>();
  readonly #previews = new Map<string, PreviewServer>();
  constructor(
    readonly options: {
      root: string;
      git: TreeGitSubstrate;
      env: Record<string, string | undefined>;
      onUpdate: () => void;
      agent?: BranchAgent;
    },
  ) {}
  snapshot(): BranchJob[] {
    return [...this.jobs.values()].map((job) => ({
      ...job,
      files: [...job.files],
      checks: [...job.checks],
    }));
  }
  async restore(jobs: BranchJob[]): Promise<void> {
    for (const saved of jobs) {
      const expected = resolve(
        this.options.root,
        saved.upid,
        ".branch-jobs",
        saved.id,
      );
      if (
        resolve(saved.workspace) !== expected ||
        (saved.previewDir &&
          resolve(saved.previewDir) !== expected &&
          !resolve(saved.previewDir).startsWith(expected + sep))
      )
        throw new Error("Saved branch path is outside its workspace");
      const job: BranchJob = { ...saved, previewUrl: null };
      if (
        ["queued", "implementing", "validating", "committing"].includes(
          job.status,
        )
      ) {
        job.status = "interrupted";
        job.error =
          "Room restarted. Retry to start a fresh attempt from the saved branch.";
      }
      this.jobs.set(job.id, job);
      if (
        job.status === "ready" &&
        job.previewDir &&
        existsSync(join(job.previewDir, "index.html"))
      )
        await this.#preview(job);
    }
  }
  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || !["queued", "implementing", "validating"].includes(job.status))
      return false;
    this.#controllers.get(id)?.abort();
    this.#update(job, {
      status: "cancelled",
      error: "Cancelled. The branch was not changed.",
    });
    return true;
  }
  async stop(): Promise<void> {
    for (const controller of this.#controllers.values()) controller.abort();
    await Promise.all(
      [...this.#previews.values()].map((server) => server.stop()),
    );
  }
  retry(id: string): Promise<BranchJob> | null {
    const job = this.jobs.get(id);
    return job && ["failed", "interrupted", "cancelled"].includes(job.status)
      ? this.run(job.upid, job.branch, job.request)
      : null;
  }
  async run(upid: string, branch: string, request: string): Promise<BranchJob> {
    const id = crypto.randomUUID();
    const job: BranchJob = {
      id,
      upid,
      branch,
      request,
      status: "queued",
      updatedAtMs: Date.now(),
      files: [],
      checks: [],
      error: null,
      previewUrl: null,
      workspace: join(this.options.root, upid, ".branch-jobs", id),
      previewDir: null,
    };
    const controller = new AbortController();
    this.jobs.set(id, job);
    this.#controllers.set(id, controller);
    this.options.onUpdate();
    const result = await this.options.git.editBranchIsolated(
      upid,
      branch,
      job.workspace,
      `room: ${request.replace(/\s+/g, " ").slice(0, 100)}`,
      async (dir) => {
        controller.signal.throwIfAborted();
        this.#update(job, { status: "implementing" });
        await (this.options.agent ?? branchAgent(this.options.env))(
          dir,
          request,
          controller.signal,
        );
        controller.signal.throwIfAborted();
        this.#update(job, { status: "validating" });
        const run = (args: string[]) =>
          runBranchCommand(args, dir, controller.signal, {
            ...process.env,
            ...this.options.env,
          });
        await run(["git", "add", "-A"]);
        const files = (
          await run(["git", "diff", "--cached", "--name-only", "-z", "HEAD"])
        )
          .split("\0")
          .filter(Boolean);
        if (!files.length)
          throw new Error("The agent made no changes. Nothing was committed.");
        this.#update(job, { files });
        await run(["git", "diff", "--cached", "--check"]);
        job.checks.push("git diff --check");
        if (existsSync(join(dir, "package.json"))) {
          const pkg = JSON.parse(
            await readFile(join(dir, "package.json"), "utf8"),
          );
          const manager =
            existsSync(join(dir, "bun.lock")) ||
            existsSync(join(dir, "bun.lockb"))
              ? "bun"
              : existsSync(join(dir, "pnpm-lock.yaml"))
                ? "pnpm"
                : existsSync(join(dir, "yarn.lock"))
                  ? "yarn"
                  : "npm";
          for (const name of ["typecheck", "test", "build"]) {
            if (typeof pkg.scripts?.[name] !== "string") continue;
            await run([manager, "run", name]);
            job.checks.push(`${manager} run ${name}`);
            this.options.onUpdate();
          }
        }
        // Only advertise a browser preview if there is an actual static entry.
        job.previewDir =
          ["dist", "build", "out", "public", ""]
            .map((path) => join(dir, path))
            .find((path) => existsSync(join(path, "index.html"))) ?? null;
        controller.signal.throwIfAborted();
        this.#update(job, { status: "committing" });
      },
    );
    this.#controllers.delete(id);
    if (controller.signal.aborted) return job;
    if (!result.ok)
      this.#update(job, { status: "failed", error: result.error });
    else if (!result.changed)
      this.#update(job, {
        status: "failed",
        error: "No changes relative to the branch tip.",
      });
    else {
      this.#update(job, { status: "ready" });
      if (job.previewDir) await this.#preview(job);
    }
    return job;
  }
  async #preview(job: BranchJob): Promise<void> {
    try {
      const server = await servePreviewDirectory(
        job.previewDir!,
        "127.0.0.1",
        null,
      );
      this.#previews.set(job.id, server);
      this.#update(job, { previewUrl: `http://127.0.0.1:${server.port}/` });
    } catch (error) {
      this.#update(job, {
        error: `Committed; preview could not start: ${String(error)}`,
      });
    }
  }
  #update(job: BranchJob, patch: Partial<BranchJob>): void {
    Object.assign(job, patch, { updatedAtMs: Date.now() });
    this.options.onUpdate();
  }
}
