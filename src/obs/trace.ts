// TraceProcessor — every event emits one structured LogEvent (ENG-T-03 stub, REQ-16).
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

  observation(obs: TranscriptObservation): TraceOutput {
    return this.emit("transcript.observe", obs.utteranceId, {
      speaker: obs.speaker,
      isFinal: obs.isFinal,
      textLength: obs.text.length,
      latencyMs: obs.latencyMs,
    });
  }

  decision(dec: CueDecision): TraceOutput {
    return this.emit("cue.decide", dec.correlationId, {
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
