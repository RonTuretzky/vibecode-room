import { describe, expect, test } from "bun:test";
import { backendsOf, buildsOf, lifecycleActionsFor, looksLikeSnapshot } from "./buildloop";
import type { ProjectorProcess, ProjectorSnapshot } from "./types";
import { demoProjectorSnapshot } from "./demo-data";

const baseProcess: ProjectorProcess = demoProjectorSnapshot.processes[0]!;

describe("buildsOf", () => {
  test("no builds[] (old server / demo fixture) -> []", () => {
    expect(buildsOf(baseProcess)).toEqual([]);
  });

  test("malformed builds[] -> [] (never throws)", () => {
    const process = { ...baseProcess, builds: "nope" } as unknown as ProjectorProcess;
    expect(buildsOf(process)).toEqual([]);
  });

  test("drops entries missing a backend id or an unknown status; keeps valid ones", () => {
    const process = {
      ...baseProcess,
      builds: [
        { backend: "smithers", status: "building", percent: 40, progressLabel: "scaffolding" },
        { status: "ready" }, // no backend id
        { backend: "native", status: "bogus" }, // unknown status
        { backend: "native", status: "ready", previewUrl: "http://x/", slideshowUrl: "http://x/slides" },
      ],
    } as unknown as ProjectorProcess;

    const builds = buildsOf(process);
    expect(builds).toHaveLength(2);
    expect(builds[0]).toMatchObject({ backend: "smithers", status: "building", percent: 40, progressLabel: "scaffolding" });
    expect(builds[1]).toMatchObject({ backend: "native", status: "ready", previewUrl: "http://x/", slideshowUrl: "http://x/slides" });
  });

  test("percent clamps into [0, 100]", () => {
    const process = {
      ...baseProcess,
      builds: [{ backend: "smithers", status: "building", percent: 140 }],
    } as unknown as ProjectorProcess;
    expect(buildsOf(process)[0]?.percent).toBe(100);
  });
});

describe("backendsOf", () => {
  test("no backends[] (old server) -> []", () => {
    expect(backendsOf(demoProjectorSnapshot)).toEqual([]);
  });

  test("malformed backends[] -> [] (never throws)", () => {
    const snapshot = { ...demoProjectorSnapshot, backends: { not: "an array" } } as unknown as ProjectorSnapshot;
    expect(backendsOf(snapshot)).toEqual([]);
  });

  test("normalizes entries, defaulting label to id and enabled/available to false", () => {
    const snapshot = {
      ...demoProjectorSnapshot,
      backends: [{ id: "eliza" }, { id: "native", label: "Native", enabled: true, available: true }],
    } as unknown as ProjectorSnapshot;
    const backends = backendsOf(snapshot);
    expect(backends).toEqual([
      { id: "eliza", label: "eliza", enabled: false, available: false, reason: undefined },
      { id: "native", label: "Native", enabled: true, available: true, reason: undefined },
    ]);
  });
});

describe("looksLikeSnapshot", () => {
  test("accepts a real projector snapshot", () => {
    expect(looksLikeSnapshot(demoProjectorSnapshot)).toBe(true);
  });

  test("rejects a thin ack and other non-snapshot bodies", () => {
    expect(looksLikeSnapshot({ ok: true })).toBe(false);
    expect(looksLikeSnapshot(null)).toBe(false);
    expect(looksLikeSnapshot("snapshot")).toBe(false);
    expect(looksLikeSnapshot({ sessionId: "x", processes: [] })).toBe(false); // missing suggestion
  });
});

describe("lifecycleActionsFor", () => {
  test("active/planning offer pause + halt", () => {
    expect(lifecycleActionsFor("active")).toEqual(["pause", "halt"]);
    expect(lifecycleActionsFor("planning")).toEqual(["pause", "halt"]);
  });

  test("paused/blocked offer resume + halt", () => {
    expect(lifecycleActionsFor("paused")).toEqual(["resume", "halt"]);
    expect(lifecycleActionsFor("blocked")).toEqual(["resume", "halt"]);
  });

  test("terminal states (halted/completed) offer nothing", () => {
    expect(lifecycleActionsFor("halted")).toEqual([]);
    expect(lifecycleActionsFor("completed")).toEqual([]);
  });
});
