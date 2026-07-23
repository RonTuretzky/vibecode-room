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
await mountWorkflow("smithering-impl", "Smithering Build (live)");
await mountWorkflow("idea-detection", "Idea Detection");

// The room server launches every accepted idea as workflow "vibersyn-process"
// (DEFAULT_GATEWAY_WORKFLOW in src/server/smithers-select.ts); without this
// registration the gateway 404s every room spawn. No UI — runs surface on the
// wall via run events.
try {
  const mod = await import("./workflows/vibersyn-process.tsx");
  // The literal import specifier gives TS the workflow's generic
  // SmithersWorkflow<Schema> type, whose typed ctx is contravariant-
  // incompatible with register()'s untyped SmithersWorkflow parameter; the
  // runtime shape is identical (the UI-mounted workflows above dodge this via
  // a non-literal specifier that types the module as any).
  gateway.register("vibersyn-process", mod.default as Parameters<typeof gateway.register>[1]);
  console.log("  vibersyn-process (room spawns) registered");
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.warn("[gateway] skipped vibersyn-process: " + message);
}

// SELF-HOSTING (VIBERSYN_SELF_MODE=1): steering the pinned SELF project
// ("mirror") launches workflow "vibersyn-self" (SELF_WORKFLOW in
// src/self/commission.ts); without this registration every self-steer spawn
// fails at launch. No UI — the SELF card renders the run's telemetry.
try {
  const mod = await import("./workflows/vibersyn-self.tsx");
  // Same literal-specifier typing dance as vibersyn-process above.
  gateway.register("vibersyn-self", mod.default as Parameters<typeof gateway.register>[1]);
  console.log("  vibersyn-self (room self-hosting spawns) registered");
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.warn("[gateway] skipped vibersyn-self: " + message);
}

// ---------------------------------------------------------------------------
// Vibersyn steer-window plumbing.
//
// vibersyn-process now parks in `waiting-event` while it waits for room steer
// signals (see workflows/vibersyn-process.tsx). Two gaps in the stock Gateway
// around parked runs:
//
//   1. Wait timeouts are only enforced when something resumes the run (the
//      engine checks the deadline on resume; nothing schedules a wake-up).
//      Steers resume the run via submitSignal -> resumeRunIfNeeded, but an
//      unsteered run would sit in waiting-event forever. The sweeper below
//      periodically resumes parked vibersyn-process runs; each resume either
//      resolves an expired steer window (skip -> run finishes) or re-parks
//      within ~half a second. Premature resumes do not reset the deadline.
//
//   2. `cancelRun` only aborts runs in the in-memory active set and returns
//      RUN_NOT_ACTIVE for parked (or already-finished) ones. The room's halt
//      path (registry.halt -> GatewaySmithersClient.halt -> cancelRun) does
//      not tolerate that error, so halting a project mid-steer-window would
//      break. The routeRequest wrapper below turns RUN_NOT_ACTIVE into:
//      terminal run -> ok (idempotent halt); parked run -> resume it into the
//      active set, then retry the abort.
//
// Both paths reuse only Gateway methods its own RPC handlers already use
// (routeRequest, resolveRun, listRunsAcrossWorkflows, resumeRun) and fail
// soft: any error leaves the stock response/behavior in place.

const VIBERSYN_WORKFLOW_KEY = "vibersyn-process";
const STEER_SWEEP_INTERVAL_MS = 60_000;

// Internal connection for self-issued RPCs — the same object shape the
// gateway builds for authenticated transports (and that the app's
// InProcessGatewayTransport passes to routeRequest).
const bridgeConnection = {
  connectionId: "vibersyn-bridge",
  transport: "internal",
  authenticated: true,
  sessionToken: null,
  role: "system",
  scopes: ["*"],
  userId: "vibersyn-bridge",
  tokenId: null,
  subscribedRuns: null,
  devtoolsStreams: new Map(),
};

const anyGateway = gateway as any;
const routeRaw = anyGateway.routeRequest.bind(gateway) as (
  connection: unknown,
  frame: Record<string, unknown>,
) => Promise<any>;

function bridgeRpc(method: string, params: Record<string, unknown>): Promise<any> {
  return routeRaw(bridgeConnection, {
    type: "req",
    id: method + ":" + crypto.randomUUID(),
    method,
    params,
  });
}

function isTerminalStatus(status: unknown): boolean {
  return status === "finished" || status === "failed" || status === "cancelled";
}

anyGateway.routeRequest = async (connection: unknown, frame: any) => {
  const response = await routeRaw(connection, frame);
  const method = frame?.method;
  const isCancel = method === "cancelRun" || method === "runs.cancel";
  if (!isCancel || response?.ok !== false || response?.error?.code !== "RUN_NOT_ACTIVE") {
    return response;
  }
  try {
    const runId = typeof frame?.params?.runId === "string" ? frame.params.runId : undefined;
    if (runId === undefined) return response;
    const resolved = await anyGateway.resolveRun(runId);
    const run = resolved == null ? undefined : await resolved.adapter.getRun(runId);
    if (run == null) return response;
    if (isTerminalStatus(run.status)) {
      // Idempotent halt: the run already ended; report its terminal status.
      return {
        type: "res",
        id: frame.id,
        ok: true,
        apiVersion: response?.apiVersion,
        payload: { runId, status: run.status },
      };
    }
    // Parked (waiting-*): resume it into the active set, then retry the abort.
    await bridgeRpc("resumeRun", { runId });
    return await routeRaw(connection, frame);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[gateway] parked-run cancel fallback failed: " + message);
    return response;
  }
};

async function sweepParkedVibersynRuns(): Promise<void> {
  try {
    const waiting = await anyGateway.listRunsAcrossWorkflows(500, "waiting-event");
    for (const run of Array.isArray(waiting) ? waiting : []) {
      if (run?.workflowKey !== VIBERSYN_WORKFLOW_KEY) continue;
      if (typeof run?.runId !== "string") continue;
      const res = await bridgeRpc("resumeRun", { runId: run.runId });
      if (res?.ok === false) {
        console.warn("[gateway] steer sweep resume failed for " + run.runId + ": " + (res?.error?.code ?? "unknown"));
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[gateway] vibersyn steer sweep failed: " + message);
  }
}

await gateway.listen({ host, port });
console.log("Smithers Gateway listening on http://" + host + ":" + port);

// Start the steer-window sweeper once the gateway is serving, and run one
// immediate pass so runs left parked by a previous session get unwedged.
setInterval(() => {
  void sweepParkedVibersynRuns();
}, STEER_SWEEP_INTERVAL_MS);
void sweepParkedVibersynRuns();
