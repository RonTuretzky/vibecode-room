// The research agents' STAND-IN seam (ROUND 2 root-cause fix).
//
// The sky relate tick and the topic refiner both ride ONE Cerebras account —
// and when that account dies (the live room's 402: quota exhausted, verified
// with real calls), the operator's "recurring reorganizer" has NO other way to
// speak. Loudness (miss streaks, /api/health legs) made the failure visible;
// this module makes it survivable: the room already trusts the host's
// logged-in `claude` CLI for genuine inference with no API key (the
// VIBERSYN_DECISION_LLM="claude-cli" seam, providers/llm/host-claude.ts), so
// the same subscription stands in for a FAILING Cerebras call.
//
// The rules are deliberate:
//   • No key configured → still a clean no-agent no-op (null). Tests, CI, and
//     offline rooms must never spawn a surprise CLI process.
//   • A key that FAILS (402/401/timeout/bad payload) means the operator WANTS
//     the agent and billing/transport is broken — the stand-in answers, and
//     the rescue is never silent: the wrapper carries `standinFor` (the
//     primary's failure reason) so the graph traces it and stamps provenance.
//   • Explicit pin: VIBERSYN_RESEARCH_LLM=cerebras (never stand in — the old
//     loud-miss behavior, byte for byte) or =claude-cli (host subscription
//     only, no key needed). Default "auto" = primary first, stand-in on
//     failure when the CLI exists.

export type ResearchAgentMode = "auto" | "cerebras" | "claude-cli";

export const CEREBRAS_AGENT = "cerebras";
export const HOST_CLAUDE_AGENT = "host-claude";

// Fast + cheap — the relate/refine replies are small strict-JSON edits, the
// same class of call the claude-cli decision seam makes (host-claude.ts).
export const STANDIN_MODEL = "haiku";
// Cold CLI boot is ~14s on the rig, warm ~3s; the callers' bounded-call
// budgets are sized to cover this (sky.ts / tree.ts DEFAULT timeouts).
export const STANDIN_TIMEOUT_MS = 25_000;

// VIBERSYN_RESEARCH_LLM — transport for the recurrent research agents (sky
// relate + topic refiner). Unset/"auto" is the default; unknown values throw
// (registry.ts idiom: an explicit knob must never silently misroute).
export function readResearchAgentMode(env: Record<string, string | undefined> = process.env): ResearchAgentMode {
  const raw = env.VIBERSYN_RESEARCH_LLM?.trim().toLowerCase();
  if (raw === undefined || raw === "" || raw === "auto") {
    return "auto";
  }
  if (raw === "cerebras" || raw === "claude-cli") {
    return raw;
  }
  throw new Error(
    `Unknown VIBERSYN_RESEARCH_LLM "${env.VIBERSYN_RESEARCH_LLM}". Expected one of: auto, cerebras, claude-cli.`,
  );
}

// Is the host `claude` CLI on PATH? Checked per call (cheap PATH stat) so a
// CLI installed mid-session is picked up without a reboot.
export function hostClaudeAvailable(): boolean {
  return Bun.which("claude") !== null;
}

// The reply wrapper: which agent actually spoke, and — when the stand-in
// rescued the tick — WHY the primary could not. `kind` is the discriminant so
// scripted runners returning plain strings/objects are never misread.
export interface AgentReply {
  kind: "agent-reply";
  agent: string;
  standinFor: string | null;
  reply: unknown;
}

export function isAgentReply(value: unknown): value is AgentReply {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { kind?: unknown }).kind === "agent-reply" &&
    typeof (value as { agent?: unknown }).agent === "string" &&
    "reply" in value
  );
}

// Unwrap for consumers: plain values (scripted test runners, direct runners)
// pass through with no provenance claim.
export function unwrapAgentReply(value: unknown): { agent: string | null; standinFor: string | null; reply: unknown } {
  if (isAgentReply(value)) {
    return { agent: value.agent, standinFor: value.standinFor, reply: value.reply };
  }
  return { agent: null, standinFor: null, reply: value };
}

export type StandInCall = (
  prompt: string,
  opts: { model: string; timeoutMs: number; signal: AbortSignal },
) => Promise<string>;

export interface ComposeAgentRunnerOptions<TRequest> {
  /** The primary transport (Cerebras). Resolving null = no key configured. */
  primary: (request: TRequest, signal: AbortSignal) => Promise<unknown>;
  /** Full prompt (system + serialized request) for the CLI stand-in. */
  promptFor: (request: TRequest) => string;
  /** Injection seams — tests never touch env, PATH, or a real CLI. */
  env?: () => Record<string, string | undefined>;
  cliAvailable?: () => boolean;
  standIn?: StandInCall;
}

// Compose the production runner: Cerebras first, host-claude stand-in on
// failure. Returns null for the deliberate no-agent config, an AgentReply
// wrapper on success, and THROWS (reason intact, both reasons when both legs
// failed) so the callers' bounded-call wrappers keep their loudness contract.
export function composeAgentRunner<TRequest>(
  options: ComposeAgentRunnerOptions<TRequest>,
): (request: TRequest, signal: AbortSignal) => Promise<unknown> {
  return async (request, signal) => {
    const env = options.env?.() ?? process.env;
    const mode = readResearchAgentMode(env);
    const cliAvailable = options.cliAvailable ?? hostClaudeAvailable;
    const standIn = options.standIn ?? hostClaudeComplete;
    const hasKey = (env.CEREBRAS_API_KEY ?? "").trim().length > 0;

    if (mode === "claude-cli") {
      const reply = await standIn(options.promptFor(request), {
        model: STANDIN_MODEL,
        timeoutMs: STANDIN_TIMEOUT_MS,
        signal,
      });
      return { kind: "agent-reply", agent: HOST_CLAUDE_AGENT, standinFor: null, reply } satisfies AgentReply;
    }
    if (!hasKey) {
      // Deliberate no-agent config — the lexical/heuristic surfaces stand,
      // honestly unstamped. Never a surprise CLI spawn.
      return null;
    }
    try {
      const reply = await options.primary(request, signal);
      if (reply === null || reply === undefined) {
        return null;
      }
      return { kind: "agent-reply", agent: CEREBRAS_AGENT, standinFor: null, reply } satisfies AgentReply;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (mode === "cerebras" || signal.aborted || !cliAvailable()) {
        throw error; // pinned, out of budget, or no CLI — the loud miss stands
      }
      try {
        const reply = await standIn(options.promptFor(request), {
          model: STANDIN_MODEL,
          timeoutMs: STANDIN_TIMEOUT_MS,
          signal,
        });
        return { kind: "agent-reply", agent: HOST_CLAUDE_AGENT, standinFor: reason, reply } satisfies AgentReply;
      } catch (standInError) {
        const standInReason = standInError instanceof Error ? standInError.message : String(standInError);
        throw new Error(`${reason}; host-claude: ${standInReason}`);
      }
    }
  };
}

// One bounded host-CLI completion (defaultClaudeCliRunner idiom,
// providers/llm/host-claude.ts — print mode, JSON envelope, no tools). Loud:
// every failure mode throws with its cause; the model's raw text reply comes
// back for the caller's own tolerant parse (parseLooseJson strips fences).
export const hostClaudeComplete: StandInCall = async (prompt, { model, timeoutMs, signal }) => {
  const proc = Bun.spawn(
    ["claude", "-p", prompt, "--model", model, "--output-format", "json", "--dangerously-skip-permissions"],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  const kill = () => proc.kill();
  const timer = setTimeout(kill, timeoutMs);
  signal.addEventListener("abort", kill, { once: true });
  try {
    const [out, err, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`host-claude exit ${exitCode}: ${(err.trim() || out.trim()).slice(0, 120)}`);
    }
    return parseCliEnvelope(out);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", kill);
  }
};

// Unwrap the CLI's --output-format json envelope to the model's text reply.
// Exported pure so the envelope contract is unit-testable without a spawn.
export function parseCliEnvelope(out: string): string {
  let envelope: unknown;
  try {
    envelope = JSON.parse(out);
  } catch {
    throw new Error(`host-claude envelope: not JSON (${out.trim().slice(0, 80)})`);
  }
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    throw new Error("host-claude envelope: not an object");
  }
  const record = envelope as Record<string, unknown>;
  if (typeof record.result !== "string") {
    throw new Error(`host-claude envelope: no result string (subtype ${String(record.subtype ?? "?")})`);
  }
  if (record.is_error === true) {
    throw new Error(`host-claude error: ${record.result.slice(0, 120)}`);
  }
  return record.result;
}
