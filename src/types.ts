// Shared data contract stub for the walking skeleton.
// Final shapes land in the shared-types-contract ticket; this file stays intentionally small.

export interface TranscriptObservation {
  text: string;
  isFinal: boolean;
  speaker: string | null;
  sessionId: string;
  latencyMs: number;
  utteranceId: string;
}

type DecisionMeta = Record<string, unknown>;

export type CueDecision =
  | {
      kind: "pass";
      addressed: boolean;
      reason: "ambient" | "near-miss" | "low-confidence" | "dropped";
      policy: string;
      decisionId: string;
      correlationId: string;
      meta: DecisionMeta;
    }
  | {
      kind: "action";
      action: {
        type: "spawn";
        targetUPID: null;
        payload: unknown;
        correlationId: string;
      };
      policy: string;
      decisionId: string;
      correlationId: string;
      meta: DecisionMeta;
    };

export interface LogEvent {
  level: "debug" | "info" | "warn" | "error";
  event: string; // verb-noun
  sessionId: string;
  correlationId?: string;
  upid?: string;
  latencyMs?: number;
  meta: Record<string, unknown>;
}
