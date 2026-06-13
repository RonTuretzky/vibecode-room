import type { Brain } from "./brain/index.ts";
import type { EventBus } from "./bus.ts";
import type { SessionConfig, Suggestion } from "./types.ts";
import { now, uid } from "./util.ts";

/**
 * The always-on suggestion channel (§5.5) — Panopticon's ambient magic, and the
 * one listening channel that runs continuously regardless of selection (C3).
 * This is the cue-style wake policy: a continuous transcript stream, a
 * deterministic gate (rate limit / cooldown / min-content), then a cheap model
 * call that may or may not fire ("observe.pass"). Bubbles have a TTL and
 * update/merge in place as the conversation evolves.
 */
export class SuggestionEngine {
  private suggestions = new Map<string, Suggestion>();
  private window = ""; // rolling transcript window
  private lastFireAt = 0;
  private lastProcessedLen = 0;
  private attempts = 0;
  private readonly windowCap = 1200;

  constructor(private deps: { brain: Brain; bus: EventBus; config: SessionConfig }) {}

  /** Feed ambient transcript into the rolling window (does not itself fire). */
  observe(text: string): void {
    if (!text.trim()) return;
    this.window = (this.window + " " + text.trim()).slice(-this.windowCap);
  }

  active(): Suggestion[] {
    return [...this.suggestions.values()].filter((s) => s.state === "active");
  }
  getAll(): Suggestion[] {
    return [...this.suggestions.values()];
  }
  get(id: string): Suggestion | undefined {
    return this.suggestions.get(id);
  }

  private minIntervalMs(): number {
    const bpm = Math.max(0.1, this.deps.config.bubblesPerMinute);
    return 60_000 / bpm;
  }

  /** Called on the meta-session cadence: expire stale bubbles, then maybe fire. */
  async tick(): Promise<void> {
    this.expire();
    const t = now();
    if (t - this.lastFireAt < this.minIntervalMs()) return; // rate gate
    const hasNew = this.window.length - this.lastProcessedLen > 24;
    // Periodically volunteer a model-initiated idea even without fresh speech.
    const modelInitiated =
      this.deps.config.modelInitiatedEveryN > 0 &&
      this.attempts > 0 &&
      this.attempts % this.deps.config.modelInitiatedEveryN === 0;
    if (!hasNew && !modelInitiated) return;
    await this.fire(modelInitiated);
  }

  private async fire(modelInitiated: boolean): Promise<void> {
    this.attempts++;
    this.lastProcessedLen = this.window.length;
    const existing = this.active().map((s) => ({ id: s.id, title: s.title, phrases: s.sourcePhrases }));
    const draft = await this.deps.brain.suggest({ transcript: this.window, existing, modelInitiated });
    if (!draft) return; // observe.pass — nothing rose to a suggestion
    this.lastFireAt = now();

    // Merge into an existing bubble in place (§5.5).
    if (draft.mergeWith && this.suggestions.has(draft.mergeWith)) {
      const s = this.suggestions.get(draft.mergeWith)!;
      s.title = draft.title;
      s.rationale = draft.rationale;
      s.demo = draft.demo;
      s.questions = draft.questions;
      s.sourcePhrases = [...new Set([...s.sourcePhrases, ...draft.sourcePhrases])];
      s.updatedAt = now();
      this.deps.bus.emit({ type: "suggestion.updated", suggestion: s });
      return;
    }

    const suggestion: Suggestion = {
      id: uid("sug"),
      title: draft.title,
      rationale: draft.rationale,
      demo: draft.demo,
      questions: draft.questions,
      createdAt: now(),
      updatedAt: now(),
      ttlMs: this.deps.config.suggestionTtlMs,
      sourcePhrases: draft.sourcePhrases,
      modelInitiated,
      state: "active",
    };
    this.suggestions.set(suggestion.id, suggestion);
    this.deps.bus.emit({ type: "suggestion.created", suggestion });
  }

  private expire(): void {
    const t = now();
    for (const s of this.suggestions.values()) {
      if (s.state !== "active" || s.ttlMs <= 0) continue;
      if (t - s.updatedAt > s.ttlMs) {
        s.state = "expired";
        this.deps.bus.emit({ type: "suggestion.expired", suggestionId: s.id });
      }
    }
  }

  /** Accept a bubble → caller (meta-session) spawns the process. */
  accept(id: string): Suggestion | null {
    const s = this.suggestions.get(id);
    if (!s) return null;
    s.state = "accepted";
    this.deps.bus.emit({ type: "suggestion.updated", suggestion: s });
    return s;
  }

  dismiss(id: string): boolean {
    const s = this.suggestions.get(id);
    if (!s) return false;
    s.state = "dismissed";
    this.deps.bus.emit({ type: "suggestion.updated", suggestion: s });
    return true;
  }
}
