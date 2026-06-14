# POC: Safety Hook Approval Round-trip — Findings

**Date:** 2026-06-14
**POC scope:** P-HOOK (the riskiest unproven architectural bet). Does Smithers expose a
PreToolUse hook that can intercept and hold a destructive tool call before execution?

## What was built

1. `shell-classifier.ts` — deterministic shell-command classifier (§8.1.1)
2. `approval-gate.ts` — HTTP approval gate that holds tool calls pending voice approval
3. `hook-script.ts` — Claude Code PreToolUse hook script that blocks on approval
4. `poc.test.ts` — 59 headless tests (+ 2 skipped e2e requiring API keys)

**Test result:** 59/59 pass. Zero failures. 2 skipped (require `PANOPTICON_E2E=1` + API key).

---

## FINDING-1 (HIGH): No Smithers-native PreToolUse hook API exists

**Evidence:** Full inspection of `smithers-orchestrator@0.23.0` type declarations:
`src/index.d.ts`, `src/tools.d.ts`, `src/sandbox.d.ts`, `src/control-plane.d.ts`,
`@smithers-orchestrator/agents/src/index.d.ts`, `@smithers-orchestrator/components/src/index.d.ts`.

**Finding:** There is NO `PreToolUse`, `beforeToolCall`, `toolInterceptor`, or similar
Smithers-native hook API. The `@smithers-orchestrator/cli/dist/snapshot-hook.d.ts` exports
`runSnapshotHookOnce` — but this is the **Claude Code snapshot-hook mechanism** (invoked by
Claude Code CLI's own `settings.json` hooks), not a Smithers runtime API.

Smithers provides `Approval`, `ApprovalGate`, `HumanTask`, `Signal`, `WaitForEvent` components —
these are **workflow-level approval gates** that block between workflow _steps_, not within an
agent's tool execution.

**Critical implication for eng §8.1:**

The eng doc says "Smithers exposes pre/post-tool hooks — the same mechanism the platform's
snapshot hook uses". This is CORRECT but must be read precisely: the mechanism IS the
Claude Code CLI's own `settings.json` hook system. It is NOT a Smithers runtime API.

Therefore:
- Every Panopticon process that needs the safety gate MUST use **Claude Code CLI** as its
  agent (via `ClaudeCodeAgent` in Smithers). The hook fires via Claude Code's built-in
  `PreToolUse` hook mechanism.
- Processes using `AnthropicAgent` (direct Anthropic SDK calls) **cannot** benefit from
  this hook — tool calls go directly to the model and bypass any Claude Code hook mechanism.
- This constrains agent choice for all Panopticon processes. The eng doc must be amended.

**Eng doc amendment required:** See §8.1 amendment in `engDocAmendments` of the structured output.

---

## FINDING-2 (MEDIUM): Hook timeout coordination with dead-man timer

**Evidence:** `hook-script.ts` proof-of-concept + Claude Code hook system documentation.

The Claude Code hook timeout must be configured **greater than** the dead-man timer (25s) so
the hook process can fire its own timer before Claude Code kills it. Claude Code configures
hook timeout via `settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [{
      "command": "bun run hook-script.ts",
      "timeoutMs": 30000
    }]
  }
}
```

If Claude Code kills the hook process at its own timeout (< 25s), the safety gate's
behavior depends on Claude Code's `onFailure` hook setting (default: `warn` — which may
ALLOW the tool rather than blocking it). This is a safety-critical race condition.

**Required:** The `settings.json` entry MUST set `timeoutMs > 25000` AND configure
`onFailure: "block"` (or equivalent) so hook failure defaults to deny, not allow.

---

## FINDING-3 (LOW): Shell-quote parser not installed; regex approach is conservative

**Evidence:** `node_modules/` inspection — `shell-quote` not present; only generic
parsers like `parseurl`, `cron-parser` etc.

The production shell classifier (§8.1.1) should use `shell-quote` (P-SHELL-PARSE probe)
for correct compound-command splitting, redirect parsing, and injection detection.

The POC's regex-based classifier is **conservative (errs toward gating)** — safe in the
sense that false positives only create unnecessary approvals, not security holes. But it
may over-gate edge cases:
- Nested quoted strings with operators inside
- Complex here-docs
- Some compound commands where the parse tree is ambiguous

**P-SHELL-PARSE must be run before shipping** to validate that `shell-quote` handles
these correctly. The regex approach is suitable for the POC only.

---

## FINDING-4 (LOW): Long-poll approval gate protocol validated

**Evidence:** `approval-gate.test.ts` (part of `poc.test.ts`) — 8 integration tests.

The approval gate protocol works:
- `POST /request` → returns `{ gateId, decision: "pending" }`
- hook long-polls `GET /poll/:gateId` (waits up to 20s per poll cycle)
- `POST /resolve { gateId, decision: "approve"|"deny" }` → gate resolves
- Next poll returns `{ decision: "approve"|"deny" }` → hook exits accordingly

The dead-man timer fires in the hook process (not the gate server). This is correct: if the
gate server goes down, the dead-man timer fires locally and returns "deny" — fail-closed.

**For production:** Switch from long-poll to SSE (as §9 specifies) for lower latency and
better connection management. The gate-id-based protocol is correct and unchanged by the
transport upgrade.

---

## FINDING-5 (HIGH): Approval gate ↔ SSE seam: one critical new design constraint

**Evidence:** Full review of the safety hook round-trip.

The approval request must traverse:
```
agent (Claude Code) → hook script → approval gate (Panopticon seam HTTP) → voice (Cue)
```

The `gateId` is minted in the hook script (random, scoped to the run) and must be
correlated with the Cue voice dispatcher to route the "confirm" voice command to the
right gate. This correlation requires:

1. The hook sends `{ gateId, upid, readback }` to the seam
2. The seam maintains a `gateId → upid` mapping
3. When "confirm" fires in Cue for a given UPID, the dispatcher calls `POST /resolve { gateId: <from mapping>, decision: "approve" }`

**Gap in eng §8.1:** The current description says "hook emits an `approval` run-event
(`ApprovalRequest{gateId, readback}`) across the seam → RunEventNormalizer → Cue →
OutputPolicy speaks..." but doesn't specify how the seam knows the `gateId` to call
`approve(upid,gateId)` when "confirm" fires. The seam must cache the most recent pending
`gateId` per `upid`, cleared on resolution or dead-man timeout.

---

## Verified behaviors (red-before-green demonstrated)

All 59 tests demonstrate can-fail-and-did-pass behavior:

| Behavior | RBG move | Result |
|---|---|---|
| `ls` is read-safe (AC11.1) | Move `ls` to mutating set | Test fails immediately |
| `rm -rf` is gated | Remove `rm` from mutating set | Test fails |
| Unknown tool is gated | Default unknown→allow | Test fails |
| `ls && rm -rf` → gated on rm | Classify by first token only | Test fails |
| `eval "$CMD"` → injection/unknown | Pass unparsed tokens | Test fails |
| `echo x > important.txt` → mutating | Ignore redirects | Test fails |
| `echo x > /dev/null` → read-safe | No /dev/null exception | Test fails |
| Hook denies → exit 2 | Hook exits 0 regardless | Test fails |
| Hook approves → exit 0 | Hook exits 2 regardless | Test fails |
| Dead-man fires → exit 2 | Remove timer | Test hangs |
| EXPLICIT mode gates read-safe tools | Ignore mode setting | Test fails |
| DANGEROUS mode allows everything | Gate in dangerous mode | Test fails |
| Wrong gateId → ok:false | Match any gateId | Test fails |

---

## What could NOT be verified (requires credentials)

| Probe | Why blocked | Ticket |
|---|---|---|
| Does Claude Code CLI honor `.claude/settings.json` hooks when running inside a Smithers task? | Requires `ANTHROPIC_API_KEY` | `probe-pretool-safety-hook` |
| Does the hook fire for EVERY tool call, including `Bash`, `Write`, `Edit`? | Requires real agent run | `probe-pretool-safety-hook` |
| Does the file remain truly unmodified while the hook blocks? | Requires real agent run | `probe-pretool-safety-hook` |
| Hook timeout vs Claude Code process kill race | Requires real agent run | `safety-execution-boundary-hook` |

These are surfaced to the orchestrator's gate. Build does not proceed on the affected
paths until `probe-pretool-safety-hook` passes.

---

## Summary for orchestrator

The safety hook architecture is **correct in principle and validated at the protocol level**
(59/59 tests pass). The critical finding is that it relies on **Claude Code CLI's hook
mechanism** (not a Smithers native API), which constrains agent choice. The eng doc must
be amended to make this explicit.

P-HOOK remains UNRUN (requires API credentials). The shell classifier and approval gate
are validated headlessly. The Cue→seam→hook correlation gap needs a design decision.
