// Panopticon core domain types.
// Source of truth: panopticon-session-1-guide.md (§5.2 metadata, §5.3 session loop,
// §5.4 input pipeline, §5.5 suggestions, §5.6 modes).

// ── Modes (§5.6) ──────────────────────────────────────────────────────────────
export type UIMode = "pro" | "easy" | "mobile";
export type ExecutionMode = "optimistic" | "explicit";
export type SafetyMode = "safe" | "dangerous";

export interface ProcessMode {
  ui: UIMode;
  execution: ExecutionMode; // optimistic = act without explicit Enter; explicit = require confirm
  safety: SafetyMode; // dangerous = run without "are you sure?"
}

// ── Process lifecycle (§5.2 state) ─────────────────────────────────────────────
// born → planning → active ⇄ paused → dead   (the "genetic loop")
export type ProcessState = "planning" | "active" | "paused" | "dead";

// What kind of artifact a process produces → drives the visualizer (G5).
export type VisualizerKind = "web" | "code" | "art" | "book" | "text" | "data";

// ── Process metadata (§5.2 — the whiteboard column) ────────────────────────────
export interface ProcessMetadata {
  upid: string; // unique process id (canonical)
  parentId?: string; // propagation lineage (fork/spawn)
  owner: string; // creator / provenance
  title: string;
  createdAt: number;
  endedAt?: number;
  mode: ProcessMode;
  gitId?: string; // canonical git ref; url is derived (urls can change)
  gitUrl?: string;
  agent: string; // agent framework: "mock" | "smithers" (default)
  // TODO(eliza): add Eliza (and other frameworks e.g. NanoClaw) as pluggable agent backends later
  model: string; // model id: claude-fable-5 (orchestrate) / claude-sonnet-4-6 (io) ...
  container?: string; // runtime container id (where the agent runs)
  state: ProcessState;
  visualizer: VisualizerKind;
  qrToken: string; // scan → pair a mobile device to this process (§5.7)
  dependsOn: string[]; // inter-process dependency rules
}

// ── Inputs (§5.4) ──────────────────────────────────────────────────────────────
export type InputType = "text" | "audio" | "video" | "mouse" | "keyboard";

export interface InputEvent {
  id: string;
  type: InputType;
  text: string; // transcribed / typed content
  source: string; // device or surface id (e.g. "pro", "mobile:<token>")
  // When set, the input is explicitly aimed at a process (select-first, C3).
  // When undefined, it is ambient and only feeds the suggestion engine.
  targetProcessId?: string;
  ts: number;
}

// ── Session loop output (§5.3) ─────────────────────────────────────────────────
// ~90% of loop ticks produce no visible output.
export interface ProcessOutput {
  processId: string;
  kind: "chat" | "artifact" | "status" | "none";
  text?: string;
  artifact?: Artifact; // a renderable thing the visualizer picks up
  ts: number;
}

export interface Artifact {
  kind: VisualizerKind;
  // For web/code: html or a url. For text/book/art: content. For data: json.
  html?: string;
  url?: string;
  content?: string;
  data?: unknown;
  title?: string;
}

// ── Suggestions / idea bubbles (§5.5) ──────────────────────────────────────────
export interface ClarifyingQuestion {
  id: string;
  prompt: string;
  choices: string[]; // multiple-choice (Ask-style); user need not answer all
}

export interface Suggestion {
  id: string;
  title: string;
  rationale: string; // why the room might want this
  demo: Artifact; // lightweight proof-of-concept shipped with the bubble
  questions: ClarifyingQuestion[];
  createdAt: number;
  ttlMs: number; // time-based TTL (§5.5); 0 = no expiry
  updatedAt: number;
  // bubbles update/merge/modify in place; we keep the source phrases for merge.
  sourcePhrases: string[];
  modelInitiated: boolean; // the model volunteered this (vs. derived from speech)
  state: "active" | "accepted" | "expired" | "dismissed";
}

// ── Hooks (§5.3) ───────────────────────────────────────────────────────────────
export interface HookContext {
  process: ProcessMetadata;
  input?: InputEvent;
  // mutable scratch space shared across a single loop tick
  scratch: Record<string, unknown>;
  log: (msg: string) => void;
}

export type Hook = (ctx: HookContext) => Promise<void> | void;

// ── Process Manager functions (§5.1) ───────────────────────────────────────────
export type PMFunction =
  | "suggest"
  | "create"
  | "modify"
  | "kill"
  | "fork"
  | "import"
  | "export"
  | "merge"
  | "pause"
  | "resume"
  | "switch_mode"
  | "switch_node";

// ── Events emitted on the meta-session bus → streamed to clients ───────────────
export type PanopticonEvent =
  | { type: "process.created"; process: ProcessMetadata }
  | { type: "process.updated"; process: ProcessMetadata }
  | { type: "process.killed"; processId: string }
  | { type: "process.output"; output: ProcessOutput }
  | { type: "process.selected"; processId: string | null }
  | { type: "process.tick"; processId: string; note: string }
  | { type: "suggestion.created"; suggestion: Suggestion }
  | { type: "suggestion.updated"; suggestion: Suggestion }
  | { type: "suggestion.expired"; suggestionId: string }
  | { type: "transcript"; text: string; source: string; ts: number }
  | { type: "session.config"; config: SessionConfig }
  | { type: "log"; scope: string; msg: string; ts: number };

// ── Tunable session config (§4 performance knobs) ──────────────────────────────
export interface SessionConfig {
  bubblesPerMinute: number; // suggestion fire-rate target ("idea diarrhea" at the high end)
  suggestionTtlMs: number; // default bubble lifetime
  transcriptChunkMs: number; // prompt-boundary chunking (~20s, §5.4)
  defaultMode: ProcessMode;
  autonomyTickMs: number; // meta-session loop rate
  modelInitiatedEveryN: number; // every N suggestions, volunteer a model-initiated idea
}

export const DEFAULT_CONFIG: SessionConfig = {
  bubblesPerMinute: 4,
  suggestionTtlMs: 5 * 60 * 1000,
  transcriptChunkMs: 20_000,
  defaultMode: { ui: "pro", execution: "optimistic", safety: "safe" },
  autonomyTickMs: 1500,
  modelInitiatedEveryN: 4,
};
