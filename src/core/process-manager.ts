import type { Brain } from "./brain/index.ts";
import type { EventBus } from "./bus.ts";
import { defaultHooks, type HookRegistry } from "./hooks.ts";
import { Process } from "./process.ts";
import type {
  HookContext,
  ProcessMetadata,
  ProcessMode,
  SessionConfig,
  VisualizerKind,
} from "./types.ts";
import { now, token, uid } from "./util.ts";

export interface CreateOptions {
  title: string;
  owner?: string;
  visualizer?: VisualizerKind;
  mode?: Partial<ProcessMode>;
  agent?: string;
  model?: string;
  parentId?: string;
}

/**
 * The Process Manager (§5.1): manages the full lifecycle of N concurrent
 * processes. Functions: suggest · create · modify · kill · fork/spawn ·
 * import · export · merge · pause · resume · switch_mode · switch_node.
 *
 * (suggest lives in SuggestionEngine; the rest are here.)
 */
export class ProcessManager {
  private procs = new Map<string, Process>();
  private archives = new Map<string, unknown>(); // pre-kill context archive (C6)
  readonly hooks: HookRegistry;

  constructor(
    private deps: { brain: Brain; bus: EventBus; config: SessionConfig },
  ) {
    this.hooks = defaultHooks((upid, ctx) => {
      this.archives.set(upid, { history: this.procs.get(upid)?.history_(), at: now(), meta: ctx.process });
    });
  }

  list(): ProcessMetadata[] {
    return [...this.procs.values()].map((p) => p.meta);
  }
  get(id: string): Process | undefined {
    return this.procs.get(id);
  }
  all(): Process[] {
    return [...this.procs.values()];
  }

  private mkCtx(meta: ProcessMetadata): HookContext {
    return { process: meta, scratch: {}, log: (msg) => this.deps.bus.log(meta.upid, msg) };
  }

  // ── create ───────────────────────────────────────────────────────────────
  async create(opts: CreateOptions): Promise<ProcessMetadata> {
    const def = this.deps.config.defaultMode;
    const meta: ProcessMetadata = {
      upid: uid("proc"),
      parentId: opts.parentId,
      owner: opts.owner ?? "room",
      title: opts.title,
      createdAt: now(),
      mode: {
        ui: opts.mode?.ui ?? def.ui,
        execution: opts.mode?.execution ?? def.execution,
        safety: opts.mode?.safety ?? def.safety,
      },
      agent: opts.agent ?? "mock",
      model: opts.model ?? (process.env.PANOPTICON_PROCESS_MODEL ?? "claude-fable-5"),
      state: "planning",
      visualizer: opts.visualizer ?? "web",
      qrToken: token(),
      dependsOn: [],
    };
    await this.hooks.runActionPre("create", this.mkCtx(meta));
    const proc = new Process(meta, { brain: this.deps.brain, hooks: this.hooks, bus: this.deps.bus });
    this.procs.set(meta.upid, proc);
    this.deps.bus.emit({ type: "process.created", process: meta });
    await this.hooks.runActionPost("create", this.mkCtx(meta));
    return meta;
  }

  // ── modify ───────────────────────────────────────────────────────────────
  modify(id: string, patch: Partial<Pick<ProcessMetadata, "title" | "visualizer" | "dependsOn">>): ProcessMetadata | null {
    const p = this.procs.get(id);
    if (!p) return null;
    Object.assign(p.meta, patch);
    this.deps.bus.emit({ type: "process.updated", process: p.meta });
    return p.meta;
  }

  // ── switch_mode (§5.6 orthogonal flags) ────────────────────────────────────
  switchMode(id: string, mode: Partial<ProcessMode>): ProcessMetadata | null {
    const p = this.procs.get(id);
    if (!p) return null;
    Object.assign(p.meta.mode, mode);
    this.deps.bus.emit({ type: "process.updated", process: p.meta });
    return p.meta;
  }

  // ── pause / resume (C4) ────────────────────────────────────────────────────
  pause(id: string): boolean {
    const p = this.procs.get(id);
    if (!p || p.meta.state === "dead") return false;
    p.meta.state = "paused";
    this.deps.bus.emit({ type: "process.updated", process: p.meta });
    return true;
  }
  resume(id: string): boolean {
    const p = this.procs.get(id);
    if (!p || p.meta.state === "dead") return false;
    p.meta.state = "active";
    this.deps.bus.emit({ type: "process.updated", process: p.meta });
    return true;
  }

  // ── kill (pre-kill archives context, C6) ───────────────────────────────────
  async kill(id: string): Promise<boolean> {
    const p = this.procs.get(id);
    if (!p) return false;
    await this.hooks.runActionPre("kill", this.mkCtx(p.meta));
    p.meta.state = "dead";
    p.meta.endedAt = now();
    this.deps.bus.emit({ type: "process.updated", process: p.meta });
    await this.hooks.runActionPost("kill", this.mkCtx(p.meta));
    this.procs.delete(id);
    this.deps.bus.emit({ type: "process.killed", processId: id });
    return true;
  }

  // ── fork / spawn (propagation; lineage via parentId) ───────────────────────
  async fork(id: string): Promise<ProcessMetadata | null> {
    const parent = this.procs.get(id);
    if (!parent) return null;
    await this.hooks.runActionPre("fork", this.mkCtx(parent.meta));
    const child = await this.create({
      title: `${parent.meta.title} (fork)`,
      owner: parent.meta.owner,
      visualizer: parent.meta.visualizer,
      mode: parent.meta.mode,
      agent: parent.meta.agent,
      model: parent.meta.model,
      parentId: parent.meta.upid,
    });
    await this.hooks.runActionPost("fork", this.mkCtx(child));
    return child;
  }

  // ── merge (fold one process's lineage marker into another) ─────────────────
  merge(intoId: string, fromId: string): ProcessMetadata | null {
    const into = this.procs.get(intoId);
    const from = this.procs.get(fromId);
    if (!into || !from) return null;
    into.meta.dependsOn = [...new Set([...into.meta.dependsOn, ...from.meta.dependsOn, from.meta.upid])];
    this.deps.bus.emit({ type: "process.updated", process: into.meta });
    void this.kill(fromId);
    return into.meta;
  }

  // ── export / import (portable process descriptor) ──────────────────────────
  export(id: string): { meta: ProcessMetadata; history: unknown } | null {
    const p = this.procs.get(id);
    if (!p) return null;
    return { meta: p.meta, history: p.history_() };
  }
  async import(descriptor: { meta: Partial<ProcessMetadata> & { title: string } }): Promise<ProcessMetadata> {
    return this.create({
      title: descriptor.meta.title,
      owner: descriptor.meta.owner,
      visualizer: descriptor.meta.visualizer,
      mode: descriptor.meta.mode,
      agent: descriptor.meta.agent,
      model: descriptor.meta.model,
    });
  }

  archiveOf(id: string): unknown {
    return this.archives.get(id);
  }
}
