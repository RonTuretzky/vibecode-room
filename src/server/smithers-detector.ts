import { HostClaudeIdeaJudge, parseJudgeReply } from "../detect";
import type { CandidateVerdict, DetectedIdea, DetectionInput, DetectionResult, IdeaDetector, VerifiableIdea } from "../detect";
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
  // Adversarial verification for gateway mode. Detection runs durably on the
  // gateway, but the skeptic pass is a single cheap call — it runs through the
  // host `claude` CLI by default so VIBERSYN_DETECT_VERIFY stays meaningful in
  // gateway mode. Injectable for tests.
  verifier?: (idea: VerifiableIdea, input: DetectionInput) => Promise<CandidateVerdict>;
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
  readonly #verifier: (idea: VerifiableIdea, input: DetectionInput) => Promise<CandidateVerdict>;

  constructor(options: SmithersIdeaDetectorOptions) {
    this.#client = options.client;
    this.#workflow = options.workflow ?? IDEA_DETECTION_WORKFLOW;
    this.#maxFrames = options.maxFrames ?? DEFAULT_MAX_FRAMES;
    this.#idFactory = options.idFactory ?? (() => `detect-${crypto.randomUUID()}`);
    const fallbackJudge = new HostClaudeIdeaJudge();
    this.#verifier = options.verifier ?? ((idea, input) => fallbackJudge.verify(idea, input));
  }

  // The adversarial skeptic pass (engine calls this when an idea first turns
  // ready). Fail-open like the local judge: a broken verifier never blocks.
  async verify(idea: VerifiableIdea, input: DetectionInput): Promise<CandidateVerdict> {
    try {
      return await this.#verifier(idea, input);
    } catch (error) {
      return { uphold: true, reason: `verifier-error: ${error instanceof Error ? error.message : String(error)}` };
    }
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
  const assessments = findAssessmentsArray(frame.payload);
  if (assessments === null) {
    return null;
  }
  // Reuse the ONE judgment-mapping path (prompt.ts): normalize each rubric,
  // derive confidence in code, gate non-proposals, repair grounding — identical
  // to how a local judge reply is handled.
  return parseJudgeReply(JSON.stringify({ assessments }), input).ideas;
}

function findAssessmentsArray(value: unknown, depth = 0): unknown[] | null {
  if (depth > 6 || value === null || typeof value !== "object") {
    return null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = findAssessmentsArray(entry, depth + 1);
      if (nested !== null) {
        return nested;
      }
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  // The workflow's `ideas` output schema is { assessments: [...rubric...] }.
  if (Array.isArray(record.assessments)) {
    return record.assessments as unknown[];
  }
  for (const key of ["output", "outputs", "ideas", "result", "data", "payload", "value", "row", "rows"]) {
    if (key in record) {
      const nested = findAssessmentsArray(record[key], depth + 1);
      if (nested !== null) {
        return nested;
      }
    }
  }
  return null;
}

function isRunCompleteFrame(frame: GatewayEventFrame): boolean {
  // The official transport nests the engine event under payload.event with its
  // own payload.payload — check the outer envelope AND the inner one (mirrors
  // normalizeSmithersRunEvent in src/seam/run-events.ts).
  const payload = isRecord(frame.payload) ? frame.payload : {};
  const names = [frame.event, payload.event].map((v) => `${v ?? ""}`.toLowerCase());
  if (names.some((n) => n.includes("run.completed") || n.includes("run.finished") || n.includes("runfinished"))) {
    return true;
  }
  const inner = isRecord(payload.payload) ? payload.payload : {};
  const statuses = [payload.status, inner.status].map((v) => `${v ?? ""}`.toLowerCase());
  return statuses.some((s) => s === "finished" || s === "failed" || s === "cancelled");
}



function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
