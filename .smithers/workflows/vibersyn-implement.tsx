// smithers-source: dev workflow (Vibersyn build harness — NOT app code).
// Implement → validate → review loop with INDEPENDENT review:
//   implement + validate = codex (gpt-5.5), review = claude (opus-4-8).
// Used to build Vibersyn's app source under the repo root (APP_ROOT in agents.ts).
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { providers } from "../agents";
import { ValidationLoop, implementOutputSchema, validateOutputSchema } from "../components/ValidationLoop";
import { reviewOutputSchema } from "../components/Review";

const inputSchema = z.object({
  prompt: z.string().default("Implement the requested change."),
});

const { Workflow, smithers } = createSmithers({
  input: inputSchema,
  implement: implementOutputSchema,
  validate: validateOutputSchema,
  review: reviewOutputSchema,
});

export default smithers((ctx) => {
  const validate = ctx.outputMaybe("validate", { nodeId: "panimpl:validate" });
  const reviews = ctx.outputs.review ?? [];

  // done = validate has run AND passed, AND at least one reviewer approved.
  const hasValidated = validate !== undefined;
  const validationPassed = hasValidated && validate.allPassed !== false;
  const anyApproved = reviews.length > 0 && reviews.some((r: any) => r.approved === true);
  const done = validationPassed && anyApproved;

  const feedbackParts: string[] = [];
  if (validate && !validationPassed && validate.failingSummary) {
    feedbackParts.push(`VALIDATION FAILED:\n${validate.failingSummary}`);
  }
  for (const review of reviews) {
    if (review.approved === false) {
      feedbackParts.push(`REVIEWER REJECTED:\n${review.feedback}`);
      if (review.issues?.length) {
        for (const issue of review.issues) {
          feedbackParts.push(`  [${issue.severity}] ${issue.title}: ${issue.description}${issue.file ? ` (${issue.file})` : ""}`);
        }
      }
    }
  }
  const feedback = feedbackParts.length > 0 ? feedbackParts.join("\n\n") : null;

  return (
    <Workflow name="vibersyn-implement">
      <ValidationLoop
        idPrefix="panimpl"
        prompt={ctx.input.prompt}
        implementAgents={[providers.codexApp]}
        validateAgents={[providers.codexApp]}
        reviewAgents={[providers.claudeApp]}
        feedback={feedback}
        done={done}
        maxIterations={3}
      />
    </Workflow>
  );
});
