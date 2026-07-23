import { describe, expect, test } from "bun:test";
import type { ProjectorProcess, ProjectorSnapshot } from "../types";
import type { BuildloopProcess, BuildloopSnapshot, ProcessBuild } from "../buildloop";
import { emptyProjectorSnapshot } from "../demo-data";
import {
  PRACTICE_ORB_COUNT,
  advanceOnSnapshot,
  guidedLanes,
  guidedNotice,
  lanesAllFailed,
  popPracticeOrb,
  skipStep,
  startGuided,
  stepNumber,
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

// A room mid-recording (unmuted + capturing) — the record step's exit state.
const recordingRoom = (overrides: Partial<BuildloopSnapshot> = {}) =>
  makeSnapshot({ muted: false, captureMode: true, ...overrides });

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

  test("advances ONLY when the room is unmuted AND capturing", () => {
    const state = atRecord();
    expect(advanceOnSnapshot(state, makeSnapshot({ muted: true, captureMode: true }))).toBe(state);
    expect(advanceOnSnapshot(state, makeSnapshot({ muted: false, captureMode: false }))).toBe(state);
    expect(advanceOnSnapshot(state, makeSnapshot({ muted: false, captureMode: undefined }))).toBe(state);
    const advanced = advanceOnSnapshot(state, recordingRoom());
    expect(advanced.step).toBe("idea");
  });

  test("advancing re-captures the process baseline at that moment", () => {
    const state = atRecord();
    const advanced = advanceOnSnapshot(
      state,
      recordingRoom({ processes: [makeProcess("upid_pre")] }),
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
    return advanceOnSnapshot(state, recordingRoom({ processes: start.processes }));
  };

  test("a NEW process (not in the baseline) advances to build and becomes the focus", () => {
    const state = atIdea(["upid_old"]);
    const unchanged = advanceOnSnapshot(
      state,
      recordingRoom({ processes: [makeProcess("upid_old")] }),
    );
    expect(unchanged).toBe(state);

    const advanced = advanceOnSnapshot(
      state,
      recordingRoom({ processes: [makeProcess("upid_old"), makeProcess("upid_new")] }),
    );
    expect(advanced.step).toBe("race");
    expect(advanced.focusUpid).toBe("upid_new");
  });

  test("a newcomer whose mock is ALREADY ready falls straight through to decide", () => {
    const state = atIdea([]);
    const readyProc = makeProcess("upid_fast", { builds: [build("native", "ready")] });
    const advanced = advanceOnSnapshot(state, recordingRoom({ processes: [readyProc] }));
    expect(advanced.step).toBe("decide");
    expect(advanced.readyBackend).toBe("native");
  });
});

describe("guided demo — race step (three MOCK lanes)", () => {
  const atRace = () => {
    const state = advanceOnSnapshot(
      atIdeaState(),
      recordingRoom({ processes: [makeProcess("upid_demo")] }),
    );
    expect(state.step).toBe("race");
    return state;
  };
  const atIdeaState = () => {
    let state = startGuided(makeSnapshot());
    for (let i = 0; i < PRACTICE_ORB_COUNT; i += 1) {
      state = popPracticeOrb(state);
    }
    return advanceOnSnapshot(state, recordingRoom());
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

  test("skipping record still re-baselines so a later spawn is detected", () => {
    const start = startGuided(makeSnapshot());
    const preExisting = recordingRoom({ processes: [makeProcess("upid_pre")] });
    const atRecord = skipStep(start, preExisting)!;
    expect(atRecord.step).toBe("record");
    const atIdea = skipStep(atRecord, preExisting)!;
    expect(atIdea.step).toBe("idea");
    expect(atIdea.baselineUpids).toEqual(["upid_pre"]);
    // upid_pre must NOT trigger the idea step; a genuine newcomer must.
    expect(advanceOnSnapshot(atIdea, preExisting)).toBe(atIdea);
    const advanced = advanceOnSnapshot(
      atIdea,
      recordingRoom({ processes: [makeProcess("upid_pre"), makeProcess("upid_new")] }),
    );
    expect(advanced.focusUpid).toBe("upid_new");
  });

  test("re-entering starts a FRESH run: step 1, zero orbs, new baseline", () => {
    // First run reaches the race…
    let state = startGuided(makeSnapshot());
    for (let i = 0; i < PRACTICE_ORB_COUNT; i += 1) {
      state = popPracticeOrb(state);
    }
    const withProc = recordingRoom({ processes: [makeProcess("upid_first")] });
    state = advanceOnSnapshot(advanceOnSnapshot(state, recordingRoom()), withProc);
    expect(state.step).toBe("race");

    // …then re-entry resets everything and treats upid_first as pre-existing.
    const again = startGuided(withProc);
    expect(again.step).toBe("orientation");
    expect(again.orbsPopped).toBe(0);
    expect(again.focusUpid).toBeNull();
    expect(again.baselineUpids).toEqual(["upid_first"]);
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
