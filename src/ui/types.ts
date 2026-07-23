import type { LogEvent } from "../types";

export type ProjectorProcessState = "planning" | "active" | "paused" | "halted" | "completed" | "blocked";
export type SuggestionState = "idle" | "queued" | "speaking" | "accepted" | "declined";
// Status of the real accept->build->preview artifact for a process. Null/absent
// for processes that never triggered a build (e.g. the seeded demo fleet).
export type ProcessBuildStatus = "building" | "ready" | "failed";

// One slide of a project's explainer deck (HTML body; fixture/demo content).
export interface ProjectSlide {
  title: string;
  html: string;
}

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
  // Optional explainer slideshow: when present, clicking the project in the
  // 3D scene opens this deck instead of steering (mock/demo affordance).
  slides?: ProjectSlide[];
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
  // Where this process came from. Absent for idea-detected builds; set for
  // projects imported from outside via the phone QR page: "github-import" when
  // the link was a real github.com repo (the server clones it), "phone-import"
  // for context-only or any-other-link submissions (url null when no link).
  source?:
    | {
        kind: "github-import";
        url: string;
      }
    | {
        kind: "phone-import";
        url: string | null;
      };
  // TAKE-HOME publish surface: once this idea's pitch deck is published to
  // GitHub Pages (confirmed 200), the public URL and the server-generated QR
  // SVG that encodes it. The wall renders the SVG directly ("scan to take it
  // home") — no client-side QR dependency. Null/absent until published.
  publishedUrl?: string | null;
  publishedQrSvg?: string | null;
}

// One candidate in the idea tray: the full ledger surfaced to the projector, not
// just the single primary bubble. Ready candidates are buildable/dismissable via
// /api/idea/:id/accept | /api/idea/:id/dismiss (or keyboard/voice).
export interface IdeaTrayItem {
  id: string;
  pitch: string;
  confidence: number;
  status: "ready" | "forming";
  maturity: "forming" | "proposed" | "elaborated" | "actionable";
  verified: boolean;
  rationale?: string;
  // Verbatim evidence quote from the grounding span, when available.
  evidence?: string;
}

export interface TranscriptLine {
  time: string;
  speaker: string;
  text: string;
  kind: "room" | "vibersyn" | "process";
}

// ── RESEARCH MODE (VoxTerm-inspired dialogue tree + research quests) ────────

// One committed room utterance with a STABLE id — the 3D dialogue tree anchors
// research nodes to the exact turn they grew from.
export interface DialogueTurn {
  id: string;
  speaker: string | null;
  text: string;
  atMs: number;
}

export type ResearchTrayKind = "fact-check" | "deep-dive" | "bias-scan";
export type ResearchTrayStatus = "proposed" | "researching" | "complete" | "failed";

// One research quest surfaced to the wall: a proposed suggestion (click to
// spawn the research), live agent progress, or a completed dossier whose deck
// (HTML slideshow with per-source QR codes) is at `deckUrl`.
export interface ResearchTrayItem {
  id: string;
  kind: ResearchTrayKind;
  topic: string;
  claim: string;
  confidence: number;
  status: ResearchTrayStatus;
  progress: number;
  progressLabel: string;
  rationale?: string;
  // Verbatim evidence quote from the grounding span, when available.
  evidence?: string;
  // The grounding turn id (contextSpan end) — the dialogue-tree anchor.
  turnId?: string;
  // Report shape summary, present once complete.
  sourceCount: number;
  biasCount: number;
  verdicts?: { supported: number; refuted: number; mixed: number; unverified: number };
  // The dossier slideshow URL once complete (GET /api/research/:id/deck).
  deckUrl?: string | null;
  error?: string;
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
  // Deck-ready decision questions the swipe deck consumes: {id, prompt, answers}.
  // Derived server-side from the candidate's parallel questions/answers arrays
  // (see src/detect/plan-questions.ts). Absent on idle/legacy gate-driven
  // suggestions that never carried structured answers.
  planQuestions?: import("../detect").PlanQuestion[];
  // Provenance (idea detection): the span of conversation this idea was grounded
  // in — the inclusive turn-id range plus the verbatim evidence the model quoted.
  // Absent on the neutral idle bubble and on legacy gate-driven suggestions.
  contextSpan?: {
    startTurnId: string;
    endTurnId: string;
    quote: string;
  };
  // One-line model rationale for why this is a buildable idea.
  rationale?: string;
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
  // IDEA CAPTURE mode: when true, the operator has explicitly started the creation
  // loop — detection runs eagerly and every surfaced idea builds itself. The
  // projector shows a distinct "capturing" indicator.
  captureMode?: boolean;
  // AUTO-BUILD SETTLE GATE surface: while an idea is armed and waiting for the
  // room to go quiet, the walls show the heard pitch, a live countdown
  // (firesInMs is SERVER-computed and republished every second), and a Done
  // button that accepts immediately.
  ideaSettle?: { armed: boolean; title: string | null; firesInMs: number | null };
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
  // The idea tray: every live ledger candidate (ready first), so the room sees
  // forming ideas and can explicitly build/dismiss instead of trusting a single
  // auto-surfaced bubble. Absent in legacy/static fixtures.
  ideas?: IdeaTrayItem[];
  // Voice control feedback: the last wake-word command the server recognized
  // ("capture on", "build", …), so walls can flash confirmation. Null when no
  // command has been recognized this session.
  voice?: {
    lastCommand: string;
    at: string;
  } | null;
  // RESEARCH MODE: when true, the research suggester watches the conversation
  // and proposes quests (fact-checks, deep-dives, bias scans) alongside idea
  // detection. Toggled via POST /api/research-mode or voice "research on".
  researchMode?: boolean;
  // True while a suggestion round's model inference is in flight — the wall's
  // "scanning the conversation" indicator (a crystal might be forming).
  researchThinking?: boolean;
  // Every live research quest, tray-ordered (researching → proposed by
  // confidence → complete → failed). Absent in legacy/static fixtures.
  research?: ResearchTrayItem[];
  // The rolling dialogue window (turns with stable ids) feeding the 3D
  // dialogue tree. Mirrors the transcript but id-addressable, so research
  // quests can anchor to the exact turn they grew from.
  dialogue?: DialogueTurn[];
}
