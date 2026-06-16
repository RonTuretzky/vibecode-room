import { describe, expect, test } from "bun:test";
import { ProcessRegistry } from "../process/registry";
import { MemorySmithersClient } from "../process/test-helpers";
import type { LogEvent, OutputDecision } from "../types";
import {
  EMERGENCY_STOP_ROUTE,
  EMERGENCY_STOP_SIGNAL_TEXT,
  EmergencySessionState,
  EmergencyStopController,
  createEmergencyStopApp,
  emergencyControlRoutes,
  emergencyControlVerbs,
} from "./stop";

describe("emergency stop controller", () => {
  test("handler halts every registered process, stops listening, ends the session, and logs REQ-14 fields", async () => {
    const client = new MemorySmithersClient();
    const traces: LogEvent[] = [];
    const outputs: OutputDecision[] = [];
    const registry = new ProcessRegistry({ client, sessionId: "emergency-unit", onTrace: (event) => traces.push(event) });
    await registry.spawn({ correlationId: "corr-spawn-a", upid: "upid-a", callsign: "Atlas", workflow: "wf" });
    await registry.spawn({ correlationId: "corr-spawn-b", upid: "upid-b", callsign: "Bravo", workflow: "wf" });
    await registry.pause("upid-b", "corr-pause-b");

    const session = new EmergencySessionState({ sessionId: "emergency-unit" });
    const controller = new EmergencyStopController({
      registry,
      listener: session,
      now: steppedClock([1_000, 1_120]),
      onTrace: (event) => traces.push(event),
      onOutput: (decision) => outputs.push(decision),
    });

    const result = await controller.trigger("corr-emergency-unit");

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        trigger: "non-voice",
        processesHalted: 2,
        latencyMs: 120,
        sessionEnded: true,
        listening: false,
      }),
    );
    expect(registry.activeRecords()).toHaveLength(0);
    expect(session.isListening()).toBe(false);
    expect(session.isSessionEnded()).toBe(true);
    expect(client.calls.filter((call) => call.name === "halt").map((call) => call.upid).sort()).toEqual(["upid-a", "upid-b"]);
    expect(outputs).toEqual([
      { channel: "earcon", id: "E5" },
      { channel: "tts", text: EMERGENCY_STOP_SIGNAL_TEXT, wordCount: 4, summarized: false },
    ]);
    expect(traces).toContainEqual(
      expect.objectContaining({
        event: "emergency.stop",
        correlationId: "corr-emergency-unit",
        latencyMs: 120,
        meta: expect.objectContaining({
          trigger: "non-voice",
          processesHalted: 2,
          sessionEnded: true,
        }),
      }),
    );
  });

  test("scope exposes one route and one verb: kill-all only", async () => {
    const app = createEmergencyStopApp(emptyController());

    expect(emergencyControlRoutes()).toEqual([`POST ${EMERGENCY_STOP_ROUTE}`]);
    expect(emergencyControlVerbs()).toEqual(["kill-all"]);
    for (const route of ["/steer", "/select", "/spawn", "/resume", "/unmute"]) {
      const response = await app.request(route, { method: "POST" });
      expect(response.status).toBe(404);
    }
  });

  test("no unmute or resume verb is available from the emergency control", () => {
    const forbidden = new Set(["unmute", "resume", "listen", "start-listening"]);
    expect(emergencyControlVerbs().some((verb) => forbidden.has(verb))).toBe(false);
    expect(emergencyControlRoutes().some((route) => /unmute|resume|listen/u.test(route))).toBe(false);
  });

  test("trigger emits a loud unambiguous audible signal", async () => {
    const outputs: OutputDecision[] = [];
    const controller = emptyController(outputs);

    await controller.trigger("corr-signal");

    expect(outputs).toContainEqual({ channel: "earcon", id: "E5" });
    expect(outputs).toContainEqual(
      expect.objectContaining({
        channel: "tts",
        text: EMERGENCY_STOP_SIGNAL_TEXT,
        summarized: false,
      }),
    );
  });
});

function emptyController(outputs: OutputDecision[] = []): EmergencyStopController {
  return new EmergencyStopController({
    registry: new ProcessRegistry({ client: new MemorySmithersClient(), sessionId: "empty-emergency" }),
    listener: new EmergencySessionState({ sessionId: "empty-emergency" }),
    onOutput: (decision) => outputs.push(decision),
  });
}

function steppedClock(values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}
