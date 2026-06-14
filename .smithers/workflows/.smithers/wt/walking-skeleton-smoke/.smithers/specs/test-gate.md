# Spec: bun test gate + SmithersBrain parsing regression tests

## Goal
Stand up a real `bun test` suite and make it part of the Smithers validate gate, so
"green gate" means typecheck **and** tests pass (smithering: no mocks, real gate).
Lock in a regression test for the `boolValue` serialization bug found during B/C
verification (smithers `output` coerces booleans to numbers → suggestions were dropped).

## Done / acceptance criteria
- Root `package.json` has a `"test": "bun test"` script.
- `.smithers/smithers.config.ts` `repoCommands.test` set to `"bun test"` (validate step references it).
- SmithersBrain's pure parsing helpers are EXPORTED and unit-tested:
  - Extract `boolValue`, `stringArray`, `visualizerKind`, `parseQuestions`, `firstJsonObject`,
    `unwrapSmithersOutput` from `src/core/brain/smithers.ts` into a new
    `src/core/brain/smithers-parse.ts` (pure, no side effects). `smithers.ts` imports them.
  - `src/core/brain/smithers-parse.test.ts` (bun:test) covers, at minimum:
    - **REGRESSION:** `boolValue(1) === true`, `boolValue(0) === false`, `boolValue("true")`,
      `boolValue("1")`, `boolValue(true)`, `boolValue("false")`, `boolValue(undefined) === false`.
    - `stringArray` on a JSON-encoded array string, a comma-joined string, a real array, "" → [].
    - `parseQuestions` on a JSON-encoded array of {prompt,choices[]}; drops malformed entries.
    - `firstJsonObject` extracts the FIRST balanced JSON object from stdout that has trailing
      non-JSON lines (the real `smithers output … --json` shape: JSON line + `cta:` lines).
    - `unwrapSmithersOutput` returns nested `.output`/`.value`/`.result` when present, else the value.
- `bun run typecheck` and `bun test` both pass. No behavior change to SmithersBrain's public API.

## Constraints
- APP code only under `src/` (+ root package.json + `.smithers/smithers.config.ts`).
- Do NOT touch `panopticon-world/` (concurrent workstream) or `node_modules/`.
- No mocks — test pure functions directly with real inputs.

## Risks
- Extracting helpers must keep `smithers.ts` behavior identical (re-import, same logic).
- `bun test` discovers `**/*.test.ts`; ensure the existing opt-in smoke test
  (`durable-run-smoke.test.ts`, skipped unless PANOPTICON_SMOKE_AGENT=1) stays skipped by default.
