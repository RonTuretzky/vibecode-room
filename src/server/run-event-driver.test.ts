import { describe, expect, test } from "bun:test";
import { RunEventDriver, runEventToOverlay, type RunEventOverlay, type RunEventStreamClient } from "./run-event-driver";
import type { GatewayEventFrame, StreamRunEventsOptions } from "../seam/smithers-client";
import type { RunEvent } from "../types";

// ISSUE-0021 unit: one run event projects onto the live process-panel fields —
// progress, lastOutput and state all derive from the RunEvent's kind/seq/text.
describe("RunEventDriver — run-event frame maps to ProjectorProcess fields", () => {
  test("a streaming 'output' event derives active state, seq-scaled progress and its text", () => {
    const overlay = runEventToOverlay(runEvent({ kind: "output", text: "Implemented the parser module", seq: 2 }));
    expect(overlay).toEqual({
      state: "active",
      progress: 24, // min(95, seq 2 * 12)
      lastOutput: "Implemented the parser module",
      lastSeq: 2,
    });
  });

  test("a 'completed' event jumps progress to 100 and the completed state", () => {
    const overlay = runEventToOverlay(runEvent({ kind: "completed", text: "Run finished", seq: 9 }));
    expect(overlay.state).toBe("completed");
    expect(overlay.progress).toBe(100);
    expect(overlay.lastOutput).toBe("Run finished");
  });

  test("a 'blocker' event maps to blocked and holds the prior progress", () => {
    const previous: RunEventOverlay = { state: "active", progress: 48, lastOutput: "working", lastSeq: 4 };
    const overlay = runEventToOverlay(runEvent({ kind: "blocker", text: "Waiting on approval", seq: 5 }), previous);
    expect(overlay.state).toBe("blocked");
    expect(overlay.progress).toBe(48); // held, not advanced
    expect(overlay.lastOutput).toBe("Waiting on approval");
    expect(overlay.lastSeq).toBe(5);
  });

  test("progress climbs monotonically and never regresses below the prior overlay", () => {
    const previous: RunEventOverlay = { state: "active", progress: 60, lastOutput: "prior", lastSeq: 6 };
    // A lower-seq event must not drag progress backwards.
    const overlay = runEventToOverlay(runEvent({ kind: "state", text: "tick", seq: 1 }), previous);
    expect(overlay.progress).toBe(60);
    expect(overlay.lastSeq).toBe(6); // max(prior 6, event 1)
  });

  test("active progress is capped below 100 while the run is still streaming", () => {
    const overlay = runEventToOverlay(runEvent({ kind: "state", text: "tick", seq: 1_000 }));
    expect(overlay.progress).toBe(95);
  });
});

// ISSUE-0021 integration: feeding gateway frames through the driver's stream
// folds them into the per-UPID overlay, deduping replays so a reconnect that
// re-emits the afterSeq boundary frame is not double-applied.
describe("RunEventDriver — streamed frames overlay the process panel for a spawned upid", () => {
  test("subscribed frames populate the overlay and onUpdate fires per applied frame", async () => {
    const client = new ScriptedStreamClient([
      [
        frame("node.started", { summary: "Parsing the project layout" }, 1),
        frame("node.output", { summary: "Implemented the parser module" }, 2),
      ],
    ]);
    const updates: Array<{ upid: string; overlay: RunEventOverlay }> = [];
    const driver = new RunEventDriver({
      client,
      onUpdate: (upid, overlay) => updates.push({ upid, overlay }),
    });

    expect(driver.overlay("upid-live")).toBeUndefined();

    await driver.subscribe("upid-live", "vibersyn-upid-live");

    const overlay = driver.overlay("upid-live");
    expect(overlay?.state).toBe("active");
    expect(overlay?.progress).toBe(24); // last applied seq 2 * 12
    expect(overlay?.lastOutput).toBe("Implemented the parser module");
    expect(overlay?.lastSeq).toBe(2);

    // Each applied frame republished exactly once, in order.
    expect(updates.map((entry) => entry.overlay.lastSeq)).toEqual([1, 2]);
    expect(client.afterSeqByCall).toEqual([0]); // a single connection, started at 0
  });

  test("a reconnect that replays the boundary frame does not double-apply it", async () => {
    // First connection yields seq 1 then throws; the driver reconnects with
    // afterSeq=1 and the gateway replays seq 1 (boundary) before seq 2. The seq
    // guard must drop the replayed seq 1 and apply seq 2 once.
    const client = new ScriptedStreamClient([
      { frames: [frame("node.started", { summary: "first" }, 1)], thenThrow: true },
      { frames: [frame("node.started", { summary: "first" }, 1), frame("task.finished", { summary: "second" }, 2)] },
    ]);
    const updates: RunEventOverlay[] = [];
    const driver = new RunEventDriver({
      client,
      reconnectDelayMs: 0,
      onUpdate: (_upid, overlay) => updates.push(overlay),
    });

    await driver.subscribe("upid-reconnect", "vibersyn-upid-reconnect");

    // seq 1 applied once (first connection), the replay dropped, seq 2 applied once.
    expect(updates.map((overlay) => overlay.lastSeq)).toEqual([1, 2]);
    expect(driver.overlay("upid-reconnect")?.lastOutput).toBe("second");
    expect(driver.overlay("upid-reconnect")?.lastSeq).toBe(2);
    // The reconnect resumed after the last applied seq, not from scratch.
    expect(client.afterSeqByCall).toEqual([0, 1]);
  });
});

function runEvent(partial: Partial<RunEvent> & Pick<RunEvent, "kind" | "text" | "seq">): RunEvent {
  return {
    upid: partial.upid ?? "upid-live",
    runId: partial.runId ?? "vibersyn-upid-live",
    kind: partial.kind,
    text: partial.text,
    seq: partial.seq,
  };
}

function frame(event: string, payload: Record<string, unknown>, seq: number): GatewayEventFrame {
  return { event, payload: { ...payload, seq }, seq };
}

interface ScriptedConnection {
  frames: GatewayEventFrame[];
  thenThrow?: boolean;
}

// A streamRunEvents stub that replays a script of connections: each subscribe()
// reconnect attempt consumes the next connection. Records the afterSeq the driver
// resumed each connection with so a test can assert the dedup watermark.
class ScriptedStreamClient implements RunEventStreamClient {
  readonly afterSeqByCall: number[] = [];
  #connections: ScriptedConnection[];

  constructor(script: Array<GatewayEventFrame[] | ScriptedConnection>) {
    this.#connections = script.map((entry) => (Array.isArray(entry) ? { frames: entry } : entry));
  }

  async *streamRunEvents(_upid: string, options?: StreamRunEventsOptions): AsyncIterable<GatewayEventFrame> {
    this.afterSeqByCall.push(options?.afterSeq ?? 0);
    const connection = this.#connections.shift();
    if (connection === undefined) {
      return;
    }
    for (const frame of connection.frames) {
      yield frame;
    }
    if (connection.thenThrow === true) {
      throw new Error("scripted stream drop");
    }
  }
}
