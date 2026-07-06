import { describe, expect, test } from "bun:test";
import { MemorySmithersClient } from "./test-helpers";
import { ProcessRegistry } from "./registry";
import { CAPACITY_REFUSAL_ACK, checkPreSpawnResources } from "./resource-check";

describe("pre-spawn resource check", () => {
  test("AC15.2 refuses at the V0 cap, leaves the registry unchanged, acks, and logs spawn.refused", async () => {
    const traces: unknown[] = [];
    const output: unknown[] = [];
    const registry = new ProcessRegistry({
      client: new MemorySmithersClient(),
      sessionId: "resource-cap",
      onTrace: (event) => traces.push(event),
      onOutput: (decision) => output.push(decision),
    });

    await registry.spawn({ correlationId: "corr-a", upid: "upid-a", callsign: "virellium", workflow: "wf" });
    await registry.spawn({ correlationId: "corr-b", upid: "upid-b", callsign: "quoravex", workflow: "wf" });
    const before = registry.records();

    const result = await registry.spawn({ correlationId: "corr-c", upid: "upid-c", callsign: "zelanori", workflow: "wf" });

    expect(result).toEqual(
      expect.objectContaining({
        accepted: false,
        reason: "capacity",
        spokenAck: CAPACITY_REFUSAL_ACK,
      }),
    );
    expect(registry.records()).toEqual(before);
    expect(output).toContainEqual(
      expect.objectContaining({
        channel: "tts",
        text: CAPACITY_REFUSAL_ACK,
      }),
    );
    expect(traces).toContainEqual(
      expect.objectContaining({
        event: "spawn.refused",
        correlationId: "corr-c",
        meta: expect.objectContaining({ reason: "capacity" }),
      }),
    );
  });

  test("host headroom below the configurable floor refuses with reason=headroom", async () => {
    const result = await checkPreSpawnResources({
      activeProcessCount: 0,
      correlationId: "corr-headroom",
      sessionId: "resource-headroom",
      minRunSlots: 2,
      minMemoryMB: 512,
      headroom: { runSlotsAvailable: 1, memoryAvailableMB: 2_048 },
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        reason: "headroom",
        event: expect.objectContaining({
          event: "spawn.refused",
          correlationId: "corr-headroom",
          meta: expect.objectContaining({ reason: "headroom" }),
        }),
      }),
    );
  });

  test("host headroom floor can be configured through env", async () => {
    const previous = process.env.VIBERSYN_MIN_MEMORY_MB;
    process.env.VIBERSYN_MIN_MEMORY_MB = "4096";
    try {
      const result = await checkPreSpawnResources({
        activeProcessCount: 0,
        correlationId: "corr-env-headroom",
        headroom: { runSlotsAvailable: 1, memoryAvailableMB: 1_024 },
      });
      expect(result).toEqual(expect.objectContaining({ ok: false, reason: "headroom" }));
    } finally {
      process.env.VIBERSYN_MIN_MEMORY_MB = previous;
    }
  });
});
