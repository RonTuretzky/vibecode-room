import { cp, mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  GatewayEventFrame,
  GatewayRpcTransport,
  StreamRunEventsOptions,
} from "../seam/smithers-client";
import { runLocalAgent } from "../providers/local-agent";
import { runCommand } from "../process/run-command";
import type { RoomEnv } from "../config/profiles";

interface LocalRun {
  id: string;
  status: string;
  error: string | null;
  frames: GatewayEventFrame[];
  controller: AbortController;
  paused: boolean;
  steering: string[];
}

/** Local implementation of the existing execution/event contract. No gateway,
 * cloud subscription, or pretend memory run is involved. */
export class LocalExecutionTransport implements GatewayRpcTransport {
  readonly runs = new Map<string, LocalRun>();
  readonly artifactsRoot: string;
  readonly buildsRoot: string;
  readonly roomRoot: string;
  readonly #writes = new Map<string, Promise<void>>();
  readonly #agent: typeof runLocalAgent;
  constructor(
    readonly env: RoomEnv,
    roots: {
      artifactsRoot?: string;
      buildsRoot?: string;
      roomRoot?: string;
      agent?: typeof runLocalAgent;
    } = {},
  ) {
    this.#agent = roots.agent ?? runLocalAgent;
    this.artifactsRoot =
      roots.artifactsRoot ?? resolve("artifacts/vibersyn-runs");
    this.buildsRoot = roots.buildsRoot ?? resolve("builds");
    this.roomRoot = roots.roomRoot ?? process.cwd();
  }
  async request(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (method === "launchRun") {
      const opts = params.options as Record<string, unknown>;
      const input = params.input as Record<string, unknown>;
      const id = segment(String(opts.runId));
      if (this.runs.has(id)) return { runId: id };
      const run: LocalRun = {
        id,
        status: "running",
        error: null,
        frames: [],
        controller: new AbortController(),
        paused: false,
        steering: [],
      };
      this.runs.set(id, run);
      await this.record(run, "run.started", "Local coding agent started");
      void this.execute(run, input, params.workflow === "vibersyn-self");
      return { runId: id };
    }
    const run = await this.get(segment(String(params.runId)));
    await this.#writes.get(run.id);
    if (method === "getRun")
      return {
        runId: run.id,
        status: run.status,
        error: run.error,
        activeWaits: [
          { type: "signal", signalName: run.paused ? "resume" : "pause" },
        ],
      };
    if (method === "cancelRun") {
      run.controller.abort();
      run.status = "cancelled";
      await this.record(run, "run.cancelled", "Local run cancelled");
      return { ok: true };
    }
    if (method === "submitSignal" || method === "resumeRun") {
      if (!["running", "paused"].includes(run.status))
        throw new Error("Local run has finished; use a new branch or retry.");
      const name = method === "resumeRun" ? "resume" : params.signalName;
      if (name === "pause") {
        run.paused = true;
        run.status = "paused";
      } else if (name === "resume") {
        run.paused = false;
        run.status = "running";
      } else
        run.steering.push(
          typeof params.payload === "string"
            ? params.payload
            : JSON.stringify(params.payload),
        );
      await this.record(
        run,
        "run.state",
        name === "pause"
          ? "Pausing after the current tool step"
          : `Local run ${String(name)}`,
      );
      return { ok: true };
    }
    throw new Error(`Unsupported local execution operation: ${method}`);
  }
  private async execute(
    run: LocalRun,
    input: Record<string, unknown>,
    self: boolean,
  ): Promise<void> {
    const upid = segment(String(input.upid));
    let dir = join(this.artifactsRoot, upid);
    const roomDir = this.roomRoot;
    let originalHead = "";
    try {
      const signal = run.controller.signal;
      if (self) {
        if (
          (
            await runCommand(["git", "status", "--porcelain"], roomDir, signal)
          ).trim()
        )
          throw new Error(
            "Save or commit existing room changes before asking the local agent to modify the room itself.",
          );
        originalHead = (
          await runCommand(["git", "rev-parse", "HEAD"], roomDir, signal)
        ).trim();
        dir = resolve(this.artifactsRoot, ".self-worktrees", run.id);
        await mkdir(resolve(this.artifactsRoot, ".self-worktrees"), {
          recursive: true,
        });
        await runCommand(
          ["git", "worktree", "add", "--detach", dir, originalHead],
          roomDir,
          signal,
        );
      }
      await mkdir(dir, { recursive: true });
      const repo = join(this.buildsRoot, upid, "repo");
      if (!self && existsSync(repo))
        await cp(repo, dir, {
          recursive: true,
          filter: (src) =>
            !src
              .split(/[\\/]/)
              .some(
                (x) =>
                  [".git", "node_modules", ".env"].includes(x) ||
                  x.startsWith(".env."),
              ),
        });
      const summary = await this.#agent(
        dir,
        String(input.instruction ?? input.prompt ?? input.pitch ?? ""),
        {
          env: this.env,
          signal,
          onProgress: (text) => {
            void this.record(run, "run.output", text).catch(() => {});
          },
          checkpoint: async () => {
            while (run.paused) {
              signal.throwIfAborted();
              await delay(signal);
            }
            return run.steering.splice(0);
          },
        },
      );
      signal.throwIfAborted();
      await checkLocalProject(dir, signal, this.env);
      if (self) {
        await runCommand(["git", "add", "-A"], dir, signal);
        await runCommand(
          [
            "git",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            `self: ${String(input.instruction ?? "local room update")
              .replace(/\s+/g, " ")
              .slice(0, 100)}`,
          ],
          dir,
          signal,
        );
        const commit = (
          await runCommand(["git", "rev-parse", "HEAD"], dir, signal)
        ).trim();
        if (
          (
            await runCommand(["git", "rev-parse", "HEAD"], roomDir, signal)
          ).trim() !== originalHead ||
          (
            await runCommand(["git", "status", "--porcelain"], roomDir, signal)
          ).trim()
        )
          throw new Error(
            `The room changed during the local self-edit. Reviewed work is retained in ${dir}; it was not applied.`,
          );
        await runCommand(
          ["git", "merge", "--ff-only", commit],
          roomDir,
          signal,
        );
        await runCommand(["git", "worktree", "remove", dir], roomDir, signal);
      } else {
        if (existsSync(join(dir, "dist", "index.html")))
          await cp(join(dir, "dist"), dir, { recursive: true });
        if (!existsSync(join(dir, "index.html")))
          throw new Error(
            "The local agent produced no runnable index.html or dist/index.html preview.",
          );
      }
      run.status = "completed";
      await this.record(run, "run.completed", summary);
    } catch (error) {
      run.status = run.controller.signal.aborted ? "cancelled" : "failed";
      run.error = error instanceof Error ? error.message : String(error);
      await this.record(run, "run.error", run.error).catch(() => {});
    }
  }
  async *streamRunEvents(
    id: string,
    options: StreamRunEventsOptions = {},
  ): AsyncIterable<GatewayEventFrame> {
    const run = await this.get(id);
    let seq = options.afterSeq ?? 0;
    while (!options.signal?.aborted) {
      for (const frame of run.frames)
        if ((frame.seq ?? 0) > seq) {
          seq = frame.seq!;
          yield frame;
        }
      if (!["running", "paused"].includes(run.status)) return;
      await delay(options.signal);
    }
  }
  private async get(id: string): Promise<LocalRun> {
    const existing = this.runs.get(id);
    if (existing) return existing;
    let saved: Pick<LocalRun, "id" | "status" | "error" | "frames">;
    try {
      saved = JSON.parse(await readFile(this.journal(id), "utf8"));
    } catch {
      throw new Error(
        "Local run is unavailable. Retry the interrupted commission.",
      );
    }
    const run: LocalRun = {
      ...saved,
      controller: new AbortController(),
      paused: false,
      steering: [],
    };
    if (["running", "paused"].includes(run.status)) {
      run.status = "failed";
      run.error =
        "Local run interrupted by room restart. Retry to continue from saved files.";
    }
    this.runs.set(id, run);
    return run;
  }
  private journal(id: string): string {
    return join(this.artifactsRoot, ".local-runs", `${segment(id)}.json`);
  }
  private async record(
    run: LocalRun,
    event: string,
    text: string,
  ): Promise<void> {
    run.frames.push({
      event,
      seq: (run.frames.at(-1)?.seq ?? 0) + 1,
      payload: { text, status: run.status },
    });
    if (run.frames.length > 200) run.frames.shift();
    const content = JSON.stringify({
      id: run.id,
      status: run.status,
      error: run.error,
      frames: run.frames,
    });
    const write = (this.#writes.get(run.id) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        await mkdir(join(this.artifactsRoot, ".local-runs"), {
          recursive: true,
        });
        const file = this.journal(run.id);
        await writeFile(`${file}.tmp`, content);
        await rename(`${file}.tmp`, file);
      });
    this.#writes.set(run.id, write);
    await write;
  }
}

function segment(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value))
    throw new Error("Invalid local run identifier");
  return value;
}
function delay(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, 150);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function checkLocalProject(
  dir: string,
  signal: AbortSignal,
  env: RoomEnv,
): Promise<void> {
  if (!existsSync(join(dir, "package.json"))) return;
  const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  const manager =
    existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))
      ? "bun"
      : existsSync(join(dir, "pnpm-lock.yaml"))
        ? "pnpm"
        : "npm";
  if (
    !existsSync(join(dir, "node_modules")) &&
    (Object.keys(pkg.dependencies ?? {}).length ||
      Object.keys(pkg.devDependencies ?? {}).length)
  )
    await runCommand([manager, "install"], dir, signal, env, 180_000);
  for (const script of ["typecheck", "test", "build"])
    if (pkg.scripts?.[script])
      await runCommand(
        [manager, "run", script],
        dir,
        signal,
        { ...env, CI: "1" },
        180_000,
      );
}
