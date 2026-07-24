import { TraceProcessor } from "../obs/trace";
import type { CueDecision, DispatchedAction, LogEvent, TranscriptObservation } from "../types";
import { COMMAND_HANDLERS, type HandlerOutput, type LocalEffect } from "./handlers";
import {
  includesPhrase,
  loadRoutingVocabulary,
  matchPhrase,
  normalizeSpeech,
  type DocumentedCommandId,
  type RoutingVocabulary,
} from "./vocabulary";

export type RouteKind = "suggestion" | "steer" | "pass";
export type AckKind = "route-suggestion" | "route-steer" | "route-declined" | "silent" | "state-earcon";
export type PassReason = "ambient" | "near-miss" | "low-confidence" | "dropped" | "rejected-no-target";

export interface ActiveProcess {
  upid: string;
  callsign: string;
  state?: "planning" | "active" | "paused" | "halted" | "running";
  selected?: boolean;
}

export interface SteeringWindow {
  upid: string;
  callsign: string;
  openedAtMs: number;
  lastActivityMs: number;
}

export interface PendingSuggestionState {
  suggestionId: string;
  pitch: string;
  mcqs: readonly string[];
  answers: readonly string[];
}

export interface DispatchContext {
  sessionId: string;
  activeProcesses?: readonly ActiveProcess[];
  openWindow?: SteeringWindow | null;
  pendingSuggestion?: PendingSuggestionState | null;
  suggestionEligible?: boolean;
  nowMs?: number;
  confidence?: number;
  trace?: TraceProcessor;
  vocabulary?: RoutingVocabulary;
}

export type DispatchDecision =
  | BaseDecision & {
      kind: "action";
      route: "suggestion" | "steer" | "pass";
      action: DispatchedAction;
      handlerOutput: HandlerOutput;
    }
  | BaseDecision & {
      kind: "local";
      route: "pass";
      localEffect: LocalEffect;
      handlerOutput: HandlerOutput;
    }
  | BaseDecision & {
      kind: "route";
      route: "suggestion";
    }
  | BaseDecision & {
      kind: "pass";
      route: "pass";
      reason: PassReason;
    };

interface BaseDecision {
  utterance: string;
  utteranceId: string;
  sessionId: string;
  correlationId: string;
  decisionId: string;
  addressed: boolean;
  ackKind: AckKind;
  priority: PriorityName;
  commandId: DocumentedCommandId | null;
  targetUPID: string | null;
  callsign: string | null;
  instruction: string;
  trace: LogEvent[];
}

type PriorityName = "mute" | "panic" | "stop" | "steer" | "suggest" | "pass";

interface Candidate {
  commandId: DocumentedCommandId | null;
  priority: PriorityName;
  addressed: boolean;
  targetUPID: string | null;
  callsign: string | null;
  instruction: string;
  route: RouteKind;
  passReason?: PassReason;
}

const STEERING_VERBS = [
  "add",
  "build",
  "change",
  "create",
  "fix",
  "implement",
  "make",
  "refactor",
  "remove",
  "set",
  "update",
  "use",
] as const;

export function dispatchUtterance(observation: TranscriptObservation, context: DispatchContext): DispatchDecision {
  const vocabulary = context.vocabulary ?? loadRoutingVocabulary();
  const trace = context.trace ?? new TraceProcessor();
  const nowMs = context.nowMs ?? Date.now();
  const correlationId = stableId("corr", observation.sessionId, observation.utteranceId, observation.text);
  const decisionId = stableId("decision", observation.utteranceId, observation.text, String(nowMs));
  const activeProcesses = [...(context.activeProcesses ?? [])].sort((left, right) => left.callsign.localeCompare(right.callsign));
  const candidate = chooseCandidate(observation.text, {
    activeProcesses,
    openWindow: activeWindow(context.openWindow ?? null, nowMs, vocabulary),
    pendingSuggestion: context.pendingSuggestion ?? null,
    suggestionEligible: context.suggestionEligible ?? false,
    confidence: context.confidence ?? 1,
    vocabulary,
  });
  const base = {
    utterance: observation.text,
    utteranceId: observation.utteranceId,
    sessionId: observation.sessionId,
    correlationId: process.env.VIBERSYN_RBG_NONDETERMINISTIC === "1" ? `${correlationId}-${Math.random()}` : correlationId,
    decisionId,
    addressed: candidate.addressed,
    ackKind: ackFor(candidate),
    priority: candidate.priority,
    commandId: candidate.commandId,
    targetUPID: candidate.targetUPID,
    callsign: candidate.callsign,
    instruction: candidate.instruction,
    trace: [] as LogEvent[],
  };

  base.trace.push(
    trace.record({
      event: "command.recognize",
      sessionId: observation.sessionId,
      correlationId: base.correlationId,
      startedAtMs: nowMs,
      endedAtMs: nowMs,
      upid: candidate.targetUPID ?? undefined,
      meta: {
        phrase: observation.text,
        matchedCommand: candidate.commandId,
        distanceScore: 0,
        addressed: candidate.addressed,
      },
    }),
  );

  if (candidate.commandId !== null && candidate.passReason === undefined) {
    const handler = COMMAND_HANDLERS[candidate.commandId];
    if (handler === undefined) {
      throw new Error(`No handler for documented command ${candidate.commandId}.`);
    }
    const output = handler({
      commandId: candidate.commandId,
      correlationId: base.correlationId,
      targetUPID: candidate.targetUPID,
      utterance: observation.text,
      instruction: candidate.instruction,
      pendingSuggestion: context.pendingSuggestion ?? undefined,
      callsign: candidate.callsign,
    });
    const decision = output.kind === "action"
      ? ({
          ...base,
          kind: "action",
          route: candidate.route,
          action: output.action,
          handlerOutput: output,
        } satisfies DispatchDecision)
      : ({
          ...base,
          kind: "local",
          route: "pass",
          localEffect: output.effect,
          handlerOutput: output,
        } satisfies DispatchDecision);
    decision.trace.push(recordRoute(trace, decision, nowMs));
    return decision;
  }

  if (candidate.route === "suggestion") {
    const decision = { ...base, kind: "route", route: "suggestion" } satisfies DispatchDecision;
    decision.trace.push(recordRoute(trace, decision, nowMs));
    return decision;
  }

  const decision = { ...base, kind: "pass", route: "pass", reason: candidate.passReason ?? "ambient" } satisfies DispatchDecision;
  decision.trace.push(recordRoute(trace, decision, nowMs));
  return decision;
}

export function routeKey(decision: DispatchDecision): "suggestion" | `steer:${string}` | "pass" {
  if (decision.route === "suggestion") {
    return "suggestion";
  }
  if (decision.route === "steer" && decision.targetUPID !== null) {
    return `steer:${decision.targetUPID}`;
  }
  return "pass";
}

export function toCueDecision(decision: DispatchDecision): CueDecision {
  if (decision.kind === "action") {
    return {
      kind: "action",
      action: decision.action,
      policy: "routing.dispatch",
      decisionId: decision.decisionId,
      correlationId: decision.correlationId,
      meta: {
        commandId: decision.commandId,
        utteranceId: decision.utteranceId,
        route: routeKey(decision),
        addressed: decision.addressed,
      },
    };
  }

  return {
    kind: "pass",
    addressed: decision.addressed,
    reason: decision.kind === "pass" && decision.reason !== "rejected-no-target" ? decision.reason : "near-miss",
    policy: "routing.dispatch",
    decisionId: decision.decisionId,
    correlationId: decision.correlationId,
    meta: {
      commandId: decision.commandId,
      utteranceId: decision.utteranceId,
      route: routeKey(decision),
      ackKind: decision.ackKind,
    },
  };
}

export function deterministicCompare(left: PriorityName, right: PriorityName): number {
  return priorityRank(left) - priorityRank(right);
}

function chooseCandidate(
  utterance: string,
  context: {
    activeProcesses: readonly ActiveProcess[];
    openWindow: SteeringWindow | null;
    pendingSuggestion: PendingSuggestionState | null;
    suggestionEligible: boolean;
    confidence: number;
    vocabulary: RoutingVocabulary;
  },
): Candidate {
  const candidates = collectCandidates(utterance, context);
  return candidates.sort((left, right) => deterministicCompare(left.priority, right.priority))[0] ?? passCandidate("ambient", false);
}

function collectCandidates(
  utterance: string,
  context: {
    activeProcesses: readonly ActiveProcess[];
    openWindow: SteeringWindow | null;
    pendingSuggestion: PendingSuggestionState | null;
    suggestionEligible: boolean;
    confidence: number;
    vocabulary: RoutingVocabulary;
  },
): Candidate[] {
  const { vocabulary } = context;
  const candidates: Candidate[] = [];
  const addressedByWake = includesPhrase(utterance, vocabulary.wake);
  const callsignMatch = findCallsign(utterance, context.activeProcesses);
  const window = context.openWindow;
  const target = callsignMatch ?? window;
  const focusedTarget = target ?? focusedProcess(context.activeProcesses);
  const instruction = callsignMatch === null ? normalizeSpeech(utterance) : instructionAfterCallsign(utterance, callsignMatch.callsign);

  if (includesPhrase(utterance, vocabulary.mute)) {
    candidates.push(commandCandidate("mute", "mute", true, null, null, ""));
  }
  if (includesPhrase(utterance, vocabulary.unmute)) {
    candidates.push(commandCandidate("unmute", "mute", true, null, null, ""));
  }
  if (includesPhrase(utterance, vocabulary.panic)) {
    if (focusedTarget !== null) {
      candidates.push(commandCandidate("panic", "panic", true, focusedTarget.upid, focusedTarget.callsign, instruction));
    } else {
      // Spoken panic halts the in-focus process. With no callsign, open window,
      // or single/selected target there is nothing unambiguous to halt, so emit
      // an addressed near-miss (no halt, no "Halting" feedback) rather than a
      // halt action with a null target. Kill-all stays the emergency control.
      candidates.push(passCandidate("near-miss", true, "panic"));
    }
  }
  if (includesPhrase(utterance, vocabulary.stop)) {
    if (target !== null) {
      candidates.push(commandCandidate("stop", "stop", true, target.upid, target.callsign, instruction));
    } else {
      candidates.push(passCandidate("near-miss", true, "stop"));
    }
  }
  if (includesPhrase(utterance, vocabulary.pauseAll)) {
    candidates.push(commandCandidate("pauseAll", "steer", true, null, null, ""));
  }
  if (includesPhrase(utterance, vocabulary.status)) {
    candidates.push(commandCandidate("status", "steer", true, null, null, ""));
  }
  if (context.pendingSuggestion !== null && includesPhrase(utterance, vocabulary.accept)) {
    candidates.push(commandCandidate("accept", "suggest", true, null, null, ""));
  } else if (context.pendingSuggestion === null && includesPhrase(utterance, vocabulary.accept)) {
    if (process.env.VIBERSYN_RBG_ACCEPT_ALWAYS_HOT === "1") {
      candidates.push(commandCandidate("accept", "suggest", true, null, null, ""));
    } else {
      candidates.push(passCandidate("near-miss", true, "accept"));
    }
  }
  if (context.pendingSuggestion !== null && includesPhrase(utterance, vocabulary.decline)) {
    candidates.push(commandCandidate("decline", "suggest", true, null, null, ""));
  } else if (context.pendingSuggestion === null && includesPhrase(utterance, vocabulary.decline)) {
    candidates.push(passCandidate("near-miss", true, "decline"));
  }
  if (window !== null && includesPhrase(utterance, vocabulary.done)) {
    candidates.push(commandCandidate("endSteering", "steer", true, window.upid, window.callsign, ""));
  }
  if (callsignMatch !== null) {
    const addressed = true;
    if (includesPhrase(instruction, vocabulary.pause)) {
      candidates.push(commandCandidate("pause", "steer", addressed, callsignMatch.upid, callsignMatch.callsign, instruction));
    } else if (includesPhrase(instruction, vocabulary.resume)) {
      candidates.push(commandCandidate("resume", "steer", addressed, callsignMatch.upid, callsignMatch.callsign, instruction));
    } else if (instruction.length === 0) {
      candidates.push(commandCandidate("selectOnly", "steer", addressed, callsignMatch.upid, callsignMatch.callsign, instruction));
    } else if (process.env.VIBERSYN_RBG_SPLIT_ONE_BREATH === "1") {
      candidates.push(commandCandidate("selectOnly", "steer", addressed, callsignMatch.upid, callsignMatch.callsign, ""));
    } else {
      candidates.push(steerCandidate("selectAndSteer", callsignMatch.upid, callsignMatch.callsign, instruction, context.confidence));
    }
  } else if (window !== null) {
    if (includesPhrase(utterance, vocabulary.pause)) {
      candidates.push(commandCandidate("pause", "steer", true, window.upid, window.callsign, instruction));
    } else if (includesPhrase(utterance, vocabulary.resume)) {
      candidates.push(commandCandidate("resume", "steer", true, window.upid, window.callsign, instruction));
    } else if (instruction.length > 0) {
      candidates.push(steerCandidate("steer", window.upid, window.callsign, instruction, context.confidence));
    }
  } else if (isTargetedPauseOrResumeNl(utterance, vocabulary)) {
    if (process.env.VIBERSYN_RBG_ROUTE_NL_PAUSE === "1" && context.activeProcesses[1] !== undefined) {
      candidates.push(commandCandidate("pause", "steer", true, context.activeProcesses[1].upid, context.activeProcesses[1].callsign, utterance));
    } else {
      candidates.push(passCandidate("near-miss", true, "pause"));
    }
  } else if (hasSteeringVerb(utterance)) {
    if (process.env.VIBERSYN_RBG_REMOVE_STEER_GUARD === "1" && context.activeProcesses[0] !== undefined) {
      candidates.push(commandCandidate("steer", "steer", false, context.activeProcesses[0].upid, context.activeProcesses[0].callsign, utterance));
    } else {
      candidates.push(passCandidate("rejected-no-target", false, null));
    }
  }

  if (addressedByWake && candidates.length === 0) {
    candidates.push(commandCandidate("wake", "steer", true, null, null, ""));
  }

  if (context.suggestionEligible) {
    candidates.push({
      commandId: null,
      priority: "suggest",
      addressed: false,
      targetUPID: null,
      callsign: null,
      instruction: "",
      route: "suggestion",
    });
  }

  candidates.push(passCandidate("ambient", false));
  return candidates;
}

function commandCandidate(
  commandId: DocumentedCommandId,
  priority: PriorityName,
  addressed: boolean,
  targetUPID: string | null,
  callsign: string | null,
  instruction: string,
): Candidate {
  return { commandId, priority, addressed, targetUPID, callsign, instruction, route: commandId === "accept" ? "suggestion" : targetUPID === null ? "pass" : "steer" };
}

function steerCandidate(
  commandId: Extract<DocumentedCommandId, "selectAndSteer" | "steer">,
  targetUPID: string,
  callsign: string,
  instruction: string,
  confidence: number,
): Candidate {
  if (confidence < loadRoutingVocabulary().steerMinConfidence && process.env.VIBERSYN_RBG_LOW_CONF_EXECUTE !== "1") {
    return passCandidate("low-confidence", true, commandId);
  }
  return commandCandidate(commandId, "steer", true, targetUPID, callsign, instruction);
}

function passCandidate(reason: PassReason, addressed: boolean, commandId: DocumentedCommandId | null = null): Candidate {
  return {
    commandId,
    priority: "pass",
    addressed,
    targetUPID: null,
    callsign: null,
    instruction: "",
    route: "pass",
    passReason: reason,
  };
}

function findCallsign(utterance: string, processes: readonly ActiveProcess[]): { upid: string; callsign: string } | null {
  const normalized = normalizeSpeech(utterance);
  for (const process of processes) {
    const callsign = normalizeSpeech(process.callsign);
    if (new RegExp(`(^|\\s)${escapeRegex(callsign)}(?=\\s|$)`, "u").test(normalized)) {
      return { upid: process.upid, callsign: process.callsign };
    }
  }
  return null;
}

function focusedProcess(processes: readonly ActiveProcess[]): { upid: string; callsign: string } | null {
  const selected = processes.filter((process) => process.selected === true);
  if (selected.length === 1) {
    return { upid: selected[0].upid, callsign: selected[0].callsign };
  }
  if (processes.length === 1) {
    return { upid: processes[0].upid, callsign: processes[0].callsign };
  }
  return null;
}

function instructionAfterCallsign(utterance: string, callsign: string): string {
  const normalized = normalizeSpeech(utterance);
  const normalizedCallsign = normalizeSpeech(callsign);
  return normalized.replace(new RegExp(`^.*?${escapeRegex(normalizedCallsign)}\\s*`, "u"), "").trim();
}

function activeWindow(window: SteeringWindow | null, nowMs: number, vocabulary: RoutingVocabulary): SteeringWindow | null {
  if (window === null) {
    return null;
  }
  const idleMs = (nowMs - window.lastActivityMs) / 1_000;
  return idleMs <= vocabulary.steerIdleSeconds ? window : null;
}

function ackFor(candidate: Candidate): AckKind {
  if (candidate.commandId === "panic") {
    return "state-earcon";
  }
  if (candidate.route === "suggestion") {
    return "route-suggestion";
  }
  if (candidate.route === "steer") {
    return "route-steer";
  }
  if (!candidate.addressed) {
    return process.env.VIBERSYN_RBG_AMBIENT_ACK === "1" ? "route-declined" : "silent";
  }
  if (candidate.commandId === "mute" || candidate.commandId === "unmute") {
    return "state-earcon";
  }
  return "route-declined";
}

// Returns the recorded event so callers can attach it to decision.trace,
// which carries only THIS dispatch's events — never the shared session trace.
function recordRoute(trace: TraceProcessor, decision: DispatchDecision, nowMs: number): LogEvent {
  const event = decision.route === "pass" ? "route.pass" : decision.route === "steer" ? "route.steer" : "route.suggestion";
  return trace.record({
    event,
    sessionId: decision.sessionId,
    correlationId: decision.correlationId,
    upid: decision.targetUPID ?? undefined,
    startedAtMs: nowMs,
    endedAtMs: nowMs,
    meta: {
      utteranceId: decision.utteranceId,
      route: routeKey(decision),
      targetUPID: decision.targetUPID,
      addressed: decision.addressed,
      ackKind: decision.ackKind,
      commandId: decision.commandId,
      decisionId: decision.decisionId,
    },
  });
}

function priorityRank(priority: PriorityName): number {
  const order: Record<PriorityName, number> = process.env.VIBERSYN_RBG_PRIORITY_MUTE_BELOW_PANIC === "1"
    ? { panic: 0, mute: 1, stop: 2, steer: 3, suggest: 4, pass: 5 }
    : { mute: 0, panic: 1, stop: 2, steer: 3, suggest: 4, pass: 5 };
  return order[priority];
}

function hasSteeringVerb(utterance: string): boolean {
  return STEERING_VERBS.some((verb) => includesPhrase(utterance, [verb]));
}

function isTargetedPauseOrResumeNl(utterance: string, vocabulary: RoutingVocabulary): boolean {
  return (matchPhrase(utterance, vocabulary.pause) !== undefined || matchPhrase(utterance, vocabulary.resume) !== undefined) && /\b(one|two|second|first|that|it|process)\b/iu.test(utterance);
}

function stableId(prefix: string, ...parts: string[]): string {
  let hash = 2166136261;
  for (const char of parts.join("|")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
