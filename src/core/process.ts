import type { Brain } from "./brain/index.ts";
import type { EventBus } from "./bus.ts";
import type { HookRegistry } from "./hooks.ts";
import type { HookContext, InputEvent, ProcessMetadata, ProcessOutput } from "./types.ts";
import { now } from "./util.ts";

interface ProcessDeps {
  brain: Brain;
  hooks: HookRegistry;
  bus: EventBus;
}

/**
 * One Process = a containerized agent working on a single thing, running its own
 * session loop (§5.3): Input → Pre-hooks → Action(s) → Post-hooks → Output.
 *
 * In V0 the "container" is in-process; the metadata.container field and the
 * Brain seam are where a real sandbox (Smithers/Daytona) and agent framework
 * (Eliza/NanoClaw) plug in.
 */
export class Process {
  readonly meta: ProcessMetadata;
  private queue: InputEvent[] = [];
  private history: { role: "user" | "agent"; text: string }[] = [];
  private deps: ProcessDeps;
  private running = false;

  constructor(meta: ProcessMetadata, deps: ProcessDeps) {
    this.meta = meta;
    this.deps = deps;
  }

  /** Route a steering input into this process's input queue (§5.2 input queue). */
  enqueue(input: InputEvent): void {
    this.queue.push(input);
  }

  pendingInputs(): number {
    return this.queue.length;
  }

  history_(): { role: "user" | "agent"; text: string }[] {
    return this.history;
  }

  private mkCtx(input?: InputEvent): HookContext {
    return {
      process: this.meta,
      input,
      scratch: {},
      log: (msg) => this.deps.bus.log(this.meta.upid, msg),
    };
  }

  /**
   * One iteration of the session loop. Called by the meta-session autonomy tick.
   * If there's queued input it's processed (usually visible); otherwise the
   * process takes an autonomous step (usually silent — ~90% no output, §5.3).
   */
  async tick(): Promise<void> {
    if (this.running) return; // never overlap ticks
    if (this.meta.state === "paused" || this.meta.state === "dead") return;
    this.running = true;
    try {
      const input = this.queue.shift();
      const autonomous = !input;
      const ctx = this.mkCtx(input);

      await this.deps.hooks.runLoopPre(ctx); // Pre-hooks

      // Action: advance the process via its brain (§5.1 actions).
      if (input) {
        this.history.push({ role: "user", text: input.text });
        if (this.meta.state === "planning") this.meta.state = "active";
      }
      const result = await this.deps.brain.step({
        process: this.meta,
        prompt: input?.text ?? "",
        history: this.history.slice(-12),
        autonomous,
      });
      if (result.reply) this.history.push({ role: "agent", text: result.reply });

      await this.deps.hooks.runLoopPost(ctx); // Post-hooks

      // Output (often none).
      if (result.reply || result.artifact) {
        const output: ProcessOutput = {
          processId: this.meta.upid,
          kind: result.artifact ? "artifact" : "chat",
          text: result.reply,
          artifact: result.artifact,
          ts: now(),
        };
        this.deps.bus.emit({ type: "process.output", output });
      } else {
        this.deps.bus.emit({ type: "process.tick", processId: this.meta.upid, note: result.note });
      }
    } catch (err) {
      this.deps.bus.log(this.meta.upid, `tick error: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
