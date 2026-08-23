import type { IdeaTrayItem, ProcessBuildStatus, ProjectorProcess, ProjectorSnapshot, TranscriptLine } from "../types";
import { backendsOf, buildsOf } from "../buildloop";

/**
 * Guided-demo step machine — the PURE core of the coached wall demo.
 *
 * DEMO RESCOPE: the guided demo covers ONLY the KICKOFF/IDEA phase of the
 * two-stage pipeline. The visitor takes an idea from spoken words to racing
 * concept MOCKS and the auto-opened pitch deck, then DECIDES how to continue
 * on the deck's "How should we continue?" surface. Any decision completes the
 * demo; picking "Build it for real" fires the real commission
 * (POST /api/process/:upid/execute) as an EPILOGUE — the demo never waits for
 * the full subscription build.
 *
 * Every advance condition reads REAL room state (the projector snapshot the
 * live server publishes over /api/state + SSE); nothing here fabricates
 * progress. The React overlay (GuidedDemo.tsx) renders `GuidedState` and the
 * App feeds every new snapshot through `advanceOnSnapshot`.
 *
 * THE STEP CONTRACT (what advances each step):
 *   orientation — 3 practice orbs; `popPracticeOrb` per pop (a local UI event —
 *                 the orbs are practice targets, not room state); all popped →
 *                 "hands" when the pinch-camera rig is live, else "record".
 *   hands       — (enlists ONLY when the hands rig was LIVE during
 *                 orientation — see setHandsLive) coaching for the real
 *                 camera grammar: pinch-hold-drag orbits, both-hands pinch
 *                 zooms, palm toward/away flies. Advances ONLY on its
 *                 explicit Continue button (routed through skipStep) — a
 *                 coaching step, never a fake state gate.
 *   record      — advances when the snapshot shows muted === false AND
 *                 captureMode === true (however achieved: the overlay's big
 *                 Record button POSTs the real /api/unmute + /api/capture +
 *                 /api/auto-accept, but a keyboard u/c or voice command counts
 *                 identically) AND the room has actually HEARD the visitor —
 *                 at least one kind:"room" transcript line beyond the speech
 *                 watermark (i.e. spoken after this run reached the record
 *                 step). A room left unmuted+capturing with hours of session
 *                 transcript never completes the step by itself. On advance
 *                 the process baseline is re-captured.
 *   idea        — advances ONLY on explicit visitor action (the Done button /
 *                 Skip, both routed through `skipStep`). The room may detect
 *                 and even auto-build in the background, but the coach never
 *                 yanks the visitor forward on its own; the race step adopts
 *                 the newborn process (first upid NOT in the baseline) as
 *                 `focusUpid` when it enters.
 *   race        — the three framework MOCK lanes race (kickoff stage; fast).
 *                 Advances when the focus process's real builds[] carry any
 *                 entry with status "ready" — i.e. the first MOCK is ready and
 *                 its pitch deck can open (legacy fallback: buildStatus ===
 *                 "ready" when builds[] is absent). While mocks genuinely
 *                 build the step CANNOT be skipped (operator rule) — the only
 *                 forward path is the first mock turning ready. Failed lanes
 *                 NEVER advance and never wedge: when every lane failed (or no
 *                 kickoff exists at all) the skip escape returns — see
 *                 raceSkippable.
 *   decide      — terminal step: the pitch deck is auto-opened and the visitor
 *                 dwell-picks a "How should we continue?" choice (rendered by
 *                 the deck overlay's room-native decision bar). ANY choice
 *                 completes the demo (the App exits on decision); `skipStep`
 *                 (the Finish button) returns null = demo complete too.
 *
 * Skip is available at every step EXCEPT a genuinely-building race (see
 * raceSkippable); re-entering (startGuided) always begins a fresh run with a
 * fresh baseline.
 *
 * WATERMARKS (feeds vs. session history): the room accumulates transcript
 * turns, detected ideas and processes for as long as it runs — the demo must
 * only ever react to items born AFTER it (re)entered, never to that history.
 * So the machine carries per-feed high-water marks in its state:
 *   baselineTurnKeys / baselineIdeaIds / baselineSettleTitle — captured by
 *   startGuided, slid forward on every snapshot WHILE ORIENTATION RUNS (the
 *   orientation→record edge, popPracticeOrb, never sees a snapshot — and the
 *   ?demo=guided auto-entry may start from an empty placeholder snapshot
 *   before the first live one lands), then FROZEN from record entry on. From
 *   that moment "beyond the watermark" means "this visitor's own speech /
 *   the ideas it produced".
 *   baselineUpids — the process watermark (recaptured entering idea, see
 *   above) so race/decide only ever adopt a process born during the demo.
 * The pure helpers freshTranscript / freshIdeas / guidedSettle expose the
 * post-watermark view; the overlay showcases ONLY that.
 */

export const PRACTICE_ORB_COUNT = 3;

// Minimum time the RACE step stays on screen even when a mock lane is already
// ready. Fast builders finish in the same frame the process appears, which
// cascaded idea -> race -> decide instantly — the visitor never saw the race.
// The demo is a guided tour; each auto-advanced step must be watchable.
export const RACE_MIN_DWELL_MS = 10_000;

export type GuidedStep = "orientation" | "hands" | "record" | "idea" | "race" | "decide";

// The per-run step order: the hands coaching step enlists ONLY when the
// pinch-camera rig is actually live (App: handsOn && handsStatus === "open") —
// a step teaching a camera that is not running would be a lie on the wall.
export function guidedStepOrder(handsLive: boolean): readonly GuidedStep[] {
  return handsLive
    ? ["orientation", "hands", "record", "idea", "race", "decide"]
    : ["orientation", "record", "idea", "race", "decide"];
}

export interface GuidedState {
  step: GuidedStep;
  // Practice-orb progress (orientation only; a local UI counter, not room state).
  orbsPopped: number;
  // The upids present when the demo (re)entered / when "record" completed —
  // the idea step looks for a process NOT in this set.
  baselineUpids: readonly string[];
  // Speech watermark: identity keys (time|speaker|text) of the transcript
  // lines already on the wall when the record step began. Only lines beyond
  // these count as demo speech (record's advance, the idea step's transcript).
  baselineTurnKeys: readonly string[];
  // Idea watermark: tray ids already detected when the record step began —
  // pre-demo ideas are never showcased as the visitor's.
  baselineIdeaIds: readonly string[];
  // The settle-gate title that was ALREADY armed when the record step began
  // (null when nothing was armed). ideaSettle carries no id, so the stale
  // pre-demo countdown is recognized by this title (see guidedSettle).
  baselineSettleTitle: string | null;
  // The project born during the demo (steps race/decide focus the camera on it).
  focusUpid: string | null;
  // Which backend's MOCK was FIRST ready (race → decide transition) so the
  // deck can open on that framework's real slideshow, whichever one won.
  readyBackend: string | null;
  // When the CURRENT step appeared (wall clock, stamped by the caller's nowMs).
  // Optional: callers that never pass nowMs (older tests) get the legacy
  // no-dwell behavior.
  enteredAtMs?: number;
  // Whether the pinch-camera hands rig was LIVE for this run (decides the step
  // list: the "hands" coaching step enlists only when true). Optional so older
  // raw-literal states keep working; absent reads as false. Slid during
  // orientation only — see setHandsLive.
  handsLive?: boolean;
}

function upidsOf(snapshot: ProjectorSnapshot): string[] {
  return snapshot.processes.map((process) => process.upid);
}

// Identity key for a transcript line (the feed carries no stable id; this is
// the same tuple the overlay already keys its React rows by). Two verbatim
// duplicates collapse — acceptable: the second is indistinguishable anyway.
function turnKeyOf(line: TranscriptLine): string {
  return `${line.time}\u001f${line.speaker}\u001f${line.text}`;
}

// The current high-water marks of every speech/idea feed in one capture.
function watermarksOf(
  snapshot: ProjectorSnapshot,
): Pick<GuidedState, "baselineTurnKeys" | "baselineIdeaIds" | "baselineSettleTitle"> {
  return {
    baselineTurnKeys: snapshot.transcript.map(turnKeyOf),
    baselineIdeaIds: (snapshot.ideas ?? []).map((idea) => idea.id),
    baselineSettleTitle: snapshot.ideaSettle?.armed === true ? snapshot.ideaSettle.title : null,
  };
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function startGuided(snapshot: ProjectorSnapshot, opts?: { handsLive?: boolean }): GuidedState {
  return {
    step: "orientation",
    orbsPopped: 0,
    baselineUpids: upidsOf(snapshot),
    ...watermarksOf(snapshot),
    focusUpid: null,
    readyBackend: null,
    handsLive: opts?.handsLive === true,
  };
}

// Hands liveness may reshape the run WHILE ORIENTATION RUNS only (the
// ?demo=guided auto-entry boots before the hands socket opens — the same
// healing doctrine as the watermark sliding in advanceOnSnapshot). Past
// orientation the step list is settled: a camera dying mid-run must not
// renumber the steps under the visitor. Identity-stable for setState callers.
export function setHandsLive(state: GuidedState, live: boolean): GuidedState {
  if (state.step !== "orientation" || (state.handsLive === true) === live) {
    return state;
  }
  return { ...state, handsLive: live };
}

// ── post-watermark feed views (what the demo may react to / showcase) ────────

// Transcript lines beyond the speech watermark — the visitor's own demo
// speech. The overlay's idea step shows ONLY these; record advances on them.
export function freshTranscript(state: GuidedState, snapshot: ProjectorSnapshot): TranscriptLine[] {
  const seen = new Set(state.baselineTurnKeys);
  return snapshot.transcript.filter((line) => !seen.has(turnKeyOf(line)));
}

// Actual visitor speech: kind "room" is the transcribed human; "vibersyn"
// (the room's own voice) and "process" (agent output) must not count.
function hasFreshRoomSpeech(state: GuidedState, snapshot: ProjectorSnapshot): boolean {
  return freshTranscript(state, snapshot).some((line) => line.kind === "room");
}

// Tray ideas beyond the idea watermark — detected during THIS demo run.
export function freshIdeas(state: GuidedState, snapshot: ProjectorSnapshot): IdeaTrayItem[] {
  const seen = new Set(state.baselineIdeaIds);
  return (snapshot.ideas ?? []).filter((idea) => !seen.has(idea.id));
}

// The settle gate (armed idea + countdown) the idea step may honestly show:
// null while nothing is armed AND while the armed idea is the stale pre-demo
// one — recognized by carrying the exact title that was already armed when
// the record step began with no post-watermark idea backing it. A fresh tray
// idea (or a new title) proves the countdown belongs to this visitor.
export function guidedSettle(
  state: GuidedState,
  snapshot: ProjectorSnapshot,
): NonNullable<ProjectorSnapshot["ideaSettle"]> | null {
  const settle = snapshot.ideaSettle;
  if (settle === undefined || settle.armed !== true) {
    return null;
  }
  if (
    state.baselineSettleTitle !== null &&
    settle.title === state.baselineSettleTitle &&
    freshIdeas(state, snapshot).length === 0
  ) {
    return null;
  }
  return settle;
}

// Step numbering renders against the run's OWN order (5 or 6 steps depending
// on the hands rig). A "hands" step can only exist in a hands-live run, so its
// number resolves against that order even if the caller forgot the flag.
export function stepNumber(step: GuidedStep, handsLive = false): number {
  return guidedStepOrder(handsLive || step === "hands").indexOf(step) + 1;
}

export function stepCount(handsLive = false): number {
  return guidedStepOrder(handsLive).length;
}

// The room is already live-listening: unmuted AND (capturing OR the browser
// mic is actually streaming — micState "live" in the App, which the snapshot
// does not carry, so callers thread it in). Entering the record step then
// would offer a button whose whole job is already done, so every entry into
// record (orb completion, orientation/hands skip) tests this and jumps
// straight to the idea step instead — freezing the watermarks and the process
// baseline at the jump, exactly as the record step's own exit would.
export function alreadyRecording(snapshot: ProjectorSnapshot, micLive = false): boolean {
  return snapshot.muted === false && (snapshot.captureMode === true || micLive);
}

// The shared edge INTO the recording phase (orientation/hands exits): freeze
// the speech/idea watermarks at this exact moment — everything beyond them is
// this visitor's own session. A room already recording skips the record step
// entirely (its button would be a no-op) and lands on "describe your idea".
function enterRecordOrIdea(state: GuidedState, snapshot: ProjectorSnapshot, nowMs?: number, micLive = false): GuidedState {
  if (alreadyRecording(snapshot, micLive)) {
    return { ...state, ...watermarksOf(snapshot), step: "idea", baselineUpids: upidsOf(snapshot), enteredAtMs: nowMs };
  }
  return { ...state, ...watermarksOf(snapshot), step: "record", enteredAtMs: nowMs };
}

// One practice orb popped (dwell-fired or clicked). All popped → the hands
// coaching step when the rig is live, else record — or straight past record
// when the room is already recording (snapshot provided / mic live).
export function popPracticeOrb(state: GuidedState, snapshot?: ProjectorSnapshot, nowMs?: number, micLive = false): GuidedState {
  if (state.step !== "orientation") {
    return state;
  }
  const orbsPopped = Math.min(state.orbsPopped + 1, PRACTICE_ORB_COUNT);
  if (orbsPopped < PRACTICE_ORB_COUNT) {
    return { ...state, orbsPopped };
  }
  // Live hands take the detour: camera coaching comes before recording, even
  // over a room already recording (the jump happens on the hands exit).
  if (state.handsLive === true) {
    return { ...state, orbsPopped, step: "hands", enteredAtMs: nowMs };
  }
  if (snapshot !== undefined) {
    return enterRecordOrIdea({ ...state, orbsPopped }, snapshot, nowMs, micLive);
  }
  return { ...state, orbsPopped, step: "record" };
}

export function focusProcess(state: GuidedState, snapshot: ProjectorSnapshot): ProjectorProcess | null {
  if (state.focusUpid === null) {
    return null;
  }
  return snapshot.processes.find((process) => process.upid === state.focusUpid) ?? null;
}

// The FIRST backend whose MOCK is ready, or null. Legacy servers without
// builds[] fall back to the single process-level buildStatus ("build" lane).
function firstReadyBackend(process: ProjectorProcess | null): string | null {
  if (process === null) {
    return null;
  }
  const builds = buildsOf(process);
  const ready = builds.find((build) => build.status === "ready");
  if (ready !== undefined) {
    return ready.backend;
  }
  if (builds.length === 0 && process.buildStatus === "ready") {
    return "build";
  }
  return null;
}

// Feed every fresh snapshot through this. Returns the SAME state object when
// nothing advances, so React setState bails without re-rendering.
export function advanceOnSnapshot(state: GuidedState, snapshot: ProjectorSnapshot, nowMs?: number): GuidedState {
  switch (state.step) {
    case "orientation":
    case "hands": {
      // Slide the speech/idea watermarks while the visitor practices (orbs OR
      // camera coaching): the record step must measure freshness from ITS OWN
      // entry, but the edges into it (popPracticeOrb, the hands Continue)
      // never see a fresh snapshot mid-flight — so the marks ride every feed
      // forward until the recording phase actually begins. This also heals
      // the ?demo=guided auto-entry, which may have baselined an empty
      // placeholder snapshot before the first live one (with the session's
      // whole history) arrived.
      const marks = watermarksOf(snapshot);
      if (
        sameStrings(marks.baselineTurnKeys, state.baselineTurnKeys) &&
        sameStrings(marks.baselineIdeaIds, state.baselineIdeaIds) &&
        marks.baselineSettleTitle === state.baselineSettleTitle
      ) {
        return state;
      }
      return { ...state, ...marks };
    }
    case "record": {
      if (!snapshot.muted && snapshot.captureMode === true && hasFreshRoomSpeech(state, snapshot)) {
        return { ...state, step: "idea", baselineUpids: upidsOf(snapshot), enteredAtMs: nowMs };
      }
      return state;
    }
    case "idea":
      // Deliberately inert: a background auto-build must not move the visitor
      // to step 4 — only their own Done/Skip (skipStep) advances the idea step.
      return state;
    case "race": {
      let next = state;
      // A skipped idea step has no focus yet: adopt the first newcomer.
      if (next.focusUpid === null) {
        const newcomer = snapshot.processes.find(
          (process) => !next.baselineUpids.includes(process.upid),
        );
        if (newcomer !== undefined) {
          next = { ...next, focusUpid: newcomer.upid };
        }
      }
      const readyBackend = firstReadyBackend(focusProcess(next, snapshot));
      if (readyBackend !== null) {
        // Hold the race on screen for its minimum dwell — instant mock lanes
        // must not blow the demo through to the deck in a single frame.
        const dwellMs = nowMs !== undefined && next.enteredAtMs !== undefined ? nowMs - next.enteredAtMs : null;
        if (dwellMs !== null && dwellMs < RACE_MIN_DWELL_MS) {
          return next;
        }
        return { ...next, step: "decide", readyBackend, enteredAtMs: nowMs };
      }
      return next;
    }
    default:
      return state;
  }
}

// Force-advance past the current step (the per-step skip button; the hands
// step's Continue routes here too). Returns null when skipping past the final
// step = demo complete. NOT always available: a race with mocks genuinely
// building refuses (identity return) — see raceSkippable.
export function skipStep(state: GuidedState, snapshot: ProjectorSnapshot, nowMs?: number, micLive = false): GuidedState | null {
  switch (state.step) {
    case "orientation":
      // Live hands take the camera-coaching detour first; otherwise fall
      // through to the recording phase (watermarks frozen at the jump — see
      // enterRecordOrIdea).
      if (state.handsLive === true) {
        return { ...state, step: "hands", enteredAtMs: nowMs };
      }
      return enterRecordOrIdea(state, snapshot, nowMs, micLive);
    case "hands":
      // The Continue button and Skip are the SAME transition — coaching is
      // done either way, nothing underneath changes (hands stay live).
      return enterRecordOrIdea(state, snapshot, nowMs, micLive);
    case "record":
      // Same baseline reset the natural advance performs, so a process that
      // appears later still registers as the demo's newcomer.
      return { ...state, step: "idea", baselineUpids: upidsOf(snapshot), enteredAtMs: nowMs };
    case "idea":
      // The race still gets its dwell stamp — skipping INTO the race must not
      // let an already-ready mock cascade straight to the deck.
      return advanceOnSnapshot({ ...state, step: "race", enteredAtMs: nowMs }, snapshot, nowMs);
    case "race":
      // MOCKS BUILDING ARE NOT SKIPPABLE (operator rule: "I should also not
      // be able to skip the mocks"): while a real kickoff races, the only way
      // forward is the first mock turning ready. Identity return = refused.
      // The never-wedge escapes (no focus process / every lane failed) pass
      // through and bypass the dwell explicitly.
      if (!raceSkippable(state, snapshot)) {
        return state;
      }
      return {
        ...state,
        step: "decide",
        readyBackend: firstReadyBackend(focusProcess(state, snapshot)),
        enteredAtMs: nowMs,
      };
    case "decide":
      return null;
  }
}

// May the race step be force-advanced? ONLY when nothing real would be
// abandoned: no focus process (a skipped-through run — the race would
// otherwise wedge forever on a kickoff that never happened) or every lane
// failed (nothing will ever turn ready). While mocks genuinely build the
// answer is no — the overlay hides its skip affordance and the machine
// enforces the refusal (skipStep returns the state unchanged).
export function raceSkippable(state: GuidedState, snapshot: ProjectorSnapshot): boolean {
  return focusProcess(state, snapshot) === null || lanesAllFailed(guidedLanes(state, snapshot));
}

// ── mock lanes (step 4, the concept race) ────────────────────────────────────

export type GuidedLaneStatus = ProcessBuildStatus | "queued";

export interface GuidedLane {
  id: string;
  label: string;
  status: GuidedLaneStatus;
  progressLabel: string | null;
  percent: number | null;
  summary: string | null;
  hasDeck: boolean;
  // The lane's live mock preview (ready lanes), for in-room View semantics.
  previewUrl: string | null;
}

// Framework display names for the race lanes. Unknown backend ids fall back to
// the server-provided chip label (never invented).
const LANE_LABELS: Record<string, string> = {
  smithers: "Smithers",
  eliza: "ElizaOS",
  native: "Native · homebrewed",
};

export function laneLabel(id: string, fallback?: string): string {
  return LANE_LABELS[id] ?? fallback ?? id;
}

// One lane per ENABLED backend (snapshot.backends roster), each carrying the
// process's REAL builds[] telemetry for that backend — or "queued" until the
// fan-out publishes its entry. Backends missing from the roster but present
// in builds[] still get a lane (never hide a real build). Legacy servers with
// no roster and no builds[] surface the single process-level buildStatus.
// Process-centric so BOTH lane consumers share it: the guided demo's race
// (via guidedLanes below) and the per-tree menu (TreeMenu.tsx).
export function processLanes(process: ProjectorProcess | null, snapshot: ProjectorSnapshot): GuidedLane[] {
  const builds = process !== null ? buildsOf(process) : [];
  const roster = backendsOf(snapshot).filter((backend) => backend.enabled);

  const laneIds: { id: string; label: string }[] = roster.map((backend) => ({
    id: backend.id as string,
    label: laneLabel(backend.id, backend.label),
  }));
  for (const build of builds) {
    if (!laneIds.some((lane) => lane.id === (build.backend as string))) {
      laneIds.push({ id: build.backend as string, label: laneLabel(build.backend, build.label) });
    }
  }
  if (laneIds.length === 0 && process !== null && typeof process.buildStatus === "string") {
    return [
      {
        id: "build",
        label: "Build",
        status: process.buildStatus,
        progressLabel: process.progressLabel.length > 0 ? process.progressLabel : null,
        percent: Number.isFinite(process.progress) ? process.progress : null,
        summary: null,
        hasDeck: false,
        previewUrl: process.previewUrl ?? null,
      },
    ];
  }

  return laneIds.map(({ id, label }) => {
    const build = builds.find((candidate) => (candidate.backend as string) === id);
    if (build === undefined) {
      return {
        id,
        label,
        status: "queued" as const,
        progressLabel: null,
        percent: null,
        summary: null,
        hasDeck: false,
        previewUrl: null,
      };
    }
    return {
      id,
      label,
      status: build.status,
      progressLabel: build.progressLabel ?? null,
      percent: build.percent ?? null,
      summary: build.summary,
      hasDeck: build.slideshowUrl !== null,
      previewUrl: build.previewUrl,
    };
  });
}

// The guided demo's race lanes: the focus process's lanes.
export function guidedLanes(state: GuidedState, snapshot: ProjectorSnapshot): GuidedLane[] {
  return processLanes(focusProcess(state, snapshot), snapshot);
}

// ONE status vocabulary for a lane, shared by the race overlay and the
// per-tree menu: "queued…" / "{progressLabel} · {percent}%" / "MOCK READY ✓" /
// "FAILED" — an honest percent instead of a silent dead row while building.
export function laneStatusLabel(lane: GuidedLane): string {
  switch (lane.status) {
    case "queued":
      return "queued…";
    case "building":
      return `${lane.progressLabel ?? "mocking…"}${lane.percent !== null ? ` · ${Math.round(lane.percent)}%` : ""}`;
    case "ready":
      return "MOCK READY ✓";
    case "failed":
      return "FAILED";
  }
}

// Honest failure state: every lane exists and every lane failed. The overlay
// says so instead of spinning forever; skip/exit stay available regardless.
export function lanesAllFailed(lanes: readonly GuidedLane[]): boolean {
  return lanes.length > 0 && lanes.every((lane) => lane.status === "failed");
}

// ── resilience notices ───────────────────────────────────────────────────────

// A blocking/degraded room condition the overlay must SAY instead of wedging
// on. Null when the current step can proceed normally.
export function guidedNotice(state: GuidedState, snapshot: ProjectorSnapshot): string | null {
  if (snapshot.emergencyStopTriggered) {
    return "EMERGENCY STOP is active — the room is halted, so the demo cannot proceed. Clear the stop (or exit the demo).";
  }
  if ((state.step === "idea" || state.step === "race") && snapshot.muted) {
    return "The room went muted, so nothing can be heard. Unmute (the Unmute button or the U key) to continue, or skip ahead.";
  }
  if (state.step === "idea" && snapshot.mic?.mode === "replay") {
    return "Audio is reaching the server but ASR is in replay mode (no DEEPGRAM_API_KEY) — speech will not transcribe. Fix the key or skip ahead.";
  }
  return null;
}

// ── rig-aware + honest-verb copy (locked verbatim by machine.test.ts) ────────

// Which physical thing moves the cursor. run-room.sh says which it wired:
// &stick=1 (the --arcade joystick path) → "stick"; any other gesture wall →
// "hand" (cameras); no gesture layer at all → "mouse" (desk). Both fusion
// sources speak the same ws protocol, so only the launcher knows — and the
// coaching must describe the input actually in the visitor's hand.
export type PointerRig = "hand" | "stick" | "mouse";

export function stepTitle(step: GuidedStep, rig: PointerRig): string {
  if (step === "orientation") {
    return rig === "hand" ? "Point with your hand" : rig === "stick" ? "Steer with the joystick" : "Point and hold";
  }
  switch (step) {
    case "hands":
      return "Fly the camera with your hands";
    case "record":
      return "Start the room recording";
    case "idea":
      return "Describe your idea";
    case "race":
      return "Watch the concepts race";
    case "decide":
      return "How should we continue?";
  }
}

export interface OrientationCopy {
  lede: string;
  practice: string;
  // Per-orb aria hint, rendered as "Practice orb N — {orbHint}".
  orbHint: string;
}

export function orientationCopy(rig: PointerRig): OrientationCopy {
  switch (rig) {
    case "hand":
      return {
        lede: "Open your hand and point at the wall. Whatever you aim at grows and glows — hold still and a ring fills around it. When the ring completes, that's your click.",
        practice: `Practice: pop the ${PRACTICE_ORB_COUNT} floating orbs. Point at one, hold until the ring closes.`,
        orbHint: "point and hold to pop",
      };
    case "stick":
      return {
        lede: "Steer with the joystick lever to move the cursor. Whatever it rests on grows and glows — hold a button and a ring fills around it. When the ring completes, that's your click.",
        practice: `Practice: pop the ${PRACTICE_ORB_COUNT} floating orbs. Steer onto one, hold a button until the ring closes.`,
        orbHint: "steer onto it and hold a button to pop",
      };
    case "mouse":
      return {
        lede: "Move the mouse to aim. Whatever the cursor rests on grows and glows — hold still (or click) and a ring fills around it. When the ring completes, that's your click.",
        practice: `Practice: pop the ${PRACTICE_ORB_COUNT} floating orbs. Rest the cursor on one until the ring closes, or just click.`,
        orbHint: "rest the cursor on it (or click) to pop",
      };
  }
}

// The record step's lede: the imperative names the real input.
export function recordCopy(rig: PointerRig): string {
  const action =
    rig === "hand"
      ? "Point at the big Start Recording button and hold."
      : rig === "stick"
        ? "Steer onto the big Start Recording button and hold a button."
        : "Press the big Start Recording button.";
  return `${action} It really unmutes the room, turns on Idea Capture and Auto-Build, and starts the microphone — from here on, the room is listening.`;
}

// EVERY dismissal verb says what happens underneath (operator: "if it's
// building the mocks and I click exit, is it going to stop building the mocks
// or not?"). The race entry exists ONLY for its never-wedge escapes (see
// raceSkippable) — while mocks build, the overlay offers no skip at all.
export function skipCopy(step: GuidedStep, handsLive = false): { label: string; title: string } {
  switch (step) {
    case "orientation":
      return {
        label: "Skip practice ▸",
        title: handsLive
          ? "Skips the pointing practice and moves to the hand-camera step — the room itself is untouched."
          : "Skips the pointing practice and moves toward recording — the room itself is untouched.",
      };
    case "hands":
      return {
        label: "Skip ▸ — hands stay live",
        title: "Skips the camera coaching — your hands keep flying the camera exactly as before.",
      };
    case "record":
      return {
        label: "Skip ▸ — mic stays as it is",
        title: "Moves on without starting the recording — the mic and capture are left exactly as they are.",
      };
    case "idea":
      return {
        label: "Skip ▸ — nothing builds",
        title: "Moves on without planting — nothing new starts building.",
      };
    case "race":
      return {
        label: "Continue without a mock ▸",
        title: "No mock is coming from this kickoff — continuing abandons nothing that is still running.",
      };
    case "decide":
      return {
        label: "✓ Finish",
        title: "Ends the guided demo. The room keeps working; nothing running is stopped.",
      };
  }
}

// The leave verb, with the build truth SAID on the surface: leaving the guide
// never stops anything the room is doing — the subtitle states exactly what
// keeps going at this step.
export function exitCopy(step: GuidedStep): { label: string; subtitle: string } {
  switch (step) {
    case "race":
      return {
        label: "✕ Leave the guide",
        subtitle: "Leaving never stops the mocks — they keep building and the tree stays in the garden.",
      };
    case "idea":
      return {
        label: "✕ Leave the guide",
        subtitle: "Leaving re-enables auto-build and the room keeps listening.",
      };
    default:
      return {
        label: "✕ Leave the guide",
        subtitle: "The room keeps working; nothing running is stopped.",
      };
  }
}

// The idea step's finalize verb speaks the room's own metaphor: planting the
// accepted idea literally grows a tree in the garden while its concept mocks
// race. The subtitle is the honest mechanics of the press.
export const PLANT_COPY = {
  label: "🌱 Plant this idea",
  subtitle: "Plants what you described in the garden — the concept mocks start racing and a real tree grows.",
} as const;

// START OVER (idea step only): drop everything said so far and listen fresh —
// the same watermark freeze the step's entry performed, re-stamped NOW, plus
// the process re-baseline. The caller re-POSTs /api/guided/hold {on:true} so
// the server mirrors it (composition.setGuidedHold re-stamps the transcript
// boundary, drops the queued bubble and disarms pre-step candidates); this is
// the pure local half. Identity no-op on any other step.
export function restartIdea(state: GuidedState, snapshot: ProjectorSnapshot, nowMs?: number): GuidedState {
  if (state.step !== "idea") {
    return state;
  }
  return { ...state, ...watermarksOf(snapshot), baselineUpids: upidsOf(snapshot), enteredAtMs: nowMs };
}
