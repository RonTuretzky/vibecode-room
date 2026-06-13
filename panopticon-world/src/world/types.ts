// Domain types — mirrors the real Panopticon core (src/core/types.ts) so the
// world maps 1:1 to actual features. Trimmed to what the prototype renders.

export type VisualizerKind = "web" | "code" | "art" | "book" | "text" | "data";
export type ProcessState = "planning" | "active" | "paused" | "dead";
export type ExecutionMode = "optimistic" | "explicit";
export type SafetyMode = "safe" | "dangerous";

// Model tiers from spec §5.9 → in-game "worker" rank.
export type ModelId =
  | "claude-fable-5"
  | "claude-sonnet-4-6"
  | "claude-haiku-4-5-20251001";

export interface ProcessMode {
  execution: ExecutionMode;
  safety: SafetyMode;
}

export interface Artifact {
  kind: VisualizerKind;
  html?: string;
  content?: string;
  title?: string;
}

export interface OutputLine {
  role: "you" | "agent";
  text: string;
  ts: number;
}

// One Process = a building in the overworld.
export interface WorldProcess {
  upid: string;
  parentId?: string;
  title: string;
  owner: string;
  createdAt: number;
  endedAt?: number;
  state: ProcessState;
  visualizer: VisualizerKind;
  model: ModelId;
  agent: string; // "mock" | "eliza" | "nanoclaw" | "smithers"
  mode: ProcessMode;
  qrToken: string;
  dependsOn: string[];
  // world-only presentation state
  grid: [number, number]; // tile coordinate on the board
  inbox: number; // queued steering inputs awaiting the session loop
  log: OutputLine[];
  lastArtifact?: Artifact;
  emitPulse: number; // bumped each time the building emits an artifact (drives anim)
  lastEmitAt: number; // ms of last output — drives "freshness" color in Grove mode
  bornAt: number; // ms timestamp the building started rising
}

export interface ClarifyingQuestion {
  id: string;
  prompt: string;
  choices: string[];
}

// One Suggestion = a floating idea bubble rising from the Idea Spring.
export interface WorldBubble {
  id: string;
  title: string;
  rationale: string;
  visualizer: VisualizerKind;
  demo: Artifact;
  questions: ClarifyingQuestion[];
  createdAt: number;
  ttlMs: number;
  modelInitiated: boolean;
  answers: Record<string, string>;
  // world-only: a stable drift seed + anchor angle around the spring
  seed: number;
  angle: number;
}

export interface TranscriptLine {
  text: string;
  source: string;
  ts: number;
}

export interface WorldConfig {
  bubblesPerMinute: number;
  suggestionTtlMs: number;
  execution: ExecutionMode;
  safety: SafetyMode;
}

export type ViewMode = "overworld" | "grove";

export interface WorldState {
  processes: WorldProcess[];
  bubbles: WorldBubble[];
  transcript: TranscriptLine[];
  config: WorldConfig;
  selected: string | null;
  dayPhase: number; // 0..1 day/night cycle = meta-session autonomy tick
  paused: boolean; // pause the whole ambient sim (not a process)
  viewMode: ViewMode; // "overworld" = SNES village · "grove" = growing lineage tree
  graftFrom: string | null; // when set, the next node click re-grafts this process onto it
}
