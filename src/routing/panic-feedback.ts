import type { DispatchedAction, OutputDecision } from "../types";

export const PANIC_HALT_CONFIRMATION = "Halting selected process.";

export function panicHaltAction(input: {
  targetUPID: string;
  correlationId: string;
  text: string;
}): DispatchedAction {
  return {
    type: "halt",
    targetUPID: input.targetUPID,
    payload: { trigger: "panic", source: "voice", text: input.text },
    correlationId: input.correlationId,
  };
}

export function panicHaltOutputs(): OutputDecision[] {
  return [
    { channel: "earcon", id: "E5" },
    {
      channel: "tts",
      text: PANIC_HALT_CONFIRMATION,
      wordCount: countWords(PANIC_HALT_CONFIRMATION),
      summarized: false,
    },
  ];
}

function countWords(text: string): number {
  return text.trim().split(/\s+/u).filter(Boolean).length;
}
