import type { CueDecision, TranscriptObservation } from "../types";

export interface WakeMatcherOptions {
  wakeWord?: string;
  policy?: string;
}

const defaultWakeWord = "panop";
const defaultPolicy = "literal-wake";

export function matchWakeWord(
  observation: TranscriptObservation,
  options: WakeMatcherOptions = {},
): CueDecision {
  const wakeWord = options.wakeWord ?? defaultWakeWord;
  const policy = options.policy ?? defaultPolicy;
  const correlationId = stableId("corr", observation.sessionId, observation.utteranceId);
  const decisionId = stableId("decision", observation.sessionId, observation.utteranceId, policy);
  const base = {
    policy,
    decisionId,
    correlationId,
    observationId: observation.utteranceId,
  };

  if (!observation.isFinal) {
    return {
      ...base,
      kind: "pass",
      addressed: false,
      reason: "non-final",
      meta: { textLength: observation.text.length },
    };
  }

  if (!containsWholeToken(observation.text, wakeWord)) {
    return {
      ...base,
      kind: "pass",
      addressed: false,
      reason: "ambient",
      meta: { textLength: observation.text.length },
    };
  }

  return {
    ...base,
    kind: "action",
    action: "wake",
    payload: { wakeWord },
    meta: { matchedText: wakeWord },
  };
}

function containsWholeToken(text: string, token: string): boolean {
  const normalizedToken = token.toLocaleLowerCase("en-US");
  return text
    .toLocaleLowerCase("en-US")
    .split(/[^a-z0-9]+/u)
    .some((candidate) => candidate === normalizedToken);
}

function stableId(prefix: string, ...parts: string[]): string {
  const encoded = parts
    .map((part) => part.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/g, ""))
    .filter(Boolean)
    .join("-");
  return `${prefix}-${encoded}`;
}
