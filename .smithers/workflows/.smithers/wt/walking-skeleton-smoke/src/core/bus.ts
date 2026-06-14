import type { PanopticonEvent } from "./types.ts";

type Listener = (e: PanopticonEvent) => void;

/**
 * The meta-session event bus. Everything the system does is published here;
 * the server fans these out to connected clients (Pro UI, mobile devices).
 * Mirrors cue's passive `/events` stream model.
 */
export class EventBus {
  private listeners = new Set<Listener>();
  private ring: PanopticonEvent[] = [];
  private readonly ringSize = 200;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: PanopticonEvent): void {
    this.ring.push(e);
    if (this.ring.length > this.ringSize) this.ring.shift();
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch (err) {
        console.error("[bus] listener error", err);
      }
    }
  }

  /** Replay recent events for a newly-connected client (cold-start priming). */
  recent(): PanopticonEvent[] {
    return [...this.ring];
  }

  log(scope: string, msg: string): void {
    this.emit({ type: "log", scope, msg, ts: Date.now() });
  }
}
