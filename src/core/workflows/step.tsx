/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod";
import { ioAgents } from "./agents.ts";

const inputSchema = z.object({
  processTitle: z.string(),
  visualizer: z.string(),
  model: z.string(),
  prompt: z.string(),
  history: z.string(),
});

const stepOutputSchema = z.object({
  reply: z.string().default(""),
  note: z.string().default("stepped"),
  done: z.boolean().default(false),
  html: z.string().default(""),
});

const { Workflow, Task, smithers } = createSmithers({
  input: inputSchema,
  step: stepOutputSchema,
});

export default smithers((ctx) => (
  <Workflow name="panopticon-step">
    <Task id="step" output={stepOutputSchema} agent={ioAgents}>
      {`You are an agent process inside Panopticon working on a single goal.
You receive a steering instruction and produce a concrete update.

Process: "${ctx.input.processTitle}"
Visualizer: ${ctx.input.visualizer}
Requested model: ${ctx.input.model}
Conversation history:
${ctx.input.history || "(none)"}

Instruction:
${ctx.input.prompt}

Produce:
- reply: one short sentence to the user
- note: a status line of 48 characters or fewer
- done: true only if the process considers its current goal complete
- html: a complete self-contained HTML document for the visualizer using inline CSS/JS and no external assets; use an empty string to keep the current view

Do not put HTML anywhere except the html field.`}
    </Task>
  </Workflow>
));
