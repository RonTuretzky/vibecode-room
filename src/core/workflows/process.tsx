/** @jsxImportSource smithers-orchestrator */
import { WaitForEvent, createSmithers } from "smithers-orchestrator";
import { z } from "zod";
import { ioAgents } from "./agents.ts";

const inputSchema = z.object({
  directive: z.string(),
  processTitle: z.string(),
  visualizer: z.string(),
  model: z.string(),
});

const steerSchema = z.object({
  text: z.string().default(""),
});

const stepOutputSchema = z.object({
  reply: z.string().default(""),
  note: z.string().default("stepped"),
  done: z.boolean().default(false),
  html: z.string().default(""),
});

const { Workflow, Task, Loop, smithers, outputs } = createSmithers({
  input: inputSchema,
  steer: steerSchema,
  step: stepOutputSchema,
});

export default smithers((ctx) => {
  const steer = ctx.latest(outputs.steer, "steer");
  const instruction = steer?.text ?? "";

  return (
    <Workflow name="panopticon-process">
      <Loop until={false} maxIterations={1000}>
        <WaitForEvent
          id="steer"
          event="steer"
          correlationId="steer"
          output={outputs.steer}
          outputSchema={steerSchema}
        />
        <Task id="step" output={outputs.step} agent={ioAgents}>
          {`You are an agent process inside Panopticon working on a long-running goal.
You receive the process directive and the latest steering instruction, then produce a concrete update.

Process: "${ctx.input.processTitle}"
Visualizer: ${ctx.input.visualizer}
Requested model: ${ctx.input.model}

Directive:
${ctx.input.directive}

Latest steering instruction:
${instruction || "(none)"}

Produce:
- reply: one short sentence to the user
- note: a status line of 48 characters or fewer
- done: true only if the process considers its current goal complete
- html: a complete self-contained HTML document for the visualizer using inline CSS/JS and no external assets; use an empty string to keep the current view

Do not put HTML anywhere except the html field.`}
        </Task>
      </Loop>
    </Workflow>
  );
});
