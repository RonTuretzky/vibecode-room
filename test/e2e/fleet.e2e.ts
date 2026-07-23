import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { Gateway, createSmithers } from "smithers-orchestrator";
import { z } from "zod";
import { decideOutput, meetsSilenceTarget, silenceRatio, type OutputPlan, type OutputTriggerClass } from "../../src/audio/output-policy";
import { FileCorrelationStore, MemoryCorrelationStore } from "../../src/seam/correlation-store";
import { SeamDispatcher } from "../../src/seam/dispatcher";
import { GatewaySmithersClient, InProcessGatewayTransport } from "../../src/seam/smithers-client";
import { SteeringWindowManager } from "../../src/routing/steering-window";
import { ProcessRegistry, CAPACITY_REFUSAL_ACK } from "../../src/process/registry";
import { MemorySmithersClient } from "../../src/process/test-helpers";
import { runReplayObservations, type DecisionInput, type DecisionLLM } from "../../src/replay/harness";
import type { DispatchedAction, TranscriptObservation } from "../../src/types";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("steering-window fleet slice e2e", () => {
  test("selects one process, steers it, then 20 seconds idle closes the window so ambient talk no longer steers", () => {
    const manager = new SteeringWindowManager({
      processes: [
        { callsign: "Atlas", upid: "upid-atlas" },
        { callsign: "Bravo", upid: "upid-bravo" },
      ],
      sessionId: "fleet-window-e2e",
      clock: () => 1_000,
    });

    const select = manager.ingestUtterance({
      text: "Atlas",
      utteranceId: "utt-select-atlas",
      correlationId: "corr-select-atlas",
      sessionId: "fleet-window-e2e",
      nowMs: 1_000,
    });
    expect(select.kind).toBe("pass");
    expect(manager.activeWindow()).toEqual(expect.objectContaining({ targetUPID: "upid-atlas" }));

    const steer = manager.ingestUtterance({
      text: "make it faster",
      utteranceId: "utt-steer-atlas",
      correlationId: "corr-steer-atlas",
      sessionId: "fleet-window-e2e",
      nowMs: 1_250,
    });
    expect(steer).toEqual(
      expect.objectContaining({
        kind: "routed",
        targetUPID: "upid-atlas",
        instruction: "make it faster",
        ackId: "route-steer",
      }),
    );
    expect(steer.traceEvents).toContainEqual(
      expect.objectContaining({
        event: "ack.emit",
        upid: "upid-atlas",
        meta: expect.objectContaining({ ackId: "route-steer" }),
      }),
    );

    const idle = manager.observeMicIdle({
      nowMs: 21_250,
      correlationId: "corr-window-idle",
      sessionId: "fleet-window-e2e",
    });
    expect(idle).toEqual(
      expect.objectContaining({
        kind: "closed",
        reason: "idle",
        closedWindow: expect.objectContaining({ targetUPID: "upid-atlas" }),
      }),
    );
    expect(manager.activeWindow()).toBeNull();

    const ambient = manager.ingestUtterance({
      text: "make it even faster",
      utteranceId: "utt-ambient-after-idle",
      correlationId: "corr-ambient-after-idle",
      sessionId: "fleet-window-e2e",
      nowMs: 21_500,
    });
    expect(ambient).toEqual(
      expect.objectContaining({
        kind: "pass",
        reason: "ambient",
        addressed: false,
        ackId: null,
      }),
    );
    expect(ambient.traceEvents.some((event) => event.event === "route.steer")).toBe(false);
  });
});

describe("seam durability recovery e2e", () => {
  test("seam steering and per-process pause stay isolated across two durable runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vibersyn-fleet-seam-"));
    tempDirs.push(dir);
    const runtime = createFleetControlRuntime("control", join(dir, "smithers.db"));
    const gateway = new Gateway({ heartbeatMs: 1_000, eventWindowSize: 200 });
    const connection = createConnection("fleet-control");
    gateway.connections.add(connection as any);
    gateway.register("vibersyn-fleet-control", runtime.workflow as any);

    const store = new MemoryCorrelationStore();
    const dispatcher = new SeamDispatcher({
      client: new GatewaySmithersClient({
        transport: new InProcessGatewayTransport(gateway as any, connection),
        correlations: store,
        defaultWorkflow: "vibersyn-fleet-control",
      }),
      correlations: store,
      sessionId: "fleet-e2e",
    });

    try {
      await dispatcher.dispatch(spawnAction("Atlas", "upid-atlas", "run-atlas", "seed-atlas"));
      if (process.env.VIBERSYN_RBG_STALL_UNSELECTED !== "1") {
        await dispatcher.dispatch(spawnAction("Bravo", "upid-bravo", "run-bravo", "seed-bravo"));
      }
      await dispatcher.drain();

      await waitForStatus(gateway, connection, "run-atlas", "waiting-event");
      await waitForStatus(gateway, connection, "run-bravo", "waiting-event");
      await waitForNodeOutput(gateway, connection, "run-atlas", "checkpoint");
      await waitForNodeOutput(gateway, connection, "run-bravo", "checkpoint");

      const replay = await runReplayObservations(
        [
          observation("virellium make atlas blue", "utt-fleet-steer-atlas"),
          observation("quoravex pause", "utt-fleet-pause-bravo"),
          observation("quoravex resume", "utt-fleet-resume-bravo"),
        ],
        durableFleetVoiceLLM(),
      );
      expect(replay.records.map((record) => record.input.temperature)).toEqual([0, 0, 0]);
      expect(replay.records.map((record) => record.output.action?.targetUPID)).toEqual([
        "upid-atlas",
        "upid-bravo",
        "upid-bravo",
      ]);

      const steerAction = replay.records[0]?.output.action;
      const pauseAction = replay.records[1]?.output.action;
      const resumeAction = replay.records[2]?.output.action;
      expect(steerAction?.type).toBe("steer");
      expect(pauseAction?.type).toBe("pause");
      expect(resumeAction?.type).toBe("resume");

      if (process.env.VIBERSYN_RBG_DROP_STEER_SIGNAL !== "1") {
        await dispatcher.dispatch(steerAction);
      }
      await dispatcher.drain();

      const atlasComplete = await waitForNodeOutput(gateway, connection, "run-atlas", "complete");
      expect(atlasComplete.row).toEqual(
        expect.objectContaining({
          seed: "seed-atlas",
          command: "make-atlas-blue",
          injection: "fleet-steer",
        }),
      );
      await expectNodeOutputMissing(gateway, connection, "run-bravo", "complete");

      await dispatcher.dispatch(
        process.env.VIBERSYN_RBG_PAUSE_ALL_UPIDS === "1"
          ? { type: "pauseAll", targetUPID: null, payload: {}, correlationId: "corr-pause-bravo" }
          : pauseAction,
      );
      await dispatcher.drain();

      expect(await store.findByUPID("upid-bravo")).toEqual(expect.objectContaining({ state: "paused" }));
      expect(await store.findByUPID("upid-atlas")).not.toEqual(expect.objectContaining({ state: "paused" }));
      await waitForNodeOutput(gateway, connection, "run-bravo", "pause-ack");

      await dispatcher.dispatch(resumeAction);
      await dispatcher.drain();
      expect(await store.findByUPID("upid-bravo")).toEqual(expect.objectContaining({ state: "active" }));
      await waitForNodeOutput(gateway, connection, "run-bravo", "resume-ack");
    } finally {
      await gateway.close().catch(() => {});
      closeRuntime(runtime);
    }
  }, 12_000);

  test("backend restart recovers an in-flight durable run from its last checkpoint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vibersyn-fleet-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "smithers.db");
    const correlationPath = join(dir, "correlations.json");
    const initial = createRuntime("initial", dbPath);
    const gateway = new Gateway({ heartbeatMs: 1_000, eventWindowSize: 200 });
    const connection = createConnection("fleet-initial");
    gateway.connections.add(connection as any);
    gateway.register("vibersyn-fleet", initial.workflow as any);
    const initialStore = new FileCorrelationStore(correlationPath);
    const initialDispatcher = new SeamDispatcher({
      client: new GatewaySmithersClient({
        transport: new InProcessGatewayTransport(gateway as any, connection),
        correlations: initialStore,
        defaultWorkflow: "vibersyn-fleet",
      }),
      correlations: initialStore,
      sessionId: "fleet-recovery-initial",
    });

    try {
      const accepted = await initialDispatcher.dispatch({
        type: "spawn",
        targetUPID: null,
        payload: {
          upid: "upid-fleet-001",
          runId: "run-fleet-001",
          workflow: "vibersyn-fleet",
          callsign: "Fleet",
          steeringWindowId: "window-fleet-001",
          input: {
            seed: "fleet seed",
            checkpoint: "checkpoint:fleet-seed",
          },
        },
        correlationId: "fleet-correlation",
      });
      expect(accepted.accepted).toBe(true);
      await initialDispatcher.drain();
      await waitForStatus(gateway, connection, "run-fleet-001", "waiting-event");
      const checkpointBefore = await rpc(gateway, connection, "getNodeOutput", {
        runId: "run-fleet-001",
        nodeId: "checkpoint",
        iteration: 0,
      });
      expect(checkpointBefore.ok).toBe(true);
      await gateway.close();
    } finally {
      await gateway.close().catch(() => {});
    }

    const recoveredDbPath = process.env.VIBERSYN_RBG_DISABLE_CHECKPOINTING === "1"
      ? join(dir, "empty-after-restart.db")
      : dbPath;
    const recovered = createRuntime("recovered", recoveredDbPath);
    const recoveredGateway = new Gateway({ heartbeatMs: 1_000, eventWindowSize: 200 });
    const recoveredConnection = createConnection("fleet-recovered");
    recoveredGateway.connections.add(recoveredConnection as any);
    recoveredGateway.register("vibersyn-fleet", recovered.workflow as any);
    const recoveredStore = new FileCorrelationStore(correlationPath);
    const recoveredDispatcher = new SeamDispatcher({
      client: new GatewaySmithersClient({
        transport: new InProcessGatewayTransport(recoveredGateway as any, recoveredConnection),
        correlations: recoveredStore,
        defaultWorkflow: "vibersyn-fleet",
      }),
      correlations: recoveredStore,
      sessionId: "fleet-recovery-restarted",
    });

    try {
      const run = await rpc(recoveredGateway, recoveredConnection, "getRun", { runId: "run-fleet-001" });
      expect(run.ok).toBe(true);
      expect(run.payload.status).toBe("waiting-event");

      const recoveredCheckpoint = await rpc(recoveredGateway, recoveredConnection, "getNodeOutput", {
        runId: "run-fleet-001",
        nodeId: "checkpoint",
        iteration: 0,
      });
      expect(recoveredCheckpoint.ok).toBe(true);
      expect(recoveredCheckpoint.payload.row).toEqual(
        expect.objectContaining({
          seed: "fleet seed",
          checkpoint: "checkpoint:fleet-seed",
        }),
      );
      expect(await recoveredStore.findByUPID("upid-fleet-001")).toEqual(
        expect.objectContaining({
          runId: "run-fleet-001",
          steeringWindowId: "window-fleet-001",
          correlationId: "fleet-correlation",
        }),
      );

      if (process.env.VIBERSYN_RBG_SKIP_RECOVERY_STEER !== "1") {
        await recoveredDispatcher.dispatch({
          type: "steer",
          targetUPID: "upid-fleet-001",
          payload: { command: "continue-after-restart" },
          correlationId: "fleet-correlation-steer",
        });
      }
      await recoveredDispatcher.drain();

      const completion = await waitForNodeOutput(recoveredGateway, recoveredConnection, "run-fleet-001", "complete");
      expect(completion.row).toEqual(
        expect.objectContaining({
          seed: "fleet seed",
          checkpoint: "checkpoint:fleet-seed",
          command: "continue-after-restart",
        }),
      );
    } finally {
      await recoveredGateway.close().catch(() => {});
      closeRuntime(initial);
      closeRuntime(recovered);
    }
  }, 10_000);
});

describe("process registry fleet e2e", () => {
  test("replayed voice fleet session preserves callsign isolation, unselected progress, and >=90% silence", async () => {
    const client = new MemorySmithersClient();
    const traces: unknown[] = [];
    const output: unknown[] = [];
    const registry = new ProcessRegistry({
      client,
      sessionId: "fleet-registry-e2e",
      onTrace: (event) => traces.push(event),
      onOutput: (decision) => output.push(decision),
    });

    const replay = await runReplayObservations(representativeFleetVoiceSession(), registryFleetVoiceLLM());
    const plans: OutputPlan[] = [];
    let afterSteerBravo: unknown;
    let afterPauseAtlas: unknown;
    let afterPauseBravo: unknown;

    for (const record of replay.records) {
      const decision = record.output;
      const plan = await decideOutput({
        trigger: decision.outputTrigger,
        addressed: decision.addressed,
        explicit: decision.explicit,
      });
      plans.push(plan);

      if (decision.clearSelection === true) {
        registry.clearSelection(record.observation.utteranceId);
      }
      if (decision.autonomousTick === true) {
        registry.advanceAutonomousTick(record.observation.utteranceId);
      }
      if (decision.action !== null) {
        await applyRegistryAction(registry, decision.action);
      }

      if (record.observation.utteranceId === "utt-steer-atlas") {
        afterSteerBravo = registry.records().find((process) => process.upid === "upid-bravo");
      }
      if (record.observation.utteranceId === "utt-pause-bravo") {
        afterPauseAtlas = registry.records().find((process) => process.upid === "upid-atlas");
        afterPauseBravo = registry.records().find((process) => process.upid === "upid-bravo");
      }
    }

    expect(replay.records.every((record) => record.input.temperature === 0)).toBe(true);
    expect(replay.records.filter((record) => record.output.action?.type === "spawn").map((record) => record.output.action?.targetUPID)).toEqual([
      null,
      null,
    ]);
    expect(replay.records.filter((record) => record.output.action?.targetUPID !== undefined).map((record) => record.output.action?.targetUPID)).toEqual([
      null,
      null,
      "upid-atlas",
      "upid-bravo",
      "upid-bravo",
    ]);

    const callsigns = registry.records().map((record) => record.callsign);
    expect(callsigns).toEqual(["virellium", "quoravex"]);
    expect(new Set(callsigns).size).toBe(callsigns.length);

    expect(afterSteerBravo).toEqual(
      expect.objectContaining({
        upid: "upid-bravo",
        callsign: "quoravex",
        progressSeq: 0,
        selected: true,
        state: "planning",
        // Two-stage pivot: the harness commissions each spawn immediately, so
        // the last action on an untouched process is "execute", not "spawn".
        lastAction: "execute",
      }),
    );
    expect(afterPauseAtlas).toEqual(expect.objectContaining({ upid: "upid-atlas", progressSeq: 1, lastAction: "steer" }));
    expect(afterPauseBravo).toEqual(expect.objectContaining({ upid: "upid-bravo", progressSeq: 0, state: "paused", lastAction: "pause" }));

    expect(registry.records().find((record) => record.upid === "upid-atlas")).toEqual(
      expect.objectContaining({ selected: false, state: "active", progressSeq: 3 }),
    );
    expect(registry.records().find((record) => record.upid === "upid-bravo")).toEqual(
      expect.objectContaining({ selected: false, state: "active", progressSeq: 2 }),
    );
    expect(client.calls.filter((call) => call.name === "pause")).toEqual([{ name: "pause", upid: "upid-bravo" }]);
    expect(client.calls.filter((call) => call.name === "resume")).toEqual([{ name: "resume", upid: "upid-bravo" }]);
    expect(client.calls.filter((call) => call.name === "steer")).toEqual([
      { name: "steer", upid: "upid-atlas", payload: { utterance: "virellium make atlas faster" } },
    ]);

    const ttsBearingTicks = plans.filter((plan) => plan.decisions.some((decision) => decision.channel === "tts")).length;
    expect(ttsBearingTicks).toBeLessThanOrEqual(Math.floor(plans.length * 0.1));
    expect(silenceRatio(plans)).toBeGreaterThanOrEqual(0.9);
    expect(meetsSilenceTarget(plans, 0.9)).toBe(true);

    const beforeThird = registry.records();
    const third = await registry.spawn({ correlationId: "corr-third", upid: "upid-charlie", callsign: "Charlie", workflow: "wf" });
    expect(third).toEqual(expect.objectContaining({ accepted: false, spokenAck: CAPACITY_REFUSAL_ACK }));
    expect(registry.records()).toEqual(beforeThird);
    expect(output).toContainEqual(expect.objectContaining({ channel: "tts", text: CAPACITY_REFUSAL_ACK }));
    expect(traces).toContainEqual(
      expect.objectContaining({
        event: "spawn.refused",
        correlationId: "corr-third",
        meta: expect.objectContaining({ reason: "capacity" }),
      }),
    );
  });
});

interface FleetVoiceOutput {
  action: DispatchedAction | null;
  outputTrigger: OutputTriggerClass;
  addressed: boolean;
  explicit: boolean;
  clearSelection?: boolean;
  autonomousTick?: boolean;
}

function durableFleetVoiceLLM(): DecisionLLM<FleetVoiceOutput> {
  const router = fleetVoiceRouter();
  return {
    decide(input: DecisionInput): FleetVoiceOutput {
      const routed = routeFleetVoice(router, input);
      if (routed !== null) {
        if (routed.targetUPID === "upid-atlas" && routed.instruction === "make atlas blue") {
          return {
            action: {
              type: "steer",
              targetUPID: "upid-atlas",
              payload: { command: "make-atlas-blue", injection: "fleet-steer" },
              correlationId: "corr-steer-atlas",
            },
            outputTrigger: "route.steer",
            addressed: true,
            explicit: true,
          };
        }
        if (routed.targetUPID === "upid-bravo" && routed.instruction === "pause") {
          return {
            action: { type: "pause", targetUPID: "upid-bravo", payload: {}, correlationId: "corr-pause-bravo" },
            outputTrigger: "route.steer",
            addressed: true,
            explicit: true,
          };
        }
        if (routed.targetUPID === "upid-bravo" && routed.instruction === "resume") {
          return {
            action: { type: "resume", targetUPID: "upid-bravo", payload: {}, correlationId: "corr-resume-bravo" },
            outputTrigger: "route.steer",
            addressed: true,
            explicit: true,
          };
        }
      }
      return silentVoiceOutput();
    },
  };
}

function registryFleetVoiceLLM(): DecisionLLM<FleetVoiceOutput> {
  const router = fleetVoiceRouter();
  return {
    decide(input: DecisionInput): FleetVoiceOutput {
      const routed = routeFleetVoice(router, input);
      if (routed !== null) {
        if (routed.targetUPID === "upid-atlas" && routed.instruction === "make atlas faster") {
          return {
            action: {
              type: "steer",
              targetUPID: "upid-atlas",
              payload: { utterance: "virellium make atlas faster" },
              correlationId: "corr-atlas-steer",
            },
            outputTrigger: "route.steer",
            addressed: true,
            explicit: true,
          };
        }
        if (routed.targetUPID === "upid-bravo" && routed.instruction === "pause") {
          return {
            action: { type: "pause", targetUPID: "upid-bravo", payload: {}, correlationId: "corr-bravo-pause" },
            outputTrigger: "route.steer",
            addressed: true,
            explicit: true,
          };
        }
        if (routed.targetUPID === "upid-bravo" && routed.instruction === "resume") {
          return {
            action: { type: "resume", targetUPID: "upid-bravo", payload: {}, correlationId: "corr-bravo-resume" },
            outputTrigger: "route.steer",
            addressed: true,
            explicit: true,
          };
        }
      }

      switch (input.observation.text) {
        case "viber spawn virellium":
          return {
            action: spawnRegistryAction("virellium", "upid-atlas", "run-atlas"),
            outputTrigger: "route.steer",
            addressed: true,
            explicit: true,
          };
        case "viber spawn quoravex":
          return {
            action: spawnRegistryAction("quoravex", "upid-bravo", "run-bravo"),
            outputTrigger: "route.steer",
            addressed: true,
            explicit: true,
          };
        case "clear fleet selection":
          return { ...silentVoiceOutput(), clearSelection: true };
        case "fleet interval tick one":
        case "fleet interval tick two":
          return { ...silentVoiceOutput(), autonomousTick: true };
        case "mute":
          return { action: null, outputTrigger: "mute", addressed: true, explicit: true };
        default:
          return silentVoiceOutput();
      }
    },
  };
}

function fleetVoiceRouter(): SteeringWindowManager {
  return new SteeringWindowManager({
    processes: [
      { callsign: "virellium", upid: "upid-atlas" },
      { callsign: "quoravex", upid: "upid-bravo" },
    ],
    sessionId: "fleet-replay-e2e",
    clock: () => 0,
  });
}

function routeFleetVoice(
  router: SteeringWindowManager,
  input: DecisionInput,
): { targetUPID: string; instruction: string } | null {
  const decision = router.ingestUtterance({
    text: input.observation.text,
    utteranceId: input.observation.utteranceId,
    correlationId: `corr-${input.observation.utteranceId}`,
    sessionId: input.observation.sessionId,
    nowMs: input.observationIndex * 1_000,
  });
  return decision.kind === "routed"
    ? { targetUPID: decision.targetUPID, instruction: decision.instruction }
    : null;
}

function spawnRegistryAction(callsign: string, upid: string, runId: string): DispatchedAction {
  return {
    type: "spawn",
    targetUPID: null,
    payload: { upid, runId, callsign, workflow: "wf" },
    correlationId: `corr-${upid}`,
  };
}

async function applyRegistryAction(registry: ProcessRegistry, action: DispatchedAction): Promise<void> {
  switch (action.type) {
    case "spawn": {
      const payload = action.payload as { upid: string; runId: string; callsign: string; workflow: string };
      const result = await registry.spawn({ ...payload, correlationId: action.correlationId });
      expect(result.accepted).toBe(true);
      // TWO-STAGE PIVOT: spawn is kickoff-only. This fleet slice exercises
      // durable steering/pause isolation, which requires commissioned runs —
      // so each replayed spawn is executed immediately.
      const executed = await registry.execute(payload.upid, { correlationId: action.correlationId });
      expect(executed.started).toBe(true);
      return;
    }
    case "steer":
      expect(action.targetUPID).not.toBeNull();
      await registry.steer(action.targetUPID as string, action.payload, action.correlationId);
      return;
    case "pause":
      expect(action.targetUPID).not.toBeNull();
      await registry.pause(action.targetUPID as string, action.correlationId);
      return;
    case "resume":
      expect(action.targetUPID).not.toBeNull();
      await registry.resume(action.targetUPID as string, action.correlationId);
      return;
    default:
      throw new Error(`Unsupported registry action in fleet e2e: ${action.type}`);
  }
}

function representativeFleetVoiceSession(): TranscriptObservation[] {
  const session = [
    observation("ambient planning chatter", "utt-ambient-001"),
    observation("viber spawn virellium", "utt-spawn-atlas"),
    observation("ambient build discussion", "utt-ambient-002"),
    observation("viber spawn quoravex", "utt-spawn-bravo"),
    observation("ambient side thread", "utt-ambient-003"),
    observation("virellium make atlas faster", "utt-steer-atlas"),
    observation("ambient code review note", "utt-ambient-004"),
    observation("quoravex pause", "utt-pause-bravo"),
    observation("ambient deploy status", "utt-ambient-005"),
    observation("quoravex resume", "utt-resume-bravo"),
    observation("clear fleet selection", "utt-clear-selection"),
    observation("ambient unselected interval", "utt-ambient-006"),
    observation("fleet interval tick one", "utt-tick-001"),
    observation("ambient still unselected", "utt-ambient-007"),
    observation("fleet interval tick two", "utt-tick-002"),
    observation("ambient still not a command", "utt-ambient-008"),
    observation("ambient pair programming comment", "utt-ambient-009"),
    observation("ambient test discussion", "utt-ambient-010"),
    observation("ambient release note", "utt-ambient-011"),
  ];

  for (let index = 12; index <= 51; index += 1) {
    session.push(observation(`ambient restraint filler ${index}`, `utt-ambient-${String(index).padStart(3, "0")}`));
  }

  session.push(observation("mute", "utt-mute"));
  return session;
}

function observation(text: string, utteranceId: string): TranscriptObservation {
  return {
    text,
    isFinal: true,
    speaker: "operator",
    sessionId: "fleet-replay-e2e",
    latencyMs: 20,
    utteranceId,
  };
}

function silentVoiceOutput(): FleetVoiceOutput {
  return {
    action: null,
    outputTrigger: "ignored-ambient",
    addressed: false,
    explicit: false,
  };
}

function createFleetControlRuntime(label: string, dbPath: string) {
  const outputs: any = {
    checkpoint: z.object({ seed: z.string(), upid: z.string(), callsign: z.string() }),
    steer: z.object({
      type: z.string(),
      payload: z.object({
        command: z.string(),
        injection: z.string(),
      }),
    }),
    pause: z.object({ upid: z.string() }),
    pauseAck: z.object({ upid: z.string(), paused: z.boolean() }),
    resume: z.object({ upid: z.string() }),
    resumeAck: z.object({ upid: z.string(), resumed: z.boolean() }),
    complete: z.object({
      seed: z.string(),
      upid: z.string(),
      callsign: z.string(),
      command: z.string(),
      injection: z.string(),
    }),
  };
  const api: any = createSmithers(outputs, { dbPath, readableName: `Vibersyn fleet control ${label}` });
  const workflow = api.smithers((ctx: any) => {
    const input = ctx.input as any;
    const seed = String(input.seed ?? input.prompt ?? "");
    const upid = String(input.upid ?? "");
    const callsign = String(input.callsign ?? "");
    const correlationId = String(input.correlationId ?? "");
    const controlMode = String(input.controlMode ?? "steer");

    const checkpoint = React.createElement(
      api.Task,
      { id: "checkpoint", output: api.outputs.checkpoint },
      { seed, upid, callsign } as any,
    );

    const steer = React.createElement(api.Signal, {
      id: "steer",
      schema: api.outputs.steer,
      correlationId,
      children: (data: any) =>
        React.createElement(
          api.Task,
          { id: "complete", output: api.outputs.complete },
          {
            seed,
            upid,
            callsign,
            command: data.payload.command,
            injection: data.payload.injection,
          } as any,
        ),
    });

    const pause = React.createElement(api.Signal, {
      id: "pause",
      schema: api.outputs.pause,
      correlationId,
      children: (data: any) =>
        React.createElement(
          api.Task,
          { id: "pause-ack", output: api.outputs.pauseAck },
          { upid: data.upid, paused: true } as any,
        ),
    });

    const resume = React.createElement(api.Signal, {
      id: "resume",
      schema: api.outputs.resume,
      correlationId,
      children: (data: any) =>
        React.createElement(
          api.Task,
          { id: "resume-ack", output: api.outputs.resumeAck },
          { upid: data.upid, resumed: true } as any,
        ),
    });

    return React.createElement(
      api.Workflow,
      { name: "vibersyn-fleet-control" },
      React.createElement(
        api.Sequence,
        null,
        checkpoint,
        ...(controlMode === "pause-resume" ? [pause, resume] : [steer]),
      ),
    );
  });
  return { api, workflow };
}

function createRuntime(label: string, dbPath: string) {
  const outputs: any = {
    checkpoint: z.object({ seed: z.string(), checkpoint: z.string() }),
    steer: z.object({
      type: z.string(),
      payload: z.object({ command: z.string() }),
    }),
    complete: z.object({
      seed: z.string(),
      checkpoint: z.string(),
      command: z.string(),
    }),
  };
  const api: any = createSmithers(outputs, { dbPath, readableName: `Vibersyn fleet ${label}` });
  const workflow = api.smithers((ctx: any) => {
    const input = ctx.input as any;
    return React.createElement(
      api.Workflow,
      { name: "vibersyn-fleet" },
      React.createElement(
        api.Sequence,
        null,
        React.createElement(
          api.Task,
          { id: "checkpoint", output: api.outputs.checkpoint },
          {
            seed: String(input.seed ?? ""),
            checkpoint: String(input.checkpoint ?? ""),
          } as any,
        ),
        React.createElement(api.Signal, {
          id: "steer",
          schema: api.outputs.steer,
          correlationId: String(input.correlationId ?? ""),
          children: (data: any) =>
            React.createElement(
              api.Task,
              { id: "complete", output: api.outputs.complete },
              {
                seed: String(input.seed ?? ""),
                checkpoint: String(input.checkpoint ?? ""),
                command: data.payload.command,
              } as any,
            ),
        }),
      ),
    );
  });
  return { api, workflow };
}

function spawnAction(callsign: string, upid: string, runId: string, seed: string) {
  return {
    type: "spawn" as const,
    targetUPID: null,
    payload: {
      upid,
      runId,
      workflow: "vibersyn-fleet-control",
      callsign,
      steeringWindowId: `window-${callsign.toLowerCase()}`,
      seed,
      input: { seed, upid, callsign, controlMode: callsign === "Bravo" ? "pause-resume" : "steer" },
    },
    correlationId: `corr-${upid}`,
  };
}

async function rpc(gateway: Gateway, connection: unknown, method: string, params?: Record<string, unknown>) {
  return (gateway as any).routeRequest(connection, {
    type: "req",
    id: `${method}:${crypto.randomUUID()}`,
    method,
    params,
  });
}

async function waitForStatus(gateway: Gateway, connection: unknown, runId: string, status: string) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    const response = await rpc(gateway, connection, "getRun", { runId });
    if (response.ok && response.payload.status === status) {
      return;
    }
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${runId} to reach ${status}`);
}

async function waitForNodeOutput(gateway: Gateway, connection: unknown, runId: string, nodeId: string) {
  const startedAt = Date.now();
  let latest: any;
  while (Date.now() - startedAt < 5_000) {
    latest = await rpc(gateway, connection, "getNodeOutput", { runId, nodeId, iteration: 0 });
    if (latest.ok && latest.payload.status === "produced") {
      return latest.payload;
    }
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${runId}/${nodeId}; latest=${JSON.stringify(latest)}`);
}

async function expectNodeOutputMissing(gateway: Gateway, connection: unknown, runId: string, nodeId: string) {
  const response = await rpc(gateway, connection, "getNodeOutput", { runId, nodeId, iteration: 0 });
  expect(response.ok === false || response.payload?.status !== "produced").toBe(true);
}

function createConnection(userId: string) {
  return {
    connectionId: `${userId}:connection`,
    transport: "ws",
    authenticated: true,
    sessionToken: "fleet-session",
    role: "operator",
    scopes: ["*"],
    userId,
    subscribedRuns: null,
    heartbeatTimer: null,
    devtoolsStreams: new Map(),
    runEventStreams: new Map(),
    seq: 0,
    ws: {
      OPEN: 1,
      readyState: 1,
      bufferedAmount: 0,
      sent: [],
      send(data: string) {
        this.sent.push(JSON.parse(data) as never);
      },
    },
  };
}

function closeRuntime(runtime: { api: { db?: any } }) {
  (runtime.api.db as any)?.$client?.close?.();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
