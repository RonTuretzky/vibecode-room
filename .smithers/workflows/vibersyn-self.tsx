// smithers-source: dev-only room-run bridge.
// SELF-HOSTING sibling of vibersyn-process: when the room runs with
// VIBERSYN_SELF_MODE=1, steering the pinned SELF project ("mirror") launches
// THIS workflow (src/self/commission.ts SelfCommissioner.steer). One durable
// subscription task applies ONE spoken/clicked correction to the room's OWN
// repository (the parent of .smithers/ — providers.claudeApp is pinned to
// APP_ROOT), gates on `bunx tsc --noEmit && bun run build`, and commits
// "self: <summary>". No steer window: each correction is its own run, and the
// room serializes them (a second steer while one executes is refused there).
//
// The room does NOT trust this run's "green" claim: after the run finishes it
// re-reads git HEAD and only reloads when a NEW commit with a "self:" subject
// actually landed (the room-side green gate). So the worst a misbehaving run
// can do is fail its own lane — it can never reload the room red.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { providers } from "../agents";

// NOTE: zod defaults are documentation only — an omitted field reaches
// ctx.input as null (same engine fact vibersyn-process documents), so every
// consumer normalizes with `??`.
const inputSchema = z.object({
  // The steering instruction. The room sends it as both `prompt` (the spawn
  // seed's prompt slot) and `instruction` (explicit input) — either works.
  prompt: z.string().nullable().default(null),
  instruction: z.string().nullable().default(null),
  upid: z.string().nullable().default(null),
  callsign: z.string().nullable().default(null),
  correlationId: z.string().nullable().default(null),
});

const changeOutputSchema = z.object({
  // One line describing the change (or why nothing was changed).
  summary: z.string(),
  // Whether a "self:" commit actually landed.
  committed: z.boolean(),
  // `git rev-parse HEAD` after the commit; null when nothing was committed.
  commitSha: z.string().nullable(),
  // The exact repo-relative paths staged into the commit.
  filesChanged: z.array(z.string()),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  change: changeOutputSchema,
});

export default smithers((ctx) => {
  const instruction = ctx.input.instruction ?? ctx.input.prompt ?? "(no instruction was provided — change nothing)";
  const callsign = ctx.input.callsign ?? "mirror";

  return (
    <Workflow name="vibersyn-self">
      <Task id="change" output={outputs.change} agent={[providers.claudeApp]}>
        {`You are the Vibersyn room modifying ITS OWN source code (self-hosting mode, callsign ${callsign}). Your working directory is the room's repository root.

STEERING INSTRUCTION (spoken or clicked in the room — apply it now):
${instruction}

HARD RULES — all of them, no exceptions:
1. FIRST run \`git status --porcelain\` and record every path it lists. Those
   are someone's uncommitted work: NEVER modify, stage, or commit any of them.
2. NEVER touch gesture-wall/, .smithers/, artifacts/, builds/, dist/,
   node_modules/, or smithers.db* — read them if you must, write them never.
   (\`bun run build\` regenerating dist/ is fine; committing dist/ is not.)
3. Make the SMALLEST change that satisfies the instruction, matching the
   codebase's existing seams and idioms. Do not refactor beyond it.
4. GREEN GATE: run \`bunx tsc --noEmit && bun run build\` and keep fixing your
   own change until BOTH pass clean. Never commit red.
5. Commit ONLY the files you created or edited, staged by EXPLICIT path
   (\`git add <path> <path>\` — never \`git add -A\`, never \`git add .\`), with
   the exact message shape:
       self: <one-line instruction summary>
   Nothing else in the message — no attribution, no Co-Authored-By trailer.
6. If the instruction cannot be satisfied under these rules, change nothing,
   commit nothing, and explain why in "summary".

Report: "summary" = one line describing what changed (or why nothing did);
"committed" = whether the self: commit landed; "commitSha" = \`git rev-parse
HEAD\` after your commit (null when none); "filesChanged" = the exact paths
you committed (empty when none).`}
      </Task>
    </Workflow>
  );
});
