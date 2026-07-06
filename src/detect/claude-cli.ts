// Spawns the host's logged-in `claude` CLI in print mode and unwraps its JSON
// envelope to the model's text reply. No API key needed — it uses the host
// subscription. Injectable everywhere so tests never shell out. Mirrors the
// runner in providers/llm/host-claude.ts, kept separate so the detection layer
// has no dependency on the legacy DecisionLLM path.
export interface ClaudeCliOptions {
  model: string;
  timeoutMs: number;
}

export type ClaudeCliRunner = (prompt: string, opts: ClaudeCliOptions) => Promise<string>;

export const defaultClaudeCliRunner: ClaudeCliRunner = async (prompt, { model, timeoutMs }) => {
  const proc = Bun.spawn(
    ["claude", "-p", prompt, "--model", model, "--output-format", "json", "--dangerously-skip-permissions"],
    { stdout: "pipe", stderr: "ignore", stdin: "ignore" },
  );
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const out = await new Response(proc.stdout).text();
    try {
      const envelope: unknown = JSON.parse(out);
      if (isRecord(envelope) && typeof envelope.result === "string") {
        return envelope.result;
      }
    } catch {
      // Not the JSON envelope — return the raw text and let the caller parse.
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
