# subscription-credentials-redaction

## Built

- Added a thin credential guard in `src/providers/credentials.ts`: model access records host Codex/Claude subscription provenance only, and raw model key construction paths are rejected without echoing values.
- Added deterministic secret redaction in `src/security/secrets.ts`, wired into `TraceProcessor` by default and into the probe harness report scanner.
- Hardened fail-closed handling for embedded neutral unknown token-shaped strings, provider-style separator tokens, and command-text credential smuggling through the host-subscription guard.
- Closed the follow-up adversarial findings: unknown-token fallback now scans common token alphabet characters (`+`, `/`, `=`, `~`) without requiring a digit, and host subscription commands now use a provider-specific exact argument allowlist rather than arbitrary dashed flags.
- Removed the public TraceProcessor default-redaction opt-out so recorded/returned events, persisted JSONL, and downstream `process()` callbacks all see redacted metadata.
- Extended the whole-session e2e to scan every trace/log/report tree it emits, including the build trace copy and probe-report output.
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
- `bun test poc/harness.test.ts`
- `bun test`
- `bunx tsc --noEmit`
- `bun -e 'import { scanSecretLikeFiles } ...'` over `artifacts/smithering/build/subscription-credentials-redaction`

## Blockers

None surfaced by the implementer. External review, verification, and adversarial challenge remain separate workflow steps.
