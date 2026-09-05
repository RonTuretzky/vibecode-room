import type { CueDecision, TranscriptObservation } from "../types";

export type AudioReadableStream = ReadableStream<Uint8Array>;

export interface ASRProvider {
  /** Flush captured audio and resolve after its final observations are consumed. */
  finishUtterance?(): Promise<void>;
  stream(audio: AudioReadableStream): AsyncIterable<TranscriptObservation>;
}

export interface TTSOptions {
  voice?: string;
}

export interface TTSProvider {
  speak(text: string, opts?: TTSOptions): Promise<AudioReadableStream>;
}

export type DecisionRole = "system" | "user" | "assistant" | "tool";

export interface DecisionMessage {
  role: DecisionRole;
  content: string;
  name?: string;
}

export interface DecisionInput {
  model: string;
  messages: DecisionMessage[];
  correlationId: string;
  temperature?: 0;
  tools?: unknown[];
  toolChoice?: unknown;
  responseFormat?: unknown;
  metadata?: Record<string, unknown>;
}

export interface DecisionOutput {
  id: string;
  model: string;
  temperature: 0;
  decision: CueDecision;
  raw?: unknown;
}

export interface DecisionLLM {
  decide(input: DecisionInput): Promise<DecisionOutput>;
}
