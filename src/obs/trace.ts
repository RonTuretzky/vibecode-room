import type { CueDecision, LogEvent, TranscriptObservation } from "../types";

export class TraceProcessor {
  readonly #events: LogEvent[] = [];

  emitDecision(decision: CueDecision, observation: TranscriptObservation): LogEvent | null {
    if (decision.kind !== "action") {
      return null;
    }

    const event: LogEvent = {
      level: "info",
      event: "route.action",
      sessionId: observation.sessionId,
      correlationId: decision.correlationId,
      latencyMs: observation.latencyMs,
      meta: {
        action: decision.action.type,
        targetUPID: decision.action.targetUPID,
        observationId: decision.meta.observationId,
        payload: decision.action.payload,
        decisionId: decision.decisionId,
        policy: decision.policy,
      },
    };

    this.#events.push(event);
    return event;
  }

  events(): LogEvent[] {
    return [...this.#events];
  }

  toJsonl(): string {
    return this.#events.map((event) => JSON.stringify(event)).join("\n");
  }
}
