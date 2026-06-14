# subscription-credentials-redaction

## Built

- Added a thin credential guard in `src/providers/credentials.ts`: model access records host Codex/Claude subscription provenance only, and raw model key construction paths are rejected without echoing values.
- Added deterministic secret redaction in `src/security/secrets.ts`, wired into `TraceProcessor` by default and into the probe harness report scanner.
- Hardened fail-closed handling for neutral unknown token-shaped strings and for command-text credential smuggling through the host-subscription guard.
- Added count-only `secret.redacted` trace events and safe JSONL serialization for raw `LogEvent` arrays.
- Added SEC-1 unit and e2e coverage for provider guard rejection, trace/report redaction, and whole-session secret scanning through the spine smoke session path.

## Gate Roll-Up

| Criterion | Status | Evidence |
|---|---|---|
| SEC-1 | passed | `evidence/SEC-1-rbg-red.log` and `evidence/SEC-1-green.log` |

## Dependency Results

- `shared-types-contract`: `artifacts/smithering/build/shared-types-contract/RESULT.md`
- `trace-processor-observability`: `artifacts/smithering/build/trace-processor-observability/RESULT.md`

## Commands

- `bun test src/providers/credentials.test.ts`
- `bun test test/e2e/secret-scan.e2e.ts`
- `bun test`
- `bunx tsc --noEmit`

## Blockers

None surfaced by the implementer. External review, verification, and adversarial challenge remain separate workflow steps.
