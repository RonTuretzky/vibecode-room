// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Workflow Skill
// smithers-description: Generate agent-facing skill documentation from local Smithers workflows.
// smithers-tags: skills, documentation, workflow-pack
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import WorkflowSkillPrompt from "../prompts/workflow-skill.mdx";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const workflowSummarySchema = z.looseObject({
  id: z.string(),
  metadataVersion: z.literal(1),
  displayName: z.string(),
  description: z.string(),
  sourceType: z.string(),
  tags: z.array(z.string()).default([]),
  aliases: z.array(z.string()).default([]),
  path: z.string(),
});

type WorkflowSummary = z.infer<typeof workflowSummarySchema>;

const workflowSkillOutputSchema = z.looseObject({
  summary: z.string(),
  generatedFiles: z.array(z.string()).default([]),
  skippedFiles: z.array(z.string()).default([]),
  markdownBody: z.string().default(""),
});

const inputSchema = z.object({
  workflow: z.string().default("all"),
  output: z.string().nullable().default(null),
  prompt: z.string().default(""),
});

const { Workflow, Task, smithers } = createSmithers({
  input: inputSchema,
  workflowSkill: workflowSkillOutputSchema,
});

function metadataValue(source: string, key: string): string | undefined {
  return source.match(new RegExp(`^//\\s*smithers-${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
}

function parseCsvMetadata(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function workflowDir(): string {
  return resolve(process.cwd(), ".smithers", "workflows");
}

function loadWorkflowSource(file: string): WorkflowSummary {
  const path = join(workflowDir(), file);
  const source = readFileSync(path, "utf8");
  const id = file.replace(/\.tsx$/, "");
  return {
    id,
    metadataVersion: 1,
    displayName: metadataValue(source, "display-name") ?? id,
    description: metadataValue(source, "description") ?? `Run the ${id} workflow.`,
    sourceType: metadataValue(source, "source") ?? "user",
    tags: parseCsvMetadata(metadataValue(source, "tags")),
    aliases: parseCsvMetadata(metadataValue(source, "aliases")),
    path,
  };
}

function discoverWorkflowSources(selected: string): WorkflowSummary[] {
  const dir = workflowDir();
  if (!existsSync(dir)) return [];
  const all = readdirSync(dir)
    .filter((file) => file.endsWith(".tsx"))
    .sort()
    .map(loadWorkflowSource)
    .filter((workflow) => workflow.id !== "workflow-skill");
  if (selected === "all") return all;
  const match = all.find((workflow) => workflow.id === selected);
  if (!match) {
    throw new Error(`Workflow not found: ${selected}`);
  }
  return [match];
}

function defaultOutputPath(selected: string): string {
  return selected === "all" ? ".smithers/skills" : `.smithers/skills/${selected}.md`;
}

export default smithers((ctx) => {
  const workflows = discoverWorkflowSources(ctx.input.workflow);
  const output = ctx.input.output ?? defaultOutputPath(ctx.input.workflow);

  return (
    <Workflow name="workflow-skill">
      <Task id="workflow-skill" output={workflowSkillOutputSchema} agent={agents.smartTool}>
        <WorkflowSkillPrompt
          workflows={workflows}
          output={output}
          prompt={ctx.input.prompt}
        />
      </Task>
    </Workflow>
  );
});
