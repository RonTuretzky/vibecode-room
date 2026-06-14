// Shared data contract — every component imports from here (ENG-T-01).
// Final shapes evolve in the shared-types-contract ticket; this stub covers the walking skeleton.

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
      action: DispatchedAction;
      policy: string;
      decisionId: string;
      correlationId: string;
      meta: DecisionMeta;
    };

export interface DispatchedAction {
  type:
    | "spawn"
    | "steer"
    | "pause"
    | "resume"
    | "halt"
    | "pauseAll"
    | "status"
    | "setMode"
    | "approve"
    | "deny";
  targetUPID: string | null;
  payload: unknown;
  correlationId: string;
}

export type ExecutionMode = "safe" | "explicit" | "dangerous";

export interface ToolCallContext {
  upid: string;
  tool: string;
  args: unknown;
  klass:
    | "read"
    | "fs-write"
    | "fs-delete"
    | "shell"
    | "vcs-push"
    | "db-mutate"
    | "net-mutate"
    | "unknown";
  gateId: string;
}

export type ShellVerdict = {
  verdict: "read-safe" | "mutating" | "unknown";
  gated: boolean;
  parts: { argv0: string; verdict: "read-safe" | "mutating" | "unknown"; reason: string }[];
};

export interface CredentialSource {
  forProvider(name: string): Promise<{ token: string }>;
}

export interface ApprovalRequest {
  upid: string;
  gateId: string;
  readback: string;
  armedTimerMs: number;
  correlationId: string;
}

export type ApprovalResolution = {
  gateId: string;
  decision: "approve" | "deny" | "timeout";
  correlationId: string;
};

export interface PendingSuggestion {
  suggestionId: string;
  pitch: string;
  mcqs: string[];
  answers: string[];
  correlationId: string;
  expiresAt: number;
}

export interface RunEvent {
  upid: string;
  runId: string;
  kind: "state" | "output" | "blocker" | "completed" | "safety" | "approval";
  text: string;
  seq: number;
}

export interface LogEvent {
  level: "debug" | "info" | "warn" | "error";
  event: string; // verb-noun
  sessionId: string;
  correlationId?: string;
  upid?: string;
  latencyMs?: number;
  meta: Record<string, unknown>;
}

export type EarconId = string;
export type AckId = string;

export type OutputDecision =
  | { channel: "silent" }
  | { channel: "earcon"; id: EarconId }
  | { channel: "ack"; id: AckId }
  | { channel: "tts"; text: string; wordCount: number; summarized: boolean };
