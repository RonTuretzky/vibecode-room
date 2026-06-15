// TraceProcessor: every event emits one structured LogEvent (ENG-T-03 stub, REQ-16).
// Verb-noun event names; stable ids; secret-free (never logs token-shaped strings).

import type { CueDecision, LogEvent, TranscriptObservation } from "../types.ts";

export type TraceOutput = { log: LogEvent; jsonl: string };

export class TraceProcessor {
  private readonly sessionId: string;
  private readonly sink: (line: string) => void;

  constructor(sessionId: string, sink: (line: string) => void = () => {}) {
    this.sessionId = sessionId;
    this.sink = sink;
  }

  // Single-event emit for the spine: one LogEvent per action decision (REQ-5 / REQ-16).
  // Returns null for pass decisions so callers can assert exactly one line per action.
  process(obs: TranscriptObservation, decision: CueDecision): TraceOutput | null {
    if (decision.kind !== "action") return null;
    return this.emit("emit.spine-action", decision.correlationId, {
      utteranceId: obs.utteranceId,
      actionType: decision.action.type,
      policy: decision.policy,
      decisionId: decision.decisionId,
    });
  }

  observation(obs: TranscriptObservation): TraceOutput {
    return this.emit("record.transcript", obs.utteranceId, {
      speaker: obs.speaker,
      isFinal: obs.isFinal,
      textLength: obs.text.length,
      latencyMs: obs.latencyMs,
    });
  }

  decision(dec: CueDecision): TraceOutput {
    return this.emit("record.decision", dec.correlationId, {
      kind: dec.kind,
      policy: dec.policy,
      decisionId: dec.decisionId,
    });
  }

  private emit(
    event: string,
    correlationId: string,
    meta: Record<string, unknown>,
  ): TraceOutput {
    const log: LogEvent = {
      level: "info",
      event,
      sessionId: this.sessionId,
      correlationId,
      meta,
    };
    const jsonl = JSON.stringify(log);
    this.sink(jsonl);
    return { log, jsonl };
  }
}
