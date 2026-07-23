import { describe, expect, test } from "bun:test";
import { ProcessRegistry, type RegistryProcess } from "../process/registry";
import { MemorySmithersClient } from "../process/test-helpers";
import type { DispatchedAction, LogEvent, OutputDecision, TranscriptObservation } from "../types";
import type { ActiveProcess, DispatchContext } from "./dispatch";
import { routeUtteranceToSeam, type SeamLike } from "./seam-bridge";
import { SteeringWindowManager } from "./steering-window";

describe("REQ-12 spoken panic halt", () => {
  test("Abort halts only the selected process and emits E5 plus short TTS within the safety budget", async () => {
    const { client, registry, traces } = await seededRegistry();
    registry.select("upid-atlas", "corr-select-atlas");
    const outputs: OutputDecision[] = [];
    const seam = registrySeam(registry);

    const startedAt = performance.now();
    const routed = await routeUtteranceToSeam(observation("Abort"), contextFromRegistry(registry), seam, {
      onOutput: (output) => {
        outputs.push(output);
      },
    });
    const measuredMs = performance.now() - startedAt;

    expect(measuredMs).toBeLessThanOrEqual(1_000);
    expect(routed.decision.kind).toBe("action");
    if (routed.decision.kind === "action") {
      expect(routed.decision.commandId).toBe("panic");
      expect(routed.decision.ackKind).toBe("state-earcon");
      expect(routed.decision.action).toEqual(
        expect.objectContaining({
          type: "halt",
          targetUPID: "upid-atlas",
          payload: expect.objectContaining({ trigger: "panic" }),
        }),
      );
    }
    expect(client.calls.filter((call) => call.name === "halt").map((call) => call.upid)).toEqual(["upid-atlas"]);
    expect(processHaltUPIDs(traces)).toEqual(["upid-atlas"]);
    expect(traces).toContainEqual(
      expect.objectContaining({
        event: "process.halt",
        upid: "upid-atlas",
        meta: expect.objectContaining({ trigger: "panic" }),
      }),
    );
    expect(registry.records()).toContainEqual(expect.objectContaining({ upid: "upid-atlas", state: "dead" }));
    expect(registry.records()).toContainEqual(expect.objectContaining({ upid: "upid-bravo", state: "active" }));
    expect(outputs).toEqual(routed.outputs);
    expect(outputs).toContainEqual({ channel: "earcon", id: "E5" });
    expect(outputs).toContainEqual(
      expect.objectContaining({
        channel: "tts",
        wordCount: expect.any(Number),
      }),
    );
    const tts = outputs.find((output): output is Extract<OutputDecision, { channel: "tts" }> => output.channel === "tts");
    expect(tts).toBeDefined();
    // Count the ACTUAL spoken text, not the (potentially lying) wordCount metadata.
    const spokenWords = (tts?.text ?? "").trim().split(/\s+/u).filter(Boolean);
    expect(spokenWords.length).toBeLessThanOrEqual(15);
    expect(tts?.wordCount).toBe(spokenWords.length);
  });

  test("Abort with multiple active processes and no focus is a near-miss — no halt, no feedback", async () => {
    const { client, registry, traces } = await seededRegistry();
    // No callsign, no open window, multiple active and none selected => nothing
    // unambiguous to halt. Panic must not halt a process or speak "Halting".
    const context: DispatchContext = {
      sessionId: "panic-halt-test",
      activeProcesses: [
        { upid: "upid-atlas", callsign: "Atlas", state: "active", selected: false },
        { upid: "upid-bravo", callsign: "Bravo", state: "active", selected: false },
      ],
      nowMs: 50_000,
      confidence: 1,
    };
    const outputs: OutputDecision[] = [];
    const routed = await routeUtteranceToSeam(observation("Abort"), context, registrySeam(registry), {
      onOutput: (output) => {
        outputs.push(output);
      },
    });

    expect(routed.decision.kind).not.toBe("action");
    expect(client.calls.filter((call) => call.name === "halt")).toEqual([]);
    expect(processHaltUPIDs(traces)).toEqual([]);
    expect(registry.records()).toContainEqual(expect.objectContaining({ upid: "upid-atlas", state: "active" }));
    expect(registry.records()).toContainEqual(expect.objectContaining({ upid: "upid-bravo", state: "active" }));
    expect(outputs).toEqual([]);
  });

  test("steering-window Abort closes the window and emits a halt for only the open target", async () => {
    const { registry, traces } = await seededRegistry();
    const actions: DispatchedAction[] = [];
    const outputs: OutputDecision[] = [];
    const manager = new SteeringWindowManager({
      processes: activeProcessesFromRegistry(registry),
      sessionId: "panic-halt-test",
      clock: () => 50_000,
      onAction: (action) => actions.push(action),
      onOutput: (output) => outputs.push(output),
    });

    manager.ingestUtterance(steeringUtterance("Atlas", "utt-open-atlas", 50_000));
    const closed = manager.ingestUtterance(steeringUtterance("Abort", "utt-abort-atlas", 50_100));

    expect(closed).toEqual(
      expect.objectContaining({
        kind: "closed",
        reason: "abort",
        closedWindow: expect.objectContaining({ targetUPID: "upid-atlas" }),
        action: expect.objectContaining({ type: "halt", targetUPID: "upid-atlas" }),
      }),
    );
    expect(manager.activeWindow()).toBeNull();
    expect(actions).toEqual([expect.objectContaining({ type: "halt", targetUPID: "upid-atlas" })]);
    expect(outputs).toEqual(closed.kind === "closed" ? closed.outputs : []);
    expect(outputs).toContainEqual({ channel: "earcon", id: "E5" });

    await dispatchToRegistry(registry, actions[0]);

    expect(processHaltUPIDs(traces)).toEqual(["upid-atlas"]);
    expect(registry.records()).toContainEqual(expect.objectContaining({ upid: "upid-atlas", state: "dead" }));
    expect(registry.records()).toContainEqual(expect.objectContaining({ upid: "upid-bravo", state: "active" }));
  });
});

async function seededRegistry(): Promise<{
  client: MemorySmithersClient;
  registry: ProcessRegistry;
  traces: LogEvent[];
}> {
  const client = new MemorySmithersClient();
  const traces: LogEvent[] = [];
  const registry = new ProcessRegistry({
    client,
    sessionId: "panic-halt-test",
    onTrace: (event) => traces.push(event),
  });
  await registry.spawn({ correlationId: "corr-spawn-atlas", upid: "upid-atlas", callsign: "Atlas", workflow: "wf" });
  await registry.spawn({ correlationId: "corr-spawn-bravo", upid: "upid-bravo", callsign: "Bravo", workflow: "wf" });
  // TWO-STAGE PIVOT: spoken panic must cancel the DURABLE run when one exists,
  // so this REQ-12 slice commissions both processes (client.halt only fires for
  // commissioned processes; a kickoff-only process halts registry-side).
  await registry.execute("upid-atlas");
  await registry.execute("upid-bravo");
  registry.advanceAutonomousTick("corr-running");
  return { client, registry, traces };
}

function registrySeam(registry: ProcessRegistry): SeamLike<{ accepted: true; actionType: DispatchedAction["type"]; targetUPID: string | null }> {
  return {
    async dispatch(action) {
      await dispatchToRegistry(registry, action);
      return { accepted: true, actionType: action.type, targetUPID: action.targetUPID };
    },
  };
}

async function dispatchToRegistry(registry: ProcessRegistry, action: DispatchedAction): Promise<void> {
  if (action.type !== "halt" || action.targetUPID === null) {
    throw new Error(`Expected targeted halt action, got ${action.type}.`);
  }
  await registry.halt(action.targetUPID, action.correlationId, triggerFromPayload(action.payload));
}

function contextFromRegistry(registry: ProcessRegistry): DispatchContext {
  return {
    sessionId: "panic-halt-test",
    activeProcesses: activeProcessesFromRegistry(registry),
    nowMs: 50_000,
    confidence: 1,
  };
}

function activeProcessesFromRegistry(registry: ProcessRegistry): ActiveProcess[] {
  return registry.activeRecords().map((record) => ({
    upid: record.upid,
    callsign: record.callsign,
    state: dispatchState(record),
    selected: record.selected,
  }));
}

function dispatchState(record: RegistryProcess): ActiveProcess["state"] {
  return record.state === "dead" ? "halted" : record.state;
}

function observation(text: string): TranscriptObservation {
  return {
    text,
    isFinal: true,
    speaker: "speaker_0",
    sessionId: "panic-halt-test",
    latencyMs: 8,
    utteranceId: `utt-${text.toLowerCase()}`,
  };
}

function steeringUtterance(text: string, utteranceId: string, nowMs: number) {
  return {
    text,
    utteranceId,
    correlationId: `corr-${utteranceId}`,
    sessionId: "panic-halt-test",
    nowMs,
  };
}

function processHaltUPIDs(traces: readonly LogEvent[]): string[] {
  return traces.filter((event) => event.event === "process.halt").map((event) => event.upid ?? "").sort();
}

function triggerFromPayload(payload: unknown): string {
  if (payload !== null && typeof payload === "object" && "trigger" in payload && typeof payload.trigger === "string") {
    return payload.trigger;
  }
  return "panic";
}
