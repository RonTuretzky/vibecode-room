import { describe, expect, test } from "bun:test";
import type { DetectionInput } from "../detect";
import type { GatewayEventFrame, SmithersClient, SpawnResult, SpawnSeed, StreamRunEventsOptions } from "../seam/smithers-client";
import { SmithersIdeaDetector, candidatesFromFrame } from "./smithers-detector";

const turns = [
  { id: "turn-0001", speaker: "speaker_0", text: "crypto laundromat cooperative", atMs: 0 },
  { id: "turn-0002", speaker: "speaker_0", text: "with revenue share", atMs: 1 },
];

function input(over: Partial<DetectionInput> = {}): DetectionInput {
  return { sessionId: "s", correlationId: "corr-1", turns, known: [], ...over };
}

// Fake gateway client that records spawns and replays scripted event frames.
class FakeSmithersClient implements SmithersClient {
  readonly spawns: SpawnSeed[] = [];
  #frames: GatewayEventFrame[];
  constructor(frames: GatewayEventFrame[]) {
    this.#frames = frames;
  }
  async spawn(seed: SpawnSeed): Promise<SpawnResult> {
    this.spawns.push(seed);
    return { upid: seed.upid, runId: `run-${seed.upid}`, workflow: seed.workflow, parentId: null };
  }
  async steer(): Promise<unknown> {
    return {};
  }
  async signal(): Promise<unknown> {
    return {};
  }
  async pause(): Promise<unknown> {
    return {};
  }
  async resume(): Promise<unknown> {
    return {};
  }
  async halt(): Promise<unknown> {
    return {};
  }
  async *streamRunEvents(_upid: string, _options?: StreamRunEventsOptions): AsyncIterable<GatewayEventFrame> {
    for (const frame of this.#frames) {
      yield frame;
    }
  }
}

describe("candidatesFromFrame", () => {
  test("extracts and grounds candidates nested under output.candidates", () => {
    const frame: GatewayEventFrame = {
      event: "run.event",
      seq: 3,
      payload: {
        output: { candidates: [{ pitch: "Crypto laundromat co-op", confidence: 0.9, startTurnId: "turn-0001", endTurnId: "turn-0002", quote: "drifted" }] },
      },
    };
    const result = candidatesFromFrame(frame, input());
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0].pitch).toBe("Crypto laundromat co-op");
    // quote is repaired from ground truth, not the model's "drifted"
    expect(result![0].contextSpan.quote).toBe("crypto laundromat cooperative with revenue share");
  });

  test("returns null for frames without a candidates array", () => {
    expect(candidatesFromFrame({ event: "run.heartbeat", payload: { status: "running" } }, input())).toBeNull();
  });
});

describe("SmithersIdeaDetector", () => {
  test("spawns the idea-detection workflow with the window and returns parsed candidates", async () => {
    const client = new FakeSmithersClient([
      { event: "run.event", seq: 1, payload: { status: "running" } },
      { event: "run.event", seq: 2, payload: { node: "detect", output: { candidates: [{ matchId: null, pitch: "Build a co-op app", confidence: 0.82, startTurnId: "turn-0001", endTurnId: "turn-0001" }] } } },
    ]);
    const detector = new SmithersIdeaDetector({ client, idFactory: () => "detect-xyz" });
    const result = await detector.detect(input({ known: [{ id: "k1", pitch: "x", contextSpan: { startTurnId: "turn-0001", endTurnId: "turn-0001", quote: "x" } }] }));
    expect(client.spawns).toHaveLength(1);
    expect(client.spawns[0].workflow).toBe("idea-detection");
    expect(client.spawns[0].input?.turns).toHaveLength(2);
    expect(client.spawns[0].input?.known).toEqual([{ id: "k1", pitch: "x", startTurnId: "turn-0001", endTurnId: "turn-0001" }]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].pitch).toBe("Build a co-op app");
  });

  test("returns zero candidates when the run completes without emitting ideas", async () => {
    const client = new FakeSmithersClient([{ event: "run.completed", seq: 9, payload: { status: "finished" } }]);
    const result = await new SmithersIdeaDetector({ client }).detect(input());
    expect(result.candidates).toHaveLength(0);
  });

  test("fails soft when spawn throws", async () => {
    const client: SmithersClient = {
      spawn: async () => {
        throw new Error("gateway down");
      },
    } as unknown as SmithersClient;
    const result = await new SmithersIdeaDetector({ client }).detect(input());
    expect(result.candidates).toHaveLength(0);
    expect(result.raw).toMatchObject({ error: "gateway down" });
  });

  test("does not spawn for an empty window", async () => {
    const client = new FakeSmithersClient([]);
    const result = await new SmithersIdeaDetector({ client }).detect(input({ turns: [] }));
    expect(client.spawns).toHaveLength(0);
    expect(result.candidates).toHaveLength(0);
  });
});
