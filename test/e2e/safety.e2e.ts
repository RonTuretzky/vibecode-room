import { describe, expect, test } from "bun:test";
import { ProcessRegistry } from "../../src/process/registry";
import { MemorySmithersClient } from "../../src/process/test-helpers";
import type { LogEvent, OutputDecision } from "../../src/types";
import { EmergencySessionState, EmergencyStopController } from "../../src/emergency/stop";

describe("REQ-14 emergency stop e2e slice", () => {
  test("one non-voice control halts every process and stops listening within 2 seconds, ending the session", async () => {
    const client = new MemorySmithersClient();
    const traces: LogEvent[] = [];
    const outputs: OutputDecision[] = [];
    const registry = new ProcessRegistry({ client, sessionId: "emergency-e2e", onTrace: (event) => traces.push(event) });
    await registry.spawn({ correlationId: "corr-spawn-a", upid: "upid-atlas", callsign: "Atlas", workflow: "wf" });
    await registry.spawn({ correlationId: "corr-spawn-b", upid: "upid-bravo", callsign: "Bravo", workflow: "wf" });
    registry.advanceAutonomousTick("corr-running");

    const session = new EmergencySessionState({ sessionId: "emergency-e2e", listening: true, muted: true });
    const controller = new EmergencyStopController({
      registry,
      listener: session,
      onTrace: (event) => traces.push(event),
      onOutput: (decision) => outputs.push(decision),
    });

    const startedAt = performance.now();
    const result = await controller.trigger("corr-emergency-e2e");
    const measuredMs = performance.now() - startedAt;

    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeLessThanOrEqual(2_000);
    expect(measuredMs).toBeLessThanOrEqual(2_000);
    expect(registry.activeRecords()).toEqual([]);
    expect(session.isListening()).toBe(false);
    expect(session.isSessionEnded()).toBe(true);
    expect(client.calls.filter((call) => call.name === "halt").map((call) => call.upid).sort()).toEqual(["upid-atlas", "upid-bravo"]);
    expect(outputs).toContainEqual({ channel: "earcon", id: "E5" });
    expect(outputs).toContainEqual(expect.objectContaining({ channel: "tts", text: "Emergency stop. Session ended." }));
    expect(traces).toContainEqual(
      expect.objectContaining({
        event: "emergency.stop",
        meta: expect.objectContaining({
          trigger: "non-voice",
          processesHalted: 2,
          sessionEnded: true,
        }),
      }),
    );
  });

  test("emergency stop is kill-all only; a fresh later session starts unmuted and re-speaks consent", async () => {
    const registry = new ProcessRegistry({ client: new MemorySmithersClient(), sessionId: "emergency-fresh" });
    await registry.spawn({ correlationId: "corr-spawn-a", upid: "upid-atlas", callsign: "Atlas", workflow: "wf" });
    const session = new EmergencySessionState({ sessionId: "emergency-fresh", listening: true, muted: true });
    const controller = new EmergencyStopController({ registry, listener: session });

    await controller.trigger("corr-emergency-fresh");

    expect(session.isSessionEnded()).toBe(true);
    expect(session.isListening()).toBe(false);
    expect(session.isMuted()).toBe(true);

    session.startFreshSession();

    expect(session.isSessionEnded()).toBe(false);
    expect(session.isListening()).toBe(true);
    expect(session.isMuted()).toBe(false);
    expect(session.consentAnnouncements()).toBe(1);
    expect(registry.activeRecords()).toEqual([]);
  });
});
