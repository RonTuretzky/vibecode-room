import type { LogEvent } from "../types";

export type ProjectorProcessState = "planning" | "active" | "paused" | "halted" | "completed" | "blocked";
export type SuggestionState = "idle" | "queued" | "speaking" | "accepted" | "declined";
// Status of the real accept->build->preview artifact for a process. Null/absent
// for processes that never triggered a build (e.g. the seeded demo fleet).
export type ProcessBuildStatus = "building" | "ready" | "failed";

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
  // Real live-preview surface (accept->build->preview). `previewUrl` is the
  // reachable http://127.0.0.1:<port>/ once the scaffolded page is served;
  // `buildStatus` tracks building -> ready | failed. Both null/absent until an
  // accepted idea triggers a build for this process.
  previewUrl?: string | null;
  buildStatus?: ProcessBuildStatus | null;
  // True when this process is the current steering target: while set, live FINAL
  // transcript lines route to THIS process's agent loop (registry.steer) instead
  // of seeding a fresh ambient suggestion. Clicking the process sets/clears it.
  steering?: boolean;
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
  // The UPID of the current steering target, or null when none is set. While set,
  // live FINAL transcript lines are routed to that process's agent loop (steer)
  // instead of seeding a new ambient suggestion. Surfaced so the projector can
  // highlight the steered bubble and show a "steering ->" indicator.
  steeringUpid?: string | null;
  // AUTO-BUILD: when true, every fired idea is accepted+built without a click. The
  // projector shows the toggle as ON.
  autoAccept?: boolean;
  // Optional live-microphone status. Absent in the static demo fixtures; the
  // server runtime sets it when a browser mic session is wired through
  // /api/mic. `mode` is the ASR backend ("deepgram" = real transcription,
  // "voxterm" = the local VoxTerm transcriber, "replay" = audio received but not
  // transcribed because no key/transcriber is set).
  mic?: {
    mode: "deepgram" | "voxterm" | "replay";
    active: boolean;
    // Total raw PCM bytes the server has received from the live mic socket. Lets
    // the projector prove audio is flowing even in "replay" mode (no ASR key).
    bytesReceived: number;
  };
}
