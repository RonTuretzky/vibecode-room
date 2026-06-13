/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod";
import { ioAgents } from "./agents.ts";

const inputSchema = z.object({
  transcript: z.string(),
  existing: z.string(),
  modelInitiated: z.boolean(),
});

const suggestOutputSchema = z.object({
  suggest: z.boolean(),
  title: z.string().default(""),
  rationale: z.string().default(""),
  visualizer: z.string().default("web"),
  sourcePhrases: z.string().default(""),
  questions: z.string().default("[]"),
  html: z.string().default(""),
});

const { Workflow, Task, smithers } = createSmithers({
  input: inputSchema,
  suggest: suggestOutputSchema,
});

export default smithers((ctx) => (
  <Workflow name="panopticon-suggest">
    <Task id="suggest" output={suggestOutputSchema} agent={ioAgents}>
      {`You are the always-on suggestion loop of Panopticon, an OS for AI-agent work.
People are talking in a room. You passively listen and occasionally propose a thing worth BUILDING.

Recent transcript:
"""${ctx.input.transcript}"""

Existing bubbles: ${ctx.input.existing || "(none)"}.
${ctx.input.modelInitiated ? "Volunteer your own idea or relevant prior art." : "Only suggest if warranted."}

Only fire when the conversation genuinely rises to a buildable idea. Otherwise set suggest=false and leave all other fields empty/default.
When you fire:
- set suggest=true
- use a short title
- write rationale as one sentence explaining why the room might want this
- set visualizer to one of: web, code, art, book, text, data
- set sourcePhrases to comma-joined key phrases from the transcript
- set questions to a JSON-encoded array of 1 to 5 objects shaped {"prompt":"...","choices":["...","...","..."]}; choices must be multiple-choice strings
- set html to a small self-contained HTML proof-of-concept with inline styles, no external assets, ideally under about 1500 characters

Do not invent that something was already built unless asked. Keep the output schema flat; do not put nested objects or arrays outside the JSON-encoded questions string.`}
    </Task>
  </Workflow>
));
