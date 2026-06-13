import type { Artifact, ClarifyingQuestion, ProcessMetadata, VisualizerKind } from "../types.ts";

/** Request to the suggestion ("should I build this?") channel — §5.5. */
export interface SuggestRequest {
  transcript: string; // recent transcript window
  existing: { id: string; title: string; phrases: string[] }[]; // for merge/dedupe in place
  modelInitiated: boolean; // volunteer an idea / prior art rather than derive from speech
}

export interface SuggestionDraft {
  title: string;
  rationale: string;
  demo: Artifact; // lightweight proof-of-concept
  questions: ClarifyingQuestion[];
  sourcePhrases: string[];
  visualizer: VisualizerKind;
  mergeWith?: string; // id of an existing suggestion this should fold into
}

/** Request to steer/advance a single process — §5.3 session loop action. */
export interface StepRequest {
  process: ProcessMetadata;
  prompt: string; // the routed instruction (or "" for an autonomous tick)
  history: { role: "user" | "agent"; text: string }[];
  autonomous: boolean; // true when this is a self-driven tick, not a user prompt
}

export interface StepResult {
  reply?: string; // chat-style response (optional; most ticks stay silent)
  artifact?: Artifact; // a renderable artifact for the visualizer
  note: string; // short status line for the process tick log
  done?: boolean; // the process considers its current goal complete
}

/**
 * The pluggable model brain. Two responsibilities, matching the spec's two
 * model tiers (§5.9): the cheap always-on I/O loop (`suggest`) and the
 * per-process orchestration/execution (`step`).
 */
export interface Brain {
  readonly name: string;
  suggest(req: SuggestRequest): Promise<SuggestionDraft | null>;
  step(req: StepRequest): Promise<StepResult>;
}
