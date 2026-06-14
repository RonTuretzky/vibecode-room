// smithers-source: dev-only smoke test (safe to delete)
// Verifies: workflow loads, a subscription agent resolves & runs, output validates,
// and—critically—reports the cwd the agent operates in (app-edit root check).
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { providers } from "../agents";

const smokeOutputSchema = z.object({
  cwd: z.string(),
  topLevelEntries: z.array(z.string()).default([]),
  note: z.string(),
});

const inputSchema = z.object({
  prompt: z.string().default("Report the working directory."),
});

const { Workflow, Task, smithers } = createSmithers({
  input: inputSchema,
  smoke: smokeOutputSchema,
});

export default smithers((ctx) => (
  <Workflow name="smoke">
    <Task id="smoke" output={smokeOutputSchema} agent={[providers.claudeApp]}>
      {`Run the shell command \`pwd\` and then \`ls -1\` in that directory.
Report the ABSOLUTE current working directory in "cwd".
Report the top-level entries you see in "topLevelEntries".
Put a one-line confirmation in "note".
Do NOT modify, create, or delete ANY files. This is a read-only probe.`}
    </Task>
  </Workflow>
));
