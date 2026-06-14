import { matchWakeWord } from "../cue/wake-matcher";
import { TraceProcessor } from "../obs/trace";
import { readTranscriptObservationJsonl } from "../replay/jsonl";
import type { CueDecision, LogEvent, TranscriptObservation } from "../types";

export interface SpineSmokeResult {
  observations: TranscriptObservation[];
  decisions: CueDecision[];
  traceEvents: LogEvent[];
}

export async function runSpineSmoke(fixturePath: string): Promise<SpineSmokeResult> {
  const observations = await readTranscriptObservationJsonl(fixturePath);
  const trace = new TraceProcessor();
  const decisions = observations.map((observation) => {
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
