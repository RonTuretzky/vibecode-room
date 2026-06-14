export interface TranscriptObservation {
  text: string;
  isFinal: boolean;
  speaker: string | null;
  sessionId: string;
  latencyMs: number;
  utteranceId: string;
}

export type CueDecision =
  | {
      kind: "pass";
      addressed: false;
      reason: "ambient" | "non-final";
      policy: string;
      decisionId: string;
      correlationId: string;
      observationId: string;
      meta: Record<string, unknown>;
    }
  | {
      kind: "action";
      action: "wake";
      policy: string;
      decisionId: string;
      correlationId: string;
      observationId: string;
      payload: {
        wakeWord: string;
      };
      meta: Record<string, unknown>;
    };

export interface LogEvent {
  level: "debug" | "info" | "warn" | "error";
  event: string;
  eventId: string;
  sessionId: string;
  correlationId: string;
  latencyMs: number;
  meta: Record<string, unknown>;
}
