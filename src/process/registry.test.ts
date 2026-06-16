import { describe, expect, test } from "bun:test";
import { MemorySmithersClient } from "./test-helpers";
import { ProcessRegistry } from "./registry";

describe("process registry", () => {
  test("AC13.1 holds two live processes with independent state", async () => {
    const client = new MemorySmithersClient();
    const registry = new ProcessRegistry({ client, sessionId: "registry-concurrent" });

    const first = await registry.spawn({ correlationId: "corr-a", upid: "upid-a", workflow: "wf" });
    const second = await registry.spawn({ correlationId: "corr-b", upid: "upid-b", workflow: "wf" });

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    expect(registry.records()).toEqual([
      expect.objectContaining({ upid: "upid-a", callsign: "virellium", state: "planning", selected: false }),
      expect.objectContaining({ upid: "upid-b", callsign: "quoravex", state: "planning", selected: true }),
    ]);
    expect(registry.statusSummary().split(/\s+/u).length).toBeLessThanOrEqual(15);
    expect(registry.statusSummary()).toBe("virellium planning; quoravex planning");
  });

  test("AC8.2 isolation: mutating A leaves B byte-for-byte unchanged", async () => {
    const client = new MemorySmithersClient();
    const registry = new ProcessRegistry({ client, sessionId: "registry-isolation" });
    await registry.spawn({ correlationId: "corr-a", upid: "upid-a", workflow: "wf" });
    await registry.spawn({ correlationId: "corr-b", upid: "upid-b", workflow: "wf" });
    const beforeB = registry.records().find((record) => record.upid === "upid-b");

    await registry.steer("upid-a", { command: "make it faster" }, "corr-steer-a");

    const afterB = registry.records().find((record) => record.upid === "upid-b");
    expect(afterB).toEqual(beforeB);
    expect(client.calls).toContainEqual({ name: "steer", upid: "upid-a", payload: { command: "make it faster" } });
  });

  test("per-process pause and resume call only the target UPID", async () => {
    const client = new MemorySmithersClient();
    const registry = new ProcessRegistry({ client, sessionId: "registry-pause" });
    await registry.spawn({ correlationId: "corr-a", upid: "upid-a", workflow: "wf" });
    await registry.spawn({ correlationId: "corr-b", upid: "upid-b", workflow: "wf" });
    registry.advanceAutonomousTick("corr-tick");

    await registry.pause("upid-b", "corr-pause-b");
    expect(registry.records().find((record) => record.upid === "upid-b")).toEqual(expect.objectContaining({ state: "paused" }));
    expect(registry.records().find((record) => record.upid === "upid-a")).toEqual(expect.objectContaining({ state: "active" }));
    expect(client.calls.filter((call) => call.name === "pause")).toEqual([{ name: "pause", upid: "upid-b" }]);

    await registry.resume("upid-b", "corr-resume-b");
    expect(registry.records().find((record) => record.upid === "upid-b")).toEqual(expect.objectContaining({ state: "active" }));
    expect(client.calls.filter((call) => call.name === "resume")).toEqual([{ name: "resume", upid: "upid-b" }]);
  });

  test("pauseAll iterates the registry using the same per-UPID pause path", async () => {
    const client = new MemorySmithersClient();
    const registry = new ProcessRegistry({ client, sessionId: "registry-pause-all" });
    await registry.spawn({ correlationId: "corr-a", upid: "upid-a", workflow: "wf" });
    await registry.spawn({ correlationId: "corr-b", upid: "upid-b", workflow: "wf" });
    registry.advanceAutonomousTick("corr-tick");

    await registry.pauseAll("corr-pause-all");

    expect(registry.records().map((record) => [record.upid, record.state])).toEqual([
      ["upid-a", "paused"],
      ["upid-b", "paused"],
    ]);
    expect(client.calls.filter((call) => call.name === "pause")).toEqual([
      { name: "pause", upid: "upid-a" },
      { name: "pause", upid: "upid-b" },
    ]);
  });

  test("AC13.3 unselected processes keep advancing and selection never pauses siblings", async () => {
    const registry = new ProcessRegistry({ client: new MemorySmithersClient(), sessionId: "registry-unselected" });
    await registry.spawn({ correlationId: "corr-a", upid: "upid-a", workflow: "wf" });
    await registry.spawn({ correlationId: "corr-b", upid: "upid-b", workflow: "wf" });
    registry.clearSelection("corr-clear");

    registry.advanceAutonomousTick("corr-tick-1");
    registry.advanceAutonomousTick("corr-tick-2");

    expect(registry.records()).toEqual([
      expect.objectContaining({ upid: "upid-a", selected: false, state: "active", progressSeq: 2 }),
      expect.objectContaining({ upid: "upid-b", selected: false, state: "active", progressSeq: 2 }),
    ]);
  });

  test("free-form natural language pause without target UPID has no registry command path", async () => {
    const registry = new ProcessRegistry({ client: new MemorySmithersClient(), sessionId: "registry-no-nl" });
    await registry.spawn({ correlationId: "corr-a", upid: "upid-a", workflow: "wf" });

    await expect(registry.pause("pause the second one" as never, "corr-nl")).rejects.toThrow(/No process/u);
  });
});
