import { describe, expect, test } from "bun:test";
import type { IdeaTrayItem, ProjectorProcess, ProjectorSnapshot, TranscriptLine } from "../types";
import type { BuildloopProcess, BuildloopSnapshot, ProcessBuild } from "../buildloop";
import { emptyProjectorSnapshot } from "../demo-data";
import {
  PLANT_COPY,
  PRACTICE_ORB_COUNT,
  advanceOnSnapshot,
  exitCopy,
  freshIdeas,
  freshTranscript,
  guidedLanes,
  guidedNotice,
  guidedSettle,
  guidedStepOrder,
  lanesAllFailed,
  orientationCopy,
  popPracticeOrb,
  raceSkippable,
  recordCopy,
  restartIdea,
  setHandsLive,
  skipCopy,
  skipStep,
  startGuided,
  stepCount,
  stepNumber,
  stepTitle,
  RACE_MIN_DWELL_MS,
} from "./machine";

// ── fake snapshot feed helpers (no network, no fixtures from demo-data) ──────

function makeProcess(upid: string, overrides: Partial<BuildloopProcess> = {}): BuildloopProcess {
  return {
    upid,
    runId: `run_${upid}`,
    callsign: `cs-${upid}`,
    state: "active",
    selected: false,
    task: `task ${upid}`,
    model: "runtime",
    progressLabel: "working",
    progress: 10,
    lastOutput: "",
    lastAction: "spawned",
    events: [],
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<BuildloopSnapshot> = {}): BuildloopSnapshot {
  return { ...emptyProjectorSnapshot, ...overrides };
}

function build(backend: string, status: ProcessBuild["status"], extra: Partial<ProcessBuild> = {}): ProcessBuild {
  return {
    backend: backend as ProcessBuild["backend"],
    label: backend,
    status,
    previewUrl: null,
    summary: null,
    slideshowUrl: null,
    ...extra,
  };
}

function turn(time: string, text: string, kind: TranscriptLine["kind"] = "room"): TranscriptLine {
  return { time, speaker: kind === "room" ? "Room" : "Vibersyn", text, kind };
}

function idea(id: string, pitch = `pitch ${id}`): IdeaTrayItem {
  return { id, pitch, confidence: 0.8, status: "ready", maturity: "actionable", verified: true };
}

// A room mid-recording (unmuted + capturing) — the record step's exit state.
const recordingRoom = (overrides: Partial<BuildloopSnapshot> = {}) =>
  makeSnapshot({ muted: false, captureMode: true, ...overrides });

// A recording room where the visitor has ALSO said something new — the full
// record-step exit condition (fresh speech beyond the watermark).
const spokenRoom = (overrides: Partial<BuildloopSnapshot> = {}) =>
  recordingRoom({ transcript: [turn("00:00:01", "hello room, new idea")], ...overrides });

describe("guided demo — entry & orientation", () => {
  test("startGuided begins at orientation with the current fleet as baseline", () => {
    const snapshot = makeSnapshot({ processes: [makeProcess("upid_a"), makeProcess("upid_b")] });
    const state = startGuided(snapshot);
    expect(state.step).toBe("orientation");
    expect(state.orbsPopped).toBe(0);
    expect(state.baselineUpids).toEqual(["upid_a", "upid_b"]);
    expect(state.focusUpid).toBeNull();
    expect(stepNumber(state.step)).toBe(1);
  });

  test("popping all practice orbs advances to record; earlier pops do not", () => {
    let state = startGuided(makeSnapshot());
    for (let i = 1; i < PRACTICE_ORB_COUNT; i += 1) {
      state = popPracticeOrb(state);
      expect(state.step).toBe("orientation");
      expect(state.orbsPopped).toBe(i);
    }
    state = popPracticeOrb(state);
    expect(state.step).toBe("record");
  });

  test("orb pops outside orientation are ignored (no double-advance)", () => {
    let state = startGuided(makeSnapshot());
    for (let i = 0; i < PRACTICE_ORB_COUNT + 3; i += 1) {
      state = popPracticeOrb(state);
    }
    expect(state.step).toBe("record");
    expect(state.orbsPopped).toBe(PRACTICE_ORB_COUNT);
  });

  test("snapshots never advance the orientation step (orbs are local practice)", () => {
    const state = startGuided(makeSnapshot());
    expect(advanceOnSnapshot(state, recordingRoom())).toBe(state);
  });
});

describe("guided demo — record step (real unmute + capture)", () => {
  const atRecord = () => {
    let state = startGuided(makeSnapshot());
    for (let i = 0; i < PRACTICE_ORB_COUNT; i += 1) {
      state = popPracticeOrb(state);
    }
    return state;
  };

  test("advances ONLY when the room is unmuted AND capturing AND has heard NEW speech", () => {
    const state = atRecord();
    const freshLine = [turn("00:00:01", "hello room, new idea")];
    expect(advanceOnSnapshot(state, makeSnapshot({ muted: true, captureMode: true, transcript: freshLine }))).toBe(state);
    expect(advanceOnSnapshot(state, makeSnapshot({ muted: false, captureMode: false, transcript: freshLine }))).toBe(state);
    expect(advanceOnSnapshot(state, makeSnapshot({ muted: false, captureMode: undefined, transcript: freshLine }))).toBe(state);
    // Unmuted + capturing but SILENT (no post-watermark line): not recorded yet.
    expect(advanceOnSnapshot(state, recordingRoom())).toBe(state);
    const advanced = advanceOnSnapshot(state, spokenRoom());
    expect(advanced.step).toBe("idea");
  });

  test("40 pre-existing transcript turns do NOT advance record — a NEW turn does", () => {
    const history = Array.from({ length: 40 }, (_, i) => turn(`00:${i}`, `old line ${i}`));
    // The whole history exists BEFORE the demo enters (and the room was even
    // left unmuted + capturing): the record step must not consider the room
    // "recorded" off that session history.
    let state = startGuided(recordingRoom({ transcript: history }));
    for (let i = 0; i < PRACTICE_ORB_COUNT; i += 1) {
      state = popPracticeOrb(state);
    }
    expect(state.step).toBe("record");
    expect(advanceOnSnapshot(state, recordingRoom({ transcript: history }))).toBe(state);

    const withNewTurn = recordingRoom({ transcript: [...history, turn("01:00", "a brand new idea")] });
    const advanced = advanceOnSnapshot(state, withNewTurn);
    expect(advanced.step).toBe("idea");
  });

  test("speech during ORIENTATION slides the watermark — record measures from its own entry", () => {
    // The demo may auto-enter off an empty placeholder snapshot; lines that
    // land while the visitor is still popping orbs are NOT record-step speech.
    let state = startGuided(makeSnapshot());
    const duringOrientation = recordingRoom({ transcript: [turn("00:01", "chatter while practicing")] });
    state = advanceOnSnapshot(state, duringOrientation);
    expect(state.step).toBe("orientation");
    for (let i = 0; i < PRACTICE_ORB_COUNT; i += 1) {
      state = popPracticeOrb(state);
    }
    expect(state.step).toBe("record");
    expect(advanceOnSnapshot(state, duringOrientation)).toBe(state);

    const newSpeech = recordingRoom({
      transcript: [turn("00:01", "chatter while practicing"), turn("00:02", "now I am recording")],
    });
    expect(advanceOnSnapshot(state, newSpeech).step).toBe("idea");
  });

  test("the room's own voice and process output are NOT visitor speech", () => {
    const state = atRecord();
    const notSpeech = recordingRoom({
      transcript: [turn("00:01", "Routed to Atlas.", "vibersyn"), turn("00:02", "build log line", "process")],
    });
    expect(advanceOnSnapshot(state, notSpeech)).toBe(state);
    const spoken = recordingRoom({ transcript: [...notSpeech.transcript, turn("00:03", "a human idea")] });
    expect(advanceOnSnapshot(state, spoken).step).toBe("idea");
  });

  test("advancing re-captures the process baseline at that moment", () => {
    const state = atRecord();
    const advanced = advanceOnSnapshot(
      state,
      spokenRoom({ processes: [makeProcess("upid_pre")] }),
    );
    expect(advanced.step).toBe("idea");
    expect(advanced.baselineUpids).toEqual(["upid_pre"]);
  });
});

describe("guided demo — idea step (real detection → spawn)", () => {
  const atIdea = (baseline: string[] = []) => {
    const start = makeSnapshot({ processes: baseline.map((upid) => makeProcess(upid)) });
    let state = startGuided(start);
    for (let i = 0; i < PRACTICE_ORB_COUNT; i += 1) {
      state = popPracticeOrb(state);
    }
    return advanceOnSnapshot(state, spokenRoom({ processes: start.processes }));
  };

  test("a NEW process does NOT auto-advance — only the visitor's Done/Skip does", () => {
    const state = atIdea(["upid_old"]);
    // The room built something in the background: the coach stays put.
    const withNewcomer = recordingRoom({ processes: [makeProcess("upid_old"), makeProcess("upid_new")] });
    expect(advanceOnSnapshot(state, withNewcomer)).toBe(state);

    // The visitor's own Done (routed through skipStep) advances, and the race
    // adopts the newborn process as its focus.
    const advanced = skipStep(state, withNewcomer);
    expect(advanced?.step).toBe("race");
    expect(advanced?.focusUpid).toBe("upid_new");
  });

  test("Done with an ALREADY-ready mock falls straight through to decide (no-clock legacy path)", () => {
    const state = atIdea([]);
    const readyProc = makeProcess("upid_fast", { builds: [build("native", "ready")] });
    const advanced = skipStep(state, recordingRoom({ processes: [readyProc] }));
    expect(advanced?.step).toBe("decide");
    expect(advanced?.readyBackend).toBe("native");
  });
});

describe("guided demo — idea/speech watermarks (session history is not the visitor's)", () => {
  // A demo entered over a room with real session history: old transcript
  // lines, an already-detected idea, and its armed build countdown.
  const history = [turn("09:00", "old meeting chatter"), turn("09:01", "more old chatter")];
  const preDemo = recordingRoom({
    transcript: history,
    ideas: [idea("idea_pre", "an idea from before the demo")],
    ideaSettle: { armed: true, title: "an idea from before the demo", firesInMs: 5_000 },
  });
  const atIdeaOverHistory = () => {
    let state = startGuided(preDemo);
    for (let i = 0; i < PRACTICE_ORB_COUNT; i += 1) {
      state = popPracticeOrb(state);
    }
    return advanceOnSnapshot(
      state,
      recordingRoom({ ...preDemo, transcript: [...history, turn("09:05", "my new spoken idea")] }),
    );
  };

  test("freshTranscript surfaces ONLY post-watermark lines (the idea step's transcript view)", () => {
    const state = atIdeaOverHistory();
    expect(state.step).toBe("idea");
    const now = recordingRoom({ ...preDemo, transcript: [...history, turn("09:05", "my new spoken idea")] });
    expect(freshTranscript(state, now).map((line) => line.text)).toEqual(["my new spoken idea"]);
    // Even when old lines dominate the window, none of them leak through.
    expect(freshTranscript(state, preDemo)).toEqual([]);
  });

  test("pre-demo ideas are ignored; a post-watermark idea surfaces", () => {
    const state = atIdeaOverHistory();
    expect(freshIdeas(state, preDemo)).toEqual([]);

    const withNewIdea = recordingRoom({
      ...preDemo,
      ideas: [idea("idea_pre", "an idea from before the demo"), idea("idea_live", "the visitor's own idea")],
    });
    expect(freshIdeas(state, withNewIdea).map((item) => item.id)).toEqual(["idea_live"]);
  });

  test("the settle countdown armed BEFORE the demo is hidden; a fresh arm shows", () => {
    const state = atIdeaOverHistory();
    // Still the pre-demo idea counting down: not the visitor's — hidden.
    expect(guidedSettle(state, preDemo)).toBeNull();

    // A different title = a new detection: shown.
    const rearmed = recordingRoom({
      ...preDemo,
      ideaSettle: { armed: true, title: "the visitor's own idea", firesInMs: 5_000 },
    });
    expect(guidedSettle(state, rearmed)?.title).toBe("the visitor's own idea");

    // Same title but a post-watermark tray idea backs it: shown (re-detected).
    const rebacked = recordingRoom({
      ...preDemo,
      ideas: [...(preDemo.ideas ?? []), idea("idea_live")],
    });
    expect(guidedSettle(state, rebacked)?.title).toBe("an idea from before the demo");

    // Disarmed: nothing to show.
    expect(guidedSettle(state, recordingRoom({ ...preDemo, ideaSettle: { armed: false, title: null, firesInMs: null } }))).toBeNull();
  });

  test("a legacy feed without an idea tray still shows a countdown armed AFTER entry", () => {
    // No `ideas` field at all (older server): the demo entered with nothing
    // armed, so a later arm is necessarily fresh.
    const legacyQuiet = recordingRoom({ ideas: undefined, ideaSettle: undefined });
    let state = startGuided(legacyQuiet);
    for (let i = 0; i < PRACTICE_ORB_COUNT; i += 1) {
      state = popPracticeOrb(state);
    }
    state = advanceOnSnapshot(state, recordingRoom({ ideas: undefined, transcript: [turn("00:01", "an idea")] }));
    expect(state.step).toBe("idea");
    const armedLater = recordingRoom({
      ideas: undefined,
      ideaSettle: { armed: true, title: "heard just now", firesInMs: 3_000 },
    });
    expect(guidedSettle(state, armedLater)?.title).toBe("heard just now");
  });
});

describe("guided demo — race step (three MOCK lanes)", () => {
  const atRace = () => {
    const state = skipStep(
      atIdeaState(),
      recordingRoom({ processes: [makeProcess("upid_demo")] }),
    )!;
    expect(state.step).toBe("race");
    return state;
  };
  const atIdeaState = () => {
    let state = startGuided(makeSnapshot());
    for (let i = 0; i < PRACTICE_ORB_COUNT; i += 1) {
      state = popPracticeOrb(state);
    }
    return advanceOnSnapshot(state, spokenRoom());
  };

  test("mocking lanes do NOT advance; the FIRST mock-ready lane does (whichever backend wins)", () => {
    const state = atRace();
    const stillBuilding = recordingRoom({
      processes: [
        makeProcess("upid_demo", {
          builds: [build("smithers", "building", { percent: 40 }), build("eliza", "building"), build("native", "building")],
        }),
      ],
    });
    expect(advanceOnSnapshot(state, stillBuilding)).toBe(state);

    const elizaWins = recordingRoom({
      processes: [
        makeProcess("upid_demo", {
          builds: [build("smithers", "building"), build("eliza", "ready", { slideshowUrl: "http://127.0.0.1:1/deck" }), build("native", "failed")],
        }),
      ],
    });
    const advanced = advanceOnSnapshot(state, elizaWins);
    expect(advanced.step).toBe("decide");
    expect(advanced.readyBackend).toBe("eliza");
  });

  test("failed lanes never advance and never wedge (skip still reaches decide)", () => {
    const state = atRace();
    const allFailed = recordingRoom({
      processes: [
        makeProcess("upid_demo", { builds: [build("smithers", "failed"), build("eliza", "failed")] }),
      ],
    });
    expect(advanceOnSnapshot(state, allFailed)).toBe(state);
    expect(lanesAllFailed(guidedLanes(state, allFailed))).toBe(true);

    const skipped = skipStep(state, allFailed);
    expect(skipped?.step).toBe("decide");
    expect(skipped?.readyBackend).toBeNull();
  });

  test("legacy fallback: no builds[] but process.buildStatus ready advances", () => {
    const state = atRace();
    const legacy = recordingRoom({
      processes: [makeProcess("upid_demo", { buildStatus: "ready" }) as ProjectorProcess],
    });
    const advanced = advanceOnSnapshot(state, legacy);
    expect(advanced.step).toBe("decide");
    expect(advanced.readyBackend).toBe("build");
  });

  test("a PRE-DEMO process going ready never advances the race (only a post-watermark newcomer)", () => {
    // upid_old exists before the demo enters — even its mock turning ready
    // must not be adopted or advance race/decide.
    const preExisting = makeProcess("upid_old", { builds: [build("smithers", "ready", { slideshowUrl: "http://x/d" })] });
    let state = startGuided(makeSnapshot({ processes: [preExisting] }));
    for (let i = 0; i < PRACTICE_ORB_COUNT; i += 1) {
      state = popPracticeOrb(state);
    }
    state = advanceOnSnapshot(state, spokenRoom({ processes: [preExisting] }));
    expect(state.step).toBe("idea");
    const race = skipStep(state, recordingRoom({ processes: [preExisting] }))!;
    expect(race.step).toBe("race");
    expect(race.focusUpid).toBeNull();

    // The pre-existing ready process is history: the race holds.
    expect(advanceOnSnapshot(race, recordingRoom({ processes: [preExisting] }))).toBe(race);

    // A genuine newcomer (born after the watermark) is adopted and races.
    const newcomer = makeProcess("upid_new", { builds: [build("eliza", "ready")] });
    const advanced = advanceOnSnapshot(race, recordingRoom({ processes: [preExisting, newcomer] }));
    expect(advanced.focusUpid).toBe("upid_new");
    expect(advanced.step).toBe("decide");
    expect(advanced.readyBackend).toBe("eliza");
  });

  test("a race step with no focus (skipped idea) adopts the first newcomer", () => {
    const skippedToDecide = skipStep(skipStep(atIdeaState(), recordingRoom())!, recordingRoom());
    // atIdeaState is already "idea": one skip → race (focus null).
    const state = skipStep(atIdeaState(), recordingRoom())!;
    expect(state.step).toBe("race");
    expect(state.focusUpid).toBeNull();
    expect(skippedToDecide?.step).toBe("decide");

    const adopted = advanceOnSnapshot(
      state,
      recordingRoom({ processes: [makeProcess("upid_late", { builds: [build("smithers", "building")] })] }),
    );
    expect(adopted.step).toBe("race");
    expect(adopted.focusUpid).toBe("upid_late");
  });
});

describe("guided demo — lanes derivation", () => {
  const stateAtRace = (focusUpid: string | null) => ({
    step: "race" as const,
    orbsPopped: PRACTICE_ORB_COUNT,
    baselineUpids: [] as string[],
    baselineTurnKeys: [] as string[],
    baselineIdeaIds: [] as string[],
    baselineSettleTitle: null,
    focusUpid,
    readyBackend: null,
  });

  test("one lane per ENABLED backend, queued until its builds[] entry exists", () => {
    const snapshot = recordingRoom({
      backends: [
        { id: "smithers", label: "Smithers", enabled: true, available: true },
        { id: "eliza", label: "ElizaOS", enabled: true, available: true },
        { id: "native", label: "Native", enabled: false, available: true },
      ],
      processes: [
        makeProcess("upid_demo", {
          builds: [build("smithers", "building", { percent: 62, progressLabel: "scaffolding" })],
        }),
      ],
    });
    const lanes = guidedLanes(stateAtRace("upid_demo"), snapshot);
    expect(lanes.map((lane) => lane.id)).toEqual(["smithers", "eliza"]);
    expect(lanes[0]).toMatchObject({ label: "Smithers", status: "building", percent: 62, progressLabel: "scaffolding" });
    expect(lanes[1]).toMatchObject({ label: "ElizaOS", status: "queued" });
  });

  test("a build from a backend missing in the roster still gets a lane", () => {
    const snapshot = recordingRoom({
      backends: [{ id: "smithers", label: "Smithers", enabled: true, available: true }],
      processes: [makeProcess("upid_demo", { builds: [build("native", "ready", { slideshowUrl: "http://x/d" })] })],
    });
    const lanes = guidedLanes(stateAtRace("upid_demo"), snapshot);
    expect(lanes.map((lane) => lane.id)).toEqual(["smithers", "native"]);
    expect(lanes[1]).toMatchObject({ label: "Native · homebrewed", status: "ready", hasDeck: true });
  });

  test("no roster + no builds: the legacy buildStatus becomes the single lane", () => {
    const snapshot = recordingRoom({
      processes: [makeProcess("upid_demo", { buildStatus: "building", progressLabel: "compiling", progress: 33 })],
    });
    const lanes = guidedLanes(stateAtRace("upid_demo"), snapshot);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]).toMatchObject({ id: "build", status: "building", progressLabel: "compiling", percent: 33 });
  });

  test("no focus process yields roster lanes all queued", () => {
    const snapshot = recordingRoom({
      backends: [
        { id: "smithers", label: "Smithers", enabled: true, available: true },
        { id: "eliza", label: "ElizaOS", enabled: true, available: true },
      ],
    });
    const lanes = guidedLanes(stateAtRace(null), snapshot);
    expect(lanes.every((lane) => lane.status === "queued")).toBe(true);
    expect(lanes).toHaveLength(2);
  });
});

describe("guided demo — skip, finish, re-enter", () => {
  test("skip walks every step in order and finishing decide returns null (demo done)", () => {
    // The walk crosses the race via its never-wedge escape: a skipped-through
    // run has NO focus process (nothing is building), so raceSkippable stays
    // true — a race with real mocks building refuses the skip (locked below).
    const snapshot = makeSnapshot();
    let state: ReturnType<typeof startGuided> | null = startGuided(snapshot);
    const walked: string[] = [state.step];
    while (state !== null) {
      state = skipStep(state, snapshot);
      if (state !== null) {
        walked.push(state.step);
      }
    }
    expect(walked).toEqual(["orientation", "record", "idea", "race", "decide"]);
  });

  test("a hands-live run walks SIX steps: the camera coaching slots before record", () => {
    const snapshot = makeSnapshot();
    let state: ReturnType<typeof startGuided> | null = startGuided(snapshot, { handsLive: true });
    const walked: string[] = [state.step];
    while (state !== null) {
      state = skipStep(state, snapshot);
      if (state !== null) {
        walked.push(state.step);
      }
    }
    expect(walked).toEqual(["orientation", "hands", "record", "idea", "race", "decide"]);
  });

  test("skipping record still re-baselines so a later spawn is detected", () => {
    const start = startGuided(makeSnapshot());
    const preExisting = recordingRoom({ processes: [makeProcess("upid_pre")] });
    // A recording room skips the record step entirely: the orientation skip
    // lands straight on idea, baseline captured at the jump.
    const atIdea = skipStep(start, preExisting)!;
    expect(atIdea.step).toBe("idea");
    expect(atIdea.baselineUpids).toEqual(["upid_pre"]);
    // The idea step never auto-advances; the visitor's Done/Skip must adopt
    // only the genuine newcomer (upid_pre is baseline).
    expect(advanceOnSnapshot(atIdea, preExisting)).toBe(atIdea);
    const advanced = skipStep(
      atIdea,
      recordingRoom({ processes: [makeProcess("upid_pre"), makeProcess("upid_new")] }),
    );
    expect(advanced?.focusUpid).toBe("upid_new");
  });

  test("re-entering starts a FRESH run: step 1, zero orbs, new baseline", () => {
    // First run reaches the race…
    let state = startGuided(makeSnapshot());
    for (let i = 0; i < PRACTICE_ORB_COUNT; i += 1) {
      state = popPracticeOrb(state);
    }
    const withProc = spokenRoom({ processes: [makeProcess("upid_first")] });
    state = skipStep(advanceOnSnapshot(state, spokenRoom()), withProc)!;
    expect(state.step).toBe("race");

    // …then re-entry resets everything and treats upid_first as pre-existing.
    const again = startGuided(withProc);
    expect(again.step).toBe("orientation");
    expect(again.orbsPopped).toBe(0);
    expect(again.focusUpid).toBeNull();
    expect(again.baselineUpids).toEqual(["upid_first"]);
  });

  test("re-entering RE-WATERMARKS: the first run's speech and ideas are the next run's history", () => {
    // Everything the first run produced — its spoken line, its detected idea —
    // is on the wall when the demo is entered AGAIN.
    const afterFirstRun = recordingRoom({
      transcript: [turn("00:00:01", "hello room, new idea")],
      ideas: [idea("idea_from_run1")],
      ideaSettle: { armed: true, title: "the first visitor's idea", firesInMs: 4_000 },
    });
    let again = startGuided(afterFirstRun);
    for (let i = 0; i < PRACTICE_ORB_COUNT; i += 1) {
      again = popPracticeOrb(again);
    }
    expect(again.step).toBe("record");
    // The first run's speech no longer counts as fresh…
    expect(advanceOnSnapshot(again, afterFirstRun)).toBe(again);
    // …its idea and armed countdown are history…
    const atIdea = skipStep(again, afterFirstRun)!;
    expect(freshIdeas(atIdea, afterFirstRun)).toEqual([]);
    expect(guidedSettle(atIdea, afterFirstRun)).toBeNull();
    // …and only the SECOND visitor's new turn advances record.
    const secondVisitor = recordingRoom({
      ...afterFirstRun,
      transcript: [...afterFirstRun.transcript, turn("00:09:00", "a different idea entirely")],
    });
    expect(advanceOnSnapshot(again, secondVisitor).step).toBe("idea");
  });
});

describe("guided demo — resilience notices (say it, never wedge)", () => {
  test("emergency stop is surfaced at any step", () => {
    const state = startGuided(makeSnapshot());
    const stopped = makeSnapshot({ emergencyStopTriggered: true });
    expect(guidedNotice(state, stopped)).toContain("EMERGENCY STOP");
  });

  test("a re-muted room is surfaced during the idea/build steps", () => {
    const state = { ...startGuided(makeSnapshot()), step: "idea" as const };
    expect(guidedNotice(state, makeSnapshot({ muted: true }))).toContain("muted");
    expect(guidedNotice(state, recordingRoom())).toBeNull();
  });

  test("replay-mode ASR (no transcription) is surfaced during the idea step", () => {
    const state = { ...startGuided(makeSnapshot()), step: "idea" as const };
    const replay = recordingRoom({ mic: { mode: "replay", active: true, bytesReceived: 100 } });
    expect(guidedNotice(state, replay)).toContain("replay");
    const deepgram = recordingRoom({ mic: { mode: "deepgram", active: true, bytesReceived: 100 } });
    expect(guidedNotice(state, deepgram)).toBeNull();
  });
});

describe("guided demo — race minimum dwell (steps must not fly by)", () => {
  const atIdeaNow = (nowMs: number) => {
    const start = makeSnapshot({ processes: [] });
    let state = startGuided(start);
    for (let i = 0; i < PRACTICE_ORB_COUNT; i += 1) {
      state = popPracticeOrb(state);
    }
    return advanceOnSnapshot(state, spokenRoom({ processes: start.processes }), nowMs);
  };

  test("an instantly-ready mock HOLDS the race for RACE_MIN_DWELL_MS, then advances", () => {
    const t0 = 1_000_000;
    const state = atIdeaNow(t0);
    const readySnap = recordingRoom({
      processes: [makeProcess("upid_fast", { builds: [build("native", "ready")] })],
    });

    // The visitor hits Done: the race opens but must NOT cascade to decide.
    const entered = skipStep(state, readySnap, t0)!;
    expect(entered.step).toBe("race");
    expect(entered.focusUpid).toBe("upid_fast");

    // Mid-dwell ticks keep holding.
    const held = advanceOnSnapshot(entered, readySnap, t0 + RACE_MIN_DWELL_MS - 1);
    expect(held.step).toBe("race");

    // Dwell elapsed: the race releases to decide with the winning backend.
    const decided = advanceOnSnapshot(held, readySnap, t0 + RACE_MIN_DWELL_MS);
    expect(decided.step).toBe("decide");
    expect(decided.readyBackend).toBe("native");
  });

  test("skipping FROM the race is REFUSED while a mock is coming — the dwell releases it", () => {
    const t0 = 2_000_000;
    const readySnap = recordingRoom({
      processes: [makeProcess("upid_fast", { builds: [build("native", "ready")] })],
    });
    const entered = skipStep(atIdeaNow(t0), readySnap, t0)!;
    expect(entered.step).toBe("race");
    // A real kickoff with a mock on the way (here: already ready, held by the
    // min dwell) cannot be skipped — identity return, the machine enforces it.
    expect(skipStep(entered, readySnap, t0 + 1)).toBe(entered);
    // The step's only forward path is its own release once the dwell elapses.
    const decided = advanceOnSnapshot(entered, readySnap, t0 + RACE_MIN_DWELL_MS);
    expect(decided.step).toBe("decide");
    expect(decided.readyBackend).toBe("native");
  });

  test("legacy no-clock callers keep the immediate cascade (no dwell enforced)", () => {
    const state = atIdeaNow(3_000_000);
    const readySnap = recordingRoom({
      processes: [makeProcess("upid_fast", { builds: [build("native", "ready")] })],
    });
    // no nowMs anywhere in the chain — dwell must not apply
    const advanced = skipStep(state, readySnap);
    expect(advanced?.step).toBe("decide");
  });
});

describe("guided demo — the record step is skipped when the room already records", () => {
  test("orb completion on a recording room jumps straight to idea (watermarked + re-baselined)", () => {
    const snapshot = recordingRoom({
      processes: [makeProcess("upid_pre")],
      transcript: [turn("00:00:01", "hours of earlier session chatter")],
    });
    let state = startGuided(makeSnapshot());
    for (let i = 0; i < PRACTICE_ORB_COUNT - 1; i += 1) {
      state = popPracticeOrb(state, snapshot, 5);
      expect(state.step).toBe("orientation");
    }
    const atIdea = popPracticeOrb(state, snapshot, 5);
    expect(atIdea.step).toBe("idea");
    // Baseline captured AT the jump: the pre-existing process must never read
    // as this demo's newcomer, and earlier speech sits behind the watermark.
    expect(atIdea.baselineUpids).toEqual(["upid_pre"]);
    expect(freshTranscript(atIdea, snapshot)).toHaveLength(0);
  });

  test("orb completion on a muted room still lands on the record step", () => {
    let state = startGuided(makeSnapshot());
    for (let i = 0; i < PRACTICE_ORB_COUNT; i += 1) {
      state = popPracticeOrb(state, makeSnapshot({ muted: true }), 5);
    }
    expect(state.step).toBe("record");
  });

  test("legacy call without a snapshot keeps the record step (no behavior change)", () => {
    let state = startGuided(makeSnapshot());
    for (let i = 0; i < PRACTICE_ORB_COUNT; i += 1) {
      state = popPracticeOrb(state);
    }
    expect(state.step).toBe("record");
  });
});

describe("guided demo — the race refuses skips while mocks build (raceSkippable)", () => {
  const raceState = (focusUpid: string | null) => ({
    step: "race" as const,
    orbsPopped: PRACTICE_ORB_COUNT,
    baselineUpids: [] as string[],
    baselineTurnKeys: [] as string[],
    baselineIdeaIds: [] as string[],
    baselineSettleTitle: null,
    focusUpid,
    readyBackend: null,
  });

  test("building lanes → NOT skippable; skipStep is an identity refusal", () => {
    const building = recordingRoom({
      processes: [
        makeProcess("upid_demo", {
          builds: [build("smithers", "building", { percent: 40 }), build("eliza", "building")],
        }),
      ],
    });
    const state = raceState("upid_demo");
    expect(raceSkippable(state, building)).toBe(false);
    expect(skipStep(state, building)).toBe(state);
  });

  test("a mix with one lane still building is NOT skippable (a mock is coming)", () => {
    const mixed = recordingRoom({
      processes: [
        makeProcess("upid_demo", { builds: [build("smithers", "failed"), build("eliza", "building")] }),
      ],
    });
    expect(raceSkippable(raceState("upid_demo"), mixed)).toBe(false);
  });

  test("EVERY lane failed → skippable (nothing will ever turn ready; never wedge)", () => {
    const allFailed = recordingRoom({
      processes: [
        makeProcess("upid_demo", { builds: [build("smithers", "failed"), build("eliza", "failed")] }),
      ],
    });
    const state = raceState("upid_demo");
    expect(raceSkippable(state, allFailed)).toBe(true);
    expect(skipStep(state, allFailed)?.step).toBe("decide");
  });

  test("no focus process (skipped-through run) → skippable (never wedge)", () => {
    const state = raceState(null);
    expect(raceSkippable(state, recordingRoom())).toBe(true);
    expect(skipStep(state, recordingRoom())?.step).toBe("decide");
  });
});

describe("guided demo — hands step (enlists only when the rig is live)", () => {
  test("the step order and count key on handsLive", () => {
    expect(guidedStepOrder(false)).toEqual(["orientation", "record", "idea", "race", "decide"]);
    expect(guidedStepOrder(true)).toEqual(["orientation", "hands", "record", "idea", "race", "decide"]);
    expect(stepCount(false)).toBe(5);
    expect(stepCount(true)).toBe(6);
    expect(stepNumber("record", false)).toBe(2);
    expect(stepNumber("record", true)).toBe(3);
    // A "hands" step can only exist in a hands-live run — it numbers against
    // that order even if a caller forgets the flag.
    expect(stepNumber("hands")).toBe(2);
  });

  test("orb completion routes orientation → hands when live, and hands → record on Continue", () => {
    let state = startGuided(makeSnapshot(), { handsLive: true });
    for (let i = 0; i < PRACTICE_ORB_COUNT; i += 1) {
      state = popPracticeOrb(state, makeSnapshot(), 5);
    }
    expect(state.step).toBe("hands");
    // The Continue button routes through skipStep: coaching done, on to record.
    const atRecord = skipStep(state, makeSnapshot(), 6)!;
    expect(atRecord.step).toBe("record");
  });

  test("hands takes priority over an already-recording room; the jump happens on its exit", () => {
    const recording = recordingRoom({
      processes: [makeProcess("upid_pre")],
      transcript: [turn("00:00:01", "earlier chatter")],
    });
    let state = startGuided(makeSnapshot(), { handsLive: true });
    for (let i = 0; i < PRACTICE_ORB_COUNT; i += 1) {
      state = popPracticeOrb(state, recording, 5);
    }
    expect(state.step).toBe("hands");
    // Continue over the recording room: record's button would be a no-op, so
    // the hands exit jumps straight to idea — watermarked + re-baselined.
    const atIdea = skipStep(state, recording, 6)!;
    expect(atIdea.step).toBe("idea");
    expect(atIdea.baselineUpids).toEqual(["upid_pre"]);
    expect(freshTranscript(atIdea, recording)).toHaveLength(0);
  });

  test("speech during the hands step keeps sliding the watermarks (record measures from ITS entry)", () => {
    let state = startGuided(makeSnapshot(), { handsLive: true });
    for (let i = 0; i < PRACTICE_ORB_COUNT; i += 1) {
      state = popPracticeOrb(state, makeSnapshot(), 5);
    }
    expect(state.step).toBe("hands");
    const chatter = recordingRoom({ transcript: [turn("00:01", "chatter while flying the camera")] });
    state = advanceOnSnapshot(state, chatter);
    expect(state.step).toBe("hands");
    const atRecord = skipStep(state, makeSnapshot({ transcript: chatter.transcript, muted: true }), 6)!;
    expect(atRecord.step).toBe("record");
    // The camera-coaching chatter sits behind the watermark…
    expect(advanceOnSnapshot(atRecord, chatter)).toBe(atRecord);
    // …and only NEW speech advances record.
    const fresh = recordingRoom({ transcript: [...chatter.transcript, turn("00:02", "now recording")] });
    expect(advanceOnSnapshot(atRecord, fresh).step).toBe("idea");
  });

  test("orientation skip detours to hands when live", () => {
    const state = startGuided(makeSnapshot(), { handsLive: true });
    expect(skipStep(state, makeSnapshot(), 5)?.step).toBe("hands");
  });

  test("setHandsLive slides ONLY during orientation and is identity-stable", () => {
    const start = startGuided(makeSnapshot());
    expect(start.handsLive).toBe(false);
    // No change → the same object (React setState bails).
    expect(setHandsLive(start, false)).toBe(start);
    const live = setHandsLive(start, true);
    expect(live.handsLive).toBe(true);
    expect(setHandsLive(live, true)).toBe(live);
    // Past orientation the run's shape is settled — no renumbering mid-run.
    const atRecord = skipStep(start, makeSnapshot({ muted: true }), 5)!;
    expect(atRecord.step).toBe("record");
    expect(setHandsLive(atRecord, true)).toBe(atRecord);
  });
});

describe("guided demo — mic-aware record entries (micState is App truth, not snapshot)", () => {
  // muted=false + captureMode OFF + the browser mic streaming: the record
  // button's job is done — both entries into record jump straight to idea.
  const micOnlyRoom = (overrides: Partial<BuildloopSnapshot> = {}) =>
    makeSnapshot({ muted: false, captureMode: false, ...overrides });

  test("orb completion with micLive lands on idea (watermarked + re-baselined)", () => {
    const room = micOnlyRoom({
      processes: [makeProcess("upid_pre")],
      transcript: [turn("00:00:01", "earlier chatter")],
    });
    let state = startGuided(makeSnapshot());
    for (let i = 0; i < PRACTICE_ORB_COUNT; i += 1) {
      state = popPracticeOrb(state, room, 5, true);
    }
    expect(state.step).toBe("idea");
    expect(state.baselineUpids).toEqual(["upid_pre"]);
    expect(freshTranscript(state, room)).toHaveLength(0);
  });

  test("orientation skip with micLive lands on idea too", () => {
    const state = startGuided(makeSnapshot());
    const skipped = skipStep(state, micOnlyRoom({ processes: [makeProcess("upid_pre")] }), 5, true)!;
    expect(skipped.step).toBe("idea");
    expect(skipped.baselineUpids).toEqual(["upid_pre"]);
  });

  test("micLive over a MUTED room still lands on the record step (unmute is real work)", () => {
    let state = startGuided(makeSnapshot());
    for (let i = 0; i < PRACTICE_ORB_COUNT; i += 1) {
      state = popPracticeOrb(state, makeSnapshot({ muted: true }), 5, true);
    }
    expect(state.step).toBe("record");
    expect(skipStep(startGuided(makeSnapshot()), makeSnapshot({ muted: true }), 5, true)?.step).toBe("record");
  });

  test("micLive=false keeps today's behavior byte-identical (captureMode decides)", () => {
    let state = startGuided(makeSnapshot());
    for (let i = 0; i < PRACTICE_ORB_COUNT; i += 1) {
      state = popPracticeOrb(state, micOnlyRoom(), 5, false);
    }
    expect(state.step).toBe("record");
  });
});

describe("guided demo — start over (restartIdea re-watermarks the idea step)", () => {
  const feed = () =>
    recordingRoom({
      processes: [makeProcess("upid_pre")],
      transcript: [turn("00:00:01", "hello room, new idea"), turn("00:00:05", "and some more of it")],
      ideas: [idea("idea_mid", "the half-described idea")],
      ideaSettle: { armed: true, title: "the half-described idea", firesInMs: 5_000 },
    });
  const atIdeaMidDescription = () => {
    let state = startGuided(makeSnapshot());
    for (let i = 0; i < PRACTICE_ORB_COUNT; i += 1) {
      state = popPracticeOrb(state);
    }
    state = advanceOnSnapshot(state, spokenRoom());
    expect(state.step).toBe("idea");
    return state;
  };

  test("after restart the SAME feed reads empty: no fresh transcript/ideas, no settle", () => {
    const state = atIdeaMidDescription();
    const room = feed();
    // Mid-description the visitor's words and the armed countdown are visible…
    expect(freshTranscript(state, room).length).toBeGreaterThan(0);
    expect(guidedSettle(state, room)).not.toBeNull();

    const restarted = restartIdea(state, room, 9_000);
    expect(restarted.step).toBe("idea");
    expect(restarted.enteredAtMs).toBe(9_000);
    // …and after Start over the exact same feed is history, not the visitor's.
    expect(freshTranscript(restarted, room)).toEqual([]);
    expect(freshIdeas(restarted, room)).toEqual([]);
    expect(guidedSettle(restarted, room)).toBeNull();
    // The process baseline re-captures too: upid_pre is no longer a newcomer.
    expect(restarted.baselineUpids).toEqual(["upid_pre"]);
    // NEW speech after the restart counts again.
    const later = recordingRoom({ ...feed(), transcript: [...room.transcript, turn("00:01:00", "a fresh take")] });
    expect(freshTranscript(restarted, later).map((line) => line.text)).toEqual(["a fresh take"]);
  });

  test("restartIdea is an identity no-op on every other step", () => {
    const orientation = startGuided(makeSnapshot());
    expect(restartIdea(orientation, feed())).toBe(orientation);
    const race = { ...orientation, step: "race" as const };
    expect(restartIdea(race, feed())).toBe(race);
  });
});

describe("guided demo — rig-true + honest-verb copy contracts", () => {
  test("stepTitle keys the orientation on the REAL pointer rig", () => {
    expect(stepTitle("orientation", "hand")).toBe("Point with your hand");
    expect(stepTitle("orientation", "stick")).toBe("Steer with the joystick");
    expect(stepTitle("orientation", "mouse")).toBe("Point and hold");
    expect(stepTitle("hands", "hand")).toBe("Fly the camera with your hands");
    expect(stepTitle("record", "stick")).toBe("Start the room recording");
    expect(stepTitle("idea", "mouse")).toBe("Describe your idea");
    expect(stepTitle("race", "hand")).toBe("Watch the concepts race");
    expect(stepTitle("decide", "hand")).toBe("How should we continue?");
  });

  test("orientationCopy speaks the input actually in the visitor's hand", () => {
    expect(orientationCopy("hand").lede).toBe(
      "Open your hand and point at the wall. Whatever you aim at grows and glows — hold still and a ring fills around it. When the ring completes, that's your click.",
    );
    expect(orientationCopy("hand").practice).toBe(
      "Practice: pop the 3 floating orbs. Point at one, hold until the ring closes.",
    );
    expect(orientationCopy("stick").lede).toBe(
      "Steer with the joystick lever to move the cursor. Whatever it rests on grows and glows — hold a button and a ring fills around it. When the ring completes, that's your click.",
    );
    expect(orientationCopy("stick").practice).toBe(
      "Practice: pop the 3 floating orbs. Steer onto one, hold a button until the ring closes.",
    );
    expect(orientationCopy("mouse").lede).toBe(
      "Move the mouse to aim. Whatever the cursor rests on grows and glows — hold still (or click) and a ring fills around it. When the ring completes, that's your click.",
    );
    expect(orientationCopy("mouse").practice).toBe(
      "Practice: pop the 3 floating orbs. Rest the cursor on one until the ring closes, or just click.",
    );
  });

  test("recordCopy rewrites the imperative per rig, mechanics identical", () => {
    expect(recordCopy("hand")).toStartWith("Point at the big Start Recording button and hold.");
    expect(recordCopy("stick")).toStartWith("Steer onto the big Start Recording button and hold a button.");
    expect(recordCopy("mouse")).toStartWith("Press the big Start Recording button.");
    for (const rig of ["hand", "stick", "mouse"] as const) {
      expect(recordCopy(rig)).toEndWith(
        "It really unmutes the room, turns on Idea Capture and Auto-Build, and starts the microphone — from here on, the room is listening.",
      );
    }
  });

  test("skipCopy says what skipping does at every step (nothing underneath changes)", () => {
    expect(skipCopy("orientation").label).toBe("Skip practice ▸");
    expect(skipCopy("orientation").title).toContain("moves toward recording");
    expect(skipCopy("orientation", true).title).toContain("hand-camera step");
    expect(skipCopy("hands").label).toBe("Skip ▸ — hands stay live");
    expect(skipCopy("record").label).toBe("Skip ▸ — mic stays as it is");
    expect(skipCopy("record").title).toContain("left exactly as they are");
    expect(skipCopy("idea").label).toBe("Skip ▸ — nothing builds");
    expect(skipCopy("idea").title).toContain("nothing new starts building");
    // The race's skip exists only for the never-wedge escapes.
    expect(skipCopy("race").label).toBe("Continue without a mock ▸");
    expect(skipCopy("race").title).toContain("abandons nothing");
  });

  test("exitCopy SAYS the build truth: leaving never stops anything", () => {
    expect(exitCopy("race").label).toBe("✕ Leave the guide");
    expect(exitCopy("race").subtitle).toBe(
      "Leaving never stops the mocks — they keep building and the tree stays in the garden.",
    );
    expect(exitCopy("idea").subtitle).toBe("Leaving re-enables auto-build and the room keeps listening.");
    for (const step of ["orientation", "hands", "record", "decide"] as const) {
      expect(exitCopy(step).subtitle).toBe("The room keeps working; nothing running is stopped.");
    }
  });

  test("the finalize verb is plant language with honest mechanics", () => {
    expect(PLANT_COPY.label).toBe("🌱 Plant this idea");
    expect(PLANT_COPY.subtitle).toBe(
      "Plants what you described in the garden — the concept mocks start racing and a real tree grows.",
    );
  });
});
