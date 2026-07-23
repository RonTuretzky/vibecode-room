import { describe, expect, test } from "bun:test";
import type { ProjectorProcess } from "./types";
import { executionOf, parseDeckDecisionMessage, stageOf } from "./stage";

function makeProcess(overrides: Record<string, unknown> = {}): ProjectorProcess {
  return {
    upid: "upid_x",
    runId: "run_x",
    callsign: "cs-x",
    state: "active",
    selected: false,
    task: "task x",
    model: "runtime",
    progressLabel: "working",
    progress: 10,
    lastOutput: "",
    lastAction: "spawned",
    events: [],
    ...overrides,
  } as ProjectorProcess;
}

describe("two-stage seam — executionOf", () => {
  test("no execution surface at all → null (pre-pivot server)", () => {
    expect(executionOf(makeProcess())).toBeNull();
    expect(executionOf(makeProcess({ builds: [{ backend: "smithers", status: "ready" }] }))).toBeNull();
  });

  test("process.execution object is normalized (executing with telemetry)", () => {
    const process = makeProcess({
      execution: { status: "executing", progressLabel: "run step 3/9", percent: 34.4 },
    });
    expect(executionOf(process)).toEqual({
      status: "executing",
      previewUrl: null,
      progressLabel: "run step 3/9",
      percent: 34.4,
      summary: null,
    });
  });

  test("built execution carries the full-app preview link", () => {
    const process = makeProcess({
      execution: { status: "built", previewUrl: "http://127.0.0.1:4300/", summary: "Full app." },
    });
    expect(executionOf(process)).toMatchObject({
      status: "built",
      previewUrl: "http://127.0.0.1:4300/",
      summary: "Full app.",
    });
  });

  test("a failed execution surfaces the server's error as the summary", () => {
    const process = makeProcess({
      execution: { status: "failed", label: "run crashed", error: "subscription run exited 1" },
    });
    expect(executionOf(process)).toMatchObject({
      status: "failed",
      progressLabel: "run crashed",
      summary: "subscription run exited 1",
    });
  });

  test("status synonyms normalize (running→executing, ready/complete→built, error→failed)", () => {
    expect(executionOf(makeProcess({ execution: { status: "running" } }))?.status).toBe("executing");
    expect(executionOf(makeProcess({ execution: { status: "complete" } }))?.status).toBe("built");
    expect(executionOf(makeProcess({ execution: { status: "error" } }))?.status).toBe("failed");
  });

  test("a builds[] entry marked as the execution lane is picked up (fallback shape)", () => {
    const byBackend = makeProcess({
      builds: [
        { backend: "smithers", status: "ready" },
        { backend: "execution", status: "building", progressLabel: "subscription run", percent: 12 },
      ],
    });
    expect(executionOf(byBackend)).toMatchObject({ status: "executing", progressLabel: "subscription run" });

    const byStatus = makeProcess({
      builds: [{ backend: "subscription", status: "built", previewUrl: "http://127.0.0.1:9/" }],
    });
    expect(executionOf(byStatus)).toMatchObject({ status: "built", previewUrl: "http://127.0.0.1:9/" });
  });

  test("malformed execution shapes degrade to null, never throw", () => {
    expect(executionOf(makeProcess({ execution: "executing" }))).toBeNull();
    expect(executionOf(makeProcess({ execution: { status: 42 } }))).toBeNull();
    expect(executionOf(makeProcess({ builds: "nope" }))).toBeNull();
    expect(executionOf(makeProcess({ builds: [null, 7, { status: "executing" }] }))).toMatchObject({
      status: "executing",
    });
  });
});

describe("two-stage seam — stageOf", () => {
  test("everything un-commissioned is a concept (including pre-pivot processes)", () => {
    expect(stageOf(makeProcess())).toBe("concept");
    expect(stageOf(makeProcess({ builds: [{ backend: "eliza", status: "ready" }] }))).toBe("concept");
  });

  test("execution telemetry makes a process commissioned", () => {
    expect(stageOf(makeProcess({ execution: { status: "executing" } }))).toBe("commissioned");
    expect(stageOf(makeProcess({ execution: { status: "built" } }))).toBe("commissioned");
  });

  test("an explicit stage string wins in both directions", () => {
    expect(stageOf(makeProcess({ stage: "commissioned" }))).toBe("commissioned");
    // Declared concept beats a stray execution-looking blob.
    expect(stageOf(makeProcess({ stage: "concept", execution: { status: "executing" } }))).toBe("concept");
  });
});

describe("deck decision postMessage bridge", () => {
  test("a well-formed vibersyn:decision message maps to its choice", () => {
    expect(parseDeckDecisionMessage({ type: "vibersyn:decision", choice: "commission" })).toBe("commission");
    expect(parseDeckDecisionMessage({ type: "vibersyn:decision", choice: "execute" })).toBe("commission");
    expect(parseDeckDecisionMessage({ type: "vibersyn:decision", choice: "iterate" })).toBe("iterate");
    expect(parseDeckDecisionMessage({ type: "vibersyn:decision", choice: "concept" })).toBe("done");
    // The generated deck's own decision ids (generator.ts decisionButtons).
    expect(parseDeckDecisionMessage({ type: "vibersyn:decision", choice: "steer" })).toBe("iterate");
    expect(parseDeckDecisionMessage({ type: "vibersyn:decision", choice: "dismiss" })).toBe("done");
  });

  test("anything else is rejected (wrong type, unknown choice, non-objects)", () => {
    expect(parseDeckDecisionMessage({ type: "other", choice: "execute" })).toBeNull();
    expect(parseDeckDecisionMessage({ type: "vibersyn:decision", choice: "rm -rf" })).toBeNull();
    expect(parseDeckDecisionMessage({ type: "vibersyn:decision" })).toBeNull();
    expect(parseDeckDecisionMessage("vibersyn:decision")).toBeNull();
    expect(parseDeckDecisionMessage(null)).toBeNull();
  });
});
