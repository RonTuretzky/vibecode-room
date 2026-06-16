import type { DispatchedAction } from "../types";
import { DOCUMENTED_COMMANDS, type DocumentedCommandId } from "./vocabulary";

export type LocalEffect =
  | "wake"
  | "mute"
  | "unmute"
  | "declineSuggestion"
  | "openSteeringWindow"
  | "closeSteeringWindow"
  | "panic";

export interface HandlerInput {
  commandId: DocumentedCommandId;
  correlationId: string;
  targetUPID: string | null;
  utterance: string;
  instruction: string;
  pendingSuggestion?: {
    suggestionId: string;
    pitch: string;
    mcqs: readonly string[];
    answers: readonly string[];
  };
  callsign?: string | null;
}

export type HandlerOutput =
  | { kind: "action"; action: DispatchedAction }
  | { kind: "local"; effect: LocalEffect; payload: Record<string, unknown> };

export type CommandHandler = (input: HandlerInput) => HandlerOutput;

const baseHandlers = {
  wake: local("wake"),
  mute: local("mute"),
  unmute: local("unmute"),
  accept(input) {
    return {
      kind: "action",
      action: {
        type: "spawn",
        targetUPID: null,
        payload: {
          suggestionId: input.pendingSuggestion?.suggestionId,
          pitch: input.pendingSuggestion?.pitch,
          mcqs: input.pendingSuggestion?.mcqs ?? [],
          answers: input.pendingSuggestion?.answers ?? [],
          source: "voice-accept",
        },
        correlationId: input.correlationId,
      },
    };
  },
  decline: local("declineSuggestion"),
  selectAndSteer(input) {
    return steerAction(input);
  },
  selectOnly(input) {
    return {
      kind: "local",
      effect: "openSteeringWindow",
      payload: { targetUPID: input.targetUPID, callsign: input.callsign ?? null },
    };
  },
  steer(input) {
    return steerAction(input);
  },
  endSteering: local("closeSteeringWindow"),
  pause(input) {
    return targetedAction("pause", input);
  },
  resume(input) {
    return targetedAction("resume", input);
  },
  pauseAll(input) {
    return {
      kind: "action",
      action: { type: "pauseAll", targetUPID: null, payload: { source: "voice" }, correlationId: input.correlationId },
    };
  },
  status(input) {
    return {
      kind: "action",
      action: { type: "status", targetUPID: null, payload: { source: "voice" }, correlationId: input.correlationId },
    };
  },
  stop(input) {
    return targetedAction("halt", input, { trigger: "stop" });
  },
  panic: local("panic"),
} satisfies Record<DocumentedCommandId, CommandHandler>;

export const COMMAND_HANDLERS: Record<DocumentedCommandId, CommandHandler> =
  process.env.PANOP_RBG_DROP_STATUS_HANDLER === "1"
    ? omitStatus(baseHandlers)
    : baseHandlers;

export function assertHandlerCoverage(handlers: Partial<Record<DocumentedCommandId, CommandHandler>> = COMMAND_HANDLERS): void {
  const missing = DOCUMENTED_COMMANDS.map((command) => command.id).filter((id) => handlers[id] === undefined);
  const extra = Object.keys(handlers).filter((id) => !DOCUMENTED_COMMANDS.some((command) => command.id === id));

  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`Command handler coverage mismatch. missing=${missing.join(",") || "none"} extra=${extra.join(",") || "none"}`);
  }
}

function local(effect: LocalEffect): CommandHandler {
  return (input) => ({ kind: "local", effect, payload: { source: "voice", utterance: input.utterance } });
}

function steerAction(input: HandlerInput): HandlerOutput {
  return targetedAction("steer", input, { instruction: input.instruction, callsign: input.callsign ?? null });
}

function targetedAction(type: "steer" | "pause" | "resume" | "halt", input: HandlerInput, payload: Record<string, unknown> = {}): HandlerOutput {
  return {
    kind: "action",
    action: {
      type,
      targetUPID: input.targetUPID,
      payload: { ...payload, source: "voice", text: input.instruction || input.utterance },
      correlationId: input.correlationId,
    },
  };
}

function omitStatus(handlers: typeof baseHandlers): Record<DocumentedCommandId, CommandHandler> {
  const copy: Partial<Record<DocumentedCommandId, CommandHandler>> = { ...handlers };
  delete copy.status;
  return copy as Record<DocumentedCommandId, CommandHandler>;
}
