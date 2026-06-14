// Trivial deterministic matcher — TextCue-equivalent for the wake word.
// Routing authority lives in deterministic code, never the LLM (invariants-in-code.html).
// decisionId is derived deterministically from utteranceId so record-replay produces identical output.

import type { CueDecision, TranscriptObservation } from "./types.ts";

const WAKE_WORDS = ["panopticon"] as const;

export function match(obs: TranscriptObservation): CueDecision {
  const lower = obs.text.toLowerCase();
  const hit = WAKE_WORDS.some((w) => lower.includes(w));

  // Deterministic: same utteranceId → same decisionId across replays.
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
      meta: { matchedWord: WAKE_WORDS.find((w) => lower.includes(w)) },
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
