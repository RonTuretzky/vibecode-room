// Pure, side-effect-free orchestration logic extracted from
// .smithers/workflows/smithering-impl.tsx so the orchestrator can be tested like
// code (docs/planning/06-orchestration.md §8 — "the orchestration logic is code, so
// it is tested like code"). NOTHING here imports the smithers runtime or touches the
// network; every function is deterministic given its inputs, so the same logic that
// drives the workflow is exercised by src/orchestration/*.test.ts with recorded
// red-before-green moves. The workflow imports these helpers instead of re-deriving
// them, so a test failure here is a real failure of the shipped scheduler.

// ─── Model families (the cross-family invariant of §4 lives or dies on these) ──
export const ANTHROPIC = "anthropic";
export const OPENAI = "openai";

// Role → family table. Implement = OpenAI/Codex, review = Anthropic (cross-family Opus
// check) + Codex, verify = independent Anthropic (Sonnet). assertCrossFamily() proves
// reviewer.family ≠ implementer.family; the RBG move (point review at OpenAI, the
// implementer's family) makes it throw.
export type RoleFamilies = {
  implementer: string;
  reviewer: string;
  verifier: string;
};
export const ROLE_FAMILIES: RoleFamilies = {
  implementer: OPENAI,
  reviewer: ANTHROPIC,
  verifier: ANTHROPIC,
};

export function assertCrossFamily(roles: RoleFamilies = ROLE_FAMILIES): void {
  if (!roles.implementer || !roles.reviewer) {
    throw new Error("orchestration: untagged agent family (implementer/reviewer)");
  }
  if (roles.implementer === roles.reviewer) {
    throw new Error(
      `orchestration: cross-family invariant violated — implementer family ${roles.implementer} === reviewer family ${roles.reviewer}`,
    );
  }
}

// ─── Tickets + DAG ────────────────────────────────────────────────────────────
export type TicketVerification = { kind: string; details: string };
export type Ticket = {
  id: string;
  title: string;
  instructions: string;
  requirementIds: string[];
  verification: TicketVerification[];
  dependsOn: string[];
  complexity: string;
};

const COMPLEXITIES = ["trivial", "small", "medium", "large"];

export function normalizeTicket(raw: any): Ticket {
  return {
    id: String(raw?.id ?? ""),
    title: String(raw?.title ?? raw?.id ?? "Ticket"),
    instructions: String(raw?.instructions ?? ""),
    requirementIds: Array.isArray(raw?.requirementIds) ? raw.requirementIds.map(String) : [],
    verification: Array.isArray(raw?.verification)
      ? raw.verification.map((v: any) => ({
          kind: String(v?.kind ?? "command"),
          details: String(v?.details ?? ""),
        }))
      : [],
    dependsOn: Array.isArray(raw?.dependsOn) ? raw.dependsOn.map(String) : [],
    complexity: COMPLEXITIES.includes(raw?.complexity) ? raw.complexity : "medium",
  };
}

// Accepts either a raw tickets array or the `{ tickets: [...] }` envelope.
export function parseTickets(raw: any): Ticket[] {
  const list = (Array.isArray(raw) ? raw : raw?.tickets ?? []) as any[];
  return list.map(normalizeTicket).filter((t) => t.id);
}

// A "probe" ticket validates a third-party API before dependent work may build on it
// (pre-build tier, §3). Probe tickets carry the stable `probe-` id prefix.
export function isProbeTicket(t: Pick<Ticket, "id">): boolean {
  return /^probe-/.test(t.id);
}

export type Wave = { index: number; tickets: Ticket[] };

// Kahn-by-levels: a ticket's wave = 1 + max(wave of its deps). Throws on cycle / dangling
// ref so the DAG-acyclic invariant (§8) is enforced before any worker spawns.
export function computeWaves(tickets: Ticket[]): Wave[] {
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const resolveDepth = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (visiting.has(id)) throw new Error(`orchestration: dependency cycle detected at ${id}`);
    const t = byId.get(id);
    if (!t) throw new Error(`orchestration: unresolved dependsOn reference '${id}'`);
    visiting.add(id);
    const d = t.dependsOn.length === 0 ? 0 : 1 + Math.max(...t.dependsOn.map(resolveDepth));
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const t of tickets) resolveDepth(t.id);
  const byWave = new Map<number, Ticket[]>();
  for (const t of tickets) {
    const w = depth.get(t.id)!;
    if (!byWave.has(w)) byWave.set(w, []);
    byWave.get(w)!.push(t);
  }
  return [...byWave.keys()]
    .sort((a, b) => a - b)
    .map((index) => ({ index, tickets: byWave.get(index)!.sort((a, b) => a.id.localeCompare(b.id)) }));
}

// The full transitive dependency closure of a ticket (excludes the ticket itself).
// Throws on a dangling ref so probe precedence can never silently pass.
export function transitiveDeps(id: string, byId: Map<string, Ticket>): Set<string> {
  const seen = new Set<string>();
  const walk = (cur: string) => {
    const t = byId.get(cur);
    if (!t) throw new Error(`orchestration: unresolved dependsOn reference '${cur}'`);
    for (const d of t.dependsOn) {
      if (seen.has(d)) continue;
      seen.add(d);
      walk(d);
    }
  };
  walk(id);
  return seen;
}

// Every probe ticket anywhere in a ticket's transitive dependency closure. These are the
// blocking probes that must show a recorded GREEN verdict before the ticket may be
// scheduled (§3 probe precedence; transitive, not just direct).
export function blockingProbeClosure(id: string, byId: Map<string, Ticket>): string[] {
  return [...transitiveDeps(id, byId)]
    .filter((depId) => {
      const t = byId.get(depId);
      return !!t && isProbeTicket(t);
    })
    .sort();
}

// ─── Probe verdicts (the real green artifact, not agent compliance, §3/§7) ─────
export type ProbeVerdict = { green: boolean; ticketId?: string; summary?: string };

// A recorded probe verdict is GREEN only when the artifact parses and an explicit
// truthy green/pass/overallPassed flag is present. Missing/unparseable/false ⇒ not green,
// so a ticket whose probe never ran (or ran red) stays unscheduled.
export function isProbeVerdictGreen(parsed: any): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  if (parsed.green === true) return true;
  if (parsed.pass === true) return true;
  if (parsed.overallPassed === true) return true;
  return false;
}

// ─── Secret scanning (fail-closed redaction, SEC-1) ────────────────────────────
export const KEY_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /Bearer\s+[A-Za-z0-9._-]{16,}/gi,
  /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g, // jwt-ish
  /\bAKIA[0-9A-Z]{16}\b/g,
];

export function redact(value: string): string {
  let out = String(value);
  for (const p of KEY_PATTERNS) out = out.replace(p, "«redacted»");
  return out;
}

// Returns the distinct key-shaped strings found in `text` (already-redacted markers do
// not match). Empty array = clean. Used by the merge gate's secret-scan (§6).
export function scanForSecrets(text: string): string[] {
  const hits = new Set<string>();
  for (const p of KEY_PATTERNS) {
    const re = new RegExp(p.source, p.flags.includes("g") ? p.flags : p.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(String(text))) !== null) {
      hits.add(m[0]);
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return [...hits];
}

// ─── Evidence-bundle gate (06-orchestration §6 — "no recorded RBG = no land") ───
export type GateRow = {
  criterionId: string;
  method: string;
  tier: "pre-build" | "pre-merge" | "postsubmit" | string;
  status: "passed" | "failed" | "skipped" | string;
  rbgRecorded: boolean;
  testPath?: string | null;
  redRunPath?: string | null;
  greenRunPath?: string | null;
};

export type EvidenceInput = {
  // Parsed contents of the bundle (null/undefined if the file is missing).
  gates: GateRow[] | null | undefined;
  verify: { pass?: boolean; ranTests?: boolean; rbgConfirmed?: boolean } | null | undefined;
  review: { pass?: boolean; approved?: boolean } | null | undefined;
  // Whether a path (relative to the bundle) exists AND is non-empty. Injected so the
  // logic is pure and unit-testable without touching disk.
  present: (relPath: string | null | undefined) => boolean;
  // Optional list of the bundle files that MUST exist + be non-empty regardless of gates
  // (RESULT.md, gates.json, verify.json, review.json, secret-scan.json).
  requiredFiles?: string[];
};

export type EvidenceResult = { ok: boolean; reasons: string[] };

// The machine record the merge lane reads. A land is allowed ONLY when, for every
// pre-merge blocking gate, rbgRecorded is true and BOTH the red and green run files exist
// and are non-empty; AND verify.json reports pass; AND every required bundle file is
// present. review.json is required as recorded advisory feedback, but its approval boolean
// is not a landing authority; the independent verifier is.
export function evaluateEvidenceBundle(input: EvidenceInput): EvidenceResult {
  const reasons: string[] = [];
  const present = input.present;

  for (const f of input.requiredFiles ?? []) {
    if (!present(f)) reasons.push(`required evidence file missing or empty: ${f}`);
  }

  if (!input.gates || !Array.isArray(input.gates)) {
    reasons.push("gates.json missing or not an array — no machine gate record to land on");
  } else {
    const preMerge = input.gates.filter((g) => g.tier === "pre-merge");
    if (preMerge.length === 0) {
      reasons.push("gates.json has no pre-merge gate rows — nothing was gated before land");
    }
    for (const g of preMerge) {
      if (g.status !== "passed") {
        reasons.push(`pre-merge gate '${g.criterionId}' status=${g.status} (must be passed)`);
        continue;
      }
      if (!g.rbgRecorded) {
        reasons.push(`pre-merge gate '${g.criterionId}' has no recorded red-before-green`);
      }
      if (!present(g.redRunPath)) {
        reasons.push(`pre-merge gate '${g.criterionId}' red run missing/empty: ${g.redRunPath ?? "(none)"}`);
      }
      if (!present(g.greenRunPath)) {
        reasons.push(`pre-merge gate '${g.criterionId}' green run missing/empty: ${g.greenRunPath ?? "(none)"}`);
      }
    }
  }

  if (!input.verify) {
    reasons.push("verify.json missing — the independent verifier left no machine record");
  } else if (input.verify.pass !== true) {
    reasons.push("verify.json pass !== true (independent test authority did not pass)");
  }

  if (!input.review) {
    reasons.push("review.json missing — the cross-family reviewer left no machine record");
  }

  return { ok: reasons.length === 0, reasons };
}

// The fixed set of bundle files the durable record requires (06-orchestration §6 table).
export const REQUIRED_BUNDLE_FILES = [
  "RESULT.md",
  "gates.json",
  "verify.json",
  "review.json",
  "secret-scan.json",
];

// ─── Run config: re-apply the input defaults smithers does NOT apply to ctx.input ──
// CRITICAL smithers behavior (verified against @smithers-orchestrator/db/zodToTable.js +
// unwrapZodType.js): the durable input table's columns are generated from the Zod input
// schema with the `.default()` wrapper STRIPPED, so a field the caller OMITS at launch is
// stored as SQL NULL and surfaces on `ctx.input` as `null` — NOT its declared schema default.
// The parent smithering workflow launches this run with ONLY `{ smoke }` set, so
// integrationBranch, baseBranch, and the concurrency caps all arrive as `null` at runtime.
// Reading them raw made build:setup emit {integrationBranch:null,baseBranch:null,…}, which the
// buildSetup output schema (z.string()) rejects — the failure of smoke-smithering-vibersyn-4-0.
// resolveBuildConfig re-applies the documented defaults so build:setup never produces a null
// branch and the depth-1 land lane always receives a real, non-base integration branch.
export const DEFAULT_INTEGRATION_BRANCH = "smithering/integration";
export const DEFAULT_BASE_BRANCH = "main";
export const DEFAULT_MAX_CONCURRENCY = 6;
export const DEFAULT_PROBE_CONCURRENCY = 8;

export type BuildConfig = {
  smoke: boolean;
  integrationBranch: string;
  baseBranch: string;
  maxConcurrency: number;
  probeConcurrency: number;
  requireDeliveryGate: boolean;
};

export function resolveBuildConfig(input: unknown): BuildConfig {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const str = (v: unknown, fallback: string): string =>
    typeof v === "string" && v.trim() !== "" ? v : fallback;
  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return {
    smoke: i.smoke === true,
    integrationBranch: str(i.integrationBranch, DEFAULT_INTEGRATION_BRANCH),
    baseBranch: str(i.baseBranch, DEFAULT_BASE_BRANCH),
    maxConcurrency: num(i.maxConcurrency, DEFAULT_MAX_CONCURRENCY),
    probeConcurrency: num(i.probeConcurrency, DEFAULT_PROBE_CONCURRENCY),
    // Default ON: full mode pauses for the human unless the caller explicitly opts out.
    requireDeliveryGate: i.requireDeliveryGate !== false,
  };
}
