import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptObservation } from "../../../src/types";

// Deterministic replay script for the live composition loop (ISSUE-0015). Two
// FINAL observations: a buildable utterance that fires a suggestion, then a
// spoken affirmation that accepts it (-> spawn -> spoken ack). Replayed through
// the ReplayASRProvider via PANOP_MIC_REPLAY_PATH, this is the binding fixture
// for the suggest->accept->spawn->speak measurable. Kept in one module so the
// e2e, the integration snapshot test, and the fixture unit test all agree on the
// exact observation sequence and the utterance ids the trace assertions key off.

export const LOOP_SCRIPT_SESSION_ID = "loop-composition-e2e";

// A buildable utterance: an explicit "let's build ..." intent with enough
// substance that the heuristic decider fires (not just queues) a suggestion.
export const BUILDABLE_UTTERANCE = "let's build a dashboard tool to ship the replay prototype today";
export const BUILDABLE_UTTERANCE_ID = "utt-build";

// A bare spoken affirmation: while a suggestion is pending this routes to the
// AcceptanceController and is classified as an accept -> registry spawn.
export const AFFIRMATION = "yes";
export const AFFIRMATION_UTTERANCE_ID = "utt-yes";

export interface LoopScriptOptions {
  sessionId?: string;
}

// The full buildable + affirmation script that drives one complete loop.
export function buildLoopScript(options: LoopScriptOptions = {}): TranscriptObservation[] {
  const sessionId = options.sessionId ?? LOOP_SCRIPT_SESSION_ID;
  return [
    finalObservation(BUILDABLE_UTTERANCE, BUILDABLE_UTTERANCE_ID, sessionId),
    finalObservation(AFFIRMATION, AFFIRMATION_UTTERANCE_ID, sessionId),
  ];
}

// Just the buildable utterance — fires + leaves a pending suggestion, with no
// affirmation to consume it. Lets a test observe the mid-loop pending state.
export function buildBuildableOnlyScript(options: LoopScriptOptions = {}): TranscriptObservation[] {
  const sessionId = options.sessionId ?? LOOP_SCRIPT_SESSION_ID;
  return [finalObservation(BUILDABLE_UTTERANCE, BUILDABLE_UTTERANCE_ID, sessionId)];
}

// Serialize a script to the JSONL shape ReplayASRProvider.fromFile expects.
export function serializeLoopScript(observations: readonly TranscriptObservation[]): string {
  return observations.map((observation) => JSON.stringify(observation)).join("\n");
}

// Write a script to a fresh temp JSONL file and return its path. The caller owns
// cleanup of the returned directory's parent (mkdtemp dir), if it tracks temps.
export function writeLoopScriptFixture(observations: readonly TranscriptObservation[], tempDirs?: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "panop-loop-script-"));
  tempDirs?.push(dir);
  const path = join(dir, "mic.jsonl");
  writeFileSync(path, serializeLoopScript(observations), "utf8");
  return path;
}

function finalObservation(text: string, utteranceId: string, sessionId: string): TranscriptObservation {
  return { text, isFinal: true, speaker: "Room", sessionId, latencyMs: 20, utteranceId };
}
