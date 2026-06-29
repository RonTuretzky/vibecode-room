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

export type SmithersClientMode = "memory" | "gateway";

export type DegradedLegName = "asr" | "tts" | "sink" | "decider" | "smithers";

// The resolved backend mode of each runtime leg the notice reasons about.
export interface RuntimeLegSelections {
  asr: AsrProviderMode;
  tts: TtsProviderMode;
  sink: AudioSinkMode;
  decider: DecisionLLMMode;
  smithers: SmithersClientMode;
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
      detail: "in-memory Smithers client — spawns are fixtures, not durable runs",
      upgrade: "set VIBERSYN_SMITHERS_GATEWAY_URL",
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
export function healthPayload(rt: { degradation: DegradationNotice }): {
  ok: true;
  app: "vibersyn-projector";
  degradation: DegradationNotice;
} {
  return { ok: true, app: "vibersyn-projector", degradation: rt.degradation };
}
