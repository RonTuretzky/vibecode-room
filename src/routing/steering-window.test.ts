import { describe, expect, test } from "bun:test";
import type { AckId } from "../types";
import { SteeringWindowManager, type SteeringDecision, type SteeringProcess } from "./steering-window";

const processes: SteeringProcess[] = [
  { callsign: "Atlas", upid: "upid-atlas" },
  { callsign: "Bravo", upid: "upid-bravo" },
];

describe("REQ-6 steering-window lifecycle", () => {
  test("AC6.2 opens on select-only callsign and routes subsequent speech to the selected UPID only", () => {
    const manager = managerAt(1_000);

    const open = manager.ingestUtterance(utterance("Atlas", "utt-open", 1_000));
    expect(open.kind).toBe("pass");
    expect(open.ackId).toBe("route-declined");
    expect(manager.activeWindow()).toEqual(
      expect.objectContaining({
        targetUPID: "upid-atlas",
        callsign: "Atlas",
        openedAtMs: 1_000,
      }),
    );

    const routed = manager.ingestUtterance(utterance("Make it faster", "utt-steer", 1_100));
    expectRoutedTo(routed, "upid-atlas", "make it faster");
    expect(routed.kind === "routed" && routed.opened).toBe(false);
    expectRoutedTrace(routed, "upid-atlas", "route-steer");
    expectNoRouteTo(routed, "upid-bravo");
  });

  test("AC6.2 target scope survives multiple utterances and never leaks to a sibling process", () => {
    const manager = managerAt(2_000);
    manager.ingestUtterance(utterance("Atlas", "utt-open", 2_000));

    const first = manager.ingestUtterance(utterance("Use blue accents", "utt-blue", 2_100));
    const second = manager.ingestUtterance(utterance("Reduce the animation", "utt-anim", 2_200));

    expectRoutedTo(first, "upid-atlas", "use blue accents");
    expectRoutedTo(second, "upid-atlas", "reduce the animation");
    expectNoRouteTo(first, "upid-bravo");
    expectNoRouteTo(second, "upid-bravo");
  });

  test("AC6.5 one-breath callsign plus instruction opens the window and routes the instruction in one utterance", () => {
    const manager = managerAt(3_000);

    const decision = manager.ingestUtterance(utterance("Atlas, make it faster", "utt-one-breath", 3_000));

    expectRoutedTo(decision, "upid-atlas", "make it faster");
    expect(decision.kind === "routed" && decision.opened).toBe(true);
    expect(manager.activeWindow()).toEqual(expect.objectContaining({ targetUPID: "upid-atlas" }));
    expectRoutedTrace(decision, "upid-atlas", "route-steer");
  });

  test("AC6.2 always-hot callsign can switch the open window to a newly addressed process", () => {
    const manager = managerAt(3_500);
    expectRoutedTo(manager.ingestUtterance(utterance("Atlas, make it faster", "utt-atlas", 3_500)), "upid-atlas", "make it faster");

    const switched = manager.ingestUtterance(utterance("Bravo, pause the crawl", "utt-bravo", 3_600));

    expectRoutedTo(switched, "upid-bravo", "pause the crawl");
    expect(switched.kind === "routed" && switched.opened).toBe(true);
    expect(manager.activeWindow()).toEqual(expect.objectContaining({ targetUPID: "upid-bravo", callsign: "Bravo" }));
  });

  test("AC6.3 closes on Done and gates Done to the open-window state", () => {
    const manager = managerAt(4_000);

    const inertDone = manager.ingestUtterance(utterance("Done", "utt-done-inert", 4_000));
    expect(inertDone).toEqual(expect.objectContaining({ kind: "pass", reason: "done-without-window", addressed: true, ackId: "route-declined" }));
    expect(manager.activeWindow()).toBeNull();

    manager.ingestUtterance(utterance("Atlas", "utt-open", 4_100));
    const closed = manager.ingestUtterance(utterance("Done", "utt-done", 4_200));

    expectClosed(closed, "done", "upid-atlas");
    expect(manager.activeWindow()).toBeNull();

    const ambient = manager.ingestUtterance(utterance("Make it faster", "utt-after-done", 4_300));
    expect(ambient).toEqual(expect.objectContaining({ kind: "pass", reason: "ambient", addressed: false, ackId: null }));
  });

  test("AC6.3 closes on Back", () => {
    const manager = managerAt(5_000);
    manager.ingestUtterance(utterance("Atlas", "utt-open", 5_000));

    const closed = manager.ingestUtterance(utterance("Back", "utt-back", 5_100));

    expectClosed(closed, "back", "upid-atlas");
    expect(manager.activeWindow()).toBeNull();
  });

  test("AC6.3 closes on Abort and ambient post-abort speech does not steer", () => {
    const manager = managerAt(6_000);
    manager.ingestUtterance(utterance("Atlas", "utt-open", 6_000));

    const closed = manager.ingestUtterance(utterance("Abort", "utt-abort", 6_050));

    expectClosed(closed, "abort", "upid-atlas");
    expect(manager.activeWindow()).toBeNull();
    const ambient = manager.ingestUtterance(utterance("Make it faster", "utt-after-abort", 6_100));
    expect(ambient.kind).toBe("pass");
    expect(ambient.ackId).toBeNull();
  });

  test("AC6.3 closes after the configured 20 seconds of mic-level idle", () => {
    const manager = managerAt(10_000);
    manager.ingestUtterance(utterance("Atlas", "utt-open", 10_000));

    const notYet = manager.observeMicIdle({ nowMs: 29_999, correlationId: "corr-idle-early" });
    expect(notYet.kind).toBe("pass");
    expect(manager.activeWindow()).toEqual(expect.objectContaining({ targetUPID: "upid-atlas" }));

    const closed = manager.observeMicIdle({ nowMs: 30_000, correlationId: "corr-idle-close" });
    expectClosed(closed, "idle", "upid-atlas");
    expect(manager.activeWindow()).toBeNull();

    const ambient = manager.ingestUtterance(utterance("This ambient talk should not steer", "utt-after-idle", 30_100));
    expect(ambient).toEqual(expect.objectContaining({ kind: "pass", reason: "ambient", addressed: false, ackId: null }));
  });
});

describe("REQ-8 selected-process steering", () => {
  test("AC8.1 each selected-process instruction carries the Layer-B route-steer ack and trace ids", () => {
    const manager = managerAt(11_000);

    const routed = manager.ingestUtterance(utterance("Atlas, simplify the header", "utt-ack", 11_000));

    expectRoutedTo(routed, "upid-atlas", "simplify the header");
    expect(routed.kind === "routed" && routed.ackId).toBe<AckId>("route-steer");
    expect(routed.traceEvents.every((event) => event.sessionId === "session-steering")).toBe(true);
    expect(routed.traceEvents.every((event) => event.correlationId === "corr-utt-ack")).toBe(true);
    expect(routed.traceEvents.some((event) => event.event === "ack.emit" && event.meta.ackId === "route-steer")).toBe(true);
  });

  test("AC8.2 steering one selected process never affects a sibling process", () => {
    const manager = managerAt(12_000);
    const atlas = manager.ingestUtterance(utterance("Atlas, make the nav compact", "utt-atlas", 12_000));

    expectRoutedTo(atlas, "upid-atlas", "make the nav compact");
    expectNoRouteTo(atlas, "upid-bravo");

    const bravo = manager.ingestUtterance(utterance("Bravo, make the footer quiet", "utt-bravo", 12_100));
    expectRoutedTo(bravo, "upid-bravo", "make the footer quiet");
    expectNoRouteTo(bravo, "upid-atlas");
  });

  test("AC8.3 low-confidence steering is not silently applied and receives an addressed-pass ack", () => {
    const manager = managerAt(13_000);
    manager.ingestUtterance(utterance("Atlas", "utt-open", 13_000));

    const lowConfidence = manager.ingestUtterance({
      ...utterance("Maybe reroute the database", "utt-low", 13_100),
      confidence: 0.1,
    });

    expect(lowConfidence).toEqual(
      expect.objectContaining({
        kind: "pass",
        reason: "low-confidence",
        addressed: true,
        ackId: "route-declined",
      }),
    );
    expect(manager.activeWindow()).toEqual(expect.objectContaining({ targetUPID: "upid-atlas" }));
  });

  test("empty speech never steers and never opens a window", () => {
    const manager = managerAt(14_000);

    const empty = manager.ingestUtterance(utterance("   ", "utt-empty", 14_000));

    expect(empty).toEqual(expect.objectContaining({ kind: "pass", reason: "empty", addressed: false, ackId: null }));
    expect(manager.activeWindow()).toBeNull();
  });
});

function managerAt(nowMs: number): SteeringWindowManager {
  return new SteeringWindowManager({
    processes,
    sessionId: "session-steering",
    clock: () => nowMs,
  });
}

function utterance(text: string, utteranceId: string, nowMs: number) {
  return {
    text,
    utteranceId,
    correlationId: `corr-${utteranceId}`,
    sessionId: "session-steering",
    speaker: "speaker-0",
    nowMs,
  };
}

function expectRoutedTo(decision: SteeringDecision, upid: string, instruction: string): void {
  expect(decision).toEqual(
    expect.objectContaining({
      kind: "routed",
      targetUPID: upid,
      instruction,
      ackId: "route-steer",
    }),
  );
}

function expectNoRouteTo(decision: SteeringDecision, upid: string): void {
  expect(decision.traceEvents.some((event) => event.event === "route.steer" && event.upid === upid)).toBe(false);
  if (decision.kind === "routed") {
    expect(decision.targetUPID).not.toBe(upid);
  }
}

function expectClosed(decision: SteeringDecision, reason: "done" | "back" | "abort" | "idle", upid: string): void {
  expect(decision).toEqual(
    expect.objectContaining({
      kind: "closed",
      reason,
      closedWindow: expect.objectContaining({ targetUPID: upid }),
    }),
  );
}

function expectRoutedTrace(decision: SteeringDecision, upid: string, ackKind: AckId): void {
  expect(decision.traceEvents).toContainEqual(
    expect.objectContaining({
      event: "route.steer",
      upid,
      meta: expect.objectContaining({ ackKind }),
    }),
  );
}
