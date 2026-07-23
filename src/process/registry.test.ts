import { describe, expect, test } from "bun:test";
import type { ProcessBuildSnapshot } from "../buildloop/orchestrator";
import { MemorySmithersClient } from "./test-helpers";
import { ProcessRegistry, steerText, type BuildLoopOrchestrator } from "./registry";

describe("process registry", () => {
  test("AC13.1 holds two live processes with independent state — and a KICKOFF spawn never launches the durable run", async () => {
    const client = new MemorySmithersClient();
    const registry = new ProcessRegistry({ client, sessionId: "registry-concurrent" });

    const first = await registry.spawn({ correlationId: "corr-a", upid: "upid-a", workflow: "wf" });
    const second = await registry.spawn({ correlationId: "corr-b", upid: "upid-b", workflow: "wf" });

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    // TWO-STAGE PIVOT: accept is kickoff only (mocks + deck). The durable
    // gateway run is NOT launched at spawn — no client.spawn until execute().
    expect(client.calls.filter((call) => call.name === "spawn")).toHaveLength(0);
    // The runId is pre-assigned deterministically so it stays stable when a
    // later execute() launches the run under it.
    expect(first.accepted && first.spawn.runId).toBe("vibersyn-upid-a");
    expect(registry.records()).toEqual([
      expect.objectContaining({ upid: "upid-a", callsign: "virellium", state: "planning", selected: false }),
      expect.objectContaining({ upid: "upid-b", callsign: "quoravex", state: "planning", selected: true }),
    ]);
    expect(registry.statusSummary().split(/\s+/u).length).toBeLessThanOrEqual(15);
    expect(registry.statusSummary()).toBe("virellium planning; quoravex planning");
  });

  test("AC8.2 isolation: mutating A leaves B byte-for-byte unchanged; the durable steer fires only once commissioned", async () => {
    const client = new MemorySmithersClient();
    const registry = new ProcessRegistry({ client, sessionId: "registry-isolation" });
    await registry.spawn({ correlationId: "corr-a", upid: "upid-a", workflow: "wf" });
    await registry.spawn({ correlationId: "corr-b", upid: "upid-b", workflow: "wf" });

    // Pre-commission steer: registry state advances, but there is no durable
    // run to signal, so the smithers client is untouched.
    await registry.steer("upid-a", { command: "make it faster" }, "corr-steer-a-kickoff");
    expect(client.calls.filter((call) => call.name === "steer")).toHaveLength(0);

    await registry.execute("upid-a");
    const beforeB = registry.records().find((record) => record.upid === "upid-b");

    await registry.steer("upid-a", { command: "make it faster" }, "corr-steer-a");

    const afterB = registry.records().find((record) => record.upid === "upid-b");
    expect(afterB).toEqual(beforeB);
    expect(client.calls).toContainEqual({ name: "steer", upid: "upid-a", payload: { command: "make it faster" } });
  });

  test("per-process pause and resume call only the target COMMISSIONED UPID", async () => {
    const client = new MemorySmithersClient();
    const registry = new ProcessRegistry({ client, sessionId: "registry-pause" });
    await registry.spawn({ correlationId: "corr-a", upid: "upid-a", workflow: "wf" });
    await registry.spawn({ correlationId: "corr-b", upid: "upid-b", workflow: "wf" });
    await registry.execute("upid-a");
    await registry.execute("upid-b");
    registry.advanceAutonomousTick("corr-tick");

    await registry.pause("upid-b", "corr-pause-b");
    expect(registry.records().find((record) => record.upid === "upid-b")).toEqual(expect.objectContaining({ state: "paused" }));
    expect(registry.records().find((record) => record.upid === "upid-a")).toEqual(expect.objectContaining({ state: "active" }));
    expect(client.calls.filter((call) => call.name === "pause")).toEqual([{ name: "pause", upid: "upid-b" }]);

    await registry.resume("upid-b", "corr-resume-b");
    expect(registry.records().find((record) => record.upid === "upid-b")).toEqual(expect.objectContaining({ state: "active" }));
    expect(client.calls.filter((call) => call.name === "resume")).toEqual([{ name: "resume", upid: "upid-b" }]);
  });

  test("a kickoff-only (never commissioned) process pauses/resumes registry-side without touching the client", async () => {
    const client = new MemorySmithersClient();
    const registry = new ProcessRegistry({ client, sessionId: "registry-pause-kickoff" });
    await registry.spawn({ correlationId: "corr-a", upid: "upid-a", workflow: "wf" });
    registry.advanceAutonomousTick("corr-tick");

    await registry.pause("upid-a", "corr-pause-a");
    expect(registry.records().find((record) => record.upid === "upid-a")).toEqual(expect.objectContaining({ state: "paused" }));
    await registry.resume("upid-a", "corr-resume-a");
    expect(registry.records().find((record) => record.upid === "upid-a")).toEqual(expect.objectContaining({ state: "active" }));
    expect(client.calls).toHaveLength(0);
  });

  test("pauseAll iterates the registry using the same per-UPID pause path", async () => {
    const client = new MemorySmithersClient();
    const registry = new ProcessRegistry({ client, sessionId: "registry-pause-all" });
    await registry.spawn({ correlationId: "corr-a", upid: "upid-a", workflow: "wf" });
    await registry.spawn({ correlationId: "corr-b", upid: "upid-b", workflow: "wf" });
    await registry.execute("upid-a");
    await registry.execute("upid-b");
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

  async start(input: {
    upid: string;
    ideaId: string;
    prompt: string;
    callsign: string | null;
    planQuestions?: readonly { id: string; prompt: string; answers: string[] }[];
  }): Promise<void> {
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

  test("a build:true spawn derives deck planQuestions from the accept seed's mcqs/answers", async () => {
    const orchestrator = new FakeOrchestrator();
    const registry = new ProcessRegistry({ client: new MemorySmithersClient(), sessionId: "reg-orch-q", orchestrator });

    // The acceptance seam spreads the accepted seed onto the spawn input, so
    // the judge's parallel questions/answers arrays ride as mcqs/answers.
    await registry.spawn({
      correlationId: "corr-accept-q",
      upid: "upid-q",
      workflow: "wf",
      prompt: "build a metronome",
      input: { pitch: "build a metronome", mcqs: ["Which sound set?"], answers: ["Wood / Electronic"] },
      build: true,
    });
    await Bun.sleep(0);

    const start = orchestrator.calls.find((call) => call.name === "start" && call.upid === "upid-q");
    const input = start?.input as { planQuestions?: Array<{ id: string; prompt: string; answers: string[] }> };
    expect(input.planQuestions).toHaveLength(1);
    expect(input.planQuestions?.[0]?.id).toMatch(/^q-/u);
    expect(input.planQuestions?.[0]?.prompt).toBe("Which sound set?");
    expect(input.planQuestions?.[0]?.answers).toEqual(["Wood", "Electronic"]);

    // A repo-import style input without the arrays omits the field entirely.
    await registry.spawn({
      correlationId: "corr-import",
      upid: "upid-plain",
      workflow: "wf",
      prompt: "ground a concept in the imported repo",
      input: { source: "github-import", pitch: "ground a concept in the imported repo" },
      build: true,
    });
    await Bun.sleep(0);

    const plain = orchestrator.calls.find((call) => call.name === "start" && call.upid === "upid-plain");
    expect(Object.keys(plain?.input as Record<string, unknown>)).not.toContain("planQuestions");
  });

  test("an explicit startBuild planQuestions override beats the input-derived mcqs/answers", async () => {
    const orchestrator = new FakeOrchestrator();
    const registry = new ProcessRegistry({ client: new MemorySmithersClient(), sessionId: "reg-orch-q-override", orchestrator });

    // The deferred-build shape (the phone import's clone routine): spawn
    // WITHOUT build, then kick startBuild directly with drafted questions.
    // The input still carries mcqs/answers that would derive a different
    // card — the explicit override must win.
    await registry.spawn({
      correlationId: "corr-import-q",
      upid: "upid-import",
      workflow: "wf",
      prompt: "seed pitch",
      input: { pitch: "seed pitch", mcqs: ["From the input?"], answers: ["A / B"] },
    });
    const drafted = [{ id: "q-drafted-1", prompt: "How bold should the first addition be?", answers: ["Small", "Ambitious"] }];
    const kicked = registry.startBuild("upid-import", {
      correlationId: "corr-kick",
      prompt: "enriched pitch",
      planQuestions: drafted,
    });
    expect(kicked).toBe(true);
    await Bun.sleep(0);

    const start = orchestrator.calls.find((call) => call.name === "start" && call.upid === "upid-import");
    const input = start?.input as { prompt?: string; planQuestions?: unknown };
    expect(input.prompt).toBe("enriched pitch");
    expect(input.planQuestions).toEqual(drafted);

    // An EMPTY override is not an override — input derivation still applies.
    await registry.spawn({
      correlationId: "corr-import-q2",
      upid: "upid-import-2",
      workflow: "wf",
      prompt: "seed pitch",
      input: { pitch: "seed pitch", mcqs: ["From the input?"], answers: ["A / B"] },
    });
    registry.startBuild("upid-import-2", { correlationId: "corr-kick-2", planQuestions: [] });
    await Bun.sleep(0);

    const second = orchestrator.calls.find((call) => call.name === "start" && call.upid === "upid-import-2");
    const derived = second?.input as { planQuestions?: Array<{ prompt: string }> };
    expect(derived.planQuestions?.map((question) => question.prompt)).toEqual(["From the input?"]);
  });

  test("a bare spawn (demo seed, no build flag) never reaches the orchestrator", async () => {
    const orchestrator = new FakeOrchestrator();
    const registry = new ProcessRegistry({ client: new MemorySmithersClient(), sessionId: "reg-orch-bare", orchestrator });
    await registry.spawn({ correlationId: "corr-a", upid: "upid-a", workflow: "wf" });
    await Bun.sleep(0);
    expect(orchestrator.calls).toEqual([]);
  });

  test("steer forwards the correction to the orchestrator; the smithers client only once commissioned", async () => {
    const client = new MemorySmithersClient();
    const orchestrator = new FakeOrchestrator();
    const registry = new ProcessRegistry({ client, sessionId: "reg-orch-steer", orchestrator });
    await registry.spawn({ correlationId: "corr-a", upid: "upid-a", workflow: "wf" });

    // Kickoff-stage steer: the mock re-run fires, the durable client does not
    // (no run exists yet).
    await registry.steer("upid-a", { text: "make it purple", source: "live-transcript" }, "corr-steer");
    await Bun.sleep(0);
    expect(orchestrator.calls).toContainEqual({ name: "steer", upid: "upid-a", text: "make it purple" });
    expect(client.calls.filter((call) => call.name === "steer")).toHaveLength(0);

    // After the commission, BOTH paths fire.
    await registry.execute("upid-a");
    await registry.steer("upid-a", { text: "now neon", source: "live-transcript" }, "corr-steer-2");
    await Bun.sleep(0);
    expect(client.calls).toContainEqual({
      name: "steer",
      upid: "upid-a",
      payload: { text: "now neon", source: "live-transcript" },
    });
    expect(orchestrator.calls).toContainEqual({ name: "steer", upid: "upid-a", text: "now neon" });
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

describe("process registry × commission (execute)", () => {
  test("execute launches the durable run once with the kickoff pitch and a stable idempotent correlation", async () => {
    const client = new MemorySmithersClient();
    const registry = new ProcessRegistry({ client, sessionId: "reg-exec" });
    await registry.spawn({
      correlationId: "corr-accept",
      upid: "upid-a",
      workflow: "vibersyn-process",
      prompt: "build a metronome",
      build: true,
    });
    expect(client.calls.filter((call) => call.name === "spawn")).toHaveLength(0);
    expect(registry.execution("upid-a")).toBeNull();

    const result = await registry.execute("upid-a");
    expect(result.started).toBe(true);
    expect(result.started && result.runId).toBe("vibersyn-upid-a");
    expect(client.calls.filter((call) => call.name === "spawn")).toEqual([{ name: "spawn", upid: "upid-a" }]);
    // The lane is visible on the snapshot fragment (minimal, without a wired
    // ExecutionRegistry).
    expect(registry.execution("upid-a")).toEqual(
      expect.objectContaining({ status: "executing", runId: "vibersyn-upid-a", percent: 0, previewUrl: null }),
    );
    expect(registry.records().find((record) => record.upid === "upid-a")?.lastAction).toBe("execute");
  });

  test("execute is idempotent: a second call reports already-executing and never double-launches", async () => {
    const client = new MemorySmithersClient();
    const registry = new ProcessRegistry({ client, sessionId: "reg-exec-idem" });
    await registry.spawn({ correlationId: "corr-a", upid: "upid-a", workflow: "wf" });

    const first = await registry.execute("upid-a");
    const second = await registry.execute("upid-a");
    expect(first.started).toBe(true);
    expect(second.started).toBe(false);
    expect(!second.started && second.reason).toBe("already-executing");
    expect(client.calls.filter((call) => call.name === "spawn")).toHaveLength(1);
  });

  test("execute on an unknown or dead UPID throws instead of launching an orphan run", async () => {
    const client = new MemorySmithersClient();
    const registry = new ProcessRegistry({ client, sessionId: "reg-exec-dead" });
    await expect(registry.execute("upid-missing")).rejects.toThrow(/No process/u);

    await registry.spawn({ correlationId: "corr-a", upid: "upid-a", workflow: "wf" });
    await registry.halt("upid-a", "corr-halt");
    await expect(registry.execute("upid-a")).rejects.toThrow(/dead/u);
    expect(client.calls.filter((call) => call.name === "spawn")).toHaveLength(0);
  });

  test("halt cancels the durable run and tears down the execution lane only for commissioned processes", async () => {
    const client = new MemorySmithersClient();
    const stopped: string[] = [];
    const registry = new ProcessRegistry({
      client,
      sessionId: "reg-exec-halt",
      execution: {
        start: (upid, runId) => ({
          status: "executing",
          runId,
          percent: 0,
          label: "commissioned",
          previewUrl: null,
          startedAtMs: 0,
          error: null,
        }),
        snapshot: () => null,
        isExecuting: () => true,
        stop: async (upid) => {
          stopped.push(upid);
        },
      },
    });
    await registry.spawn({ correlationId: "corr-a", upid: "upid-a", workflow: "wf" });
    await registry.spawn({ correlationId: "corr-b", upid: "upid-b", workflow: "wf" });
    await registry.execute("upid-a");

    await registry.halt("upid-a", "corr-halt-a");
    await registry.halt("upid-b", "corr-halt-b");

    // Only the commissioned process had a run to cancel...
    expect(client.calls.filter((call) => call.name === "halt")).toEqual([{ name: "halt", upid: "upid-a" }]);
    // ...but the lane teardown is unconditional (defensive against races).
    expect(stopped).toEqual(["upid-a", "upid-b"]);
    expect(registry.activeRecords()).toHaveLength(0);
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
