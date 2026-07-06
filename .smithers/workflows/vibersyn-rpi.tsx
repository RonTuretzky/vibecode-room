// smithers-source: dev workflow (Vibersyn build — full "smithering" pipeline; NOT app code).
// research -> plan -> implement -> validate -> review, with INDEPENDENT review and TDD-first:
//   research / plan / implement / validate = codex (gpt-5.5); review = claude (opus-4-8).
// Validate + implement prompts gate on `bun run typecheck` AND `bun test` (no mocks, green gate).
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { providers } from "../agents";
import { ValidationLoop, implementOutputSchema, validateOutputSchema } from "../components/ValidationLoop";
import { reviewOutputSchema } from "../components/Review";
import ResearchPrompt from "../prompts/research.mdx";
import PlanPrompt from "../prompts/plan.mdx";

const researchOutputSchema = z.looseObject({
  summary: z.string(),
  keyFindings: z.array(z.string()).default([]),
});
const planOutputSchema = z.looseObject({
  summary: z.string(),
  steps: z.array(z.string()).default([]),
});

const inputSchema = z.object({
  prompt: z.string().default("Implement the requested change."),
  tdd: z.boolean().default(true),
});

const { Workflow, Task, Sequence, smithers } = createSmithers({
  input: inputSchema,
  research: researchOutputSchema,
  plan: planOutputSchema,
  implement: implementOutputSchema,
  validate: validateOutputSchema,
  review: reviewOutputSchema,
});

export default smithers((ctx) => {
  const prompt = ctx.input.prompt;
  const tdd = ctx.input.tdd;

  const research = ctx.outputMaybe("research", { nodeId: "research" });
  const plan = ctx.outputMaybe("plan", { nodeId: "plan" });

  const planPrompt = [
    prompt,
    research
      ? `RESEARCH FINDINGS:\n${research.summary}\n\nKey findings:\n${research.keyFindings.map((f: string) => `- ${f}`).join("\n")}`
      : null,
    tdd
      ? "IMPORTANT: test-first. The plan MUST start with `bun test` steps that define expected behavior before any implementation step."
      : null,
  ].filter(Boolean).join("\n\n---\n");

  const implementPrompt = [
    prompt,
    research ? `RESEARCH FINDINGS:\n${research.summary}` : null,
    plan
      ? `IMPLEMENTATION PLAN:\n${plan.summary}\n\nSteps:\n${plan.steps.map((s: string, i: number) => `${i + 1}. ${s}`).join("\n")}`
      : null,
    tdd ? "Follow the plan's test-first approach: write/extend `bun test` tests BEFORE production code." : null,
    "GATE (no mocks): `bun run typecheck` AND `bun test` MUST both pass before finishing. Use real backends/data; do not fabricate or stub away failures.",
  ].filter(Boolean).join("\n\n---\n");

  const validate = ctx.outputMaybe("validate", { nodeId: "rpi:validate" });
  const reviews = ctx.outputs.review ?? [];

  const validationPassed = validate !== undefined && validate.allPassed !== false;
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
    <Workflow name="vibersyn-rpi">
      <Sequence>
        <Task id="research" output={researchOutputSchema} agent={[providers.codexApp]}>
          <ResearchPrompt prompt={prompt} />
        </Task>
        <Task id="plan" output={planOutputSchema} agent={[providers.codexApp]}>
          <PlanPrompt prompt={planPrompt} />
        </Task>
        <ValidationLoop
          idPrefix="rpi"
          prompt={implementPrompt}
          implementAgents={[providers.codexApp]}
          validateAgents={[providers.codexApp]}
          reviewAgents={[providers.claudeApp]}
          feedback={feedback}
          done={done}
          maxIterations={3}
        />
      </Sequence>
    </Workflow>
  );
});
