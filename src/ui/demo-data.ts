import type { LogEvent } from "../types";
import type { ProjectorSnapshot } from "./types";

const trace = (event: string, correlationId: string, meta: Record<string, unknown>, upid?: string): LogEvent => ({
  level: "info",
  event,
  sessionId: "projector-demo",
  correlationId,
  upid,
  latencyMs: 42,
  meta,
});

export const demoProjectorSnapshot: ProjectorSnapshot = {
  sessionId: "projector-demo",
  listening: true,
  muted: false,
  globalState: "ready",
  activeCue: "Atlas steering window",
  emergencyStopTriggered: false,
  suggestion: {
    state: "queued",
    pitch: "Turn the meeting notes into a blocker announcer.",
    confidence: 0.82,
    gate: {
      words: 74,
      minWords: 60,
      seconds: 128,
      minSeconds: 90,
    },
    questions: ["Which repo?", "Should it post to Slack?", "Who reviews first?"],
  },
  audio: {
    lastSpoken: "Atlas active. I will include the run name in the summary.",
    earcon: "route-steer double click",
    silenceRatio: 0.91,
  },
  processes: [
    {
      upid: "upid_atlas_7f3",
      runId: "smithers_run_9c12",
      callsign: "Atlas",
      state: "active",
      selected: true,
      task: "Blocker announcer",
      model: "Codex gpt-5.5",
      progressLabel: "writing summary",
      progress: 68,
      lastOutput: "Done with scan. Updating the announcement copy now.",
      lastAction: "steer: include run name",
      events: ["spawn confirmed", "plan accepted", "steered by room", "summary emitted"],
    },
    {
      upid: "upid_cobalt_5e0",
      runId: "smithers_run_9c55",
      callsign: "Cobalt",
      state: "planning",
      selected: false,
      task: "Migration dry-run",
      model: "Claude Sonnet 4.6",
      progressLabel: "checking resources",
      progress: 24,
      lastOutput: "Planning the dry-run path before touching files.",
      lastAction: "spawned from accepted suggestion",
      events: ["spawn confirmed", "resource check", "planning"],
    },
  ],
  transcript: [
    {
      time: "12:04:31",
      speaker: "Room",
      kind: "room",
      text: "Atlas, also include the run name in the spoken summary.",
    },
    {
      time: "12:04:32",
      speaker: "Vibersyn",
      kind: "vibersyn",
      text: "Routed to Atlas.",
    },
    {
      time: "12:05:02",
      speaker: "Room",
      kind: "room",
      text: "The standup notes keep losing blockers.",
    },
    {
      time: "12:05:40",
      speaker: "Vibersyn",
      kind: "vibersyn",
      text: "Idea queued for the next idle gap.",
    },
  ],
  trace: [
    trace("observe.final", "corr-atlas-001", { utteranceId: "utt-218", speaker: "speaker-1" }),
    trace("route.action", "corr-atlas-001", { action: "steer", targetUPID: "upid_atlas_7f3" }, "upid_atlas_7f3"),
    trace("process.steer", "corr-atlas-001", { runId: "smithers_run_9c12" }, "upid_atlas_7f3"),
    trace("output.tts", "corr-atlas-001", { text: "Routed to Atlas." }, "upid_atlas_7f3"),
    trace("observe.pass", "corr-room-224", { reason: "ambient", wordCount: 18 }),
    trace("suggestion.queued", "corr-suggest-009", { confidence: 0.82, idlePreferred: true }),
  ],
  // The idea tray fixture: ready candidates first (buildable/dismissable), then a
  // dimmed forming one — so the offline demo shows the full explicit-confirm flow.
  ideas: [
    {
      id: "idea_blocker_announcer",
      pitch: "Turn the meeting notes into a blocker announcer.",
      confidence: 0.82,
      status: "ready",
      maturity: "actionable",
      verified: true,
      rationale: "Concrete, scoped, and the pain was mentioned twice.",
      evidence: "The standup notes keep losing blockers.",
    },
    {
      id: "idea_retro_wall",
      pitch: "A retro wall that clusters this week's wins and gripes.",
      confidence: 0.63,
      status: "ready",
      maturity: "proposed",
      verified: false,
      evidence: "We never see the wins next to the gripes.",
    },
    {
      id: "idea_focus_chime",
      pitch: "Ambient focus chime keyed to who is speaking.",
      confidence: 0.31,
      status: "forming",
      maturity: "forming",
      verified: false,
    },
  ],
  voice: null,
  updatedAt: new Date("2026-06-16T18:00:00.000Z").toISOString(),
};

// The neutral, fixture-free baseline the LIVE runtime publishes before any real
// activity: zero processes, an empty transcript, an idle suggestion with an empty
// pitch, and an empty trace/audio. The demo fixture above is reserved for the
// OFFLINE-DEMO (?live=0) UI path and tests; the live /api/state must reflect real
// state only, so it starts from this instead of spreading demoProjectorSnapshot.
export const emptyProjectorSnapshot: ProjectorSnapshot = {
  sessionId: "projector-live",
  listening: true,
  muted: false,
  globalState: "ready",
  activeCue: "idle",
  emergencyStopTriggered: false,
  suggestion: {
    state: "idle",
    pitch: "",
    confidence: 0,
    gate: { words: 0, minWords: 0, seconds: 0, minSeconds: 0 },
    questions: [],
  },
  audio: {
    lastSpoken: "",
    earcon: "",
    silenceRatio: 1,
  },
  processes: [],
  transcript: [],
  trace: [],
  ideas: [],
  voice: null,
  updatedAt: new Date(0).toISOString(),
  steeringUpid: null,
  autoAccept: false,
};

export function withUnmuted(snapshot: ProjectorSnapshot): ProjectorSnapshot {
  return {
    ...snapshot,
    listening: true,
    muted: false,
    globalState: "ready",
    activeCue: "ambient listening",
    audio: {
      ...snapshot.audio,
      lastSpoken: "Unmuted.",
      earcon: "ambient E2 restored",
    },
    trace: [
      ...snapshot.trace,
      trace("mute.released", `corr-unmute-${Date.now()}`, { trigger: "unmute-button", streamingToCloud: true }),
    ].slice(-80),
    updatedAt: new Date().toISOString(),
  };
}
