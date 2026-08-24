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
  // `atMs` is when the import LANDED — the wall's arrival offer ("📦 … arrived
  // — ⚘ Plant it…") keys off it, because "a upid I have not seen before" is
  // true of every old import whenever a wall boots ahead of the first filled
  // snapshot. Optional: pre-atMs servers simply never trigger the offer.
  source?:
    | {
        kind: "github-import";
        url: string;
        atMs?: number;
      }
    | {
        kind: "phone-import";
        url: string | null;
        atMs?: number;
      };
  // TAKE-HOME publish surface: once this idea's pitch deck is published to
  // GitHub Pages (confirmed 200), the public URL and the server-generated QR
  // SVG that encodes it. The wall renders the SVG directly ("scan to take it
  // home") — no client-side QR dependency. Null/absent until published.
  publishedUrl?: string | null;
  publishedQrSvg?: string | null;
  // LIVE DEPLOYMENT (GitHub imports): the deploy-resolver's confirmed URL for
  // this repo's running app (VIBERSYN_DEPLOY_MAP override → clone scrape +
  // HEAD probes → gh garnish). Feeds the tree menu's "🌐 Live app" row, which
  // opens the holo panel's same-origin /salem proxy iframe. Null/absent when
  // no deployment resolved (most trees).
  deployUrl?: string | null;
  // GIT SUBSTRATE surface for tree visuals: the tree's real local repo.
  // branches is tiny and bounded (<=8): main + one concept/<backend> per lane
  // (adopted GitHub imports grow room/<slug> branches instead, each carrying
  // its PR URL once one is open against the origin), with session commit
  // counts. remoteUrl is null until published on commission (private GitHub
  // repo + draft PR per concept branch) — for adopted trees it is the origin.
  treeRepo?: { branches: Array<{ name: string; commits: number; prUrl?: string }>; remoteUrl: string | null } | null;
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
  // The concept topic (dialogueTopics entry) this turn belongs to, when the
  // server has clustered it. Null/absent = unclustered.
  topicId?: string | null;
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
  // Live findings (capped): the synthesized DRAFT while verification runs
  // (draft=true), the fact-checked set once complete.
  findings?: { claim: string; verdict: "supported" | "refuted" | "mixed" | "unverified" }[];
  draft?: boolean;
  // Follow-up questions from the completed dossier — each is one click away
  // from spawning its own research (POST /api/research/:id/followup).
  followUps?: string[];
  // Honest degradation notes ("fact-check pass failed — findings unverified").
  degraded?: string[];
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
  // The room/<slug> branch the steering target is scoped to (the record toggle
  // dwelled on a specific branch of an adopted tree), or null when the select
  // was unscoped. Lives and dies with steeringUpid.
  steeringBranch?: string | null;
  // WHERE THE LAST SPOKEN CHANGE TO THE ROOM LANDED — the post-Stop receipt.
  //   • branch: the branch that will grow the change (null = it grew nothing),
  //   • onto: the existing branch the operator asked to graft onto, or null
  //     for the default fresh cut,
  //   • error: why the room refused. A refusal means NOTHING was dispatched —
  //     the change was not quietly grown on some other branch.
  selfLanding?: { branch: string | null; onto: string | null; error: string | null; atMs: number } | null;
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
  // SELF-REBUILD ("the room rebuilds itself"): the RUNTIME toggle gating the
  // green-self-commit → exit-87 rebuild trigger. Boots on when
  // VIBERSYN_SELF_MODE=1 (the --self supervisor exports it); flipped from the
  // wall via POST /api/self-rebuild.
  selfRebuild?: boolean;
  // True when this server was launched with VIBERSYN_SELF_MODE=1 — i.e. under
  // the run-room --self supervisor loop, the only launch where an exit 87
  // actually rebuilds and relaunches the process. Lets the wall title the
  // Self-Rebuild toggle honestly (ARMED vs needs a --self launch).
  selfSupervisor?: boolean;
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
  // Concept clusters over the dialogue window. Each topic is a BRANCH of the
  // 3D conversation tree; turns reference their topic via topicId.
  dialogueTopics?: Array<{ id: string; label: string; turnIds: string[]; freshAtMs: number }>;
  // The conversation SKY over the ceiling: one cloud per concept topic,
  // remembered BEYOND the rolling dialogue window (turnCount = retired + live
  // members; liveTopicId null once the window killed the topic), plus
  // cross-cloud relations. PROVENANCE IS PART OF THE CONTRACT: each link's
  // source says whether the recurrent agent thread judged it ("agent") or the
  // deterministic lexical fallback did ("lexical"), and agentAtMs is null
  // until the agent has actually spoken. Shapes mirror research/sky.ts
  // (declared inline like dialogueTopics — the ui never imports server code).
  sky?: {
    clouds: Array<{
      id: string;
      label: string;
      labelSource: "agent" | "topic";
      firstAtMs: number;
      freshAtMs: number;
      turnCount: number;
      liveTopicId: string | null;
      dominantSpeaker: string | null;
      // NAMING GATE: false = too thin (or agent-dusted) to earn a label — the
      // ceiling renders this accumulation as dust, never a named constellation.
      // Optional for legacy fixtures (absent = named).
      named?: boolean;
      // RETIRED member turns kept as STARS (constellation asterism points).
      // Only the freshest clouds carry them; elidedCount admits evicted
      // history. Live stars are joined client-side from `dialogue` by topicId.
      stars?: Array<{ id: string; atMs: number; speaker: string | null; gist: string }>;
      elidedCount?: number;
    }>;
    links: Array<{ a: string; b: string; strength: number; reason: string; source: "agent" | "lexical" }>;
    updatedAtMs: number;
    agentAtMs: number | null;
    // LOUDNESS: the relate agent's live miss streak + last reason (mirrors
    // /api/health's sky-relate leg). `agent` = which transport landed the last
    // applied tick ("cerebras" | "host-claude" stand-in | null before any).
    // Optional for legacy fixtures.
    relate?: { missStreak: number; lastMissReason: string | null; agent?: string | null };
    // Retired babble: chronological dust, faint and nameless on the ceiling.
    dust?: Array<{ atMs: number }>;
  };
}
