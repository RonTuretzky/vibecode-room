import { OpenCodeAgent as SmithersOpenCodeAgent } from "smithers-orchestrator";

// Built-in OpenCode CLI agent (cliEngine: "opencode").
// Tweak `model`, `cwd`, or uncomment extra options below to match your setup.
export const OpenCodeAgent = new SmithersOpenCodeAgent({
  model: "anthropic/claude-sonnet-4-5",
  cwd: process.cwd(),
  // agentName: "build",
  // systemPrompt: "Add shared instructions for every OpenCode run.",
  // yolo: true,
});
