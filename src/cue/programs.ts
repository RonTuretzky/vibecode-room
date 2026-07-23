import type { DispatchedAction } from "../types";
import type { CueCoreModule } from "./source";

export interface ProgramIsolationProbe {
  ambientProgram: string;
  steeringProgram: string;
  ambientTools: string[];
  steeringTools: string[];
  ambientActions: DispatchedAction[];
  steeringActions: DispatchedAction[];
}

export function createCuePrograms(cue: CueCoreModule): {
  programs: unknown[];
  tools: unknown[];
  risks: string[];
} {
  const tools = [
    new cue.MappedActionTool({
      name: "vibersyn.suggest",
      description: "Queue a conservative ambient suggestion.",
      inputSchema: {
        type: "object",
        required: ["concept"],
        properties: { concept: { type: "string" } },
      },
      mapper: (call: { arguments?: Record<string, unknown> }) => [
        {
          type: "spawn",
          targetUPID: null,
          payload: { suggestion: call.arguments ?? {} },
          correlationId: "cue-mapper-pending",
        } satisfies DispatchedAction,
      ],
    }),
    new cue.MappedActionTool({
      name: "vibersyn.steer",
      description: "Deliver a steering instruction to a selected durable process.",
      inputSchema: {
        type: "object",
        required: ["callsign", "instruction"],
        properties: {
          callsign: { type: "string" },
          instruction: { type: "string" },
          upid: { type: "string" },
        },
      },
      mapper: (call: { arguments?: Record<string, unknown> }) => [
        {
          type: "steer",
          targetUPID: typeof call.arguments?.upid === "string" ? call.arguments.upid : null,
          payload: call.arguments ?? {},
          correlationId: "cue-mapper-pending",
        } satisfies DispatchedAction,
      ],
    }),
  ];

  return {
    tools,
    programs: [
      {
        name: "ambient-C2",
        triggers: [cue.Triggers.onCue("text")],
        allowedTools: ["vibersyn.suggest"],
        llmProvider: {
          // CONTRACT-PROBE inference, not a real model: canned tool calls that
          // let the two-Program isolation probe observe routing. Inert unless
          // VIBERSYN_CUE_STUB_PROGRAMS=1 — a live room must never fabricate a
          // suggestion from a hardcoded table.
          infer({ cue: cueEvent, tools: eligibleTools }: { cue?: { metadata?: Record<string, unknown> }; tools: Array<{ name: string }> }) {
            if (process.env.VIBERSYN_CUE_STUB_PROGRAMS !== "1") return [];
            if (cueEvent?.metadata?.pattern !== "build") return [];
            if (!eligibleTools.some((tool) => tool.name === "vibersyn.suggest")) return [];
            return [{ tool: "vibersyn.suggest", arguments: { concept: "add replay tests" } }];
          },
        },
      },
      {
        name: "steering-C3",
        triggers: [cue.Triggers.onCue("text")],
        allowedTools: ["vibersyn.steer"],
        llmProvider: {
          // CONTRACT-PROBE inference — see ambient-C2 above. Inert unless
          // VIBERSYN_CUE_STUB_PROGRAMS=1.
          infer({ cue: cueEvent, tools: eligibleTools }: { cue?: { metadata?: Record<string, unknown> }; tools: Array<{ name: string }> }) {
            if (process.env.VIBERSYN_CUE_STUB_PROGRAMS !== "1") return [];
            if (cueEvent?.metadata?.pattern !== "cometa") return [];
            if (!eligibleTools.some((tool) => tool.name === "vibersyn.steer")) return [];
            return [
              {
                tool: "vibersyn.steer",
                arguments: { callsign: "cometa", instruction: "focus tests", upid: "upid-cometa" },
              },
            ];
          },
        },
      },
    ],
    risks: [
      "D2: steering Program isolation depends on Cue allowedTools and adapter-side dispatch verification.",
      "Program llmProviders are contract-probe stubs (canned tool calls), inert unless VIBERSYN_CUE_STUB_PROGRAMS=1.",
    ],
  };
}

export function assertTwoProgramIsolation(probe: ProgramIsolationProbe): void {
  if (probe.ambientProgram === probe.steeringProgram) {
    throw new Error("Ambient and steering Programs must be independent.");
  }

  if (probe.ambientTools.includes("vibersyn.steer")) {
    throw new Error("Ambient Program may not receive the steering tool.");
  }

  if (probe.steeringTools.includes("vibersyn.suggest")) {
    throw new Error("Steering Program may not receive the ambient suggestion tool.");
  }

  if (probe.ambientActions.some((action) => action.type === "steer")) {
    throw new Error("Ambient observations may never produce steering actions.");
  }

  if (probe.steeringActions.some((action) => action.type === "spawn")) {
    throw new Error("Steering observations may never produce suggestion/spawn actions.");
  }
}
