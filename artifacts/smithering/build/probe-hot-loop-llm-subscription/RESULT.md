# probe-hot-loop-llm-subscription

## Built

- Added `poc/p-llm.test.ts`, `poc/a-llm-sub.test.ts`, and a shared live probe in `poc/llm-subscription-probe.ts`.
- The probe calls the host's logged-in CLI subscription routes only: `codex` and `claude --print`.
- CLI invocations run with a sanitized allowlisted environment so raw provider credential variables are not inherited by the subscription transport.
- Temperature-0 determinism is checked as decision identity across repeated same-input CLI invocations, not byte-identical full CLI output.
- Live verdicts are refreshed by default; artifact-cache reuse is opt-in only through `PANOP_LLM_PROBE_USE_ARTIFACT_CACHE=1`.
- Model output parsing is strict: invalid decisions or non-`MappedActionTool` tools fail before schema assertion.
- Raw model key construction is rejected through the landed credential guard; no `SubscriptionCredentialProvider`, Cerebras base-URL fallback, or Haiku-specific credential path was added.
- The ACT criteria include the §22 A2 amendment: a status/information query addressed to a named callsign must classify as ACT.
- The probe writes `artifacts/smithering/probes/probe-hot-loop-llm-subscription/verdict.json`.

## Probe Verdict

`verdict.json` is red:

- Codex and Claude subscription routes were reachable through the host CLIs and returned `MappedActionTool`-compatible decision schemas.
- The repeated named callsign status query classified as `ACT` with `panopticon.steer`.
- Same-input repeated invocations produced identical tool decisions for record-replay purposes.
- No subscription-routed candidate met the 100 ms p50 hot-loop budget. The latest measured best host subscription CLI p50 was 3437 ms.
- The conflict is specifically the host subscription CLI transport round trip versus the 100 ms hot-loop budget; no raw-key API fallback was built.
- The $0.15/hr cost gate is recorded as unmeasured by the live host subscription CLI probe. Host subscriptions do not expose per-call metering to this probe, and treating them as $0/hr would make the gate tautological.
- Probe/build traces and evidence secret-scan clean.

This is surfaced as the binding PRD §6 conflict required by the ticket; no product workaround was built.

## Gate Roll-Up

| Criterion | Status | Evidence |
|---|---|---|
| P-LLM | failed | Failable RBG recorded in `evidence/P-LLM-rbg-red.log`; conflict-acknowledgement run in `evidence/P-LLM-green.log`; probe verdict remains red because the latency and live cost gates are unmet |
| A-LLM-SUB | failed | Failable raw-key route recorded in `evidence/A-LLM-SUB-rbg-red.log`; conflict-acknowledgement run in `evidence/A-LLM-SUB-green.log`; probe verdict remains red because no host subscription route met all hot-loop gates |

## Dependency Results

- `probe-suite-harness`: `artifacts/smithering/build/probe-suite-harness/RESULT.md`
- `subscription-credentials-redaction`: `artifacts/smithering/build/subscription-credentials-redaction/RESULT.md`

## Commands

- `bun test poc/p-llm.test.ts poc/a-llm-sub.test.ts`
- `bun test poc/p-llm.test.ts` (strict; expected to fail while the binding conflict is unresolved)
- `PANOP_LLM_PROBE_ACCEPT_CONFLICT=1 bun test poc/p-llm.test.ts` (records the conflict without claiming the budget passed)
- `PANOP_LLM_PROBE_ROUTE_RAW_KEY=1 bun test poc/a-llm-sub.test.ts`
- `bunx tsc --noEmit --module ESNext --target ESNext --moduleResolution bundler --lib ESNext,DOM --types bun --strict --skipLibCheck --allowImportingTsExtensions poc/llm-subscription-probe.ts poc/p-llm.test.ts poc/a-llm-sub.test.ts`
- `bun -e 'import { scanSecretLikeFiles } ...'` over this build bundle and the probe verdict directory.

## Blockers

- No host logged-in Codex/Claude CLI subscription candidate met the 100 ms p50 hot-loop budget.
- The host subscription CLIs do not expose enough per-call metering to prove the live $0.15/hr cost gate.
- These remain surfaced conflicts for the gate; no product workaround was built.
