// Trivial deterministic matcher: TextCue-equivalent for the wake word.
// Routing authority lives in deterministic code, never the LLM (invariants-in-code.html).
// decisionId is derived deterministically from utteranceId so record-replay produces identical output.

import type { CueDecision, TranscriptObservation } from "./types.ts";

const WAKE_WORDS = ["viber"] as const;

export function match(obs: TranscriptObservation): CueDecision {
  const lower = obs.text.toLowerCase();
  const matchedWord = WAKE_WORDS.find((w) => new RegExp(`\\b${w}\\b`, "i").test(lower));
  const hit = matchedWord !== undefined;

  // Deterministic: same utteranceId maps to same decisionId across replays.
  const decisionId = `decision:${obs.utteranceId}`;
  const correlationId = obs.utteranceId; // utterance is the correlation root in the skeleton

  if (hit && obs.isFinal) {
    return {
      kind: "action",
      action: {
        type: "spawn",
        targetUPID: null,
        payload: { text: obs.text },
        correlationId,
      },
      policy: "TextCue/wake-word",
      decisionId,
      correlationId,
      meta: { matchedWord },
    };
  }

  return {
    kind: "pass",
    addressed: false,
    reason: "ambient",
    policy: "TextCue/wake-word",
    decisionId,
    correlationId,
    meta: {},
  };
}
