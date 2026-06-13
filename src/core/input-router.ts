import type { EventBus } from "./bus.ts";
import type { ProcessManager } from "./process-manager.ts";
import type { SuggestionEngine } from "./suggestion-engine.ts";
import type { InputEvent } from "./types.ts";
import { now } from "./util.ts";

/**
 * The input pipeline (§5.4): [1] identify type → [2] select process →
 * [3] parse instruction → [4] select action(s).
 *
 * Routing rule (V0, C2/C3): steering input is bound to the explicitly selected
 * process (input.targetProcessId). Unselected speech is NOT routed to any
 * existing process — but it is NOT discarded: it keeps feeding the always-on
 * suggestion engine. One mic, two channels.
 */
export class InputRouter {
  constructor(
    private deps: { pm: ProcessManager; suggestions: SuggestionEngine; bus: EventBus },
  ) {}

  route(input: InputEvent): { routedTo: string | null } {
    // [2] select process: explicit target = steering; none = ambient.
    if (input.targetProcessId) {
      const proc = this.deps.pm.get(input.targetProcessId);
      if (proc && proc.meta.state !== "dead") {
        proc.enqueue(input); // [3]/[4] parse + action happen inside the process tick
        return { routedTo: proc.meta.upid };
      }
      return { routedTo: null };
    }

    // Ambient channel: feed the always-on suggestion engine only (C3).
    this.deps.suggestions.observe(input.text);
    this.deps.bus.emit({ type: "transcript", text: input.text, source: input.source, ts: input.ts ?? now() });
    return { routedTo: null };
  }
}
