import { describe, expect, test } from "bun:test";
import type { ProcessBuildSnapshot } from "../buildloop/orchestrator";
import { MemorySmithersClient } from "./test-helpers";
import { ProcessRegistry, steerText, type BuildLoopOrchestrator } from "./registry";

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

// A recording fake of the multi-backend build orchestrator seam.
class FakeOrchestrator implements BuildLoopOrchestrator {
  readonly calls: Array<{ name: string; upid?: string; input?: unknown; text?: string }> = [];
  buildsByUpid = new Map<string, ProcessBuildSnapshot[]>();

  async start(input: { upid: string; ideaId: string; prompt: string; callsign: string | null }): Promise<void> {
    this.calls.push({ name: "start", upid: input.upid, input });
  }

  async steer(upid: string, text: string): Promise<void> {
    this.calls.push({ name: "steer", upid, text });
  }

  async abortAll(upid: string): Promise<void> {
    this.calls.push({ name: "abortAll", upid });
  }

  builds(upid: string): ProcessBuildSnapshot[] {
    return this.buildsByUpid.get(upid) ?? [];
  }
}

describe("process registry × build orchestrator", () => {
  test("a build:true spawn fans the accepted idea out through the orchestrator", async () => {
    const orchestrator = new FakeOrchestrator();
    const registry = new ProcessRegistry({ client: new MemorySmithersClient(), sessionId: "reg-orch", orchestrator });

    const result = await registry.spawn({
      correlationId: "corr-accept",
      upid: "upid-a",
      workflow: "wf",
      prompt: "build a metronome",
      build: true,
    });
    expect(result.accepted).toBe(true);
    await Bun.sleep(0); // the fire-and-forget start settles on a microtask

    expect(orchestrator.calls).toContainEqual({
      name: "start",
      upid: "upid-a",
      // Callsign is now INFERRED from the pitch (project-name.ts), not a pool
      // codename — "build" is a stopword, "metronome" is the project.
      input: { upid: "upid-a", ideaId: "upid-a", prompt: "build a metronome", callsign: "metronome" },
    });
  });

  test("a bare spawn (demo seed, no build flag) never reaches the orchestrator", async () => {
    const orchestrator = new FakeOrchestrator();
    const registry = new ProcessRegistry({ client: new MemorySmithersClient(), sessionId: "reg-orch-bare", orchestrator });
    await registry.spawn({ correlationId: "corr-a", upid: "upid-a", workflow: "wf" });
    await Bun.sleep(0);
    expect(orchestrator.calls).toEqual([]);
  });

  test("steer forwards the spoken correction to the orchestrator in addition to the smithers client", async () => {
    const client = new MemorySmithersClient();
    const orchestrator = new FakeOrchestrator();
    const registry = new ProcessRegistry({ client, sessionId: "reg-orch-steer", orchestrator });
    await registry.spawn({ correlationId: "corr-a", upid: "upid-a", workflow: "wf" });

    await registry.steer("upid-a", { text: "make it purple", source: "live-transcript" }, "corr-steer");
    await Bun.sleep(0);

    // BOTH paths fire: the durable smithers-client forward AND the real rebuild.
    expect(client.calls).toContainEqual({
      name: "steer",
      upid: "upid-a",
      payload: { text: "make it purple", source: "live-transcript" },
    });
    expect(orchestrator.calls).toContainEqual({ name: "steer", upid: "upid-a", text: "make it purple" });
  });

  test("halt aborts the UPID's orchestrator builds", async () => {
    const orchestrator = new FakeOrchestrator();
    const registry = new ProcessRegistry({ client: new MemorySmithersClient(), sessionId: "reg-orch-halt", orchestrator });
    await registry.spawn({ correlationId: "corr-a", upid: "upid-a", workflow: "wf" });

    await registry.halt("upid-a", "corr-halt");

    expect(orchestrator.calls).toContainEqual({ name: "abortAll", upid: "upid-a" });
  });

  test("builds() exposes the orchestrator's per-backend snapshot fragment for the merge point", () => {
    const orchestrator = new FakeOrchestrator();
    const fragment: ProcessBuildSnapshot[] = [
      {
        backend: "smithers",
        label: "Smithers",
        status: "ready",
        previewUrl: "http://127.0.0.1:9999/smithers/?v=1",
        summary: "built",
        slideshowUrl: null,
      },
    ];
    orchestrator.buildsByUpid.set("upid-a", fragment);
    const registry = new ProcessRegistry({ client: new MemorySmithersClient(), sessionId: "reg-orch-snap", orchestrator });
    expect(registry.builds("upid-a")).toEqual(fragment);
    expect(registry.builds("upid-unknown")).toEqual([]);

    const bare = new ProcessRegistry({ client: new MemorySmithersClient(), sessionId: "reg-no-orch" });
    expect(bare.builds("upid-a")).toEqual([]);
  });

  test("steerText extracts the correction from the payload shapes the runtime sends", () => {
    expect(steerText({ text: "tighten the layout", source: "live-transcript" })).toBe("tighten the layout");
    expect(steerText("bare string correction")).toBe("bare string correction");
    expect(steerText({ text: "   " })).toBeNull();
    expect(steerText({ command: "no text field" })).toBeNull();
    expect(steerText(42)).toBeNull();
  });
});

describe("llm project naming", () => {
  test("spawn upgrades the deterministic title when the namer resolves, keeping the callsign", async () => {
    const registry = new ProcessRegistry({
      client: new MemorySmithersClient(),
      sessionId: "registry-namer",
      namer: async () => ({ title: "Snow Sip Calculator", handle: "snow" }),
    });

    const result = await registry.spawn({ correlationId: "corr-n", upid: "upid-n", workflow: "wf", prompt: "an app about annual snowfall drinking water" });
    expect(result.accepted).toBe(true);
    await Bun.sleep(0); // fire-and-forget namer settles on a microtask

    const record = registry.records().find((r) => r.upid === "upid-n");
    expect(record?.title).toBe("Snow Sip Calculator");
    expect(record?.callsign).toBe("snowfall"); // spoken handle stays deterministic
  });

  test("a failed namer leaves the deterministic title in place", async () => {
    const registry = new ProcessRegistry({
      client: new MemorySmithersClient(),
      sessionId: "registry-namer-fail",
      namer: async () => null,
    });
    await registry.spawn({ correlationId: "corr-f", upid: "upid-f", workflow: "wf", prompt: "an app about annual snowfall drinking water" });
    await Bun.sleep(0);
    const record = registry.records().find((r) => r.upid === "upid-f");
    expect(record?.title).toBe("Annual Snowfall Drinking App");
    expect(record?.callsign).toBe("snowfall");
  });
});
