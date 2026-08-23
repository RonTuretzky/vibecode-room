// Structured startup degradation notice (ISSUE-0003 / GAP-002).
//
// Every leg of the runtime has a real and a degraded (stubbed/offline) backend.
// This module turns the *resolved* per-leg selections into a structured notice
// that (a) is logged once at boot and (b) is surfaced on /api/health, so a
// degraded deployment is explicitly accepted and documented rather than silently
// pretending every leg is live. The builder is a pure function of the selections
// so it is unit-testable without booting the server.

import type { AsrProviderMode, DecisionLLMMode, TtsProviderMode } from "../providers";
import type { AudioSinkMode } from "./audio-device-sink";
import type { SummarizerMode } from "../audio/summarizer";

export type SmithersClientMode = "memory" | "gateway";

export type DegradedLegName =
  | "asr"
  | "tts"
  | "sink"
  | "decider"
  | "smithers"
  | "summarizer"
  | "sky-relate"
  | "topic-refiner";

// The recurrent Cerebras agents' RUNTIME failure surface (CloudGraph.agentHealth
// / ConceptTree.agentHealth shape, structurally typed so this module stays free
// of runtime imports). Unlike the boot-time leg selections these degrade and
// recover DYNAMICALLY: a persistent miss streak (e.g. the silent HTTP 402 that
// starved the sky for 77 consecutive ticks) grows a leg, a landed tick drops it.
export interface AgentTickHealth {
  missStreak: number;
  lastMissReason: string | null;
}

// Misses this many consecutive ticks → the leg reports degraded.
export const AGENT_MISS_DEGRADED_STREAK = 3;

// Pure: dynamic degraded legs for the sky relate + topic refiner agents.
export function agentTickLegs(health: {
  skyRelate?: AgentTickHealth;
  topicRefiner?: AgentTickHealth;
}): DegradedLeg[] {
  const legs: DegradedLeg[] = [];
  const sky = health.skyRelate;
  if (sky !== undefined && sky.missStreak >= AGENT_MISS_DEGRADED_STREAK) {
    legs.push({
      leg: "sky-relate",
      mode: "miss-streak",
      detail: `sky relate: ${sky.missStreak} consecutive misses (${sky.lastMissReason ?? "unknown"})`,
      upgrade: "top up Cerebras billing / check CEREBRAS_API_KEY (CEREBRAS_MODEL optional)",
    });
  }
  const refiner = health.topicRefiner;
  if (refiner !== undefined && refiner.missStreak >= AGENT_MISS_DEGRADED_STREAK) {
    legs.push({
      leg: "topic-refiner",
      mode: "miss-streak",
      detail: `topic refiner: ${refiner.missStreak} consecutive misses (${refiner.lastMissReason ?? "unknown"})`,
      upgrade: "top up Cerebras billing / check CEREBRAS_API_KEY (CEREBRAS_MODEL optional)",
    });
  }
  return legs;
}

// The resolved backend mode of each runtime leg the notice reasons about.
export interface RuntimeLegSelections {
  asr: AsrProviderMode;
  tts: TtsProviderMode;
  sink: AudioSinkMode;
  decider: DecisionLLMMode;
  smithers: SmithersClientMode;
  // The hot-loop ">15 words -> summarize" guard's summarizer leg (output-policy.ts:67
  // via src/audio/summarizer.ts's selectSummarizer). "deterministic" is a real,
  // never-wedges fallback but is NOT a model-quality summary — it's a word-clamp
  // truncation, so it counts as degraded the same way the heuristic decider does.
  // ABSENT (undefined) means the caller never wired a summarizer selection at
  // all (the audit's original state) — that is ALSO degraded, so /api/health can
  // never claim allReal while the leg is stubbed OR unwired.
  summarizer?: SummarizerMode;
}

export interface DegradedLeg {
  leg: DegradedLegName;
  mode: string;
  detail: string;
  // The env var / action that upgrades this leg to its real backend.
  upgrade: string;
}

export interface DegradationNotice {
  degraded: DegradedLeg[];
  allReal: boolean;
}

// Pure: which legs are running a stubbed/offline backend, and how to upgrade each.
export function buildDegradationNotice(selections: RuntimeLegSelections): DegradationNotice {
  const degraded: DegradedLeg[] = [];

  if (selections.asr === "replay") {
    degraded.push({
      leg: "asr",
      mode: selections.asr,
      detail: "replay ASR — no live transcription",
      upgrade: "set DEEPGRAM_API_KEY (or VIBERSYN_ASR_PROVIDER=voxterm)",
    });
  }
  if (selections.tts === "noop") {
    degraded.push({
      leg: "tts",
      mode: selections.tts,
      detail: "silent TTS — no spoken output",
      upgrade: "set VIBERSYN_TTS_PROVIDER=elevenlabs (+ ELEVENLABS_API_KEY)",
    });
  }
  if (selections.sink === "noop") {
    degraded.push({
      leg: "sink",
      mode: selections.sink,
      detail: "no-op audio sink — synthesized audio is discarded",
      upgrade: "set VIBERSYN_AUDIO_SINK=device",
    });
  }
  if (selections.decider === "heuristic" || selections.decider === "replay") {
    degraded.push({
      leg: "decider",
      mode: selections.decider,
      detail: "heuristic DecisionLLM — no model-quality suggestion decisions",
      upgrade: "log into the host Claude subscription / set ANTHROPIC_API_KEY (or VIBERSYN_DECISION_LLM=claude)",
    });
  }
  if (selections.smithers === "memory") {
    degraded.push({
      leg: "smithers",
      mode: selections.smithers,
      detail: "in-memory Smithers client — spawns are fixtures and run telemetry is fake, not durable runs",
      upgrade: "set VIBERSYN_SMITHERS_GATEWAY_URL",
    });
  }
  if (selections.summarizer === undefined) {
    degraded.push({
      leg: "summarizer",
      mode: "unwired",
      detail: "no summarizer selection wired — overlong hot-loop updates fall through to the mid-sentence clamp",
      upgrade: "wire selectSummarizer(env) from src/audio/summarizer.ts into composition",
    });
  } else if (selections.summarizer === "deterministic") {
    degraded.push({
      leg: "summarizer",
      mode: selections.summarizer,
      detail: "deterministic word-clamp summarizer — overlong hot-loop updates are truncated, not model-summarized",
      upgrade: "set CEREBRAS_API_KEY (or VIBERSYN_SUMMARIZER=cerebras)",
    });
  }

  return { degraded, allReal: degraded.length === 0 };
}

// A human-readable, multi-line boot log. Returns a single "all real" line when
// nothing is degraded so the boot log always says something explicit.
export function formatDegradationNotice(notice: DegradationNotice): string {
  if (notice.allReal) {
    return "Vibersyn runtime: all legs running real backends — no degradation.";
  }
  const count = notice.degraded.length;
  const header = `Vibersyn runtime degraded — ${count} leg${count === 1 ? "" : "s"} stubbed:`;
  const lines = notice.degraded.map((d) => `  • ${d.leg} (${d.mode}): ${d.detail} → ${d.upgrade}`);
  return [header, ...lines].join("\n");
}

// Pure /api/health payload — exposes the same degradation flags the boot notice
// logs, so a degraded deployment is inspectable over HTTP. Typed structurally so
// this module stays free of any runtime/server import (and side effects).
// SELF-HOSTING MODE additions: `bootId` is the runtime's stable per-boot id (a
// wall that reconnects and sees a DIFFERENT bootId is talking to a new build of
// the server and reloads itself); `selfMode` says whether VIBERSYN_SELF_MODE
// pinned the mirror project. Both are tolerant of legacy callers (null/false).
// AGENT LOUDNESS additions: optional `skyAgent`/`topicRefiner` runtime health —
// when a recurrent Cerebras agent has missed AGENT_MISS_DEGRADED_STREAK
// consecutive ticks, the payload's degradation grows a DYNAMIC leg (and drops
// it again after a landed tick), so a silent permanent relate failure is
// impossible. Tolerant of legacy callers (absent = no dynamic legs).
export function healthPayload(rt: {
  degradation: DegradationNotice;
  bootId?: string;
  selfMode?: boolean;
  skyAgent?: AgentTickHealth;
  topicRefiner?: AgentTickHealth;
}): {
  ok: true;
  app: "vibersyn-projector";
  degradation: DegradationNotice;
  bootId: string | null;
  selfMode: boolean;
} {
  const dynamic = agentTickLegs({ skyRelate: rt.skyAgent, topicRefiner: rt.topicRefiner });
  const degradation =
    dynamic.length === 0
      ? rt.degradation
      : { degraded: [...rt.degradation.degraded, ...dynamic], allReal: false };
  return {
    ok: true,
    app: "vibersyn-projector",
    degradation,
    bootId: rt.bootId ?? null,
    selfMode: rt.selfMode === true,
  };
}
