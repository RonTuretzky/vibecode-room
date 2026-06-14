import { readFile } from "node:fs/promises";
import { transcriptObservationSchema, type TranscriptObservation } from "../types";

export async function readTranscriptObservationJsonl(path: string): Promise<TranscriptObservation[]> {
  const body = await readFile(path, "utf8");
  const observations: TranscriptObservation[] = [];

  for (const [index, rawLine] of body.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid transcript JSONL at line ${index + 1}: ${(error as Error).message}`);
    }

    const result = transcriptObservationSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`Invalid transcript observation at line ${index + 1}: ${result.error.message}`);
    }

    observations.push(result.data);
  }

  return observations;
}
