import { expect, test } from "bun:test";
import { demoProjectorSnapshot } from "./demo-data";
import type { BuildloopProcess } from "./buildloop";
import { projectStatus } from "./project-status";
import { AdaptiveResolution } from "./render-quality";
import { suggestFromTurn } from "../research/suggester";

test("concept readiness overrides the registry's planning percentage", () => {
  const process: BuildloopProcess = {
    ...demoProjectorSnapshot.processes[0]!,
    state: "planning",
    progress: 0,
    builds: [
      {
        backend: "native",
        label: "Native",
        status: "ready",
        previewUrl: "/preview",
        slideshowUrl: "/deck",
        summary: "ready",
      },
    ],
  };
  expect(projectStatus(process).label).toBe("Concept ready");
  expect(projectStatus(process).percent).toBeNull();
});
test("a stalled concept explains its last update before there is a deck", () => {
  const process: BuildloopProcess = {
    ...demoProjectorSnapshot.processes[0]!,
    builds: [
      {
        backend: "native",
        label: "Native",
        status: "building",
        previewUrl: null,
        slideshowUrl: null,
        summary: null,
        lastProgressAtMs: 1000,
        progressLabel: "waiting for model",
      },
    ],
  };
  expect(projectStatus(process, [], 21_000).label).toBe(
    "Waiting for concept provider",
  );
  expect(projectStatus(process, [], 21_000).detail).toContain(
    "No progress update for 20s",
  );
});
test("recovery status outranks a previously successful preview", () => {
  const process = {
    ...demoProjectorSnapshot.processes[0]!,
    recovery: "interrupted" as const,
  };
  expect(projectStatus(process).retry).toBe(true);
  expect(projectStatus(process).label).toBe("Interrupted");
});
test("resolution changes only after sustained slow frames and respects its cooldown", () => {
  const quality = new AdaptiveResolution(1.5, 2);
  for (let frame = 0; frame < 89; frame++)
    expect(quality.sample(40, 10_000)).toBeNull();
  expect(quality.sample(40, 10_000)).toBe(1.25);
  for (let frame = 0; frame < 90; frame++)
    expect(quality.sample(40, 11_000)).toBeNull();
});
test("feature requests with numbers and superlatives are not proposed as factual claims", () => {
  for (const text of [
    "we should build a dashboard with 3 cards for every task",
    "add the best welcome panel and always show all projects",
    "could you make a garden with 12 growing branches",
  ]) {
    expect(
      suggestFromTurn({ id: "turn", text, speaker: "user", atMs: 0 }),
    ).toBeNull();
  }
  expect(
    suggestFromTurn({
      id: "claim",
      text: "The planet has 8 billion people living on it",
      speaker: "user",
      atMs: 0,
    })?.kind,
  ).toBe("fact-check");
});
