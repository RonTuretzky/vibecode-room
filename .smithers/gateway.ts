import { Gateway, mdxPlugin } from "smithers-orchestrator";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

mdxPlugin();

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
process.chdir(projectRoot);

const parsedPort = Number(process.env.PORT ?? "7331");
const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 7331;
const host = process.env.HOST ?? "127.0.0.1";

const gateway = new Gateway({ heartbeatMs: 15_000 });

// Mount each workflow + its UI independently. A workflow that fails to
// import (e.g. a broken prompt/MDX) disables only its own UI — the rest of
// the gateway and the other workflow UIs still come up.
async function mountWorkflow(key: string, title: string) {
  try {
    const mod = await import("./workflows/" + key + ".tsx");
    gateway.register(key, mod.default, {
      ui: { entry: resolve(here, "ui", key + ".tsx"), title },
    });
    console.log("  " + title + " UI -> http://" + host + ":" + port + "/workflows/" + key);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[gateway] skipped " + key + " UI: " + message);
  }
}

console.log("Workflow UIs:");
await mountWorkflow("kanban", "Kanban");
await mountWorkflow("plan", "Plan");
await mountWorkflow("implement", "Implement");
await mountWorkflow("research-plan-implement", "Research Plan Implement");
await mountWorkflow("review", "Review");
await mountWorkflow("research", "Research");
await mountWorkflow("ticket-create", "Ticket Create");
await mountWorkflow("tickets-create", "Tickets Create");
await mountWorkflow("ralph", "Ralph");
await mountWorkflow("improve-test-coverage", "Improve Test Coverage");
await mountWorkflow("debug", "Debug");
await mountWorkflow("grill-me", "Grill Me");
await mountWorkflow("feature-enum", "Feature Enum");
await mountWorkflow("audit", "Audit");
await mountWorkflow("mission", "Mission");
await mountWorkflow("workflow-skill", "Workflow Skill");
await mountWorkflow("vcs", "VCS");
await mountWorkflow("smithering", "Smithering");

await gateway.listen({ host, port });
console.log("Smithers Gateway listening on http://" + host + ":" + port);
