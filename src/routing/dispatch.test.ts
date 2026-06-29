import { describe, expect, test } from "bun:test";
import type { TranscriptObservation } from "../types";
import { assertHandlerCoverage } from "./handlers";
import { DOCUMENTED_COMMANDS, ROUTING_ENV_DEFAULTS, loadRoutingVocabulary } from "./vocabulary";
import { dispatchUtterance, routeKey, toCueDecision, type ActiveProcess, type DispatchDecision } from "./dispatch";

const processes: ActiveProcess[] = [
  { callsign: "Atlas", upid: "upid-atlas", state: "active" },
  { callsign: "Bravo", upid: "upid-bravo", state: "active" },
];

describe("routing dispatch invariants", () => {
  test("priority-ladder resolves mute > panic > stop > steer > suggest > pass deterministically", () => {
    const coOccurring = dispatch("Atlas abort mute stop make it faster", {
      openWindow: openAtlas(),
      suggestionEligible: true,
    });
    const panicBeatsStop = dispatch("Atlas abort stop make it faster", {
      openWindow: openAtlas(),
      suggestionEligible: true,
    });
    const stopBeatsSteer = dispatch("Atlas stop make it faster", {
      openWindow: openAtlas(),
      suggestionEligible: true,
    });
    const steerBeatsSuggest = dispatch("Atlas make it faster", {
      suggestionEligible: true,
    });
    const suggestBeatsPass = dispatch("we should build a compact telemetry panel", {
      suggestionEligible: true,
    });

    expect(coOccurring.commandId).toBe("mute");
    expect(panicBeatsStop.commandId).toBe("panic");
    expect(stopBeatsSteer.commandId).toBe("stop");
    expect(steerBeatsSuggest.commandId).toBe("selectAndSteer");
    expect(routeKey(suggestBeatsPass)).toBe("suggestion");
  });

  test("dispatch-invariant rejects steering verbs with no in-utterance callsign and no open window", () => {
    const decision = dispatch("make it faster", { suggestionEligible: false });

    expect(decision.kind).toBe("pass");
    expect(routeKey(decision)).toBe("pass");
    expect(decision.targetUPID).toBeNull();
    expect(decision.commandId).toBeNull();
    expect(decision.addressed).toBe(false);
    expect(toCueDecision(decision)).toEqual(
      expect.objectContaining({
        kind: "pass",
        addressed: false,
      }),
    );
  });

  test("routing-exclusivity returns exactly one of suggestion, steer:X, or pass", () => {
    const cases = [
      dispatch("Atlas make it faster"),
      dispatch("we should build an index", { suggestionEligible: true }),
      dispatch("ordinary ambient chatter about lunch"),
      dispatch("status"),
      dispatch("pause all"),
      dispatch("yes", { pendingSuggestion: pendingSuggestion() }),
    ];

    for (const decision of cases) {
      const routes = [
        routeKey(decision) === "suggestion",
        routeKey(decision).startsWith("steer:"),
        routeKey(decision) === "pass",
      ].filter(Boolean);
      expect(routes).toHaveLength(1);
    }
  });

  test("one-breath select-and-steer selects the callsign and emits one steer action", () => {
    const decision = dispatch("Atlas, make it faster");

    expect(decision.kind).toBe("action");
    expect(decision.commandId).toBe("selectAndSteer");
    expect(routeKey(decision)).toBe("steer:upid-atlas");
    expect(action(decision)).toEqual(
      expect.objectContaining({
        type: "steer",
        targetUPID: "upid-atlas",
        payload: expect.objectContaining({ instruction: "make it faster" }),
      }),
    );
  });

  test("tier-gating keeps Yes inert outside SUGGESTION_DELIVERY", () => {
    const casualYes = dispatch("yes");
    const pendingYes = dispatch("yes", { pendingSuggestion: pendingSuggestion() });

    expect(casualYes.kind).toBe("pass");
    expect(casualYes.commandId).toBe("accept");
    expect(casualYes.addressed).toBe(true);
    expect(pendingYes.kind).toBe("action");
    expect(action(pendingYes)).toEqual(
      expect.objectContaining({
        type: "spawn",
        targetUPID: null,
        payload: expect.objectContaining({
          suggestionId: "suggestion-001",
          pitch: "Add a status panel",
          answers: ["compact"],
        }),
      }),
    );
  });

  test("determinism replays the same transcript N times to byte-identical decisions", () => {
    const decisions = Array.from({ length: 50 }, () =>
      stripTrace(dispatch("Atlas, pause", { nowMs: 50_000, confidence: 0.99 })),
    );

    for (const decision of decisions) {
      expect(decision).toEqual(decisions[0]);
    }
  });

  test("command-coverage maps every §4.3 row to exactly one handler and no cut setMode handler exists", () => {
    expect(() => assertHandlerCoverage()).not.toThrow();
    expect(DOCUMENTED_COMMANDS.map((command) => command.id).sort()).toEqual([
      "accept",
      "decline",
      "endSteering",
      "mute",
      "panic",
      "pause",
      "pauseAll",
      "resume",
      "selectAndSteer",
      "selectOnly",
      "status",
      "steer",
      "stop",
      "unmute",
      "wake",
    ]);
    expect(DOCUMENTED_COMMANDS.map((command) => command.id)).not.toContain("setMode");
  });

  test("per-process pause and resume route only from callsign or open window, never free-form NL", () => {
    const atlasPause = dispatch("Atlas, pause");
    const bravoResume = dispatch("resume", { openWindow: openBravo() });
    const nlPause = dispatch("pause the second one");

    expect(action(atlasPause)).toEqual(expect.objectContaining({ type: "pause", targetUPID: "upid-atlas" }));
    expect(action(bravoResume)).toEqual(expect.objectContaining({ type: "resume", targetUPID: "upid-bravo" }));
    expect(nlPause.kind).toBe("pass");
    expect(nlPause.commandId).toBe("pause");
    expect(nlPause.targetUPID).toBeNull();
  });

  test("addressed-vs-ambient pass is deterministic: addressed pass gets declined ack, ignored ambient is silent", () => {
    const addressed = dispatch("Viber blargle");
    const ambient = dispatch("routine background chat");

    expect(addressed.kind).toBe("local");
    expect(addressed.addressed).toBe(true);
    expect(addressed.ackKind).toBe("route-declined");
    expect(ambient.kind).toBe("pass");
    expect(ambient.addressed).toBe(false);
    expect(ambient.ackKind).toBe("silent");
    expect(ambient.trace.find((event) => event.event === "route.pass")).toEqual(
      expect.objectContaining({
        meta: expect.objectContaining({ addressed: false, ackKind: "silent" }),
      }),
    );
  });

  test("low-confidence steering is dropped with an addressed ack and never executed", () => {
    const decision = dispatch("Atlas make it blue", { confidence: 0.1 });

    expect(decision.kind).toBe("pass");
    expect(decision.addressed).toBe(true);
    expect(decision.ackKind).toBe("route-declined");
    expect(decision.targetUPID).toBeNull();
  });

  test("word lists and thresholds are env-tunable with documented defaults", () => {
    const defaults = loadRoutingVocabulary({});
    const custom = loadRoutingVocabulary({
      VIBERSYN_WAKE_WORDS: "panwatch,opticon",
      VIBERSYN_STOP_WORDS: "cease",
      VIBERSYN_STEER_IDLE_SECONDS: "13",
      VIBERSYN_STEER_MIN_CONFIDENCE: "0.7",
    });

    expect(ROUTING_ENV_DEFAULTS.VIBERSYN_MUTE_WORDS).toBe("mute");
    expect(ROUTING_ENV_DEFAULTS.VIBERSYN_UNMUTE_WORDS).toBe("unmute");
    expect(defaults.wake).toEqual(["viber"]);
    expect(custom.wake).toEqual(["panwatch", "opticon"]);
    expect(custom.stop).toEqual(["cease"]);
    expect(custom.steerIdleSeconds).toBe(13);
    expect(custom.steerMinConfidence).toBe(0.7);
  });
});

function dispatch(
  text: string,
  overrides: Partial<Parameters<typeof dispatchUtterance>[1]> = {},
): DispatchDecision {
  return dispatchUtterance(observation(text), {
    sessionId: "session-routing",
    activeProcesses: processes,
    nowMs: 25_000,
    confidence: 1,
    ...overrides,
  });
}

function observation(text: string): TranscriptObservation {
  return {
    text,
    isFinal: true,
    speaker: "speaker_0",
    sessionId: "session-routing",
    latencyMs: 10,
    utteranceId: `utt-${text.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "empty"}`,
  };
}

function action(decision: DispatchDecision) {
  if (decision.kind !== "action") {
    throw new Error(`Expected action decision, got ${decision.kind}.`);
  }
  return decision.action;
}

function openAtlas() {
  return { upid: "upid-atlas", callsign: "Atlas", openedAtMs: 1_000, lastActivityMs: 24_000 };
}

function openBravo() {
  return { upid: "upid-bravo", callsign: "Bravo", openedAtMs: 1_000, lastActivityMs: 24_000 };
}

function pendingSuggestion() {
  return {
    suggestionId: "suggestion-001",
    pitch: "Add a status panel",
    mcqs: ["Which density?"],
    answers: ["compact"],
  };
}

function stripTrace(decision: DispatchDecision): Omit<DispatchDecision, "trace"> {
  const { trace: _trace, ...rest } = decision;
  return rest;
}
