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
      name: "panopticon.suggest",
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
      name: "panopticon.steer",
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
        allowedTools: ["panopticon.suggest"],
        llmProvider: {
          infer({ cue: cueEvent, tools: eligibleTools }: { cue?: { metadata?: Record<string, unknown> }; tools: Array<{ name: string }> }) {
            if (cueEvent?.metadata?.pattern !== "build") return [];
            if (!eligibleTools.some((tool) => tool.name === "panopticon.suggest")) return [];
            return [{ tool: "panopticon.suggest", arguments: { concept: "add replay tests" } }];
          },
        },
      },
      {
        name: "steering-C3",
        triggers: [cue.Triggers.onCue("text")],
        allowedTools: ["panopticon.steer"],
        llmProvider: {
          infer({ cue: cueEvent, tools: eligibleTools }: { cue?: { metadata?: Record<string, unknown> }; tools: Array<{ name: string }> }) {
            if (cueEvent?.metadata?.pattern !== "cometa") return [];
            if (!eligibleTools.some((tool) => tool.name === "panopticon.steer")) return [];
            return [
              {
                tool: "panopticon.steer",
                arguments: { callsign: "cometa", instruction: "focus tests", upid: "upid-cometa" },
              },
            ];
          },
        },
      },
    ],
    risks: [
      "D2: steering Program isolation depends on Cue allowedTools and adapter-side dispatch verification.",
    ],
  };
}

export function assertTwoProgramIsolation(probe: ProgramIsolationProbe): void {
  if (probe.ambientProgram === probe.steeringProgram) {
    throw new Error("Ambient and steering Programs must be independent.");
  }

  if (probe.ambientTools.includes("panopticon.steer")) {
    throw new Error("Ambient Program may not receive the steering tool.");
  }

  if (probe.steeringTools.includes("panopticon.suggest")) {
    throw new Error("Steering Program may not receive the ambient suggestion tool.");
  }

  if (probe.ambientActions.some((action) => action.type === "steer")) {
    throw new Error("Ambient observations may never produce steering actions.");
  }

  if (probe.steeringActions.some((action) => action.type === "spawn")) {
    throw new Error("Steering observations may never produce suggestion/spawn actions.");
  }
}
