// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Monitor Smithers
// smithers-description: Watchdog over Smithers runs: detect stuck, blocked, failed, or over-budget runs and escalate.
// smithers-tags: ops, monitoring
/** @jsxImportSource smithers-orchestrator */
import { $ } from "bun";
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import ClassifyPrompt from "../prompts/monitor-smithers-classify.mdx";
import TriagePrompt from "../prompts/monitor-smithers-triage.mdx";

const inputSchema = z.object({
  staleMinutes: z
    .number()
    .default(15)
    .describe("A run with no recent activity past this many minutes is treated as stale/stuck."),
});

// 1. The raw snapshot of currently-known runs, gathered by shelling out to `ps`.
const runSchema = z.looseObject({
  runId: z.string(),
  status: z.string(),
  ageMinutes: z.number().default(0),
  lastEvent: z.string().nullable().default(null),
});

const pollSchema = z.looseObject({
  runs: z.array(runSchema).default([]),
  summary: z.string(),
});

// 2. The same runs, sorted into health buckets by a cheap/fast agent.
const classifySchema = z.looseObject({
  buckets: z.looseObject({
    healthy: z.array(z.string()).default([]),
    stuck: z.array(z.string()).default([]),
    blocked: z.array(z.string()).default([]),
    failed: z.array(z.string()).default([]),
    overBudget: z.array(z.string()).default([]),
  }),
  summary: z.string(),
});

// 3. Concrete escalation actions for every non-healthy run.
const triageSchema = z.looseObject({
  actions: z
    .array(
      z.object({
        runId: z.string(),
        problem: z.string(),
        recommendedAction: z.string(),
      }),
    )
    .default([]),
  digest: z.string(),
});

const { Workflow, Task, Sequence, Branch, smithers, outputs } = createSmithers({
  input: inputSchema,
  poll: pollSchema,
  classify: classifySchema,
  triage: triageSchema,
});

// Pull the live run table from the CLI. Deterministic, no agent: shell out, parse
// JSON, and normalise into the watchdog's run shape. Any failure (CLI missing,
// non-zero exit, bad JSON) degrades to an empty list rather than throwing.
async function pollRuns(staleMinutes: number) {
  const res = await $`bunx smithers-orchestrator ps --format json --all`.nothrow().quiet();
  if (res.exitCode !== 0) {
    return { runs: [], summary: "Could not read runs from `smithers ps` (non-zero exit)." };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout.toString());
  } catch {
    return { runs: [], summary: "Could not parse `smithers ps --format json` output." };
  }

  const rawList = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { runs?: unknown }).runs)
      ? (parsed as { runs: unknown[] }).runs
      : [];

  const runs = rawList.map((row) => {
    const r = row as Record<string, unknown>;
    const runId = String(r.id ?? r.runId ?? "unknown");
    const status = String(r.status ?? r.dbStatus ?? r.state ?? "unknown");
    const startedRaw = r.started ?? r.startedAt;
    const ageMatch = typeof startedRaw === "string" ? startedRaw.match(/(\d+)\s*([smhd])/) : null;
    let ageMinutes = 0;
    if (ageMatch) {
      const n = Number(ageMatch[1]);
      const unit = ageMatch[2];
      ageMinutes = unit === "m" ? n : unit === "h" ? n * 60 : unit === "d" ? n * 1440 : Math.round(n / 60);
    }
    const step = r.step ?? r.lastEvent;
    const lastEvent = step != null && String(step) !== "—" ? String(step) : null;
    return { runId, status, ageMinutes, lastEvent };
  });

  const staleCount = runs.filter((run) => run.ageMinutes >= staleMinutes).length;
  return {
    runs,
    summary: `${runs.length} run(s) seen; ${staleCount} past the ${staleMinutes}m stale threshold.`,
  };
}

/**
 * A watchdog over Smithers itself. It polls the live run table, has a cheap agent
 * sort runs into health buckets, and — only when something is wrong — has a smart
 * agent produce concrete escalation actions (which gate to clear, which run to
 * triage). Healthy fleets short-circuit before the expensive triage step.
 */
export default smithers((ctx) => {
  const staleMinutes = ctx.input.staleMinutes ?? 15;

  const poll = ctx.outputMaybe("poll", { nodeId: "poll" });
  const classify = ctx.outputMaybe("classify", { nodeId: "classify" });

  // Anything not in the `healthy` bucket needs escalation.
  const buckets = classify?.buckets;
  const unhealthy = buckets
    ? [...buckets.stuck, ...buckets.blocked, ...buckets.failed, ...buckets.overBudget]
    : [];
  const hasProblems = unhealthy.length > 0;

  return (
    <Workflow name="monitor-smithers">
      <Sequence>
        {/* 1 — Deterministically read the live run table from the CLI. */}
        <Task id="poll" output={outputs.poll}>
          {async () => await pollRuns(staleMinutes)}
        </Task>

        {/* 2 — Sort the runs into health buckets. Cheap/fast: pure classification. */}
        {poll ? (
          <Task id="classify" output={outputs.classify} agent={agents.cheapFast}>
            <ClassifyPrompt runs={poll.runs} summary={poll.summary} staleMinutes={staleMinutes} />
          </Task>
        ) : null}

        {/* 3 — Only escalate when something is actually wrong. */}
        <Branch
          if={classify !== undefined && hasProblems}
          then={
            <Task id="triage" output={outputs.triage} agent={agents.smart}>
              <TriagePrompt buckets={classify?.buckets} runs={poll?.runs ?? []} summary={classify?.summary} />
            </Task>
          }
          else={null}
        />
      </Sequence>
    </Workflow>
  );
});
