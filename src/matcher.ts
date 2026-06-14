// Trivial deterministic matcher — TextCue-equivalent for the wake word.
// Routing authority lives in deterministic code, never the LLM (invariants-in-code.html).

import { randomUUID } from "node:crypto";
import type { CueDecision, TranscriptObservation } from "./types.ts";

const WAKE_WORDS = ["daybreak", "panopticon"] as const;

export function match(obs: TranscriptObservation): CueDecision {
  const lower = obs.text.toLowerCase();
  const hit = WAKE_WORDS.some((w) => lower.includes(w));

  const decisionId = randomUUID();
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
