import type { AckId } from "../types";
import { loadRoutingVocabulary, matchPhrase, normalizeSpeech, type RoutingVocabulary } from "./vocabulary";

export interface SteeringProcess {
  callsign: string;
  upid: string;
}

export interface SteeringUtterance {
  text: string;
  utteranceId: string;
  correlationId: string;
  sessionId?: string;
  speaker?: string | null;
  confidence?: number;
  nowMs?: number;
}

export interface SteeringWindowState {
  windowId: string;
  targetUPID: string;
  callsign: string;
  openedAtMs: number;
  lastMicActivityAtMs: number;
  lastUtteranceId: string | null;
}

export type SteeringDecision =
  | {
      kind: "routed";
      targetUPID: string;
      callsign: string;
      instruction: string;
      window: SteeringWindowState;
      opened: boolean;
      ackId: Extract<AckId, "route-steer">;
      traceEvents: SteeringTraceEvent[];
    }
  | {
      kind: "closed";
      reason: "done" | "back" | "abort" | "idle";
      closedWindow: SteeringWindowState | null;
      ackId: Extract<AckId, "route-declined"> | null;
      traceEvents: SteeringTraceEvent[];
    }
  | {
      kind: "pass";
      reason: "ambient" | "empty" | "done-without-window" | "low-confidence";
      addressed: boolean;
      ackId: Extract<AckId, "route-declined"> | null;
      window: SteeringWindowState | null;
      traceEvents: SteeringTraceEvent[];
    };

export interface SteeringTraceEvent {
  level: "debug" | "info" | "warn";
  event: string;
  sessionId: string;
  correlationId: string;
  upid?: string;
  meta: Record<string, unknown>;
}

export interface SteeringWindowManagerOptions {
  processes: readonly SteeringProcess[];
  vocabulary?: RoutingVocabulary;
  sessionId?: string;
  clock?: () => number;
}

export class SteeringWindowManager {
  readonly #processes: SteeringProcess[];
  readonly #vocabulary: RoutingVocabulary;
  readonly #sessionId: string;
  readonly #clock: () => number;
  #window: SteeringWindowState | null = null;
  #sequence = 0;

  constructor(options: SteeringWindowManagerOptions) {
    this.#processes = [...options.processes];
    this.#vocabulary = options.vocabulary ?? loadRoutingVocabulary();
    this.#sessionId = options.sessionId ?? "steering-session";
    this.#clock = options.clock ?? (() => Date.now());
  }

  activeWindow(): SteeringWindowState | null {
    return cloneWindow(this.#window);
  }

  ingestUtterance(utterance: SteeringUtterance): SteeringDecision {
    const nowMs = utterance.nowMs ?? this.#clock();
    const text = normalizeSpeech(utterance.text);
    const sessionId = utterance.sessionId ?? this.#sessionId;
    const baseTrace = {
      sessionId,
      correlationId: utterance.correlationId,
    };

    if (text.length === 0) {
      return passDecision("empty", false, null, this.#window, [
        trace(baseTrace, "debug", "route.pass", undefined, {
          reason: "empty",
          utteranceId: utterance.utteranceId,
          ackKind: "silent",
        }),
      ]);
    }

    const abort = matchPhrase(text, this.#vocabulary.panic);
    if (abort !== undefined) {
      const closed = this.#close("abort");
      return {
        kind: "closed",
        reason: "abort",
        closedWindow: closed,
        ackId: closed === null ? null : "route-declined",
        traceEvents: [
          trace(baseTrace, "warn", "steering.window.close", closed?.targetUPID, {
            reason: "abort",
            utteranceId: utterance.utteranceId,
            windowId: closed?.windowId ?? null,
            ackKind: closed === null ? "silent" : "route-declined",
          }),
        ],
      };
    }

    if (this.#window !== null) {
      const done = matchPhrase(text, this.#vocabulary.done);
      if (done !== undefined && text === normalizeSpeech(done)) {
        const reason = normalizeSpeech(done) === "back" ? "back" : "done";
        const closed = this.#close(reason);
        return {
          kind: "closed",
          reason,
          closedWindow: closed,
          ackId: "route-declined",
          traceEvents: [
            trace(baseTrace, "info", "steering.window.close", closed?.targetUPID, {
              reason,
              utteranceId: utterance.utteranceId,
              windowId: closed?.windowId ?? null,
              ackKind: "route-declined",
            }),
          ],
        };
      }
    } else if (matchPhrase(text, this.#vocabulary.done) !== undefined) {
      return passDecision("done-without-window", true, "route-declined", null, [
        trace(baseTrace, "info", "route.pass", undefined, {
          reason: "done-without-window",
          utteranceId: utterance.utteranceId,
          ackKind: "route-declined",
        }),
      ]);
    }

    const callsignMatch = findCallsignAtStart(text, this.#processes);
    const selected = callsignMatch?.process;
    let opened = false;
    let instruction = text;

    if (selected !== undefined) {
      this.#window = {
        windowId: `steer-${selected.upid}-${++this.#sequence}`,
        targetUPID: selected.upid,
        callsign: selected.callsign,
        openedAtMs: nowMs,
        lastMicActivityAtMs: nowMs,
        lastUtteranceId: utterance.utteranceId,
      };
      opened = true;
      instruction = callsignMatch.instruction;
    }

    if (this.#window === null) {
      return passDecision("ambient", false, null, null, [
        trace(baseTrace, "debug", "route.pass", undefined, {
          reason: "ambient",
          utteranceId: utterance.utteranceId,
          ackKind: "silent",
        }),
      ]);
    }

    const window = this.#window;
    window.lastMicActivityAtMs = nowMs;
    window.lastUtteranceId = utterance.utteranceId;

    if ((utterance.confidence ?? 1) < this.#vocabulary.steerMinConfidence) {
      return passDecision("low-confidence", true, "route-declined", window, [
        trace(baseTrace, "warn", "route.pass", window.targetUPID, {
          reason: "low-confidence",
          utteranceId: utterance.utteranceId,
          windowId: window.windowId,
          confidence: utterance.confidence ?? null,
          minConfidence: this.#vocabulary.steerMinConfidence,
          ackKind: "route-declined",
        }),
      ]);
    }

    if (instruction.length === 0) {
      return {
        kind: "pass",
        reason: "ambient",
        addressed: true,
        ackId: "route-declined",
        window: cloneWindow(window),
        traceEvents: [
          trace(baseTrace, "info", "steering.window.open", window.targetUPID, {
            callsign: window.callsign,
            utteranceId: utterance.utteranceId,
            windowId: window.windowId,
            ackKind: "route-declined",
          }),
        ],
      };
    }

    const targetUPID =
      process.env.PANOP_RBG_STEER_WRONG_UPID === "1" ? firstDifferentUPID(this.#processes, window.targetUPID) ?? window.targetUPID : window.targetUPID;
    if (process.env.PANOP_RBG_ONE_BREATH_DROPS_INSTRUCTION === "1" && opened) {
      instruction = "";
    }
    const effectiveInstruction = instruction.trim();
    if (effectiveInstruction.length === 0) {
      return passDecision("empty", true, "route-declined", window, [
        trace(baseTrace, "warn", "route.pass", window.targetUPID, {
          reason: "empty",
          utteranceId: utterance.utteranceId,
          windowId: window.windowId,
          ackKind: "route-declined",
        }),
      ]);
    }

    const windowSnapshot = cloneWindow({ ...window, targetUPID });
    return {
      kind: "routed",
      targetUPID,
      callsign: window.callsign,
      instruction: effectiveInstruction,
      window: windowSnapshot,
      opened,
      ackId: "route-steer",
      traceEvents: [
        ...(opened
          ? [
              trace(baseTrace, "info", "steering.window.open", window.targetUPID, {
                callsign: window.callsign,
                utteranceId: utterance.utteranceId,
                windowId: window.windowId,
              }),
            ]
          : []),
        trace(baseTrace, "info", "route.steer", targetUPID, {
          utteranceId: utterance.utteranceId,
          instruction: effectiveInstruction,
          windowId: window.windowId,
          selectedUPID: window.targetUPID,
          targetUPID,
          ackKind: "route-steer",
        }),
        trace(baseTrace, "info", "ack.emit", targetUPID, {
          ackId: "route-steer",
          route: "steer",
          utteranceId: utterance.utteranceId,
          windowId: window.windowId,
        }),
      ],
    };
  }

  observeMicIdle(input: { nowMs?: number; correlationId: string; sessionId?: string }): SteeringDecision {
    const nowMs = input.nowMs ?? this.#clock();
    const sessionId = input.sessionId ?? this.#sessionId;

    if (this.#window === null) {
      return passDecision("ambient", false, null, null, [
        trace({ sessionId, correlationId: input.correlationId }, "debug", "route.pass", undefined, {
          reason: "idle-without-window",
          ackKind: "silent",
        }),
      ]);
    }

    const elapsedMs = nowMs - this.#window.lastMicActivityAtMs;
    const idleMs = this.#vocabulary.steerIdleSeconds * 1_000;
    if (elapsedMs < idleMs || process.env.PANOP_RBG_STEER_DISABLE_IDLE_TIMER === "1") {
      return passDecision("ambient", false, null, this.#window, [
        trace({ sessionId, correlationId: input.correlationId }, "debug", "steering.window.idle_wait", this.#window.targetUPID, {
          windowId: this.#window.windowId,
          elapsedMs,
          idleMs,
        }),
      ]);
    }

    const closed = this.#close("idle");
    return {
      kind: "closed",
      reason: "idle",
      closedWindow: closed,
      ackId: null,
      traceEvents: [
        trace({ sessionId, correlationId: input.correlationId }, "info", "steering.window.close", closed?.targetUPID, {
          reason: "idle",
          windowId: closed?.windowId ?? null,
          elapsedMs,
          idleMs,
          ackKind: "silent",
        }),
      ],
    };
  }

  #close(_reason: SteeringDecision extends never ? never : "done" | "back" | "abort" | "idle"): SteeringWindowState | null {
    const closed = cloneWindow(this.#window);
    this.#window = null;
    return closed;
  }
}

function findCallsignAtStart(text: string, processes: readonly SteeringProcess[]): { process: SteeringProcess; instruction: string } | null {
  const sorted = [...processes].sort((left, right) => right.callsign.length - left.callsign.length || left.callsign.localeCompare(right.callsign));
  for (const process of sorted) {
    const callsign = normalizeSpeech(process.callsign);
    if (text === callsign) {
      return { process, instruction: "" };
    }
    if (text.startsWith(`${callsign} `)) {
      return { process, instruction: text.slice(callsign.length).trim() };
    }
  }
  return null;
}

function passDecision(
  reason: Extract<SteeringDecision, { kind: "pass" }>["reason"],
  addressed: boolean,
  ackId: Extract<AckId, "route-declined"> | null,
  window: SteeringWindowState | null,
  traceEvents: SteeringTraceEvent[],
): Extract<SteeringDecision, { kind: "pass" }> {
  return {
    kind: "pass",
    reason,
    addressed,
    ackId,
    window: cloneWindow(window),
    traceEvents,
  };
}

function trace(
  ids: { sessionId: string; correlationId: string },
  level: SteeringTraceEvent["level"],
  event: string,
  upid: string | undefined,
  meta: Record<string, unknown>,
): SteeringTraceEvent {
  return {
    level,
    event,
    sessionId: ids.sessionId,
    correlationId: ids.correlationId,
    upid,
    meta,
  };
}

function cloneWindow(window: SteeringWindowState | null): SteeringWindowState | null;
function cloneWindow(window: SteeringWindowState): SteeringWindowState;
function cloneWindow(window: SteeringWindowState | null): SteeringWindowState | null {
  return window === null ? null : { ...window };
}

function firstDifferentUPID(processes: readonly SteeringProcess[], current: string): string | null {
  return processes.find((process) => process.upid !== current)?.upid ?? null;
}
