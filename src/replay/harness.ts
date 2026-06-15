// Record-replay harness (ENG-T-02 stub).
// Reads a JSONL file of pre-recorded TranscriptObservations from disk.
// Yields each line as a parsed observation: no network, no mic, no API keys.

import { readFileSync } from "node:fs";
import type { TranscriptObservation } from "../types.ts";

export function* loadFixture(path: string): Generator<TranscriptObservation> {
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    yield JSON.parse(trimmed) as TranscriptObservation;
  }
}
