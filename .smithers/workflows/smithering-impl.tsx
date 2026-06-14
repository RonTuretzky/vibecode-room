// smithers-source: generated (smithering step 9 — the bespoke implementation workflow).
// smithers-metadata-version: 1
// smithers-display-name: Smithering — Implementation
// smithers-description: Walks the tickets.json DAG in topological waves; each ticket is a fresh-context worker in its own git worktree (implement → cross-family review → independent test-authority verify), lands through a depth-1 serialized merge lane onto an integration branch (NEVER main), and persists a red-before-green evidence bundle per ticket. Implements docs/planning/06-orchestration.md.
// smithers-tags: coding, implementation, worktrees, dag, validation, orchestration
//
// ─────────────────────────────────────────────────────────────────────────────
// HOW THIS FILE IMPLEMENTS docs/planning/06-orchestration.md (each DECISION → code):
//
//   §1 worktreeLayout    one <Worktree> per ticket at .smithers/wt/<id> on branch
//                        build/<id>, based off the INTEGRATION branch (see merge note).
//                        Worktree ids/branches derive from the stable kebab ticket id —
//                        never an index/timestamp — so a killed run resumes onto the same
//                        worktree (REQ-15 durability ethic, applied to the build).
//   §2 mergePolicy       depth-1 SERIALIZED merge lane: each wave's lands go through a
//                        <MergeQueue maxConcurrency={1}>; waves run in DAG order, so at most
//                        one writer touches the integration branch at a time. landTicketBranch
//                        re-runs the pre-merge gate on the rebased tip, fast-forwards on green,
//                        and BOUNCES (records, does not force-land) on conflict/red. There is
//                        NO optimistic merge / auto-eviction (ORCH-A-02).
//   §3 testTiers         pre-build probe gate (probe tickets land first, write only poc/+probes/),
//                        deterministic hermetic PRE-MERGE subset enforced by the verifier +
//                        the land gate, and the full real-world suite is POSTSUBMIT on the
//                        integration branch. RBG (red-before-green) recordings are mandatory.
//   §4 modelAssignment   implement = Anthropic (Sonnet/Opus by complexity), review = OpenAI
//                        Codex (cross-family — reviewer.family ≠ implementer.family is a
//                        STRUCTURAL invariant, asserted at module load), verify = an
//                        INDEPENDENT fresh-context Anthropic instance whose authority is the
//                        test result, not its opinion. Safety tickets implement on Opus and
//                        additionally get an adversarial Codex `challenge`.
//   §5 concurrency       max 6 ticket workers per wave; probe-only waves burst to 8; merge
//                        lane depth 1. Sized to the DAG's real antichain width.
//   §6 observability      every ticket persists artifacts/smithering/build/<id>/ (RESULT.md,
//                        gates.json, evidence/ RBG runs, tests.log, tsc.log, review.json,
//                        verify.json, trace/*.jsonl, secret-scan.json). The orchestrator emits
//                        verb-noun build.* / merge.lane.* events to artifacts/smithering/build/
//                        _trace.jsonl with fail-closed secret redaction. Judgment calls get a
//                        self-contained HTML decision log under artifacts/smithering/decisions/.
//   §7 contextManagement  EVERY worker gets fresh context (no fork) and reads inputs from disk:
//                        the prompt carries the ticket object verbatim + doc paths to READ +
//                        the landed-dep RESULT.md list + the exact gate/RBG obligations + its
//                        model-role contract. A worker whose dep's blocking probe is unrun/red
//                        STOPS and surfaces a blocker — it never builds on an unproven API and
//                        never raises a human request (the orchestrator's gates do that).
//
// THE HARD CONTRACT (overrides the literal "main" wording in 06-orchestration §1/§2):
//   This workflow NEVER merges to the base branch. All work lands on the integration branch
//   (default `smithering/integration`); merging integration → main is a HUMAN act after
//   delivery. The integration branch IS the build's trunk, so worktrees base off it.
//
// SMOKE MODE (input.smoke=true): processes ONLY the first ticket (the dependsOn:[] root,
//   `walking-skeleton-smoke`) end-to-end INCLUDING its verification, with NO approval gates,
//   and reaches terminal status `finished`. This is what the parent smithering workflow runs
//   before the expensive full launch.
//
// Run (the operating agent does this; the human just asks for the outcome):
//   bunx smithers-orchestrator up .smithers/workflows/smithering-impl.tsx --input '{"smoke":true}'
//   bunx smithers-orchestrator up .smithers/workflows/smithering-impl.tsx --input '{"smoke":false}' --detach
// ─────────────────────────────────────────────────────────────────────────────
/** @jsxImportSource smithers-orchestrator */
import { $ } from "bun";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  ClaudeCodeAgent,
  CodexAgent,
  MergeQueue,
  createSmithers,
  defineTool,
} from "smithers-orchestrator";
import { z } from "zod/v4";
// Pure orchestration logic lives in src/orchestration/core.ts so it is tested like code
// (06-orchestration §8). The workflow imports the SAME functions the unit tests exercise —
// a green src/orchestration/*.test.ts is real evidence for the shipped scheduler/gate.
import {
  ANTHROPIC,
  OPENAI,
  REQUIRED_BUNDLE_FILES,
  type BuildConfig,
  type Ticket,
  blockingProbeClosure,
  computeWaves,
  evaluateEvidenceBundle,
  isProbeTicket,
  isProbeVerdictGreen,
  parseTickets,
  redact,
  resolveBuildConfig,
  scanForSecrets,
} from "../../src/orchestration/core.ts";

// ─── Paths (mirrored with the parent smithering workflow — change both together) ──
const TICKETS_PATH = "artifacts/smithering/tickets.json";
const BUILD_DIR = "artifacts/smithering/build";
const DECISIONS_DIR = "artifacts/smithering/decisions";
const PROBES_DIR = "artifacts/smithering/probes";
const TRACE_FILE = `${BUILD_DIR}/_trace.jsonl`;
const PLANNING = "docs/planning";

// Tickets the eng/backpressure docs flag as safety-critical: implement on Opus + an
// adversarial Codex `challenge` against the read-safe allowlist (06-orchestration §4).
const SAFETY_TICKET_IDS = new Set([
  "safety-execution-boundary-hook",
  "shell-command-classifier",
]);

// ─── Model roster (families are the whole point of §4 — keep them honestly distinct) ──
// ANTHROPIC / OPENAI family tags are imported from src/orchestration/core.ts.
const OPUS_MODEL = "claude-opus-4-8";
const SONNET_MODEL = "claude-sonnet-4-6";
const HAIKU_MODEL = "claude-haiku-4-5-20251001";
// codex-1 is a ChatGPT account that rejects "gpt-5.3-codex"; use the supported "gpt-5.5"
// (per .smithers/agents.ts). GPT-5.4 in the doc == the Codex CLI family, distinct from Claude.
const CODEX_MODEL = "gpt-5.5";

const HOUR = 60 * 60_000;

// Implementer (Anthropic). cwd is repo root; inside a <Worktree> the descendant cwd is
// overridden to the worktree path, so each worker edits ONLY its own working copy.
const opusImpl = new ClaudeCodeAgent({ model: OPUS_MODEL, cwd: process.cwd(), timeoutMs: 2 * HOUR });
const sonnetImpl = new ClaudeCodeAgent({ model: SONNET_MODEL, cwd: process.cwd(), timeoutMs: 90 * 60_000 });

// Verifier (Anthropic) — DISTINCT agent instances from the implementers so the verifier is a
// different run/context (verifier-independence, §4). Authority = the test result.
const opusVerify = new ClaudeCodeAgent({ model: OPUS_MODEL, cwd: process.cwd(), timeoutMs: HOUR });
const haikuVerify = new ClaudeCodeAgent({ model: HAIKU_MODEL, cwd: process.cwd(), timeoutMs: 40 * 60_000 });

// Reviewer (OpenAI / Codex) — cross-family. workspace-write so it can persist its own
// review.json verdict into the machine-checked evidence bundle (the land gate REQUIRES
// review.json). The prompt forbids editing implementation code — it only writes its verdict.
const codexReview = new CodexAgent({
  model: CODEX_MODEL,
  config: { model_reasoning_effort: "high" },
  sandbox: "workspace-write",
  yolo: false,
  skipGitRepoCheck: true,
  cwd: process.cwd(),
  timeoutMs: 30 * 60_000,
});
// Adversarial red-team for safety tickets (Codex `challenge` posture). workspace-write so it
// can persist its own challenge verdict file into the evidence bundle (forbidden to edit code).
const codexChallenge = new CodexAgent({
  model: CODEX_MODEL,
  config: { model_reasoning_effort: "xhigh" },
  sandbox: "workspace-write",
  yolo: false,
  skipGitRepoCheck: true,
  cwd: process.cwd(),
  timeoutMs: 30 * 60_000,
});

// Family tags travel WITH the agent so the cross-family invariant is checkable, not implied.
const FAMILY = new WeakMap<object, string>([
  [opusImpl, ANTHROPIC],
  [sonnetImpl, ANTHROPIC],
  [opusVerify, ANTHROPIC],
  [haikuVerify, ANTHROPIC],
  [codexReview, OPENAI],
  [codexChallenge, OPENAI],
]);

// ─── §4 model assignment by complexity ───────────────────────────────────────
type Assignment = {
  implementer: ClaudeCodeAgent;
  reviewer: CodexAgent;
  verifier: ClaudeCodeAgent;
  challenge: CodexAgent | null;
  implementerLabel: string;
  reviewerLabel: string;
  verifierLabel: string;
  maxIterations: number;
};

function assignmentFor(ticket: any): Assignment {
  const safety = SAFETY_TICKET_IDS.has(ticket.id);
  const complexity = ticket.complexity ?? "medium";
  // Safety-critical → Opus implementer + adversarial challenge regardless of complexity.
  if (safety) {
    return {
      implementer: opusImpl,
      reviewer: codexReview,
      verifier: opusVerify,
      challenge: codexChallenge,
      implementerLabel: `Opus 4.8 (${OPUS_MODEL})`,
      reviewerLabel: `Codex GPT-5.4 review + adversarial challenge (${CODEX_MODEL})`,
      verifierLabel: `independent Opus 4.8 (${OPUS_MODEL})`,
      maxIterations: 7,
    };
  }
  if (complexity === "large") {
    return {
      implementer: opusImpl,
      reviewer: codexReview,
      verifier: opusVerify,
      challenge: null,
      implementerLabel: `Opus 4.8 (${OPUS_MODEL})`,
      reviewerLabel: `Codex GPT-5.4 (${CODEX_MODEL})`,
      verifierLabel: `independent Opus 4.8 (${OPUS_MODEL})`,
      maxIterations: 7,
    };
  }
  if (complexity === "small") {
    return {
      implementer: sonnetImpl,
      reviewer: codexReview,
      verifier: haikuVerify,
      challenge: null,
      implementerLabel: `Sonnet 4.6 (${SONNET_MODEL})`,
      reviewerLabel: `Codex GPT-5.4 (${CODEX_MODEL})`,
      verifierLabel: `Haiku 4.5 RBG-evidence audit (${HAIKU_MODEL})`,
      maxIterations: 4,
    };
  }
  // medium (default)
  return {
    implementer: sonnetImpl,
    reviewer: codexReview,
    verifier: opusVerify,
    challenge: null,
    implementerLabel: `Sonnet 4.6 (${SONNET_MODEL})`,
    reviewerLabel: `Codex GPT-5.4 (${CODEX_MODEL})`,
    verifierLabel: `independent Opus 4.8 (${OPUS_MODEL})`,
    maxIterations: 6,
  };
}

// Module-load assertion: the reviewing family must never equal the implementing family.
// A regression here (e.g. someone points review at a Claude agent) fails the build fast.
function assertCrossFamily(): void {
  for (const ticket of ALL_TICKETS) {
    const a = assignmentFor(ticket);
    const implFamily = FAMILY.get(a.implementer);
    const revFamily = FAMILY.get(a.reviewer);
    if (!implFamily || !revFamily) {
      throw new Error(`smithering-impl: untagged agent family for ticket ${ticket.id}`);
    }
    if (implFamily === revFamily) {
      throw new Error(
        `smithering-impl: cross-family invariant violated for ${ticket.id} — implementer family ${implFamily} === reviewer family ${revFamily}`,
      );
    }
  }
}

// ─── Ticket loading + DAG → topological waves (computed once at module load) ──
// Ticket type, normalizeTicket, parseTickets, isProbeTicket, computeWaves all live in
// src/orchestration/core.ts (pure + unit-tested). loadTickets is the only disk-touching wrapper.
function loadTickets(): Ticket[] {
  try {
    const raw = JSON.parse(readFileSync(resolve(process.cwd(), TICKETS_PATH), "utf8"));
    return parseTickets(raw);
  } catch {
    return [];
  }
}

const ALL_TICKETS = loadTickets();
const TICKET_BY_ID = new Map(ALL_TICKETS.map((t) => [t.id, t]));

// The first ticket = the unique dependsOn:[] root the smoke slice exercises end-to-end.
function firstTicket(): Ticket | null {
  return ALL_TICKETS.find((t) => t.dependsOn.length === 0) ?? ALL_TICKETS[0] ?? null;
}

// Wave type + computeWaves live in src/orchestration/core.ts (pure + unit-tested).
type Wave = { index: number; tickets: Ticket[] };

const ALL_WAVES: Wave[] = ALL_TICKETS.length > 0 ? computeWaves(ALL_TICKETS) : [];
assertCrossFamily();

// ─── Observability: fail-closed secret redaction + verb-noun structured trace ──
// redact()/scanForSecrets() (the SEC-1 key patterns) are imported from core and unit-tested.
function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  const line = redact(JSON.stringify({ event, ...fields }));
  try {
    mkdirSync(resolve(process.cwd(), BUILD_DIR), { recursive: true });
    appendFileSync(resolve(process.cwd(), TRACE_FILE), `${line}\n`);
  } catch (err) {
    // The build-level trace stream must never crash the build, but a failure to persist it
    // is itself surfaced (never silently swallowed) — the authoritative per-ticket evidence
    // bundle is the fail-closed record the land gate enforces.
    console.error(`logEvent: failed to persist trace line (${(err as Error)?.message ?? err}): ${line}`);
  }
  console.log(line);
}

// ─── §1/§2 the deterministic, idempotent land operation (merge authority is CODE) ──
// NEVER merges to the base/main branch. Idempotent: a branch already in the integration
// ancestry is a no-op. On red gate or conflict it BOUNCES (records, does not force-land).
type LandArgs = {
  ticketId: string;
  branch: string;
  integrationBranch: string;
  baseBranch: string;
  idempotencyKey: string;
};
type LandResult = {
  ticketId: string;
  landed: boolean;
  ff: boolean;
  alreadyLanded: boolean;
  branch: string;
  integrationBranch: string;
  reason: string;
};

// The depth-1 land lane operates in a DEDICATED, clean integration worktree — NEVER the
// repo root (which may be dirty / on a detached HEAD). This removes the resume + unrelated-
// change risk the reviewer flagged: a real-budget land never touches the operator's tree.
const INTEGRATION_WT = ".smithers/integration";

// The fixed evidence bundle a worker writes lives under its OWN worktree (robust to the
// `*.log` .gitignore rule, which would otherwise drop RBG run logs from the merge). Read it
// there so the gate sees the full record regardless of what got committed.
function workerBundleDir(ticketId: string): string {
  return resolve(process.cwd(), ".smithers/wt", ticketId, BUILD_DIR, ticketId);
}

// Recursively count key-shaped strings across an evidence bundle (fail-closed, SEC-1).
// Uses plain readdirSync(string[]) + statSync so it typechecks under both the project config
// and a bare `tsc` invocation (the Dirent<Buffer> overload differs between them).
function bundleSecretCount(dir: string): number {
  let count = 0;
  const walk = (d: string) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      const p = resolve(d, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(p);
      } else if (st.isFile() && st.size <= 2_000_000) {
        try {
          count += scanForSecrets(readFileSync(p, "utf8")).length;
        } catch {
          /* unreadable file — ignored by the scanner */
        }
      }
    }
  };
  walk(dir);
  return count;
}

// Does the merged tree carry any failable test file? (Avoids a spurious bounce on a tree
// that legitimately has no tests yet, while still running the suite once tests exist.)
function hasAnyTestFile(root: string): boolean {
  const exts = [".test.ts", ".test.tsx", ".spec.ts"];
  const skip = new Set(["node_modules", ".git", ".smithers", "dist"]);
  const walk = (d: string, depth: number): boolean => {
    if (depth > 8) return false;
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return false;
    }
    for (const name of names) {
      const p = resolve(d, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (skip.has(name)) continue;
        if (walk(p, depth + 1)) return true;
      } else if (st.isFile() && exts.some((x) => name.endsWith(x))) {
        return true;
      }
    }
    return false;
  };
  return walk(root, 0);
}

// Run a package.json script in the integration worktree IF it is defined; otherwise log a
// skip (a not-yet-built tier must not block the bootstrap, but its absence is recorded).
async function runOptionalScript(
  ticketId: string,
  wtAbs: string,
  script: string,
  reasons: string[],
  { blocking }: { blocking: boolean },
): Promise<void> {
  let scripts: Record<string, unknown> = {};
  try {
    scripts = JSON.parse(readFileSync(resolve(wtAbs, "package.json"), "utf8"))?.scripts ?? {};
  } catch {
    /* no package.json on the merged tip yet */
  }
  if (!scripts[script]) {
    logEvent("merge.lane.gate.skip", { ticketId, gate: script, reason: "no such script on merged tip" });
    return;
  }
  const res = await $`bun run ${script}`.cwd(wtAbs).nothrow().quiet();
  const ok = res.exitCode === 0;
  logEvent(ok ? "merge.lane.gate.pass" : "merge.lane.gate.red", { ticketId, gate: script });
  if (!ok && blocking) reasons.push(`pre-merge gate '${script}' red on merged tip`);
}

// ─── The deterministic pre-merge gate (06-orchestration §6 — merge authority is CODE) ──
// Run AFTER the --no-commit merge stages the rebased tip, BEFORE commit. Machine-checks the
// durable evidence bundle (no recorded RBG = no land), scans for secrets, then re-runs the
// pre-merge tier (tsc + bun test incl. the walking-skeleton smoke + architecture lint) on
// the merged tip. Returns the concrete reasons so a bounce is debuggable with no context.
async function runMergeGate(ticketId: string): Promise<{ ok: boolean; reasons: string[] }> {
  const reasons: string[] = [];
  const wtAbs = resolve(process.cwd(), INTEGRATION_WT);
  const bundleDir = workerBundleDir(ticketId);

  const present = (rel?: string | null): boolean => {
    if (!rel) return false;
    try {
      const st = statSync(resolve(bundleDir, rel));
      return st.isFile() && st.size > 0;
    } catch {
      return false;
    }
  };
  const readJson = (name: string): any => {
    try {
      return JSON.parse(readFileSync(resolve(bundleDir, name), "utf8"));
    } catch {
      return null;
    }
  };

  // 1) Durable evidence bundle is authoritative — gates.json red/green, verify.json,
  //    review.json, and the required files must all be present + non-empty (§6).
  const ev = evaluateEvidenceBundle({
    gates: readJson("gates.json"),
    verify: readJson("verify.json"),
    review: readJson("review.json"),
    present,
    requiredFiles: REQUIRED_BUNDLE_FILES,
  });
  if (!ev.ok) reasons.push(...ev.reasons);

  // 2) Secret-redaction gate — zero key-shaped strings anywhere in the bundle (SEC-1).
  const secretHits = bundleSecretCount(bundleDir);
  if (secretHits > 0) reasons.push(`secret-scan found ${secretHits} key-shaped string(s) in the evidence bundle`);

  // 3) Typecheck the merged tip (the rebased combination, not just the branch in isolation).
  if (existsSync(resolve(wtAbs, "tsconfig.json"))) {
    const tsc = await $`bunx tsc --noEmit`.cwd(wtAbs).nothrow().quiet();
    if (tsc.exitCode !== 0) reasons.push("pre-merge gate red: tsc --noEmit on the merged tip");
  } else {
    logEvent("merge.lane.gate.skip", { ticketId, gate: "tsc", reason: "no tsconfig on merged tip" });
  }

  // 4) Re-run the deterministic pre-merge test subset on the merged tip — this is the
  //    walking-skeleton smoke + unit/integration tests. A red suite BOUNCES.
  if (hasAnyTestFile(wtAbs)) {
    const t = await $`bun test`.cwd(wtAbs).nothrow().quiet();
    if (t.exitCode !== 0) reasons.push("pre-merge gate red: bun test on the merged tip (incl. walking-skeleton smoke)");
  } else {
    logEvent("merge.lane.gate.skip", { ticketId, gate: "bun test", reason: "no test files on merged tip yet" });
  }

  // 5) Architecture lint is a blocking pre-merge tier IF the build has defined it; absent
  //    (early in the build) it is logged, not faked.
  await runOptionalScript(ticketId, wtAbs, "lint:arch", reasons, { blocking: true });

  return { ok: reasons.length === 0, reasons };
}

// Postsubmit (the full real-world suite) runs AFTER the land on the integration tip. Per
// ORCH-A-02 a postsubmit failure is a manual revert (the human's act), so this RECORDS the
// verdict in the trace rather than blocking — but it can never be silently skipped.
async function runPostsubmit(ticketId: string): Promise<void> {
  const wtAbs = resolve(process.cwd(), INTEGRATION_WT);
  let scripts: Record<string, unknown> = {};
  try {
    scripts = JSON.parse(readFileSync(resolve(wtAbs, "package.json"), "utf8"))?.scripts ?? {};
  } catch {
    /* none yet */
  }
  if (!scripts["postsubmit"]) {
    logEvent("merge.lane.postsubmit.skip", { ticketId, reason: "no postsubmit script on integration tip" });
    return;
  }
  const res = await $`bun run postsubmit`.cwd(wtAbs).nothrow().quiet();
  logEvent(res.exitCode === 0 ? "merge.lane.postsubmit.green" : "merge.lane.postsubmit.red", { ticketId });
}

async function landTicketBranch(args: LandArgs): Promise<LandResult> {
  const { ticketId, branch, integrationBranch, baseBranch, idempotencyKey } = args;
  const base: LandResult = {
    ticketId,
    landed: false,
    ff: false,
    alreadyLanded: false,
    branch,
    integrationBranch,
    reason: "",
  };
  const startedMs = Date.now();
  logEvent("merge.lane.enqueue", { ticketId, branch, integrationBranch });

  // HARD GUARD: refuse to land onto main / the base branch — merging is a human act.
  if (!integrationBranch || integrationBranch === "main" || integrationBranch === baseBranch) {
    const reason = `refused: integration branch must not be base/main (got '${integrationBranch}')`;
    logEvent("merge.lane.refused", { ticketId, reason });
    return { ...base, reason };
  }

  // All git ops run in the DEDICATED integration worktree, never the (possibly dirty) root.
  const wt = INTEGRATION_WT;
  if (!existsSync(resolve(process.cwd(), wt))) {
    const reason = `integration worktree ${wt} is not set up (build:setup did not run)`;
    logEvent("merge.lane.bounce", { ticketId, reason: "no-worktree" });
    return { ...base, reason };
  }

  // Pin the integration worktree to the integration branch tip (safe here — dedicated tree).
  const co = await $`git checkout ${integrationBranch}`.cwd(wt).nothrow().quiet();
  if (co.exitCode !== 0) {
    const reason = `cannot checkout integration branch in worktree: ${redact((co.stderr?.toString() ?? "").slice(-400))}`;
    logEvent("merge.lane.bounce", { ticketId, reason: "checkout" });
    return { ...base, reason };
  }

  // Idempotency: if the branch tip is already an ancestor of integration, the land happened.
  const merged = await $`git merge-base --is-ancestor ${branch} HEAD`.cwd(wt).nothrow().quiet();
  if (merged.exitCode === 0) {
    logEvent("merge.lane.land", { ticketId, ff: true, alreadyLanded: true, latencyMs: Date.now() - startedMs });
    return { ...base, landed: true, ff: true, alreadyLanded: true, reason: "already landed (idempotent no-op)" };
  }

  // Stage the rebased tip with --no-commit so the pre-merge gate runs on the COMBINED tree.
  const stage = await $`git merge --no-commit --no-ff ${branch}`.cwd(wt).nothrow().quiet();
  if (stage.exitCode !== 0) {
    // Materialized conflict → bounce to the worker, do not force-land.
    await $`git merge --abort`.cwd(wt).nothrow().quiet();
    logEvent("merge.lane.bounce", { ticketId, reason: "conflict" });
    return { ...base, reason: `rebase/merge conflict — bounced to worker for fix-up resume` };
  }

  // Deterministic pre-merge gate (evidence bundle + secret scan + tsc + bun test + arch lint).
  const gate = await runMergeGate(ticketId);
  if (!gate.ok) {
    await $`git merge --abort`.cwd(wt).nothrow().quiet();
    logEvent("merge.lane.bounce", { ticketId, reason: "gate", failures: gate.reasons.slice(0, 8) });
    return { ...base, reason: `pre-merge gate red — land refused: ${gate.reasons[0] ?? "evidence incomplete"}` };
  }

  const commit = await $`git commit -m ${`land ${ticketId} [idem:${idempotencyKey}]`}`.cwd(wt).nothrow().quiet();
  if (commit.exitCode !== 0) {
    await $`git merge --abort`.cwd(wt).nothrow().quiet();
    logEvent("merge.lane.bounce", { ticketId, reason: "commit" });
    return { ...base, reason: `commit failed: ${redact((commit.stderr?.toString() ?? "").slice(-400))}` };
  }

  logEvent("merge.lane.land", { ticketId, ff: false, latencyMs: Date.now() - startedMs });
  // Postsubmit (full real-world suite) runs after the land; records its verdict, never blocks.
  await runPostsubmit(ticketId);
  return { ...base, landed: true, ff: false, reason: "landed (gated --no-ff merge in integration worktree)" };
}

// §"side-effecting custom tools declare sideEffect + idempotency keys". landTool is the
// agent-facing wrapper the conflict-bounce fix-up path uses; the deterministic land lane
// calls landTicketBranch directly (merge authority stays in CODE, never the LLM). Both share
// one idempotent implementation, so a retry/resume is a no-op rather than a second merge.
// NOTE: a task that calls this is a side effect — it is NEVER given a `cache` policy.
export const landTool = defineTool({
  name: "smithering.land_ticket_branch",
  description:
    "Land a ticket's build/<id> branch onto the integration branch via the depth-1 merge lane. Idempotent; refuses to touch base/main.",
  schema: z.object({
    ticketId: z.string(),
    branch: z.string(),
    integrationBranch: z.string(),
    baseBranch: z.string(),
  }),
  sideEffect: true,
  // The implementation IS idempotent — a branch already in the integration ancestry is a
  // no-op (merge-base --is-ancestor short-circuit), so a retry/resume never double-merges.
  idempotent: true,
  async execute(args, ctx) {
    // ctx.idempotencyKey is stable across retries/resumes for the same task iteration; fall
    // back to the stable ticket-derived key so the key is never null (and survives resume).
    return landTicketBranch({ ...args, idempotencyKey: ctx.idempotencyKey ?? `land-${args.ticketId}` });
  },
});

// ─── §1 integration-branch + build-dir setup (idempotent; the build's trunk) ──
// Defense-in-depth: coerce away null/empty branch names AT the producer so the buildSetup
// output is always valid strings even on a direct call (the caller already resolves defaults
// via resolveBuildConfig). A null here is exactly what broke smoke-smithering-panopticon-4-0,
// so a coercion that ever fires is logged rather than silently emitting an invalid output.
async function ensureIntegrationBranch(integrationBranchArg: string, baseBranchArg: string) {
  const notes: string[] = [];
  const cfg = resolveBuildConfig({ integrationBranch: integrationBranchArg, baseBranch: baseBranchArg });
  const integrationBranch = cfg.integrationBranch;
  const baseBranch = cfg.baseBranch;
  if (integrationBranch !== integrationBranchArg || baseBranch !== baseBranchArg) {
    notes.push(
      `coerced invalid branch input (integration='${integrationBranchArg}', base='${baseBranchArg}') to defaults (integration='${integrationBranch}', base='${baseBranch}')`,
    );
    logEvent("build.integration.coerced", { gotIntegration: integrationBranchArg, gotBase: baseBranchArg, integrationBranch, baseBranch });
  }
  mkdirSync(resolve(process.cwd(), BUILD_DIR), { recursive: true });
  mkdirSync(resolve(process.cwd(), DECISIONS_DIR, "build"), { recursive: true });
  let created = false;
  const exists = await $`git rev-parse --verify ${integrationBranch}`.nothrow().quiet();
  if (exists.exitCode !== 0) {
    const fromBase = await $`git rev-parse --verify ${baseBranch}`.nothrow().quiet();
    const start = fromBase.exitCode === 0 ? baseBranch : "HEAD";
    const mk = await $`git branch ${integrationBranch} ${start}`.nothrow().quiet();
    created = mk.exitCode === 0;
    if (!created) notes.push(`could not create ${integrationBranch}: ${redact((mk.stderr?.toString() ?? "").slice(-300))}`);
    else notes.push(`created integration branch ${integrationBranch} off ${start}`);
  } else {
    notes.push(`integration branch ${integrationBranch} already exists`);
  }

  // Dedicated, clean integration worktree so the land lane NEVER checks out / merges in the
  // (possibly dirty, detached-HEAD) repo root — idempotent: skip if already registered.
  const wtAbs = resolve(process.cwd(), INTEGRATION_WT);
  let worktreeReady = existsSync(wtAbs);
  if (!worktreeReady) {
    mkdirSync(resolve(process.cwd(), ".smithers"), { recursive: true });
    const add = await $`git worktree add ${INTEGRATION_WT} ${integrationBranch}`.nothrow().quiet();
    worktreeReady = add.exitCode === 0;
    if (!worktreeReady) {
      notes.push(`could not add integration worktree ${INTEGRATION_WT}: ${redact((add.stderr?.toString() ?? "").slice(-300))}`);
    } else {
      notes.push(`added integration worktree ${INTEGRATION_WT} on ${integrationBranch}`);
    }
  } else {
    notes.push(`integration worktree ${INTEGRATION_WT} already present`);
  }
  logEvent("build.integration.ready", { integrationBranch, baseBranch, created, worktreeReady });
  return { integrationBranch, baseBranch, created, buildDir: BUILD_DIR, notes };
}

// ─── Schemas (house style: looseObject + defaults — a slightly-off agent reply degrades
//     instead of hard-failing; artifacts on disk are the full record, outputs are the index) ──
const buildSetupSchema = z.looseObject({
  integrationBranch: z.string().default("smithering/integration"),
  baseBranch: z.string().default("main"),
  created: z.boolean().default(false),
  buildDir: z.string().default(BUILD_DIR),
  notes: z.array(z.string()).default([]),
});

// One row per blocking pre-merge gate the worker ran, mirroring 06-orchestration §6 gates.json.
const gateRowSchema = z.looseObject({
  criterionId: z.string().default(""),
  method: z.string().default("unit_test"),
  tier: z.enum(["pre-build", "pre-merge", "postsubmit"]).default("pre-merge"),
  status: z.enum(["passed", "failed", "skipped"]).default("passed"),
  rbgRecorded: z.boolean().default(false),
  redRunPath: z.string().nullable().default(null),
  greenRunPath: z.string().nullable().default(null),
});

const buildImplementSchema = z.looseObject({
  ticketId: z.string().default(""),
  summary: z.string().default(""),
  filesChanged: z.array(z.string()).default([]),
  committed: z.boolean().default(false),
  gates: z.array(gateRowSchema).default([]),
  rbgRecorded: z.boolean().default(false),
  allGatesGreen: z.boolean().default(false),
  evidencePath: z.string().default(""),
  decisionDocs: z.array(z.string()).default([]),
  blockers: z.array(z.string()).default([]),
});

const buildReviewSchema = z.looseObject({
  ticketId: z.string().default(""),
  reviewer: z.string().default(""),
  family: z.string().default(OPENAI),
  kind: z.enum(["review", "challenge"]).default("review"),
  approved: z.boolean().default(false),
  feedback: z.string().default(""),
  issues: z
    .array(
      z.looseObject({
        severity: z.enum(["critical", "major", "minor", "nit"]).default("minor"),
        title: z.string().default(""),
        file: z.string().nullable().default(null),
        description: z.string().default(""),
      }),
    )
    .default([]),
});

const buildVerifySchema = z.looseObject({
  ticketId: z.string().default(""),
  verifier: z.string().default(""),
  family: z.string().default(ANTHROPIC),
  ranTests: z.boolean().default(false),
  rbgConfirmed: z.boolean().default(false),
  gatesGreen: z.boolean().default(false),
  pass: z.boolean().default(false),
  summary: z.string().default(""),
});

const buildLandSchema = z.looseObject({
  ticketId: z.string().default(""),
  landed: z.boolean().default(false),
  ff: z.boolean().default(false),
  alreadyLanded: z.boolean().default(false),
  branch: z.string().default(""),
  integrationBranch: z.string().default(""),
  reason: z.string().default(""),
});

const ticketResultSchema = z.looseObject({
  ticketId: z.string().default(""),
  status: z.enum(["finished", "landed", "blocked", "failed", "skipped"]).default("blocked"),
  branch: z.string().default(""),
  summary: z.string().default(""),
});

const gateSchema = z.looseObject({
  approved: z.boolean().default(false),
  note: z.string().nullable().default(null),
  decidedBy: z.string().nullable().default(null),
  decidedAt: z.string().nullable().default(null),
});

const finalReportSchema = z.looseObject({
  status: z.enum(["finished", "partial", "blocked", "cancelled"]).default("partial"),
  smoke: z.boolean().default(false),
  totalTickets: z.number().int().default(0),
  landedTickets: z.number().int().default(0),
  blockedTickets: z.number().int().default(0),
  integrationBranch: z.string().default(""),
  mergedToMain: z.boolean().default(false), // invariant: stays false — merging is the human's act
  blockers: z.array(z.string()).default([]),
  summary: z.string().default(""),
  artifactPath: z.string().nullable().default(BUILD_DIR),
});

const inputSchema = z.object({
  // smoke=true → ONLY the first ticket, end-to-end incl. verification, NO gates, reaches finished.
  smoke: z.boolean().default(false),
  integrationBranch: z.string().default("smithering/integration"),
  baseBranch: z.string().default("main"),
  maxConcurrency: z.number().int().min(1).max(8).default(6), // §5: 6 ticket workers
  probeConcurrency: z.number().int().min(1).max(8).default(8), // §5: probe waves burst to 8
  requireDeliveryGate: z.boolean().default(true), // full mode pauses for the human before declaring done
});

const { Workflow, Task, Sequence, Parallel, Loop, Approval, Worktree, smithers, outputs } = createSmithers({
  input: inputSchema,
  buildSetup: buildSetupSchema,
  buildImplement: buildImplementSchema,
  buildReview: buildReviewSchema,
  buildVerify: buildVerifySchema,
  buildLand: buildLandSchema,
  ticketResult: ticketResultSchema,
  gate: gateSchema,
  finalReport: finalReportSchema,
});

// ─── Per-ticket id helpers (derive from the stable ticket id — never an index/timestamp) ──
const implId = (id: string) => `build:${id}:implement`;
const reviewId = (id: string) => `build:${id}:review`;
const challengeId = (id: string) => `build:${id}:challenge`;
const verifyId = (id: string) => `build:${id}:verify`;
const resultId = (id: string) => `build:${id}:result`;
const blockedId = (id: string) => `build:${id}:blocked`;
const landId = (id: string) => `build:${id}:land`;
const worktreePath = (id: string) => `.smithers/wt/${id}`;
const buildBranch = (id: string) => `build/${id}`;
const evidenceDir = (id: string) => `${BUILD_DIR}/${id}`;

// ─── ctx readers (mirror the iteration-pinned pattern the parent uses) ────────
function latestImplement(ctx: any, id: string) {
  return ctx.latest("buildImplement", implId(id));
}
function latestVerify(ctx: any, id: string) {
  return ctx.latest("buildVerify", verifyId(id));
}
function latestReview(ctx: any, id: string) {
  return ctx.latest("buildReview", reviewId(id));
}
function latestChallenge(ctx: any, id: string) {
  return ctx.latest("buildReview", challengeId(id));
}
function landRow(ctx: any, id: string) {
  return ctx.outputMaybe("buildLand", { nodeId: landId(id), iteration: 0 });
}
function ticketLanded(ctx: any, id: string): boolean {
  return landRow(ctx, id)?.landed === true;
}

// A probe's verdict is the REAL green artifact (not agent compliance): the probe worker
// records it under <probeId>/probes/<probeId>/verdict.json. Read the worker worktree first
// (where it is written), then the integration tip (where a landed probe's verdict lives).
function probeVerdictGreen(probeId: string): boolean {
  const candidates = [
    resolve(process.cwd(), ".smithers/wt", probeId, PROBES_DIR, probeId, "verdict.json"),
    resolve(process.cwd(), INTEGRATION_WT, PROBES_DIR, probeId, "verdict.json"),
    resolve(process.cwd(), PROBES_DIR, probeId, "verdict.json"),
  ];
  for (const p of candidates) {
    try {
      if (isProbeVerdictGreen(JSON.parse(readFileSync(p, "utf8")))) return true;
    } catch {
      /* missing / unparseable → treated as NOT green (fail-closed) */
    }
  }
  return false;
}

// Every TRANSITIVE blocking probe in the ticket's closure must show a recorded green verdict.
function ticketProbesGreen(t: Ticket): boolean {
  return blockingProbeClosure(t.id, TICKET_BY_ID).every(probeVerdictGreen);
}

// Machine-check the durable evidence bundle on disk (gates.json RBG red/green present +
// verify.json + review.json + required files). This is what makes "done" mean something
// beyond the agent's say-so (§6): the same gate the land lane enforces, read at schedule time.
function ticketEvidenceComplete(t: Ticket): boolean {
  const bundleDir = workerBundleDir(t.id);
  const present = (rel?: string | null): boolean => {
    if (!rel) return false;
    try {
      const st = statSync(resolve(bundleDir, rel));
      return st.isFile() && st.size > 0;
    } catch {
      return false;
    }
  };
  const readJson = (name: string): any => {
    try {
      return JSON.parse(readFileSync(resolve(bundleDir, name), "utf8"));
    } catch {
      return null;
    }
  };
  return evaluateEvidenceBundle({
    gates: readJson("gates.json"),
    verify: readJson("verify.json"),
    review: readJson("review.json"),
    present,
    requiredFiles: REQUIRED_BUNDLE_FILES,
  }).ok;
}

function ticketEligible(ctx: any, t: Ticket): boolean {
  // A ticket may build only once every dep has LANDED on the integration branch (§1 ready())
  // AND every transitive blocking probe shows a recorded GREEN verdict — Cue / third-party
  // work is NEVER scheduled on agent compliance, only on a real green probe artifact (§3/§7).
  return t.dependsOn.every((d) => ticketLanded(ctx, d)) && ticketProbesGreen(t);
}
function ticketDone(ctx: any, t: Ticket): boolean {
  const v = latestVerify(ctx, t.id);
  const r = latestReview(ctx, t.id);
  const reviewOk = r?.approved === true;
  const challengeOk = !SAFETY_TICKET_IDS.has(t.id) || latestChallenge(ctx, t.id)?.approved === true;
  // The reviewer/verifier booleans are necessary but NOT sufficient — the durable evidence
  // bundle must machine-check out before a ticket is treated as landable (06-orchestration §6).
  return v?.pass === true && reviewOk && challengeOk && ticketEvidenceComplete(t);
}
function ticketSettled(ctx: any, t: Ticket): boolean {
  if (ticketLanded(ctx, t.id)) return true;
  const res =
    ctx.outputMaybe("ticketResult", { nodeId: resultId(t.id), iteration: 0 }) ??
    ctx.outputMaybe("ticketResult", { nodeId: blockedId(t.id), iteration: 0 });
  return res !== undefined && ["blocked", "failed", "skipped"].includes(res.status);
}
function ticketFeedback(ctx: any, t: Ticket): string | null {
  const parts: string[] = [];
  const v = latestVerify(ctx, t.id);
  if (v && v.pass === false) parts.push(`VERIFIER (test authority) FAILED:\n${v.summary}`);
  const r = latestReview(ctx, t.id);
  if (r && r.approved === false) {
    parts.push(`CROSS-FAMILY REVIEWER (${r.family}) REJECTED:\n${r.feedback}`);
    for (const i of r.issues ?? []) {
      parts.push(`  [${i.severity}] ${i.title}: ${i.description}${i.file ? ` (${i.file})` : ""}`);
    }
  }
  if (SAFETY_TICKET_IDS.has(t.id)) {
    const c = latestChallenge(ctx, t.id);
    if (c && c.approved === false) parts.push(`ADVERSARIAL CHALLENGE BROKE THE ALLOWLIST:\n${c.feedback}`);
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

// ─── Worker prompts (fresh context — §7 contract carried verbatim in every prompt) ──
function ticketBlock(t: Ticket): string {
  return JSON.stringify(
    {
      id: t.id,
      complexity: t.complexity,
      requirementIds: t.requirementIds,
      dependsOn: t.dependsOn,
      instructions: t.instructions,
      verification: t.verification,
    },
    null,
    2,
  );
}

function landedDepsBlock(t: Ticket): string {
  if (t.dependsOn.length === 0) return "(none — this ticket has no dependencies)";
  return t.dependsOn
    .map((d) => {
      const dep = TICKET_BY_ID.get(d);
      return `- ${d} — landed on the integration branch. READ its built interfaces + ${evidenceDir(d)}/RESULT.md${
        dep ? ` (${dep.title})` : ""
      }`;
    })
    .join("\n");
}

function probeVerdictPaths(t: Ticket): string {
  // The orchestrator's scheduler ENFORCES this (ticketEligible → ticketProbesGreen): every
  // transitive blocking probe must have a recorded green verdict.json on disk before this
  // ticket is scheduled at all. The prompt mirrors the machine gate so the worker can self-check.
  const probes = blockingProbeClosure(t.id, TICKET_BY_ID);
  const lines: string[] = probes.map(
    (d) =>
      `- ${d}: the scheduler already confirmed ${PROBES_DIR}/${d}/verdict.json is GREEN ({"green":true}); re-read it before building.`,
  );
  if (probes.length === 0 && !isProbeTicket(t)) lines.push("(no blocking probe in this ticket's transitive closure)");
  if (isProbeTicket(t)) {
    lines.push(
      `- THIS is a probe ticket: write ONLY under poc/ and ${PROBES_DIR}/. You MUST record a machine-readable`,
      `  verdict at ${PROBES_DIR}/${t.id}/verdict.json = {"green": <true|false>, "ticketId": "${t.id}", "summary": "..."}`,
      `  backed by a failable RBG run. Dependent tickets STAY UNSCHEDULED until that file reads green — never fake it.`,
    );
  }
  return lines.join("\n");
}

function implementerPrompt(ctx: any, t: Ticket, a: Assignment): string {
  const feedback = ticketFeedback(ctx, t);
  const safety = SAFETY_TICKET_IDS.has(t.id);
  const probe = isProbeTicket(t);
  return [
    `You are the IMPLEMENTER for ONE ticket of the Panopticon V0 build. You have FRESH CONTEXT and NO`,
    `conversation history — read everything you need from disk. You are running inside an isolated git`,
    `worktree at ${worktreePath(t.id)} on branch ${buildBranch(t.id)}; edit ONLY this working copy.`,
    ``,
    `── YOUR TICKET (verbatim from ${TICKETS_PATH}) ──`,
    ticketBlock(t),
    ``,
    `── READ THESE FROM DISK (paths, not summaries — do not trust memory) ──`,
    `- ${PLANNING}/01-prd.md, ${PLANNING}/02-design.md, ${PLANNING}/03-eng.md (the §-anchors your`,
    `  requirementIds ${t.requirementIds.join(", ") || "(none)"} touch), ${PLANNING}/04-backpressure.md`,
    `  (find the EXACT gate rows for your requirementIds), ${PLANNING}/05-tickets.md, ${PLANNING}/06-orchestration.md.`,
    `- Relevant ${DECISIONS_DIR}/*.html decision docs, and the recorded probe verdicts under ${PROBES_DIR}/.`,
    `- For safety-hook work also read artifacts/smithering/poc/safety-hook-approval-roundtrip/FINDINGS.md.`,
    ``,
    `── WORKTREE CONTRACT ──`,
    `Branch ${buildBranch(t.id)} is based off the INTEGRATION branch. Your already-landed dependencies`,
    `(read their REAL built interfaces from disk — never re-derive them):`,
    landedDepsBlock(t),
    ``,
    `── PROBE PRECEDENCE (STOP rule) ──`,
    probeVerdictPaths(t),
    `If a blocking probe in your dependency closure is UNRUN or FAILED, DO NOT write product code on the`,
    `unproven API: stop, and report the blocker in your structured output (blockers[]). Never invent a pass.`,
    ``,
    `── WHAT "DONE" MEANS (the validation bar is the centerpiece, not an afterthought) ──`,
    `1. Implement the ticket. Routing/safety authority lives in DETERMINISTIC code, never the LLM.`,
    `2. Write the ticket's ENTIRE verification[] block as real tests — BOTH unit/integration AND e2e`,
    `   where named. Aim for 10×–100× more tests than a human would: corner cases, error paths, empty/`,
    `   largest inputs, fuzzing where applicable, benchmarks for anything perf-critical.`,
    `3. RED-BEFORE-GREEN is mandatory: for EVERY blocking pre-merge gate, first demonstrate the test is`,
    `   capable of FAILING (archive the failing run), then make it pass (archive the passing run). "It`,
    `   works" / "the agent said it's done" is NOT evidence — only a test shown capable of failing is.`,
    `4. Emit structured, leveled logs with traceable correlation ids so a later agent with NO context can`,
    `   debug this (REQ-16). Never write a raw provider key to any source/log/artifact (SEC-1).`,
    feedback
      ? `\n── PREVIOUS ATTEMPT FEEDBACK (fix every item; re-run red-before-green for each fix) ──\n${feedback}`
      : ``,
    ``,
    `── PERSIST THIS EVIDENCE BUNDLE under ${evidenceDir(t.id)}/ (06-orchestration §6) ──`,
    `The land lane MACHINE-CHECKS this bundle (it does not trust prose): a missing red/green run, a`,
    `missing/empty required file, or a key-shaped string anywhere here REFUSES the land. Write:`,
    `- RESULT.md (what you built, gate roll-up, links to dep RESULT.md, surfaced blockers)`,
    `- gates.json (one row per gate: {criterionId, method, tier, status, rbgRecorded, redRunPath, greenRunPath}).`,
    `  For EVERY pre-merge blocking gate, status MUST be "passed", rbgRecorded true, and redRunPath/greenRunPath`,
    `  must point at real, non-empty files under evidence/.`,
    `- evidence/ (the RBG red + green runs, named by criterion, e.g. AC11.1-rbg-red.log / AC11.1-green.log)`,
    `- tests.log, tsc.log, trace/*.jsonl (secret-scanned), secret-scan.json (zero key-shaped strings)`,
    `- review.json + verify.json complete the bundle: the cross-family reviewer and the independent`,
    `  verifier write these, and the land gate requires BOTH to exist + report pass/approved. Leave the`,
    `  filenames free for them; do not fabricate either yourself.`,
    probe ? `- (probe ticket) write ONLY under poc/ and ${PROBES_DIR}/; the verdict.json goes under ${PROBES_DIR}/${t.id}/.` : ``,
    ``,
    `── DECISION DOCS for judgment calls (alternatives, example in/out, diffs) ──`,
    `For any genuine judgment call, write a self-contained HTML decision log under ${DECISIONS_DIR}/build/`,
    `(reuse the dark self-contained template the existing ${DECISIONS_DIR}/*.html files use).`,
    ``,
    `── COMMIT ──`,
    `Commit your work + evidence on branch ${buildBranch(t.id)} inside this worktree (jj or git) so the`,
    `depth-1 merge lane can land it. The land step is deterministic CODE; you do not merge anything.`,
    safety
      ? `\n── SAFETY-CRITICAL ──\nThis ticket is safety-critical. A cross-family adversarial CHALLENGE will try to break your read-safe\nallowlist. Prove the gate fails CLOSED: an unparseable/unknown command must be held, never executed.`
      : ``,
    ``,
    `You are the implementer (Anthropic). A CROSS-FAMILY reviewer (${a.reviewerLabel}) and an INDEPENDENT`,
    `test-authority verifier (${a.verifierLabel}) will follow. Never raise a human request — surface`,
    `blockers in structured output; the orchestrator's gates talk to the human.`,
  ]
    .filter(Boolean)
    .join("\n");
}

function reviewerPrompt(t: Ticket, kind: "review" | "challenge"): string {
  const header =
    kind === "challenge"
      ? `You are an ADVERSARIAL RED-TEAM reviewer (OpenAI/Codex — a DIFFERENT model family from the`
      : `You are the CROSS-FAMILY code reviewer (OpenAI/Codex — a DIFFERENT model family from the`;
  return [
    `${header} Anthropic implementer). Read the worktree diff on branch ${buildBranch(t.id)} and the`,
    `evidence bundle under ${evidenceDir(t.id)}/. You do not edit code; you judge.`,
    ``,
    `── TICKET ──`,
    ticketBlock(t),
    ``,
    `── READ FROM DISK ──`,
    `${PLANNING}/04-backpressure.md (the exact gate rows for ${t.requirementIds.join(", ") || "this ticket"}),`,
    `${PLANNING}/03-eng.md, and the ticket's gates.json + evidence/ RBG runs.`,
    ``,
    kind === "challenge"
      ? [
          `── ADVERSARIAL MANDATE ──`,
          `Actively TRY TO BREAK the read-safe allowlist / safety gate. Construct compound commands`,
          `(&&/;/|), redirections, substitution, eval, process-subst, and unparseable input. If ANY`,
          `destructive command can slip through as "read-safe", or the gate ever fails OPEN, set`,
          `approved=false and show the exact bypass. Default to approved=false if you are unsure.`,
        ].join("\n")
      : [
          `── REVIEW MANDATE ──`,
          `Confirm: (a) the implementation matches the ticket + its eng/backpressure rows; (b) the tests`,
          `actually prove the behavior (unit AND e2e where named) and are not tautological; (c) EVERY`,
          `blocking gate has a genuine red-before-green pair in evidence/ (a real failing run, not a stub);`,
          `(d) no raw provider key anywhere; (e) routing/safety authority is deterministic code, not the LLM.`,
          `Set approved=false with concrete issues[] if any of these is missing.`,
        ].join("\n"),
    ``,
    `── WRITE THE DURABLE VERDICT (the land lane requires it) ──`,
    `Persist ${evidenceDir(t.id)}/review.json = {"family":"openai","model":"${CODEX_MODEL}","kind":"${kind}",`,
    `"approved":<bool>,"pass":<bool>,"findings":[{"severity","title","file","description"}]}. This file is`,
    `part of the machine-checked evidence bundle — a missing/empty review.json REFUSES the land. Never write`,
    `a key-shaped string into it (the bundle is secret-scanned).`,
    ``,
    `Output reviewer="${kind === "challenge" ? "codex-challenge" : "codex-review"}", family="openai", and`,
    `kind="${kind}". Never raise a human request — your verdict is the structured output.`,
  ].join("\n");
}

function verifierPrompt(t: Ticket, a: Assignment): string {
  return [
    `You are the INDEPENDENT TEST-AUTHORITY VERIFIER (${a.verifierLabel}). You have FRESH CONTEXT and a`,
    `DISTINCT run from the implementer — you re-derive state from disk. Your authority is the TEST RESULT,`,
    `never your opinion; you do not re-litigate taste.`,
    ``,
    `── TICKET ──`,
    ticketBlock(t),
    ``,
    `── DO ──`,
    `1. Re-run the ticket's PRE-MERGE deterministic gate tier on branch ${buildBranch(t.id)}: the named`,
    `   bun test files + tsc --noEmit + the walking-skeleton smoke + the secret-redaction unit test +`,
    `   the hermetic replay-driven e2e (doubles only — no net/mic/keys). Capture output to disk.`,
    `2. For EVERY blocking gate, confirm the red-before-green evidence under ${evidenceDir(t.id)}/evidence/`,
    `   is GENUINE: the red run must be a real failure of a real test (open each one), and the green run`,
    `   must pass. A blocking gate with no failable test, or whose only evidence is "the agent said it's`,
    `   done", FAILS verification.`,
    `3. Write ${evidenceDir(t.id)}/verify.json = {ranTests, rbgConfirmed, gatesGreen, pass}.`,
    ``,
    `Set pass=true ONLY if you ran the tests, every blocking gate is green, AND every RBG pair is genuine.`,
    `Set pass=false otherwise and say exactly which gate/evidence is missing. Never raise a human request.`,
  ].join("\n");
}

// ─── Per-ticket worker subtree (implement → review[+challenge] → verify), in its worktree ──
function renderWorker(ctx: any, t: Ticket) {
  const cfg = resolveBuildConfig(ctx.input);
  const a = assignmentFor(t);
  const done = ticketDone(ctx, t);
  return (
    <Worktree
      key={t.id}
      id={`wt-${t.id}`}
      path={worktreePath(t.id)}
      branch={buildBranch(t.id)}
      // Worktrees base off the INTEGRATION branch (the build's trunk), never main.
      baseBranch={cfg.integrationBranch}
    >
      <Sequence>
        <Loop id={`build:${t.id}:loop`} until={done} maxIterations={a.maxIterations} onMaxReached="return-last">
          <Sequence>
            <Task
              id={implId(t.id)}
              output={outputs.buildImplement}
              agent={a.implementer}
              timeoutMs={2 * HOUR}
              heartbeatTimeoutMs={20 * 60_000}
              continueOnFail
            >
              {implementerPrompt(ctx, t, a)}
            </Task>
            <Parallel maxConcurrency={2}>
              <Task
                id={reviewId(t.id)}
                output={outputs.buildReview}
                agent={a.reviewer}
                timeoutMs={30 * 60_000}
                continueOnFail
              >
                {reviewerPrompt(t, "review")}
              </Task>
              {a.challenge ? (
                <Task
                  id={challengeId(t.id)}
                  output={outputs.buildReview}
                  agent={a.challenge}
                  timeoutMs={30 * 60_000}
                  continueOnFail
                >
                  {reviewerPrompt(t, "challenge")}
                </Task>
              ) : null}
            </Parallel>
            <Task
              id={verifyId(t.id)}
              output={outputs.buildVerify}
              agent={a.verifier}
              timeoutMs={HOUR}
              heartbeatTimeoutMs={20 * 60_000}
              continueOnFail
            >
              {verifierPrompt(t, a)}
            </Task>
          </Sequence>
        </Loop>
        <Task id={resultId(t.id)} output={outputs.ticketResult} continueOnFail>
          {{
            ticketId: t.id,
            // "finished" = the worker completed implement→review→verify; ACTUAL landing truth
            // is the buildLand row (the final report counts landings from there, not from here).
            status: (done ? "finished" : "blocked") as "finished" | "blocked",
            branch: buildBranch(t.id),
            summary: done
              ? `Implemented + cross-family reviewed + independently verified; queued for the depth-1 land lane.`
              : `Did not reach done after ${a.maxIterations} iterations — held out of the land lane (blocker).`,
          }}
        </Task>
      </Sequence>
    </Worktree>
  );
}

function renderBlocked(t: Ticket) {
  // A ticket whose deps did not land is skipped this run and surfaced as a blocker (no LLM spend).
  return (
    <Task key={t.id} id={blockedId(t.id)} output={outputs.ticketResult} continueOnFail>
      {{
        ticketId: t.id,
        status: "blocked" as const,
        branch: buildBranch(t.id),
        summary: `Blocked: a dependency did not land (deps: ${t.dependsOn.join(", ") || "none"}). Surfaced to the orchestrator's gate.`,
      }}
    </Task>
  );
}

// One wave = a <Parallel> of independent workers, then a depth-1 <MergeQueue> land lane.
// Waves run in DAG order (Sequence), so the lane is globally serialized: one writer at a time.
function renderWave(ctx: any, wave: Wave) {
  // Render is PURE — no side effects here. Probe-only waves burst to the higher cap (§5);
  // build.wave.* events are emitted from the executing setup/land compute tasks, not render.
  const cfg = resolveBuildConfig(ctx.input);
  const allProbes = wave.tickets.every(isProbeTicket);
  const cap = allProbes ? cfg.probeConcurrency : cfg.maxConcurrency;
  return (
    <Sequence key={`wave-${wave.index}`}>
      <Parallel id={`wave-${wave.index}-build`} maxConcurrency={cap}>
        {wave.tickets.map((t) => (ticketEligible(ctx, t) ? renderWorker(ctx, t) : renderBlocked(t)))}
      </Parallel>
      <MergeQueue id={`wave-${wave.index}-land`} maxConcurrency={1}>
        {wave.tickets
          .filter((t) => ticketEligible(ctx, t) && ticketDone(ctx, t) && !ticketLanded(ctx, t.id))
          .map((t) => (
            <Task key={t.id} id={landId(t.id)} output={outputs.buildLand} continueOnFail>
              {() =>
                landTicketBranch({
                  ticketId: t.id,
                  branch: buildBranch(t.id),
                  integrationBranch: cfg.integrationBranch,
                  baseBranch: cfg.baseBranch,
                  // Stable, ticket-derived idempotency key — survives resume (never an index/timestamp).
                  idempotencyKey: `land-${t.id}`,
                })
              }
            </Task>
          ))}
      </MergeQueue>
    </Sequence>
  );
}

// ─── Final report (computed at render time from ctx — static value task) ─────
function buildFinalReport(ctx: any, ticketsToBuild: Ticket[], smoke: boolean) {
  const cfg = resolveBuildConfig(ctx.input);
  const landed = ticketsToBuild.filter((t) => ticketLanded(ctx, t.id));
  const blocked = ticketsToBuild.filter((t) => !ticketLanded(ctx, t.id));
  const blockers: string[] = [];
  for (const t of blocked) {
    const fb = ticketFeedback(ctx, t);
    blockers.push(`${t.id}: ${fb ? fb.split("\n")[0] : "did not land"}`);
  }
  const allLanded = blocked.length === 0;
  const status = smoke
    ? landed.length === ticketsToBuild.length
      ? "finished"
      : "blocked"
    : allLanded
      ? "finished"
      : "partial";
  return {
    status: status as "finished" | "partial" | "blocked" | "cancelled",
    smoke,
    totalTickets: ticketsToBuild.length,
    landedTickets: landed.length,
    blockedTickets: blocked.length,
    integrationBranch: cfg.integrationBranch,
    mergedToMain: false, // invariant — merging the integration branch is the human's act
    blockers,
    summary: smoke
      ? `Smoke build: first ticket (${ticketsToBuild[0]?.id ?? "n/a"}) ${
          landed.length === ticketsToBuild.length ? "implemented, verified, and landed on" : "did NOT land on"
        } ${cfg.integrationBranch}. No approval gates ran.`
      : `Full build: ${landed.length}/${ticketsToBuild.length} tickets landed on ${cfg.integrationBranch} (depth-1 lane, never main). ${blocked.length} blocked. Merge to main is the human's act after delivery.`,
    artifactPath: BUILD_DIR,
  };
}

// ─── Workflow ────────────────────────────────────────────────────────────────
export default smithers((ctx) => {
  // ctx.input fields the parent omits arrive as `null` (smithers strips Zod .default() from
  // the durable input columns), so resolve the documented defaults ONCE here and downstream.
  const cfg: BuildConfig = resolveBuildConfig(ctx.input);
  const smoke = cfg.smoke;
  const setup = ctx.outputMaybe("buildSetup", { nodeId: "build:setup", iteration: 0 });

  // smoke=true → ONLY the first ticket (the dependsOn:[] root) end-to-end, NO gates.
  const root = firstTicket();
  const ticketsToBuild = smoke ? (root ? [root] : []) : ALL_TICKETS;
  const waves: Wave[] = smoke
    ? root
      ? [{ index: 0, tickets: [root] }]
      : []
    : ALL_WAVES;

  const allSettled = setup !== undefined && ticketsToBuild.length > 0 && ticketsToBuild.every((t) => ticketSettled(ctx, t));

  // Full-mode human gate (skipped entirely in smoke mode): accept the built integration
  // branch. This NEVER merges to main — it just records the human's acceptance.
  const deliveryGate = ctx.outputMaybe("gate", { nodeId: "gate:delivery", iteration: 0 });
  const needDeliveryGate = !smoke && cfg.requireDeliveryGate;
  const deliveryDecided = !needDeliveryGate || deliveryGate !== undefined;

  const reportReady = allSettled && deliveryDecided;
  const report = reportReady ? buildFinalReport(ctx, ticketsToBuild, smoke) : null;

  return (
    <Workflow name="smithering-impl">
      <Sequence>
        {/* §1 — the build trunk: an integration branch off base (NEVER main is touched). */}
        <Task id="build:setup" output={outputs.buildSetup}>
          {() => ensureIntegrationBranch(cfg.integrationBranch, cfg.baseBranch)}
        </Task>

        {/* DAG → topological waves; each wave is a Parallel of fresh-context workers in their
            own worktrees, then a depth-1 serialized land lane onto the integration branch. */}
        {setup ? waves.map((wave) => renderWave(ctx, wave)) : null}

        {/* Full mode only: pause for the human before declaring the build accepted. */}
        {!smoke && setup && allSettled && needDeliveryGate && !deliveryGate ? (
          <Approval
            id="gate:delivery"
            output={outputs.gate}
            request={{
              title: "Accept the built integration branch?",
              summary: `All ${ticketsToBuild.length} tickets settled on ${cfg.integrationBranch}. This run will NOT merge to ${cfg.baseBranch} — merging is your act after delivery. Accept the build?`,
              metadata: { integrationBranch: cfg.integrationBranch, artifactPath: BUILD_DIR },
            }}
            onDeny="continue"
          />
        ) : null}

        {report ? (
          <Task id="build:report" output={outputs.finalReport}>
            {report}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
