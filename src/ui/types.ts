import type { LogEvent } from "../types";

export type ProjectorProcessState = "planning" | "active" | "paused" | "halted" | "completed" | "blocked";
export type SuggestionState = "idle" | "queued" | "speaking" | "accepted" | "declined";

export interface ProjectorProcess {
  upid: string;
  runId: string;
  callsign: string;
  state: ProjectorProcessState;
  selected: boolean;
  task: string;
  model: string;
  progressLabel: string;
  progress: number;
  lastOutput: string;
  lastAction: string;
  events: string[];
}

export interface TranscriptLine {
  time: string;
  speaker: string;
  text: string;
  kind: "room" | "panopticon" | "process";
}

export interface ProjectorSuggestion {
  state: SuggestionState;
  pitch: string;
  confidence: number;
  gate: {
    words: number;
    minWords: number;
    seconds: number;
    minSeconds: number;
  };
  questions: string[];
}

export interface ProjectorSnapshot {
  sessionId: string;
  listening: boolean;
  muted: boolean;
  globalState: string;
  activeCue: string;
  emergencyStopTriggered: boolean;
  suggestion: ProjectorSuggestion;
  audio: {
    lastSpoken: string;
    earcon: string;
    silenceRatio: number;
  };
  processes: ProjectorProcess[];
  transcript: TranscriptLine[];
  trace: LogEvent[];
  updatedAt: string;
  // Optional live-microphone status. Absent in the static demo fixtures; the
  // server runtime sets it when a browser mic session is wired through
  // /api/mic. `mode` is the ASR backend ("deepgram" = real transcription,
  // "replay" = audio received but not transcribed because no key is set).
  mic?: {
    mode: "deepgram" | "replay";
    active: boolean;
    // Total raw PCM bytes the server has received from the live mic socket. Lets
    // the projector prove audio is flowing even in "replay" mode (no ASR key).
    bytesReceived: number;
  };
}
