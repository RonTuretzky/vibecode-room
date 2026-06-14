# probe-suite-harness

## Built

- `poc/harness.ts`: a reusable validate-before-build probe runner for real third-party API probes.
- `runProbe()` requires every assertion to provide both a green check and a red `falsify()` check; a red check that does not fail is recorded as `not-failable` and rejected as evidence.
- Structured reports are written under `artifacts/smithering/reports/<probe-id>/` with `report.json`, `rbg.jsonl`, and `secret-scan.json`.
- The harness redacts key-shaped strings before report writes and then fail-closed scans its own report directory.
- `poc/harness.test.ts`: the `bun test poc/<probe>.test.ts` convention, with sample probe coverage for report writing, RBG recording, non-failable assertion refusal, surfaced probe failures, and report redaction.

## Gate Roll-Up

| Criterion | Status | Evidence |
|---|---|---|
| ENG-T-05 | passed | RBG red and green logs under `evidence/`; green run also copied to `tests.log` |

## Dependency Results

- Depends on `walking-skeleton-smoke`, landed on the integration branch.
- Dependency evidence read from `artifacts/smithering/build/walking-skeleton-smoke/RESULT.md`.

## Reports

- `artifacts/smithering/reports/harness-sample-probe/report.json`
- `artifacts/smithering/reports/harness-non-failable-probe/report.json`
- `artifacts/smithering/reports/harness-failing-probe/report.json`
- `artifacts/smithering/reports/harness-redaction-probe/report.json`

## Blockers

None surfaced.
