import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createModelCredentialSource, rejectRawModelCredentials } from "../src/providers/credentials";
import { hasSecretLikeString, redactSecretValues, scanSecretLikeFiles, scanSecretLikeText } from "../src/security/secrets";

export const PROBE_ID = "probe-hot-loop-llm-subscription";
export const PROBE_ROOT = join("artifacts", "smithering", "probes", PROBE_ID);
export const BUILD_ROOT = join("artifacts", "smithering", "build", PROBE_ID);
export const TRACE_ROOT = join(BUILD_ROOT, "trace");
export const DECISION_BUDGET_MS = 100;
export const COST_BUDGET_PER_HOUR_USD = 0.15;

export type HotLoopDecision = "PASS" | "ACT";
export type HotLoopTool = "observe.pass" | "panopticon.suggest" | "panopticon.steer";

export interface HotLoopToolCall {
  id: string;
  decision: HotLoopDecision;
  tool: HotLoopTool;
  arguments: Record<string, unknown>;
  confidence: number;
  reason: string;
}

export interface CliAttempt {
  provider: "openai-codex" | "anthropic-claude";
  command: string;
  status: "passed" | "failed";
  subscriptionRouted: boolean;
  latencyMs: number;
  decisions: HotLoopToolCall[];
  invocations: CliInvocation[];
  stdoutPreview: string;
  error?: string;
}

export interface CliInvocation {
  id: string;
  latencyMs: number;
  decisions: HotLoopToolCall[];
  stdoutPreview: string;
}

export interface HotLoopProbeVerdict {
  green: boolean;
  ticketId: typeof PROBE_ID;
  summary: string;
  selected?: CliAttempt;
  attempts: CliAttempt[];
  checks: {
    deterministic: boolean;
    p50LatencyWithinBudget: boolean;
    mappedActionToolSchema: boolean;
    noRawKeyRoute: boolean;
    traceSecretClean: boolean;
    costWithinBudget: boolean;
    actPromptAmendment: boolean;
  };
  metrics: {
    budgetMs: number;
    p50LatencyMs: number | null;
    costBudgetPerHourUsd: number;
    estimatedCostPerHourUsd: number | null;
    costBasis: "not-measured-host-subscription-no-metering";
  };
  blockers: string[];
}

const CACHE_PATH = join(PROBE_ROOT, "verdict.json");
const TRACE_PATH = join(TRACE_ROOT, "llm-subscription-probe.jsonl");

const HOT_LOOP_PROMPT = `You are the Panopticon hot-loop decision classifier.

Return only valid JSON with this exact shape:
{"decisions":[{"id":"repeat-1","decision":"PASS|ACT","tool":"observe.pass|panopticon.suggest|panopticon.steer","arguments":{},"confidence":0.0,"reason":"short"}]}

ACT when the segment contains a clear new buildable idea, a named callsign command, a panic/stop word, a clear accept/reject of a pending suggestion, or a status/information query addressed to a named callsign.
PASS for status updates about existing work, room discussion, human-to-human questions, social talk, filler, and vague intent.
When an ACT decision is addressed to a named callsign, use panopticon.steer and include the callsign and short instruction.

Classify these transcript segments:
repeat-1: Daybreak, what's your current status?
pass-1: The agent is still running the TypeScript compiler checks.`;

const SAFE_ENV_NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TERM",
  "LANG",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
]);

export function assertDeterministic(invocations: CliInvocation[] | HotLoopToolCall[]): void {
  const runs = isInvocationArray(invocations)
    ? invocations.map((invocation) => invocation.decisions)
    : [invocations as HotLoopToolCall[]];
  if (runs.length < 2) {
    throw new Error("missing same-input repeated CLI invocations");
  }
  const [first, ...rest] = runs.map(canonicalDecisions);
  for (const next of rest) {
    if (JSON.stringify(first) !== JSON.stringify(next)) {
      throw new Error("temperature-0 replay decisions diverged across repeated CLI invocations");
    }
  }
}

export function assertP50Latency(attempts: CliAttempt[], budgetMs = DECISION_BUDGET_MS): void {
  const measured = attempts
    .filter((attempt) => attempt.status === "passed" && attempt.subscriptionRouted)
    .map((attempt) => ({ attempt, p50: candidateP50LatencyMs(attempt) }))
    .filter((entry): entry is { attempt: CliAttempt; p50: number } => entry.p50 !== null);
  if (measured.length === 0) {
    throw new Error("no successful subscription-routed model call to measure");
  }
  const passing = measured.find((entry) => entry.p50 <= budgetMs);
  if (passing === undefined) {
    const best = measured.sort((a, b) => a.p50 - b.p50)[0];
    throw new Error(`best subscription-routed candidate p50 latency ${best.p50.toFixed(0)} ms exceeds ${budgetMs} ms budget`);
  }
}

export function assertMappedActionToolSchema(decisions: HotLoopToolCall[]): void {
  if (decisions.length === 0) {
    throw new Error("model returned no decisions");
  }
  for (const decision of decisions) {
    if (!["PASS", "ACT"].includes(decision.decision)) {
      throw new Error(`invalid decision ${String(decision.decision)}`);
    }
    if (!["observe.pass", "panopticon.suggest", "panopticon.steer"].includes(decision.tool)) {
      throw new Error(`tool ${String(decision.tool)} is not MappedActionTool-compatible`);
    }
    if (decision.decision === "PASS" && decision.tool !== "observe.pass") {
      throw new Error("PASS decisions must map to observe.pass");
    }
    if (decision.decision === "ACT" && decision.tool === "observe.pass") {
      throw new Error("ACT decisions must select a mapped action tool");
    }
    if (decision.tool === "panopticon.steer") {
      if (typeof decision.arguments.callsign !== "string" || typeof decision.arguments.instruction !== "string") {
        throw new Error("panopticon.steer requires callsign and instruction arguments");
      }
    }
    if (typeof decision.confidence !== "number" || decision.confidence < 0 || decision.confidence > 1) {
      throw new Error("confidence must be a number in [0,1]");
    }
  }
}

export function assertNoRawKeyPath(): void {
  let rejected = false;
  try {
    rejectRawModelCredentials({ rawApiKey: "fixture-raw-provider-key" });
  } catch {
    rejected = true;
  }
  if (!rejected) {
    throw new Error("raw model credential path was accepted");
  }

  const env = sanitizedSubscriptionCliEnv({
    PATH: "/usr/bin",
    OPENAI_API_KEY: generatedOpenAiLikeKey(),
    ANTHROPIC_API_KEY: generatedAnthropicLikeKey(),
    MODEL_TOKEN: generatedBearerLikeToken(),
  });
  if ("OPENAI_API_KEY" in env || "ANTHROPIC_API_KEY" in env || "MODEL_TOKEN" in env) {
    throw new Error("raw provider credential environment was inherited by subscription CLI route");
  }
}

export function assertNoSecretText(text: string): void {
  const findings = scanSecretLikeText(text);
  if (findings.length > 0) {
    throw new Error(`secret-shaped text detected: ${findings.map((finding) => finding.pattern).join(",")}`);
  }
}

export function assertCostGate(costPerHourUsd: number | null): void {
  if (costPerHourUsd === null) {
    throw new Error("cost could not be measured for any subscription-routed candidate");
  }
  if (costPerHourUsd > COST_BUDGET_PER_HOUR_USD) {
    throw new Error(`hot-loop cost $${costPerHourUsd.toFixed(4)}/hr exceeds $${COST_BUDGET_PER_HOUR_USD}/hr gate`);
  }
}

export function assertActPromptAmendment(decisions: HotLoopToolCall[]): void {
  const statusDecision = decisions.find((decision) => decision.id === "repeat-1");
  if (statusDecision?.decision !== "ACT" || statusDecision.tool !== "panopticon.steer") {
    throw new Error("named callsign status query did not classify as ACT");
  }
}

export async function runHotLoopSubscriptionProbe(options: { forceRefresh?: boolean } = {}): Promise<HotLoopProbeVerdict> {
  if (!options.forceRefresh && process.env.PANOP_LLM_PROBE_USE_ARTIFACT_CACHE === "1") {
    const cached = await readCachedVerdict();
    if (cached !== null) {
      return cached;
    }
  }

  await rm(PROBE_ROOT, { recursive: true, force: true });
  await mkdir(PROBE_ROOT, { recursive: true });
  await mkdir(TRACE_ROOT, { recursive: true });
  await writeFile(TRACE_PATH, "");

  const attempts: CliAttempt[] = [];
  for (const candidate of candidates()) {
    attempts.push(await runCandidate(candidate));
    await appendTrace("llm_probe.candidate", attempts[attempts.length - 1]);
  }

  const selected = selectLowestLatencyPassedCandidate(attempts);
  const decisions = selected?.decisions ?? [];
  const selectedInvocations = selected?.invocations ?? [];
  const checks = {
    deterministic: safeCheck(() => assertDeterministic(selectedInvocations)),
    p50LatencyWithinBudget: safeCheck(() => assertP50Latency(attempts)),
    mappedActionToolSchema: safeCheck(() => assertMappedActionToolSchema(decisions)),
    noRawKeyRoute: safeCheck(() => assertNoRawKeyPath()),
    traceSecretClean: true,
    costWithinBudget: safeCheck(() => assertCostGate(estimatedCostPerHourUsd(selected))),
    actPromptAmendment: safeCheck(() => assertActPromptAmendment(decisions)),
  };
  const p50LatencyMs = selected === undefined ? null : candidateP50LatencyMs(selected);
  const preliminaryVerdict = buildVerdict(selected, attempts, { ...checks, traceSecretClean: true }, p50LatencyMs);
  const traceSecretClean = await prospectiveVerdictSecretScan(preliminaryVerdict);
  const verdict = buildVerdict(selected, attempts, { ...checks, traceSecretClean }, p50LatencyMs);
  await writeFile(CACHE_PATH, JSON.stringify(redactForArtifact(verdict), null, 2) + "\n");
  await appendTrace("llm_probe.verdict", verdict);
  return verdict;
}

function buildVerdict(
  selected: CliAttempt | undefined,
  attempts: CliAttempt[],
  checks: HotLoopProbeVerdict["checks"],
  p50LatencyMs: number | null,
): HotLoopProbeVerdict {
  const blockers = buildBlockers(checks, attempts);
  const green = blockers.length === 0;
  return {
    green,
    ticketId: PROBE_ID,
    summary: green
      ? "A subscription-routed hot-loop model met determinism, p50 latency, schema, prompt, cost, and trace-secret gates."
      : "No host subscription-routed Codex/Claude CLI model met the hot-loop model gate; this is a binding PRD §6 conflict for the gate.",
    selected,
    attempts,
    checks,
    metrics: {
      budgetMs: DECISION_BUDGET_MS,
      p50LatencyMs,
      costBudgetPerHourUsd: COST_BUDGET_PER_HOUR_USD,
      estimatedCostPerHourUsd: estimatedCostPerHourUsd(selected),
      costBasis: "not-measured-host-subscription-no-metering",
    },
    blockers,
  };
}

function candidates(): Array<{ provider: CliAttempt["provider"]; command: string[]; display: string; timeoutMs: number }> {
  return [
    {
      provider: "openai-codex",
      command: ["codex", "-a", "never", "exec", "--ephemeral", "--ignore-rules", "--sandbox", "read-only", "-o", join(PROBE_ROOT, "codex-last-message.json"), HOT_LOOP_PROMPT],
      display: "codex exec",
      timeoutMs: 60000,
    },
    {
      provider: "anthropic-claude",
      command: ["claude", "--print", "--output-format", "json", "--max-budget-usd", "0.05", "--tools", "", "--system-prompt", "Return only the requested JSON. Do not use tools.", HOT_LOOP_PROMPT],
      display: "claude --print",
      timeoutMs: 60000,
    },
  ];
}

async function runCandidate(candidate: ReturnType<typeof candidates>[number]): Promise<CliAttempt> {
  const started = performance.now();
  const env = sanitizedSubscriptionCliEnv();
  const source = createModelCredentialSource({
    provider: candidate.provider,
    command: candidate.provider === "openai-codex" ? "codex" : "claude --print",
    env,
  });
  if (source.kind !== "host-subscription") {
    return failedAttempt(candidate, candidate.display, performance.now() - started, "model credential source was not host-subscription");
  }

  try {
    const invocations: CliInvocation[] = [];
    for (const invocationId of ["same-input-1", "same-input-2"]) {
      const invocation = await runCandidateInvocation(candidate, env, invocationId);
      invocations.push(invocation);
      await appendTrace("llm_probe.invocation", { provider: candidate.provider, command: source.command, invocation });
    }
    const latencyMs = percentile(invocations.map((invocation) => invocation.latencyMs), 0.5) ?? performance.now() - started;
    const decisions = invocations[0]?.decisions ?? [];
    return {
      provider: candidate.provider,
      command: source.command,
      status: "passed",
      subscriptionRouted: source.kind === "host-subscription",
      latencyMs,
      decisions,
      invocations,
      stdoutPreview: invocations[0]?.stdoutPreview ?? "",
    };
  } catch (error) {
    return failedAttempt(candidate, source.command, performance.now() - started, error instanceof Error ? error.message : String(error));
  }
}

async function runCandidateInvocation(
  candidate: ReturnType<typeof candidates>[number],
  env: Record<string, string>,
  invocationId: string,
): Promise<CliInvocation> {
  const started = performance.now();
  const proc = Bun.spawn(candidate.command, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const timedOut = await waitWithTimeout(proc, candidate.timeoutMs);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const latencyMs = performance.now() - started;
  if (timedOut) {
    proc.kill();
    throw new Error("candidate timed out");
  }
  if (proc.exitCode !== 0) {
    throw new Error(summarizeCliError(stdout, stderr));
  }
  const outputText = await candidateOutput(candidate, stdout);
  const decisions = parseDecisions(outputText);
  return {
    id: invocationId,
    latencyMs,
    decisions,
    stdoutPreview: preview(outputText),
  };
}

async function waitWithTimeout(proc: Bun.Subprocess<"ignore", "pipe", "pipe">, timeoutMs: number): Promise<boolean> {
  let timeout: Timer | undefined;
  const result = await Promise.race([
    proc.exited.then(() => false),
    new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(true), timeoutMs);
    }),
  ]);
  if (timeout !== undefined) {
    clearTimeout(timeout);
  }
  return result;
}

function failedAttempt(candidate: ReturnType<typeof candidates>[number], command: string, latencyMs: number, error: string): CliAttempt {
  return {
    provider: candidate.provider,
    command,
    status: "failed",
    subscriptionRouted: true,
    latencyMs,
    decisions: [],
    invocations: [],
    stdoutPreview: "",
    error: preview(error),
  };
}

async function candidateOutput(candidate: ReturnType<typeof candidates>[number], stdout: string): Promise<string> {
  if (candidate.provider === "openai-codex") {
    try {
      return await readFile(join(PROBE_ROOT, "codex-last-message.json"), "utf8");
    } catch {
      return stdout;
    }
  }
  const parsed = JSON.parse(stdout) as { result?: string };
  return parsed.result ?? stdout;
}

export function parseDecisions(text: string): HotLoopToolCall[] {
  const jsonText = extractJson(text);
  const parsed = JSON.parse(jsonText) as { decisions?: unknown };
  if (!Array.isArray(parsed.decisions)) {
    throw new Error("response did not contain decisions array");
  }
  return parsed.decisions.map((entry) => normalizeDecision(entry));
}

function normalizeDecision(entry: unknown): HotLoopToolCall {
  const value = entry as Record<string, unknown>;
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new Error("decision id must be a non-empty string");
  }
  if (value.decision !== "PASS" && value.decision !== "ACT") {
    throw new Error(`invalid decision ${String(value.decision)}`);
  }
  if (value.tool !== "observe.pass" && value.tool !== "panopticon.suggest" && value.tool !== "panopticon.steer") {
    throw new Error(`tool ${String(value.tool)} is not MappedActionTool-compatible`);
  }
  if (typeof value.confidence !== "number") {
    throw new Error("confidence must be numeric");
  }
  if (typeof value.reason !== "string") {
    throw new Error("reason must be a string");
  }
  return {
    id: value.id,
    decision: value.decision,
    tool: value.tool,
    arguments: typeof value.arguments === "object" && value.arguments !== null && !Array.isArray(value.arguments) ? value.arguments as Record<string, unknown> : {},
    confidence: value.confidence,
    reason: value.reason,
  };
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("no JSON object found in model output");
  }
  return trimmed.slice(start, end + 1);
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? null;
}

function selectLowestLatencyPassedCandidate(attempts: CliAttempt[]): CliAttempt | undefined {
  return [...attempts]
    .filter((attempt) => attempt.status === "passed" && attempt.subscriptionRouted)
    .sort((a, b) => (candidateP50LatencyMs(a) ?? Number.POSITIVE_INFINITY) - (candidateP50LatencyMs(b) ?? Number.POSITIVE_INFINITY))[0];
}

function candidateP50LatencyMs(attempt: CliAttempt): number | null {
  const latencies = attempt.invocations.length > 0
    ? attempt.invocations.map((invocation) => invocation.latencyMs)
    : [attempt.latencyMs];
  return percentile(latencies, 0.5);
}

function estimatedCostPerHourUsd(attempt: CliAttempt | undefined): number | null {
  if (attempt === undefined || attempt.status !== "passed") {
    return null;
  }
  // Host Codex/Claude subscription CLIs do not expose per-call metering to this
  // probe. Treating unmetered subscription access as $0/hr would make the live
  // $0.15/hr cost gate tautological, so the probe records this as unmeasured.
  return null;
}

function safeCheck(check: () => void): boolean {
  try {
    check();
    return true;
  } catch {
    return false;
  }
}

function buildBlockers(checks: HotLoopProbeVerdict["checks"], attempts: CliAttempt[]): string[] {
  const blockers: string[] = [];
  if (!attempts.some((attempt) => attempt.status === "passed" && attempt.subscriptionRouted)) {
    blockers.push("No host logged-in Codex/Claude CLI subscription candidate returned a usable decision response.");
  }
  if (!checks.deterministic) blockers.push("Temperature-0 determinism was not proven.");
  if (!checks.p50LatencyWithinBudget) blockers.push("No subscription-routed candidate met the 100 ms p50 hot-loop budget.");
  if (!checks.mappedActionToolSchema) blockers.push("MappedActionTool-compatible tool-selection schema was not proven.");
  if (!checks.noRawKeyRoute) blockers.push("Raw-key rejection assertion failed.");
  if (!checks.traceSecretClean) blockers.push("Probe trace or report contained a key-shaped string.");
  if (!checks.costWithinBudget) blockers.push("The $0.15/hr cost gate was not measured by the host subscription CLI probe.");
  if (!checks.actPromptAmendment) blockers.push("The ACT prompt amendment for named callsign status/information queries was not proven.");
  return blockers;
}

export function sanitizedSubscriptionCliEnv(baseEnv: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined || value.length === 0) {
      continue;
    }
    if (!SAFE_ENV_NAMES.has(key) && !key.startsWith("LC_")) {
      continue;
    }
    if (hasSecretLikeString(value, [key])) {
      continue;
    }
    env[key] = value;
  }
  env.NO_COLOR = "1";
  return env;
}

function isInvocationArray(value: CliInvocation[] | HotLoopToolCall[]): value is CliInvocation[] {
  return value.length > 0 && "decisions" in (value[0] as unknown as Record<string, unknown>);
}

function canonicalDecisions(decisions: HotLoopToolCall[]): Array<Pick<HotLoopToolCall, "id" | "decision" | "tool" | "arguments">> {
  return decisions.map((decision) => ({
    id: decision.id,
    decision: decision.decision,
    tool: decision.tool,
    arguments: decision.arguments,
  }));
}

function generatedOpenAiLikeKey(): string {
  return ["sk", "proj", "A".repeat(48)].join("-");
}

function generatedAnthropicLikeKey(): string {
  return ["sk", "ant", "B".repeat(48)].join("-");
}

function generatedBearerLikeToken(): string {
  return `Bearer ${"C".repeat(48)}`;
}

async function appendTrace(event: string, meta: unknown): Promise<void> {
  await writeFile(TRACE_PATH, formatTraceLine(event, meta) + "\n", { flag: "a" });
}

function formatTraceLine(event: string, meta: unknown): string {
  return JSON.stringify(redactForArtifact({
    event,
    ticketId: PROBE_ID,
    correlationId: "probe-hot-loop-llm-subscription",
    ts: new Date().toISOString(),
    meta,
  }));
}

async function prospectiveVerdictSecretScan(verdict: HotLoopProbeVerdict): Promise<boolean> {
  const cacheText = JSON.stringify(redactForArtifact(verdict), null, 2) + "\n";
  const verdictTraceLine = formatTraceLine("llm_probe.verdict", verdict) + "\n";
  const currentArtifactsClean = (await scanSecretLikeFiles(PROBE_ROOT)).passed && (await scanSecretLikeFiles(TRACE_ROOT)).passed;
  const pendingWritesClean = scanSecretLikeText(cacheText).length === 0 && scanSecretLikeText(verdictTraceLine).length === 0;
  return currentArtifactsClean && pendingWritesClean;
}

function redactForArtifact<T>(value: T): T {
  const redacted = redactSecretValues(value).value;
  return JSON.parse(JSON.stringify(redacted, (_key, entry) => {
    if (typeof entry === "string") {
      return preview(entry);
    }
    return entry;
  })) as T;
}

function summarizeCliError(stdout: string, stderr: string): string {
  const combined = `${stdout}\n${stderr}`;
  if (/credit balance is too low/iu.test(combined)) {
    return "Credit balance is too low";
  }
  if (/not supported/iu.test(combined)) {
    return "Requested model is not supported by this subscription";
  }
  if (/not logged in|login required|authentication/iu.test(combined)) {
    return "CLI subscription authentication failed";
  }
  return combined.trim() || "CLI exited without output";
}

function preview(text: string): string {
  return text.replace(/[^\S\n]+/gu, " ").trim().slice(0, 500);
}

async function readCachedVerdict(): Promise<HotLoopProbeVerdict | null> {
  try {
    return JSON.parse(await readFile(CACHE_PATH, "utf8")) as HotLoopProbeVerdict;
  } catch {
    return null;
  }
}
