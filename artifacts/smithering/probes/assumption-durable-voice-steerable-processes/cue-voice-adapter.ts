/**
 * cue-voice-adapter.ts
 *
 * Adapter: Cue observation → Smithers signal
 *
 * This file shows HOW voice steering connects to durable Smithers processes.
 * It cannot be executed without Cue installed from source (github:jameslbarnes/cue,
 * pnpm monorepo) — see probe evidence for that status.
 *
 * The pattern:
 *   room speech → Deepgram ASR → TranscriptObservation →
 *   Cue CueHarness → WordCue policy fires → MappedActionTool →
 *   smithersSignalAdapter → smithers signal <runId> steer --data '{"text":"..."}'
 */

// NOTE: These imports resolve only after `pnpm build` inside github:jameslbarnes/cue.
// They are typed here to document the API shape; they are not executed.
//
// import { CueHarness, ConversationState, DecisionHistory } from "@cue/core";
// import { WordCue, MappedActionTool, PassTool, ToolRegistry } from "@cue/core";

import { execSync } from "node:child_process";

// ─── Types (mirroring @cue/core shapes from GitHub README + source) ──────────

interface Observation {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  timestamp: number;
  source?: string;
}

interface ToolCall {
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
}

interface ToolResult {
  status: "ok" | "error";
  output?: Record<string, unknown>;
}

// ─── Active process registry ──────────────────────────────────────────────────

interface ActiveProcess {
  upid: string;
  callsign: string; // e.g. "atlas", "bravo", "cobalt"
  runId: string;
}

const registry = new Map<string, ActiveProcess>();

export function registerProcess(p: ActiveProcess): void {
  registry.set(p.callsign.toLowerCase(), p);
}

export function deregisterProcess(callsign: string): void {
  registry.delete(callsign.toLowerCase());
}

// ─── Signal delivery to Smithers ─────────────────────────────────────────────

interface SteerPayload {
  text: string;
  stop: boolean;
}

/**
 * Deliver a steer signal to a named Smithers run via CLI.
 * In production this would call the Smithers HTTP API directly.
 */
export function deliverSteerSignal(runId: string, payload: SteerPayload): {
  success: boolean;
  error?: string;
} {
  try {
    const data = JSON.stringify(payload);
    execSync(`smithers signal ${runId} steer --data '${data}'`, {
      encoding: "utf8",
      timeout: 5000,
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// ─── Cue MappedActionTool handler (what Cue calls when a magic word fires) ──

/**
 * This is the action mapper for the steer tool in Cue.
 * Called by Cue's harness when the LLM selects the "vibersyn.steer" tool.
 *
 * Cue API: new MappedActionTool(name, description, schema, eligibility, actionMapper)
 */
export async function steerActionMapper(
  call: ToolCall,
  _context: unknown
): Promise<ToolResult> {
  const { callsign, instruction, stop } = call.arguments as {
    callsign: string;
    instruction: string;
    stop?: boolean;
  };

  const process = registry.get(callsign.toLowerCase());
  if (!process) {
    return {
      status: "error",
      output: { reason: `No live process with callsign '${callsign}'` },
    };
  }

  const result = deliverSteerSignal(process.runId, {
    text: instruction,
    stop: stop ?? false,
  });

  return {
    status: result.success ? "ok" : "error",
    output: {
      runId: process.runId,
      callsign,
      instruction,
      stop: stop ?? false,
      error: result.error,
    },
  };
}

// ─── Cue configuration shape (what a CueHarness would look like) ─────────────

/**
 * Returns the Cue server config object for the voice steering layer.
 * This is DOCUMENTATION of the intended integration — not executable without @cue/core.
 *
 * In production, this config is passed to CueHarness (or CueServer from @cue/server).
 */
export function buildCueConfig() {
  return {
    // Transcription provider: Deepgram Nova-3 (via @cue/server DeepgramProvider)
    transcriptionProvider: "deepgram",

    // LLM provider: Cerebras Llama 3.3-70B (hot loop — cheap/fast)
    llmProvider: "cerebras",

    // Cue policies — the decision layer
    policies: [
      // Magic-word cue: fires when a process callsign appears in transcript
      {
        type: "WordCue",
        words: Array.from(registry.keys()), // dynamic: populated as processes spawn
        cooldownSeconds: 2,
        label: "magic-word",
      },
      // Suggestion cue: fires every N words for ambient suggestion engine
      {
        type: "WordCountCue",
        wordCount: 80,
        cooldownSeconds: 30,
        label: "suggestion",
      },
      // Idle cue: fires after silence for dead-man timer
      {
        type: "IdleCue",
        idleSeconds: 20,
        label: "steering-window-close",
      },
    ],

    // Programs — what the harness does when a cue fires
    programs: [
      {
        name: "steer-process",
        triggers: ["onCue:magic-word"],
        allowedTools: ["vibersyn.steer", "observe.pass"],
        prompt: {
          system: `You are the Vibersyn voice dispatcher.
When a magic word (callsign) is spoken, route the user's instruction to the right process.
Always use vibersyn.steer if there is an instruction; use observe.pass if it was just the callsign alone.`,
          userTemplate: "{{transcriptAttention}}",
        },
      },
    ],

    // Tools — the action surface
    tools: [
      {
        // vibersyn.steer: selected by LLM when magic word + instruction detected
        type: "MappedActionTool",
        name: "vibersyn.steer",
        description: "Deliver a steering instruction to a named Vibersyn process",
        schema: {
          type: "object",
          required: ["callsign", "instruction"],
          properties: {
            callsign: {
              type: "string",
              description: "The process callsign (e.g. atlas, bravo)",
            },
            instruction: {
              type: "string",
              description: "The natural-language steering instruction",
            },
            stop: {
              type: "boolean",
              description: "Set true to stop the process after this instruction",
            },
          },
        },
        // Points to steerActionMapper above
        handler: steerActionMapper,
      },
      {
        // observe.pass: first-class no-op — the common case
        type: "PassTool",
        name: "observe.pass",
      },
    ],
  };
}

// ─── Seam diagram (textual) ───────────────────────────────────────────────────

export const SEAM_DIAGRAM = `
Voice Steering Seam: Cue → Smithers
====================================

Room speech
  │
  ▼ (Deepgram WebSocket / @cue/server DeepgramProvider)
TranscriptObservation { text, isFinal, speaker, latencyMs }
  │
  ▼ (CueHarness.ingest)
WordCue policy ── matches callsign "atlas" in text
  │  fires Heartbeat { name: "magic-word", reason: "atlas" }
  ▼
Program "steer-process" runs
  │  LLM: Cerebras Llama 3.3-70B, temperature 0
  │  Prompt: recent transcript + steer tool schema
  ▼
MappedActionTool selected: vibersyn.steer { callsign: "atlas", instruction: "..." }
  │
  ▼ (steerActionMapper → deliverSteerSignal)
smithers signal <runId> steer --data '{"text":"...","stop":false}'
  │
  ▼ (Smithers engine: bridgeSignalResolve)
WaitForEvent in vibersyn-probe-process unblocks
  │
  ▼
Loop continues → Task records received instruction
  │
  ▼ (Cue JSONL: decisions.jsonl)
observe.pass or next cue fires on subsequent speech
`;
