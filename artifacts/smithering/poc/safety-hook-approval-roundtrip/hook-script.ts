#!/usr/bin/env bun
/**
 * hook-script.ts — Claude Code PreToolUse hook for the Vibersyn safety gate.
 *
 * This script runs as a subprocess called by Claude Code's PreToolUse hook mechanism
 * (configured in .claude/settings.json):
 *
 *   {
 *     "hooks": {
 *       "PreToolUse": [{"command": "bun run artifacts/smithering/poc/safety-hook-approval-roundtrip/hook-script.ts"}]
 *     }
 *   }
 *
 * Claude Code behavior:
 *   - Sends JSON to stdin: { session_id, hook_event_name, tool_name, tool_input, ... }
 *   - Reads stdout for optional JSON override
 *   - Exit 0 = allow tool; Exit 2 = block tool with message; Exit 1 = block (generic error)
 *
 * This hook:
 *   1. Reads the tool call from stdin
 *   2. Classifies the tool (read-safe vs mutating/unknown)
 *   3. Read-safe → exit 0 immediately (AC11.1: Safe mode stays autonomous)
 *   4. Mutating/unknown → sends approval request to the Vibersyn gate server
 *   5. Blocks until approved (exit 0), denied (exit 2), or dead-man timeout (exit 2)
 *
 * GATE_SERVER_URL env var: where the approval gate runs (default: http://127.0.0.1:7777)
 * SAFETY_MODE env var: "safe" (default) | "explicit" | "dangerous"
 * DEAD_MAN_TIMEOUT_MS env var: how long to wait before auto-deny (default: 25000)
 *
 * POC FINDING recorded in FINDINGS.md:
 *   - This hook only fires for Claude Code CLI agent (not AnthropicAgent SDK calls)
 *   - The tool_name in PreToolUse payload uses Claude Code's tool names (Bash, Write, Read, Edit)
 *     not Smithers' defineTool names. Mapping is required.
 *   - The hook process must complete within Claude Code's hook timeout (configurable).
 *   - Dead-man timer (25s default) should be < Claude Code's hook timeout.
 */

import { classifyToolCall } from "./shell-classifier.ts";

const GATE_SERVER_URL = process.env.GATE_SERVER_URL ?? "http://127.0.0.1:7777";
const SAFETY_MODE = (process.env.SAFETY_MODE ?? "safe") as "safe" | "explicit" | "dangerous";
const DEAD_MAN_TIMEOUT_MS = Number(process.env.DEAD_MAN_TIMEOUT_MS ?? "25000");

interface ClaudeCodeHookPayload {
  session_id: string;
  hook_event_name: "PreToolUse" | "PostToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response?: unknown;
  [key: string]: unknown;
}

/** Build a ≤15-word read-back from the tool call. */
function buildReadback(toolName: string, toolArgs: Record<string, unknown>): string {
  const name = toolName.toLowerCase();
  if (name === "bash" || name === "shell") {
    const cmd = String(toolArgs.cmd ?? toolArgs.command ?? "").slice(0, 50);
    return `About to run: ${cmd}. Say confirm to proceed.`;
  }
  if (name === "write" || name === "edit") {
    const path = String(toolArgs.path ?? "file").split("/").pop() ?? "file";
    return `About to write ${path}. Say confirm to proceed.`;
  }
  return `About to use ${toolName}. Say confirm to proceed.`;
}

async function requestApproval(
  toolName: string,
  toolArgs: Record<string, unknown>,
  readback: string,
): Promise<"approve" | "deny" | "timeout"> {
  // Register with the gate server
  let gateId: string;
  try {
    const res = await fetch(`${GATE_SERVER_URL}/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolName, toolArgs, readback }),
    });
    const data = (await res.json()) as { gateId: string };
    gateId = data.gateId;
  } catch (err) {
    // Gate server unavailable — deny by default (fail-closed)
    process.stderr.write(`[vibersyn-hook] gate server unavailable: ${err}\n`);
    return "deny";
  }

  // Output the readback to stderr (visible in the agent's trace)
  process.stderr.write(`[vibersyn-hook] BLOCKED gateId=${gateId}: ${readback}\n`);

  // Long-poll for decision with dead-man timer
  const deadline = Date.now() + DEAD_MAN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const pollTimeout = Math.min(remaining, 3_000);

    try {
      const res = await fetch(`${GATE_SERVER_URL}/poll/${gateId}`, {
        signal: AbortSignal.timeout(pollTimeout + 500),
      });
      const data = (await res.json()) as { decision: string };
      if (data.decision === "approve") return "approve";
      if (data.decision === "deny") return "deny";
      if (data.decision === "timeout") return "timeout";
      if (data.decision === "unknown") return "deny"; // fail-closed
      // "pending" or other → loop again
    } catch {
      // Network error during poll — continue looping until deadline
    }
  }

  // Dead-man timer fired — resolve to deny
  process.stderr.write(`[vibersyn-hook] dead-man timer fired gateId=${gateId} → deny\n`);
  try {
    await fetch(`${GATE_SERVER_URL}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gateId, decision: "timeout" }),
    });
  } catch {
    // Best effort
  }
  return "timeout";
}

async function main(): Promise<void> {
  // Read the tool call payload from stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();

  let payload: ClaudeCodeHookPayload;
  try {
    payload = JSON.parse(raw) as ClaudeCodeHookPayload;
  } catch {
    // Can't parse → deny (fail-closed)
    process.stderr.write(`[vibersyn-hook] could not parse stdin: ${raw}\n`);
    process.exit(2);
  }

  const { tool_name: toolName, tool_input: toolArgs } = payload;

  // Dangerous mode → allow everything (gate bypassed)
  if (SAFETY_MODE === "dangerous") {
    process.stderr.write(`[vibersyn-hook] DANGEROUS mode — allowing ${toolName}\n`);
    process.exit(0);
  }

  // Classify the tool call
  const classification = classifyToolCall(toolName, toolArgs ?? {});

  // Explicit mode → gate every tool, even read-safe
  if (SAFETY_MODE === "explicit") {
    process.stderr.write(`[vibersyn-hook] EXPLICIT mode — gating ${toolName} (${classification.reason})\n`);
    const readback = buildReadback(toolName, toolArgs ?? {});
    const decision = await requestApproval(toolName, toolArgs ?? {}, readback);
    if (decision === "approve") {
      process.stderr.write(`[vibersyn-hook] approved ${toolName}\n`);
      process.exit(0);
    } else {
      // Write block message to stdout (Claude Code reads it)
      process.stdout.write(JSON.stringify({ type: "block", message: `Vibersyn safety gate: ${decision} — ${toolName} was not approved.` }));
      process.exit(2);
    }
  }

  // Safe mode (default) — only gate mutating/unknown
  if (!classification.gated) {
    // Read-safe → allow without prompting (AC11.1: Safe stays autonomous)
    process.exit(0);
  }

  // Mutating or unknown → request approval
  const readback = buildReadback(toolName, toolArgs ?? {});
  const decision = await requestApproval(toolName, toolArgs ?? {}, readback);

  if (decision === "approve") {
    process.stderr.write(`[vibersyn-hook] approved ${toolName}\n`);
    process.exit(0);
  } else {
    process.stdout.write(JSON.stringify({
      type: "block",
      message: `Vibersyn safety gate: ${decision} — ${toolName} was not approved within ${DEAD_MAN_TIMEOUT_MS}ms.`,
    }));
    process.exit(2);
  }
}

main().catch((err) => {
  process.stderr.write(`[vibersyn-hook] fatal: ${err}\n`);
  process.exit(2);
});
