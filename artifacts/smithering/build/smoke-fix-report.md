# Smoke fix — `smoke-smithering-panopticon-4-0` (build:setup validation failure)

## Symptom (from the child run: `smithers why / inspect / events`)
`build:setup` failed all retries with a `ZodError` on the `buildSetup` output:

```
path: integrationBranch — Invalid input: expected string, received null
path: baseBranch       — Invalid input: expected string, received null
```

The trace confirms the producer emitted nulls:

```
{"event":"build.integration.ready","integrationBranch":null,"baseBranch":null,"created":true,"worktreeReady":true}
```

## Root cause (verified against the smithers source, not assumed)
`build:setup` runs `ensureIntegrationBranch(ctx.input.integrationBranch, ctx.input.baseBranch)`
and returns those values verbatim. Both were `null` at runtime.

Why null, despite `inputSchema` declaring `integrationBranch: z.string().default("smithering/integration")`?
The durable **input table columns are generated from the Zod input schema with the `.default()`
wrapper STRIPPED**:

- `@smithers-orchestrator/db/zodToTable.js` builds each column via `unwrapZodType(zodType)`,
  and `unwrapZodType.js` unwraps `default` / `optional` / `nullable` to the base type, creating a
  plain `text(col)` column with **no** Drizzle default.
- A field the caller omits at launch is therefore stored as SQL `NULL` and surfaces on
  `ctx.input` as `null` — **not** the schema default.

The parent (`smithering.tsx:252`, `runSmokeAttempt`) launches this workflow with **only**
`JSON.stringify({ smoke: true })`, so `integrationBranch`, `baseBranch`, and the concurrency caps
all arrive as `null`. The full-mode launch (`{ smoke: false }`) omits them too, so this was a
total failure of `build:setup`, not a smoke-only edge case.

This is a real product bug (a `null` integration branch would also have broken the depth-1 land
lane's `git checkout`/hard-guard), so the fix resolves the defaults — it does **not** loosen the
`buildSetup` contract or stub anything.

## Fix
1. **`src/orchestration/core.ts`** — new pure, unit-tested helper `resolveBuildConfig(input)` plus
   `DEFAULT_*` constants. It re-applies the documented defaults that smithers does not put on
   `ctx.input`, coercing `null`/empty/whitespace branch names and non-finite caps to their
   defaults, and treating `requireDeliveryGate` as ON unless explicitly `false`. (Pure logic lives
   in `core.ts` so it is tested like code — the workflow's stated §8 convention.)
2. **`.smithers/workflows/smithering-impl.tsx`** — every `ctx.input.*` read in the render tree now
   goes through `resolveBuildConfig(ctx.input)` (workflow body, `renderWorker`, `renderWave`,
   `buildFinalReport`, the delivery `Approval`). `build:setup` now calls
   `ensureIntegrationBranch(cfg.integrationBranch, cfg.baseBranch)`.
3. **Defense-in-depth** — `ensureIntegrationBranch` also coerces null/empty branch args at the
   producer and emits a `build.integration.coerced` event if it ever has to, so a regression is
   observable instead of silently emitting an invalid output.

The fix is robust on **resume** of the already-failed run (whose stored input row still has
NULL branches) as well as on a fresh smoke run.

## Verification (factual)
- **Unit tests** — `src/orchestration/build-config.test.ts` (8 cases) including a regression case
  that reproduces the exact failing `ctx.input` shape (`{smoke:true, integrationBranch:null, …}`).
  Full orchestration suite: **41 pass / 0 fail**.
- **Red-before-green** — reverting the helper to the original raw-passthrough behaviour makes
  **6/8** of the new tests fail (`cfg.integrationBranch` → `undefined`); restoring the fix → **8/8 pass**.
  The test is genuinely failable, not tautological.
- **Typecheck** — `tsc --noEmit` (the project `typecheck` script) passes with no errors.
- **Graph** — `bunx smithers-orchestrator graph .smithers/workflows/smithering-impl.tsx` renders
  with exit code 0 and no stderr (module loads, cross-family invariant assertion runs).
- **Not done** — a full smoke re-run was not executed here (it spawns the real implement→review→
  verify agents); the orchestrator should re-launch the smoke as the next step. The deterministic
  `build:setup` failure itself is fixed and proven by the unit tests + graph render above.
