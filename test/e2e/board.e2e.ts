import { describe, expect, test } from "bun:test";
import { TraceProcessor, reconstructCrossComponentCausalChain } from "../../src/obs/trace";
import { BoardEventBus, createBoardApp, runBoardIndependentVoiceFlow } from "../../src/obs/board";

describe("REQ-16 board e2e", () => {
  test("board-non-authoritative: canonical voice flow passes when board server is down", async () => {
    const result = await runBoardIndependentVoiceFlow();

    expect(result.ok).toBe(true);
    expect(result.stages).toEqual(["observation", "decision", "action", "outcome"]);
  });

  test("with board up, persisted traces alone reconstruct the live loop", async () => {
    const trace = new TraceProcessor();
    const correlationId = "corr-board-e2e-001";
    const upid = "upid-board-e2e-001";
    const bus = new BoardEventBus();
    const app = createBoardApp(bus);

    const live = await runBoardIndependentVoiceFlow({ boardUrl: "http://127.0.0.1:0/unused" });
    const inputs = [
      { event: "observe.final", meta: { seq: 1, utteranceId: "utt-board", text: "Viber status" } },
      { event: "route.action", meta: { seq: 2, utteranceId: "utt-board", decisionId: "decision-board", action: "status" } },
      { event: "process.status", upid, meta: { seq: 3, utteranceId: "utt-board", runId: "run-board" } },
      { event: "output.tts", upid, meta: { seq: 4, utteranceId: "utt-board", text: "Atlas active" } },
    ];
    for (const [index, input] of inputs.entries()) {
      const event = trace.record({
        event: input.event,
        sessionId: "board-e2e",
        correlationId,
        upid: input.upid,
        startedAtMs: index,
        endedAtMs: index + 1,
        meta: input.meta,
      });
      bus.appendTrace(event);
    }

    const state = await app.request("/state");
    expect(state.status).toBe(200);
    expect((await state.json()).trace).toHaveLength(4);

    const chain = reconstructCrossComponentCausalChain(
      {
        observationsJsonl: JSON.stringify({ event: "observe.final", correlationId, utteranceId: "utt-board", seq: 1 }),
        decisionsJsonl: JSON.stringify({ event: "route.action", correlationId, decisionId: "decision-board", seq: 2 }),
        actionsJsonl: JSON.stringify({ event: "process.status", correlationId, upid, runId: "run-board", seq: 3 }),
        smithersJsonl: JSON.stringify({ event: "output.tts", upid, runId: "run-board", text: "Atlas active", seq: 4 }),
      },
      live.correlationId,
    );

    expect(chain.complete).toBe(true);
    expect(chain.events.map((event) => event.event)).toEqual(["observe.final", "route.action", "process.status", "output.tts"]);
  });
});
