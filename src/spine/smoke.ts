import { matchWakeWord } from "../cue/wake-matcher";
import { TraceProcessor } from "../obs/trace";
import { readTranscriptObservationJsonl } from "../replay/jsonl";
import type { CueDecision, LogEvent, TranscriptObservation } from "../types";

export interface SpineSmokeResult {
  observations: TranscriptObservation[];
  decisions: CueDecision[];
  traceEvents: LogEvent[];
}

export interface SpineSmokeOptions {
  trace?: TraceProcessor;
  observationMeta?: (observation: TranscriptObservation, index: number) => Record<string, unknown>;
}

export async function runSpineSmoke(fixturePath: string, options: SpineSmokeOptions = {}): Promise<SpineSmokeResult> {
  const observations = await readTranscriptObservationJsonl(fixturePath);
  const trace = options.trace ?? new TraceProcessor();
  const decisions = observations.map((observation, index) => {
    const extraMeta = options.observationMeta?.(observation, index);
    if (extraMeta !== undefined) {
      trace.record({
        event: "observe.final",
        sessionId: observation.sessionId,
        correlationId: `corr-${observation.sessionId}-${observation.utteranceId}`,
        startedAtMs: 0,
        endedAtMs: observation.latencyMs,
        meta: {
          utteranceId: observation.utteranceId,
          speaker: observation.speaker,
          isFinal: observation.isFinal,
          ...extraMeta,
        },
      });
    }

    const decision = matchWakeWord(observation);
    trace.emitDecision(decision, observation);
    return decision;
  });

  return {
    observations,
    decisions,
    traceEvents: trace.events(),
  };
}
