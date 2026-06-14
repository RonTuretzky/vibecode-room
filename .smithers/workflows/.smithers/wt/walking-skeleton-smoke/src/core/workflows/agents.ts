import os from "node:os";
import path from "node:path";
import { ClaudeCodeAgent, CodexAgent } from "smithers-orchestrator";

export const codex = new CodexAgent({
  model: "gpt-5.5",
  configDir: path.join(os.homedir(), ".codex"),
  skipGitRepoCheck: true,
});

export const claude = new ClaudeCodeAgent({ model: "claude-opus-4-8" });

export const ioAgents = [codex, claude];
