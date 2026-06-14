# Spec: fix the durable process steer-loop + cancel (D1 hardening)

## Context
D1 added a durable, steerable process run: `src/core/workflows/process.tsx`
(a `<Loop>` of `<WaitForEvent event="steer">` → `<Task id="step">`),
`src/core/gateway.ts` (embedded app Gateway), `src/core/control-plane.ts`
(SmithersControlPlane wrapping gateway-client), and an opt-in end-to-end test
`src/core/durable-run-smoke.test.ts`.

The end-to-end smoke (run with `PANOPTICON_SMOKE_AGENT=1 bun test --timeout 180000 src/core/durable-run-smoke.test.ts`)
revealed TWO real bugs. The core round-trip works (launch → waiting-event → steer →
step runs via ioAgents → events stream), but:

1. **Double-fire / busy-loop:** one steer signal produced a step at loop iteration 0
   AND iteration 1. `process.tsx` uses a STATIC `correlationId="steer"`, so after the
   event is delivered once, every subsequent loop iteration's `<WaitForEvent>` re-resolves
   on the same already-delivered event instead of blocking for a fresh signal.
2. **Kill rejected:** `control.kill(upid)` → `cancelRun` failed with
   `GatewayRpcError: RUN_NOT_ACTIVE ("Run is not currently active")`.

## Goal / acceptance criteria
- **Exactly one `step` per steer.** After one `steer()`, exactly one `step` node runs,
  then the run blocks again in `waiting-event` until the NEXT steer. No busy-loop.
- **Pause/kill work on a waiting run.** `control.pause(upid)` and `control.kill(upid)`
  succeed (or are made to succeed) when the run is suspended in `waiting-event`.
  Handle `RUN_NOT_ACTIVE` correctly — research the right mechanism (e.g. per-iteration
  correlationId so the run truly suspends; a dedicated "kill"/"stop" signal the loop
  checks; or the correct cancel call/state for a waiting run).
- The smoke test passes deterministically and is STRENGTHENED:
  - set its own `{ timeout: 180_000 }` (do not rely on bun's 5s default),
  - assert exactly one `step` runs per steer (no second step before a second steer),
  - assert `kill` succeeds and the run ends non-active.

## Research first (the mechanism is subtle — do not guess)
Read, before changing code:
- `node_modules/smithers-orchestrator` docs/types for `WaitForEvent` props
  (`id`, `event`, `correlationId`, `output`, `outputSchema`, `timeoutMs`, `onTimeout`)
  and how a Loop iteration keys nodes (ctx.iteration / iterationCount).
- The smithers gateway-client `submitSignal` (correlationKey/signalName) and `cancelRun`,
  and what run statuses `cancelRun` accepts (find where `RUN_NOT_ACTIVE` is raised in
  `node_modules/@smithers-orchestrator/**`).
- Any canonical signal-driven-loop example (e.g. `.smithers/workflows/demo.tsx` patterns).
Then make `control-plane.steer(upid, text)` deliver to the iteration the run is CURRENTLY
waiting on (e.g. read current iteration from `getRun`, submit with the matching correlationId).

## Constraints
- Edit ONLY: `src/core/workflows/process.tsx`, `src/core/control-plane.ts`,
  `src/core/gateway.ts` (if needed), `src/core/durable-run-smoke.test.ts`.
- Do NOT touch `panopticon-world/`, `node_modules/`, or unrelated files.
- Subscriptions only (ioAgents). No mocks — the smoke test uses the real gateway + a real agent step.
- Gate: `bun run typecheck` passes AND `PANOPTICON_SMOKE_AGENT=1 bun test --timeout 180000 src/core/durable-run-smoke.test.ts` passes. Run both before finishing.
