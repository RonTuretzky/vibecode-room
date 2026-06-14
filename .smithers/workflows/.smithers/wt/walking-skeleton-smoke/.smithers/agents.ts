// smithers-source: generated
// Account providers (camelCase labels) come from ~/.smithers/accounts.json — managed via `smithers agent add|list|remove`.
import { homedir } from "node:os";
import path from "node:path";
import { type AgentLike, PiAgent as SmithersPiAgent, KimiAgent as SmithersKimiAgent, AmpAgent as SmithersAmpAgent, ClaudeCodeAgent as SmithersClaudeCodeAgent, CodexAgent as SmithersCodexAgent, GeminiAgent as SmithersGeminiAgent } from "smithers-orchestrator";
import { ClaudeCodeAgent } from "./agents/claude-code";
import { CodexAgent } from "./agents/codex";
import { OpenCodeAgent } from "./agents/opencode";

export { ClaudeCodeAgent } from "./agents/claude-code";
export { CodexAgent } from "./agents/codex";
export { OpenCodeAgent } from "./agents/opencode";

// The app being built (Panopticon) is the PARENT of this .smithers/ dev pack.
// Dev-workflow coding agents must operate HERE so they edit the app source —
// NOT inside .smithers/ (which is dev tooling only; never mix the two).
// `cwd: process.cwd()` resolves to .smithers/ when launched via `smithers up`,
// so app-editing agents must pin cwd to APP_ROOT explicitly.
const APP_ROOT = path.resolve(import.meta.dir, "..");

export const providers = {
  claude: ClaudeCodeAgent,
  codex: CodexAgent,
  opencode: OpenCodeAgent,
  pi: new SmithersPiAgent({ provider: "openai", model: "gpt-5.3-codex" }),
  kimi: new SmithersKimiAgent({ model: "kimi-latest" }),
  amp: new SmithersAmpAgent(),
  claudeSonnet: new SmithersClaudeCodeAgent({ model: "claude-sonnet-4-7", cwd: process.cwd() }),
  kimi1: new SmithersKimiAgent({ model: "kimi-latest", configDir: path.join(homedir(), ".smithers/accounts/kimi-1"), cwd: process.cwd() }),
  codex1: new SmithersCodexAgent({ model: "gpt-5.3-codex", configDir: path.join(homedir(), ".codex"), skipGitRepoCheck: true, cwd: process.cwd() }),
  gemini1: new SmithersGeminiAgent({ model: "gemini-3.1-pro-preview", configDir: path.join(homedir(), ".gemini"), cwd: process.cwd() }),

  // App-editing agents: working subscriptions (codex-1, gemini-1) pinned to APP_ROOT.
  // Use these for any dev workflow that builds Panopticon's source.
  // NOTE: codex-1 is a ChatGPT account — it rejects "gpt-5.3-codex"; use the
  // account's supported model "gpt-5.5" (the default in ~/.codex/config.toml).
  codexApp: new SmithersCodexAgent({ model: "gpt-5.5", configDir: path.join(homedir(), ".codex"), skipGitRepoCheck: true, cwd: APP_ROOT }),
  geminiApp: new SmithersGeminiAgent({ model: "gemini-3.1-pro-preview", configDir: path.join(homedir(), ".gemini"), cwd: APP_ROOT }),
  // Claude Code (subscription via the `claude` CLI) pinned to APP_ROOT. Used as the
  // INDEPENDENT reviewer (implementer = codex), per user direction "use codex and claude".
  claudeApp: new SmithersClaudeCodeAgent({ model: "claude-opus-4-8", cwd: APP_ROOT }),
} as const;

export const agents = {
  // Working subscriptions only: codex-1 (gpt-5.5) and claude (Claude Code, opus-4-8),
  // both pinned to APP_ROOT so dev workflows edit the app source, not .smithers/.
  // gemini-1 is OMITTED (quota exhausted — it hangs in a capacity-retry loop) and
  // kimi-1 is OMITTED (OAuth expired; run `kimi login` to revive). Re-add when healthy.
  cheapFast: [providers.codexApp, providers.claudeApp],
  smart: [providers.codexApp, providers.claudeApp],
  smartTool: [providers.codexApp, providers.claudeApp],
} as const satisfies Record<string, AgentLike[]>;
