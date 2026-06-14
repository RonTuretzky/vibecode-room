// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Backpressure Plan
// smithers-description: Turn acceptance criteria into a gate matrix (schema/test/eval/review/approval/trace) so a workflow cannot just try-its-best and move on.
// smithers-tags: quality, backpressure
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import ExtractCriteriaPrompt from "../prompts/backpressure-plan-extract-criteria.mdx";
import PlanGatesPrompt from "../prompts/backpressure-plan-plan-gates.mdx";

const inputSchema = z.object({
  prompt: z
    .string()
    .default("Describe the goal and its acceptance criteria in plain English.")
    .describe("The goal / acceptance criteria to turn into a backpressure gate matrix."),
});

// 1. The flat list of testable acceptance criteria pulled out of the prompt.
const criteriaSchema = z.looseObject({
  criteria: z
    .array(z.string())
    .default([])
    .describe("One atomic, verifiable acceptance criterion per entry."),
});

// 2. The gate matrix: every criterion mapped to how it is verified and enforced.
const gatesSchema = z.looseObject({
  gates: z
    .array(
      z.object({
        criterion: z.string().describe("The acceptance criterion this gate enforces."),
        verificationMethod: z
          .enum([
            "schema",
            "unit_test",
            "integration_test",
            "eval",
            "review",
            "approval",
            "trace",
            "manual_check",
          ])
          .describe("How the criterion is checked."),
        gateType: z
          .enum(["blocking", "warning", "informational"])
          .describe("blocking stops the run; warning flags; informational only records."),
        checkedBy: z.string().describe("Who/what runs the check (a task id, scorer, human role, or tool)."),
        failureAction: z.string().describe("What happens when this gate fails."),
        evidenceRequired: z
          .array(z.string())
          .default([])
          .describe("Concrete artifacts that prove the gate passed (logs, diffs, reports, traces)."),
        humanApprovalRequired: z
          .boolean()
          .default(false)
          .describe("True if a durable human approval gate is needed for this criterion."),
      }),
    )
    .default([])
    .describe("One gate per criterion; every blocking criterion maps to a verification method."),
  summary: z.string().default("").describe("2-3 sentence overview of the backpressure plan."),
});

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  input: inputSchema,
  extractCriteria: criteriaSchema,
  planGates: gatesSchema,
});

export default smithers((ctx) => {
  // Gate the plan-gates stage on the extracted criteria being available.
  const criteria = ctx.outputMaybe("extractCriteria", { nodeId: "extract-criteria" });

  return (
    <Workflow name="backpressure-plan">
      <Sequence>
        {/* 1 — Pull the prompt apart into atomic, verifiable acceptance criteria. */}
        <Task id="extract-criteria" output={outputs.extractCriteria} agent={agents.smart}>
          <ExtractCriteriaPrompt prompt={ctx.input.prompt} />
        </Task>

        {/* 2 — Map each criterion to a verification method + enforcement gate. */}
        {criteria ? (
          <Task id="plan-gates" output={outputs.planGates} agent={agents.smart}>
            <PlanGatesPrompt criteria={criteria.criteria} prompt={ctx.input.prompt} />
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
