#!/usr/bin/env bun
// CLI entrypoint for the ENG-T-02 record-replay harness (src/replay/harness.ts).
//
// Loads a transcript-observation JSONL file (fixtures/asr/*.jsonl works), drives
// the replay harness against a fresh no-key composition (SuggestionEngine +
// HeuristicDecisionLLM — no network, no credentials, temperature 0), prints the
// structured trace and per-observation decisions, and proves determinism by
// running the same stream twice and byte-comparing the canonical JSONL output.
//
// Usage:
//   bun scripts/replay-harness.ts [observations.jsonl] [--jsonl] [--quiet]
//
//   observations.jsonl  Transcript observation JSONL (default:
//                       fixtures/asr/nova3-observations.jsonl). Each line must
//                       match transcriptObservationSchema in src/types.ts.
//   --jsonl             Also print the canonical replay decision stream (one
//                       canonical-JSON record per line) to stdout.
//   --quiet             Suppress per-decision trace lines; print summary only.

import { resolve } from "node:path";
import {
  runReplayHarness,
  type DecisionInput,
  type DecisionLLM,
  type ReplayTraceEvent,
} from "../src/replay/harness";
import { HeuristicDecisionLLM } from "../src/providers/llm/heuristic";
import { SuggestionEngine, type SuggestionEngineDecision } from "../src/suggest/engine";

const DEFAULT_FIXTURE = "fixtures/asr/nova3-observations.jsonl";

function usage(): string {
  return [
    "Usage: bun scripts/replay-harness.ts [observations.jsonl] [--jsonl] [--quiet]",
    "",
    "Replays a transcript-observation JSONL through the deterministic replay",
    "harness (src/replay/harness.ts) wired to a fresh SuggestionEngine +",
    "HeuristicDecisionLLM composition (no network, no keys, temperature 0).",
    "",
    `  observations.jsonl  path to JSONL (default: ${DEFAULT_FIXTURE})`,
    "  --jsonl             also emit the canonical decision stream JSONL to stdout",
    "  --quiet             summary only, no per-decision lines",
    "  -h, --help          show this help",
  ].join("\n");
}

// Fresh composition per run: a real SuggestionEngine driven by the no-key
// heuristic decider, with a fixed clock + sequential id factory so replays are
// byte-identical (mirrors test/e2e/heuristic-decision.e2e.ts wiring).
function freshComposition(): DecisionLLM<SuggestionEngineDecision> {
  let nextId = 0;
  const engine = new SuggestionEngine({
    sessionId: "replay-cli",
    llm: new HeuristicDecisionLLM(),
    env: {
      VIBERSYN_SUGGEST_WORD_FLOOR: "3",
      VIBERSYN_SUGGEST_INTERRUPT_RECENCY_WEIGHT: "0",
      VIBERSYN_SUGGEST_INTERRUPT_VELOCITY_WEIGHT: "0",
      VIBERSYN_SUGGEST_INTERRUPT_PENDING_STEERING_WEIGHT: "0",
    },
    clock: () => 1_000,
    idFactory: () => `replay-cli-${nextId++}`,
  });

  return {
    decide(input: DecisionInput): Promise<SuggestionEngineDecision> {
      return engine.observe({
        observation: input.observation,
        correlationId: `corr-${input.observation.utteranceId}`,
      });
    },
  };
}

function describeDecision(decision: SuggestionEngineDecision): string {
  switch (decision.kind) {
    case "pass":
      return `pass (${decision.reason})`;
    case "queued":
      return `queued (${decision.reason}) pitch=${JSON.stringify(decision.queued.suggestion.pitch)}`;
    case "fired":
      return `fired pitch=${JSON.stringify(decision.suggestion.pitch)} mcqs=${decision.suggestion.mcqs.length}`;
    case "expired":
      return `expired suggestionId=${decision.suggestion.suggestion.suggestionId}`;
    case "idle":
      return "idle";
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    console.log(usage());
    return 0;
  }

  const emitJsonl = args.includes("--jsonl");
  const quiet = args.includes("--quiet");
  const positional = args.filter((arg) => !arg.startsWith("-"));
  if (positional.length > 1) {
    console.error(`Unexpected extra arguments: ${positional.slice(1).join(" ")}\n\n${usage()}`);
    return 1;
  }
  const jsonlPath = resolve(import.meta.dir, "..", positional[0] ?? DEFAULT_FIXTURE);

  const trace: ReplayTraceEvent[] = [];
  const result = await runReplayHarness(jsonlPath, freshComposition(), {
    trace: (event) => trace.push(event),
  });

  console.log(`replay-harness: ${jsonlPath}`);
  console.log(`observations: ${result.records.length}`);

  if (!quiet) {
    for (const [index, record] of result.records.entries()) {
      const observation = record.observation;
      console.log(
        `  [${index}] ${observation.utteranceId} final=${observation.isFinal} ` +
          `text=${JSON.stringify(observation.text)}`,
      );
      console.log(
        `      decision: ${describeDecision(record.output)} ` +
          `cacheHit=${record.cacheHit} ioHash=${record.ioHash.slice(0, 16)}`,
      );
    }
    console.log("trace events:");
    for (const event of trace) {
      console.log(`  ${JSON.stringify(event)}`);
    }
  }

  // Determinism proof: a second fresh composition over the same JSONL must
  // reproduce the decision stream byte-for-byte (the harness's core contract).
  const second = await runReplayHarness(jsonlPath, freshComposition());
  const identical = second.jsonl === result.jsonl;
  console.log(`determinism check (2 fresh runs, byte-identical jsonl): ${identical ? "PASS" : "FAIL"}`);

  if (emitJsonl) {
    console.log("--- decision stream jsonl ---");
    if (result.jsonl.length > 0) {
      console.log(result.jsonl);
    }
  }

  return identical ? 0 : 1;
}

process.exit(await main());
