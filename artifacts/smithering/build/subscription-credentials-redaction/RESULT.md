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
- Hardened the adversarial metadata-key gap: credential-shaped object property names are now redacted before trace/probe/report emission, including nested `LogEvent.meta` and probe report metadata keys.
- Fixed the latest adversarial challenge: long alphabetic-only opaque values under neutral metadata keys are now treated as unknown secret candidates and redacted before trace, report, or scan emission.
- Fixed the follow-up common-token alphabet gaps: slash-only opaque tokens, padding-only opaque tokens, and provider-prefixed alphabetic opaque tokens under neutral metadata keys now redact fail-closed.
- Fixed the latest allowlist challenge: hyphenated provider-prefixed numeric opaque values under neutral metadata keys now redact fail-closed.
- Hardened the whole-session scanner to inspect every regular file under trace/log/report roots, including extensionless files.

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

## Follow-up Fix Evidence

- `evidence/SEC-1-rbg-red.log` now includes a failable red run for unredacted credential-shaped metadata keys and the whole-session planted-leak e2e.
- `evidence/SEC-1-green.log` records the repaired unit, e2e, full-suite, and typecheck runs.
- `secret-scan.json` reports zero key-shaped strings in this ticket's build bundle.
- Decision log: `artifacts/smithering/decisions/build/credential-shaped-metadata-keys.html`.
- Decision log: `artifacts/smithering/decisions/build/alphabetic-opaque-token-redaction.html`.
- Decision log: `artifacts/smithering/decisions/build/common-opaque-token-redaction.html`.
- Decision log: `artifacts/smithering/decisions/build/numeric-token-extensionless-scan.html`.

## Blockers

None surfaced by the implementer. External review, verification, and adversarial challenge remain separate workflow steps.
