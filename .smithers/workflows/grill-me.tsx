// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Grill Me
// smithers-description: Ask targeted questions until vague requirements become actionable.
// smithers-tags: requirements, planning
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import { GrillMe, grillOutputSchema } from "../components/GrillMe";

const WORKFLOW_ID = "grill-me";

const { Workflow, smithers, outputs } = createSmithers({
  input: z.object({
    prompt: z.string().default("Describe what you want to get grilled on."),
    maxIterations: z.number().int().default(30),
  }),
  grill: grillOutputSchema,
});

export default smithers((ctx) => (
  <Workflow name={WORKFLOW_ID}>
    <GrillMe
      idPrefix={WORKFLOW_ID}
      context={ctx.input.prompt}
      agent={agents.smart}
      output={outputs.grill}
      maxIterations={ctx.input.maxIterations}
    />
  </Workflow>
));
