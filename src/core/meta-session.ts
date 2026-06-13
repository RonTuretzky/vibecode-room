import { makeBrain, type Brain } from "./brain/index.ts";
import { EventBus } from "./bus.ts";
import { InputRouter } from "./input-router.ts";
import { ProcessManager, type CreateOptions } from "./process-manager.ts";
import { SuggestionEngine } from "./suggestion-engine.ts";
import { DEFAULT_CONFIG, type InputEvent, type ProcessMetadata, type SessionConfig } from "./types.ts";
import { now, uid } from "./util.ts";

/**
 * The META-SESSION (§5 architecture root): a long-running, always-on outer loop
 * backed by Smithers durable orchestration. Smithers owns the forkable,
 * resumable outer loop. This layer owns the Process Manager, the always-on
 * Suggestion Engine, the Input Router, and the event bus, and it drives the
 * autonomy tick that advances every process and the suggestion channel on a
 * cadence.
 *
 * Here it's implemented natively so the system runs today.
 */
// TODO(eliza): an elizaOS AgentRuntime + autonomy service could plug in here later as an alternative outer loop.
export class MetaSession {
  readonly bus = new EventBus();
  readonly brain: Brain;
  readonly pm: ProcessManager;
  readonly suggestions: SuggestionEngine;
  readonly router: InputRouter;
  config: SessionConfig;

  private selectedId: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(config: Partial<SessionConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.brain = makeBrain();
    this.pm = new ProcessManager({ brain: this.brain, bus: this.bus, config: this.config });
    this.suggestions = new SuggestionEngine({ brain: this.brain, bus: this.bus, config: this.config });
    this.router = new InputRouter({ pm: this.pm, suggestions: this.suggestions, bus: this.bus });
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  start(): void {
    if (this.timer) return;
    this.bus.log("meta", "session started");
    this.timer = setInterval(() => void this.tick(), this.config.autonomyTickMs);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private ticking = false;
  /** One autonomy tick: advance the suggestion channel and every live process. */
  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.suggestions.tick();
      await Promise.all(this.pm.all().map((p) => p.tick()));
    } finally {
      this.ticking = false;
    }
  }

  // ── selection (§5.4 select-first) ───────────────────────────────────────────
  select(id: string | null): void {
    this.selectedId = id && this.pm.get(id) ? id : null;
    this.bus.emit({ type: "process.selected", processId: this.selectedId });
  }
  selected(): string | null {
    return this.selectedId;
  }

  // ── input ────────────────────────────────────────────────────────────────
  /** Ambient transcript (mic / chat with no target) → suggestion channel. */
  observe(text: string, source = "room"): void {
    this.router.route({ id: uid("in"), type: "audio", text, source, ts: now() });
  }
  /** Steering prompt aimed at a specific process (Pro click→type→Enter). */
  prompt(processId: string, text: string, source = "pro"): { routedTo: string | null } {
    return this.router.route({
      id: uid("in"),
      type: "text",
      text,
      source,
      targetProcessId: processId,
      ts: now(),
    });
  }

  // ── suggestion accept → spawn process (auto-select, enter planning) ─────────
  async acceptSuggestion(
    suggestionId: string,
    answers: Record<string, string> = {},
  ): Promise<ProcessMetadata | null> {
    const sug = this.suggestions.accept(suggestionId);
    if (!sug) return null;
    const opts: CreateOptions = {
      title: sug.title,
      visualizer: sug.demo.kind,
      owner: "room",
    };
    const meta = await this.pm.create(opts);
    this.select(meta.upid);
    // Seed the new process with the demo artifact + the answered questions.
    const answerLines = Object.entries(answers).map(([q, a]) => `- ${q}: ${a}`);
    const seed = `Spin up "${sug.title}". ${sug.rationale}\n${
      answerLines.length ? "Decisions:\n" + answerLines.join("\n") : ""
    }`;
    this.prompt(meta.upid, seed, "suggestion");
    return meta;
  }

  setConfig(patch: Partial<SessionConfig>): SessionConfig {
    // Mutate in place: pm and suggestions hold the same config reference.
    Object.assign(this.config, patch);
    if (patch.autonomyTickMs && this.timer) {
      this.stop();
      this.start();
    }
    this.bus.emit({ type: "session.config", config: this.config });
    return this.config;
  }

  /** Snapshot for a freshly-connected client. */
  snapshot() {
    return {
      processes: this.pm.list(),
      suggestions: this.suggestions.getAll(),
      selected: this.selectedId,
      config: this.config,
      brain: this.brain.name,
    };
  }
}
