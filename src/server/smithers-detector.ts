import type { DetectedIdea, DetectionInput, DetectionResult, IdeaDetector } from "../detect";
import type { GatewayEventFrame, SmithersClient, SpawnSeed } from "../seam/smithers-client";

export const IDEA_DETECTION_WORKFLOW = "idea-detection";
const DEFAULT_MAX_FRAMES = 200;

export interface SmithersIdeaDetectorOptions {
  client: SmithersClient;
  workflow?: string;
  // Max event frames to read before giving up on a run (safety bound).
  maxFrames?: number;
  // Unique-id factory for the per-round run UPID. Injectable for tests.
  idFactory?: () => string;
}

// An IdeaDetector that runs detection as a DURABLE SMITHERS RUN: each detect()
// launches the `idea-detection` workflow with the transcript window as input and
// reads the structured `ideas` output back off the run's event stream. This is
// the "done with Smithers" execution path — replayable, observable, and sharing
// the gateway seam the build runs already use. Selected when a gateway is
// configured; the LocalDetectionRunner runs the same inference inline otherwise.
//
// Fail-soft: any spawn/stream/parse failure yields zero candidates, exactly like
// the host-claude detector, so a flaky gateway never wedges detection.
export class SmithersIdeaDetector implements IdeaDetector {
  readonly #client: SmithersClient;
  readonly #workflow: string;
  readonly #maxFrames: number;
  readonly #idFactory: () => string;

  constructor(options: SmithersIdeaDetectorOptions) {
    this.#client = options.client;
    this.#workflow = options.workflow ?? IDEA_DETECTION_WORKFLOW;
    this.#maxFrames = options.maxFrames ?? DEFAULT_MAX_FRAMES;
    this.#idFactory = options.idFactory ?? (() => `detect-${crypto.randomUUID()}`);
  }

  async detect(input: DetectionInput): Promise<DetectionResult> {
    if (input.turns.length === 0) {
      return { candidates: [] };
    }
    const upid = this.#idFactory();
    const seed: SpawnSeed = {
      upid,
      workflow: this.#workflow,
      correlationId: input.correlationId,
      input: {
        sessionId: input.sessionId,
        correlationId: input.correlationId,
        turns: input.turns,
        known: input.known.map((k) => ({
          id: k.id,
          pitch: k.pitch,
          startTurnId: k.contextSpan.startTurnId,
          endTurnId: k.contextSpan.endTurnId,
        })),
      },
    };
    try {
      await this.#client.spawn(seed);
      const candidates = await this.#collectCandidates(upid, input);
      return { candidates };
    } catch (error) {
      return { candidates: [], raw: { error: error instanceof Error ? error.message : String(error) } };
    }
  }

  async #collectCandidates(upid: string, input: DetectionInput): Promise<DetectedIdea[]> {
    let frames = 0;
    for await (const frame of this.#client.streamRunEvents(upid)) {
      frames += 1;
      const candidates = candidatesFromFrame(frame, input);
      if (candidates !== null) {
        return candidates;
      }
      if (isRunCompleteFrame(frame) || frames >= this.#maxFrames) {
        break;
      }
    }
    return [];
  }
}

// Tolerant extractor: pull the detect node's `ideas` output (an array of detected
// ideas) out of a run-event frame, wherever the gateway nests it. Returns null
// when this frame doesn't carry the output (keep streaming).
export function candidatesFromFrame(frame: GatewayEventFrame, input: DetectionInput): DetectedIdea[] | null {
  const ideas = findCandidatesArray(frame.payload);
  if (ideas === null) {
    return null;
  }
  return coerceCandidates(ideas, input);
}

function findCandidatesArray(value: unknown, depth = 0): unknown[] | null {
  if (depth > 6 || value === null || typeof value !== "object") {
    return null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = findCandidatesArray(entry, depth + 1);
      if (nested !== null) {
        return nested;
      }
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  // The workflow's `ideas` output schema is { candidates: DetectedIdea[] }.
  if (Array.isArray(record.candidates)) {
    return record.candidates as unknown[];
  }
  for (const key of ["output", "outputs", "ideas", "result", "data", "payload", "value", "row", "rows"]) {
    if (key in record) {
      const nested = findCandidatesArray(record[key], depth + 1);
      if (nested !== null) {
        return nested;
      }
    }
  }
  return null;
}

function coerceCandidates(raw: unknown[], input: DetectionInput): DetectedIdea[] {
  const turnIds = new Set(input.turns.map((t) => t.id));
  const firstId = input.turns[0]?.id;
  const lastId = input.turns.at(-1)?.id;
  const out: DetectedIdea[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const r = entry as Record<string, unknown>;
    const pitch = typeof r.pitch === "string" ? r.pitch.trim() : "";
    if (pitch.length === 0 || firstId === undefined || lastId === undefined) {
      continue;
    }
    const startTurnId = typeof r.startTurnId === "string" && turnIds.has(r.startTurnId) ? r.startTurnId : firstId;
    const endTurnId = typeof r.endTurnId === "string" && turnIds.has(r.endTurnId) ? r.endTurnId : lastId;
    out.push({
      matchId: typeof r.matchId === "string" && r.matchId.trim().length > 0 ? r.matchId.trim() : null,
      pitch,
      confidence: clamp01(typeof r.confidence === "number" ? r.confidence : 0.6),
      questions: stringArray(r.questions).slice(0, 3),
      answers: stringArray(r.answers).slice(0, 3),
      contextSpan: {
        startTurnId,
        endTurnId,
        quote: groundQuote(input, startTurnId, endTurnId) ?? (typeof r.quote === "string" ? r.quote : ""),
      },
      rationale: typeof r.rationale === "string" ? r.rationale : "",
    });
  }
  return out;
}

function groundQuote(input: DetectionInput, startId: string, endId: string): string | null {
  const startIndex = input.turns.findIndex((t) => t.id === startId);
  const endIndex = input.turns.findIndex((t) => t.id === endId);
  if (startIndex === -1 || endIndex === -1) {
    return null;
  }
  const [lo, hi] = startIndex <= endIndex ? [startIndex, endIndex] : [endIndex, startIndex];
  return input.turns
    .slice(lo, hi + 1)
    .map((t) => t.text)
    .join(" ");
}

function isRunCompleteFrame(frame: GatewayEventFrame): boolean {
  const event = `${frame.event ?? ""}`.toLowerCase();
  if (event.includes("run.completed") || event.includes("run.finished") || event.includes("runfinished")) {
    return true;
  }
  const status = isRecord(frame.payload) ? `${frame.payload.status ?? ""}`.toLowerCase() : "";
  return status === "finished" || status === "failed" || status === "cancelled";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim())
    : [];
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
