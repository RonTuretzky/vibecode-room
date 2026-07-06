import { describe, expect, test } from "bun:test";
import { createCorrelationRecord, MemoryCorrelationStore } from "../../src/seam/correlation-store";
import { SeamDispatcher } from "../../src/seam/dispatcher";
import { MemorySmithersClient } from "../../src/process/test-helpers";
import { routeUtteranceToSeam } from "../../src/routing/seam-bridge";
import type { ActiveProcess, DispatchContext } from "../../src/routing/dispatch";
import type { TranscriptObservation } from "../../src/types";

const processes: ActiveProcess[] = [
  { callsign: "Atlas", upid: "upid-atlas", state: "active" },
  { callsign: "Bravo", upid: "upid-bravo", state: "active" },
];

function seededStore(): MemoryCorrelationStore {
  return new MemoryCorrelationStore(
    processes.map((proc) =>
      createCorrelationRecord({
        upid: proc.upid,
        runId: `run-${proc.upid}`,
        callsign: proc.callsign,
        correlationId: `seed-${proc.upid}`,
        state: "active",
      }),
    ),
  );
}

function buildSeam(): { seam: SeamDispatcher; client: MemorySmithersClient; store: MemoryCorrelationStore } {
  const client = new MemorySmithersClient();
  const store = seededStore();
  const seam = new SeamDispatcher({ client, correlations: store, sessionId: "routing-seam-e2e" });
  return { seam, client, store };
}

function observation(text: string): TranscriptObservation {
  return {
    text,
    isFinal: true,
    speaker: "speaker_0",
    sessionId: "routing-seam-e2e",
    latencyMs: 12,
    utteranceId: `utt-${text.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "empty"}`,
  };
}

function context(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return { sessionId: "routing-seam-e2e", activeProcesses: processes, nowMs: 25_000, confidence: 1, ...overrides };
}

describe("routing→seam voice control e2e", () => {
  test("a spoken per-process pause routes through dispatchUtterance and executes on the seam", async () => {
    const { seam, client, store } = buildSeam();

    const routed = await routeUtteranceToSeam(observation("Atlas, pause"), context(), seam);
    await seam.drain();

    expect(routed.decision.kind).toBe("action");
    expect(routed.route).toBe("steer:upid-atlas");
    expect(routed.cueDecision.kind).toBe("action");
    expect(routed.dispatch).toEqual(expect.objectContaining({ accepted: true, actionType: "pause", targetUPID: "upid-atlas" }));
    expect(client.calls).toContainEqual({ name: "pause", upid: "upid-atlas" });
    expect(await store.findByUPID("upid-atlas")).toEqual(expect.objectContaining({ state: "paused" }));
    expect(await store.findByUPID("upid-bravo")).toEqual(expect.objectContaining({ state: "active" }));
  });

  test("a one-breath select-and-steer routes the instruction to the addressed process on the seam", async () => {
    const { seam, client } = buildSeam();

    const routed = await routeUtteranceToSeam(observation("Bravo, make it faster"), context(), seam);
    await seam.drain();

    expect(routed.decision.kind).toBe("action");
    expect(routed.route).toBe("steer:upid-bravo");
    expect(routed.dispatch).toEqual(expect.objectContaining({ accepted: true, actionType: "steer", targetUPID: "upid-bravo" }));
    expect(client.calls).toContainEqual(
      expect.objectContaining({ name: "steer", upid: "upid-bravo", payload: expect.objectContaining({ text: "make it faster" }) }),
    );
  });

  test("a spoken fleet status request resolves to a status summary through the seam", async () => {
    const { seam, client } = buildSeam();

    const routed = await routeUtteranceToSeam(observation("status"), context(), seam);
    await seam.drain();

    expect(routed.decision.kind).toBe("action");
    expect(routed.dispatch).toEqual(expect.objectContaining({ accepted: true, actionType: "status" }));
    if (routed.dispatch?.accepted) {
      expect(typeof routed.dispatch.statusSummary).toBe("string");
      expect(routed.dispatch.statusSummary?.length).toBeGreaterThan(0);
    }
    // status is a read-back: it never reaches a spawn/steer/pause client call.
    expect(client.calls).toHaveLength(0);
  });

  test("ambient chatter and un-targeted steering verbs never drive the seam", async () => {
    const { seam, client } = buildSeam();

    const ambient = await routeUtteranceToSeam(observation("ordinary ambient chatter about lunch"), context(), seam);
    const untargeted = await routeUtteranceToSeam(observation("make it faster"), context({ activeProcesses: [] }), seam);
    await seam.drain();

    expect(ambient.decision.kind).toBe("pass");
    expect(ambient.route).toBe("pass");
    expect(ambient.dispatch).toBeNull();

    expect(untargeted.decision.kind).toBe("pass");
    expect(untargeted.route).toBe("pass");
    expect(untargeted.dispatch).toBeNull();

    expect(client.calls).toHaveLength(0);
  });
});
