// smithers-source: dev-only room-run bridge.
// The Vibersyn room server launches every accepted idea as workflow
// "vibersyn-process" (DEFAULT_GATEWAY_WORKFLOW, src/server/smithers-select.ts).
// This durable build has one subscription agent build the idea as a static app
// under artifacts/vibersyn-runs/<upid>/ — never anywhere else in the repo —
// then enters a bounded STEER WINDOW: a loop (max MAX_STEER_ITERATIONS) that
// durably waits for a "steer" signal from the room (CLICK A PROJECT -> STEER
// IT routes live transcript lines through GatewaySmithersClient.steer, which
// submits signalName "steer" with correlationKey = the spawn correlationId).
// Each received steer runs a follow-up agent task applying the correction to
// the same output directory; when a window passes with no signal the wait
// times out (onTimeout="skip") and the run finishes cleanly.
//
// Signal-delivery facts this file relies on (verified against
// smithers-orchestrator 0.23; docs: node_modules/@smithers-orchestrator/cli/
// docs/llms-full.txt, engine source: durable-deferred-bridge.js):
//   - A signal matches a waiting node only when BOTH the signal name equals
//     the node's `event` AND the correlationIds are an exact match (null ==
//     null included). The room seam always submits correlationKey = the spawn
//     correlationId, so the wait below must correlate on
//     ctx.input.correlationId. Manual/CLI launches (correlationId null) are
//     steerable via `smithers signal <runId> steer --data '{...}'` with no
//     --correlation flag.
//   - A run parks (status "waiting-event") while a wait is pending; a steer
//     signal resumes it via the gateway (submitSignal -> resumeRunIfNeeded).
//     Wait timeouts are only enforced on resume, so ../gateway.ts runs a
//     sweeper that periodically resumes parked vibersyn-process runs; without
//     it an unsteered run would never time out.
//   - "pause"/"resume" signals from the room seam have no matching wait node
//     here: they are durably recorded, resolve immediately for the caller,
//     and act as no-ops (their resume side effect just re-parks the run).
//   - Known limitation: steers submitted while a task is still executing
//     (initial build or a steer fix) are recorded but not replayed into a
//     later wait (the engine only matches signals received after the wait
//     attempt started). Steering is therefore only live while the run is
//     parked in the steer window; at most one queued steer is consumed per
//     window.
//   - Timeout-skip transiently surfaces a phantom output row with null
//     payload during the resuming session, so every consumer below filters
//     `payload != null`.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Loop, Sequence, WaitForEvent } from "smithers-orchestrator";
import { z } from "zod/v4";
import { providers } from "../agents";

const STEER_LOOP_ID = "steer-loop";
const MAX_STEER_ITERATIONS = 5;
// One steer window: how long each loop iteration waits for a steer signal
// before the run completes. Enforced at sweeper granularity (see gateway.ts).
const DEFAULT_STEER_WAIT_MS = 5 * 60_000;

// NOTE: zod defaults here are documentation only — the engine persists the
// launch input through the generated table schema, so an omitted field
// reaches ctx.input as null (verified against 0.23). Every consumer below
// must normalize with `??`.
const inputSchema = z.object({
  prompt: z.string().nullable().default(null),
  upid: z.string().nullable().default(null),
  callsign: z.string().nullable().default(null),
  // Spawn correlation id, injected into the input by GatewaySmithersClient
  // .spawn (src/seam/smithers-client.ts). Steer signals from the room carry
  // this exact value as their correlationKey — see the header comment.
  correlationId: z.string().nullable().default(null),
  steerWaitMs: z.number().int().nullable().default(null),
});

const buildOutputSchema = z.object({
  outputDir: z.string(),
  entrypoint: z.string(),
  summary: z.string(),
});

// Separate schema INSTANCE for steer fixes: createSmithers keys tables by the
// zod object identity, so reusing buildOutputSchema would collide the tables.
const steerFixOutputSchema = z.object({
  outputDir: z.string(),
  entrypoint: z.string(),
  summary: z.string(),
});

// Payload-only capture: with `payload` as the single non-key column, the
// engine stores the ENTIRE signal payload JSON into that column without
// per-field validation, so any object-shaped steer payload is accepted
// (the room sends { type: "steer", payload: { text, source } }).
const steerSignalSchema = z.object({
  payload: z.unknown(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  build: buildOutputSchema,
  steer: steerSignalSchema,
  steerFix: steerFixOutputSchema,
});

// Best-effort extraction of the human correction text from a steer payload.
// Room shape: { type: "steer", payload: { text, source } }; tolerate a bare
// { text } (manual CLI signal) and fall back to the raw JSON.
function steerTextFrom(payload: unknown): string {
  if (typeof payload === "object" && payload !== null) {
    const outer = payload as Record<string, unknown>;
    const inner = outer.payload;
    if (typeof inner === "object" && inner !== null) {
      const text = (inner as Record<string, unknown>).text;
      if (typeof text === "string" && text.trim().length > 0) return text;
    }
    if (typeof outer.text === "string" && outer.text.trim().length > 0) return outer.text;
  }
  return JSON.stringify(payload ?? null);
}

// Clamp a caller-supplied steer window to something sane; fall back to the
// default when absent (null), non-finite, or out of range.
function normalizeSteerWaitMs(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_STEER_WAIT_MS;
  return Math.min(Math.max(Math.floor(value), 1_000), 60 * 60_000);
}

export default smithers((ctx) => {
  const prompt = ctx.input.prompt ?? "Build a small self-contained static web app.";
  const upid = ctx.input.upid ?? "upid-unknown";
  const callsign = ctx.input.callsign ?? null;
  const steerWaitMs = normalizeSteerWaitMs(ctx.input.steerWaitMs);
  // Current steer-loop iteration (0-based). `ctx.iterations` is keyed by the
  // Loop id; `ctx.iteration` mirrors it while this is the only loop.
  const iteration = ctx.iterations?.[STEER_LOOP_ID] ?? ctx.iteration ?? 0;
  // Real steer signals received so far (filter out the timeout-skip phantom
  // row — see header). One row per loop iteration, at most.
  const steers = ((ctx.outputs.steer ?? []) as Array<{ iteration?: number; payload?: unknown }>)
    .filter((row) => row.payload !== null && row.payload !== undefined);
  // A completed iteration with no steer row means its wait timed out — the
  // room went quiet, so the loop must exit instead of opening another window.
  const steerExhausted = steers.length < iteration;
  const currentSteer = steers.find((row) => Number(row.iteration ?? 0) === iteration);
  const priorFixes = (ctx.outputs.steerFix ?? []) as Array<{ iteration?: number; summary?: string }>;
  const build = ((ctx.outputs.build ?? []) as Array<{ summary?: string }>)[0];

  const outputDirLine = `artifacts/vibersyn-runs/${upid}/`;

  return (
    <Workflow name="vibersyn-process">
      <Sequence>
        <Task id="build" output={outputs.build} agent={[providers.claudeApp]}>
          {`You are building a room-accepted idea${callsign ? ` (callsign ${callsign})` : ""}.

IDEA: ${prompt}

Create a small, self-contained static web app for this idea in the directory
${outputDirLine} — create it if needed, and write ONLY
inside that directory; never modify any other path in this repository.
index.html must work when opened directly: inline CSS/JS, no build step, no
network dependencies. Keep it to a single focused page that demonstrates the
idea well.

Report the ABSOLUTE output directory in "outputDir", the entry file path in
"entrypoint", and a one-line description of what you built in "summary".`}
        </Task>

        {/* Bounded steer window: wait for a room steer, apply it, repeat. */}
        <Loop
          id={STEER_LOOP_ID}
          until={steerExhausted}
          maxIterations={MAX_STEER_ITERATIONS}
          onMaxReached="return-last"
        >
          <Sequence>
            <WaitForEvent
              id="steer"
              event="steer"
              correlationId={ctx.input.correlationId ?? undefined}
              output={outputs.steer}
              outputSchema={steerSignalSchema}
              timeoutMs={steerWaitMs}
              onTimeout="skip"
              label={`steer window ${iteration + 1}/${MAX_STEER_ITERATIONS}`}
            />
            {currentSteer ? (
              <Task id="apply-steer" output={outputs.steerFix} agent={[providers.claudeApp]} continueOnFail>
                {`You are applying a live steering correction to a room-built app${callsign ? ` (callsign ${callsign})` : ""}.

ORIGINAL IDEA: ${prompt}
WHAT WAS BUILT: ${build?.summary ?? "(build summary unavailable — inspect the directory)"}${priorFixes.length > 0 ? `\nPRIOR CORRECTIONS ALREADY APPLIED:\n${priorFixes.map((fix, index) => `  ${index + 1}. ${fix.summary ?? "(no summary)"}`).join("\n")}` : ""}

STEERING CORRECTION (spoken by the room, apply it now):
${steerTextFrom(currentSteer.payload)}

Apply this correction to the existing app in the directory
${outputDirLine} — modify ONLY files inside that
directory; never touch any other path in this repository. Keep the app
self-contained: index.html must still work when opened directly (inline
CSS/JS, no build step, no network dependencies).

Report the ABSOLUTE output directory in "outputDir", the entry file path in
"entrypoint", and a one-line description of the change you made in "summary".`}
              </Task>
            ) : null}
          </Sequence>
        </Loop>
      </Sequence>
    </Workflow>
  );
});
