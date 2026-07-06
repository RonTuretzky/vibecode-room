import type { AckId, EarconId } from "../types";
import type { EarconEmission, EarconSink } from "../cue/adapter";

export const DEFAULT_EARCON_SAMPLE_RATE_HZ = envNumber("VIBERSYN_EARCON_SAMPLE_RATE_HZ", 24_000);
export const DEFAULT_EARCON_VOLUME = envNumber("VIBERSYN_EARCON_VOLUME", 0.18);
export const DEFAULT_EARCON_MAX_LATENCY_MS = envNumber("VIBERSYN_EARCON_MAX_LATENCY_MS", 300);

export interface PcmClip {
  id: EarconId | AckId;
  layer: "A" | "B";
  kind: "tonal-earcon" | "non-tonal-ack";
  sampleRateHz: number;
  channels: 1;
  pcm: Int16Array;
  durationMs: number;
}

export interface AudioDispatchMeta {
  correlationId?: string;
  source?: string;
  emittedAtMs?: number;
}

export interface AudioOutput {
  playPcm(clip: PcmClip, meta?: AudioDispatchMeta): void | Promise<void>;
}

export interface EarconSinkOptions {
  now?: () => number;
  maxLatencyMs?: number;
}

interface ToneSegment {
  frequencyHz: number;
  durationMs: number;
}

interface EarconSpec {
  id: EarconId;
  label: string;
  tones: readonly ToneSegment[];
  interToneGapMs?: number;
}

interface AckSpec {
  id: AckId;
  label: string;
  pattern: "whoosh" | "tick-tick" | "declined-tick" | "pulse";
}

export const EARCON_SPECS: Readonly<Record<EarconId, EarconSpec>> = {
  E1: {
    id: "E1",
    label: "ready cue",
    tones: [
      { frequencyHz: 523.25, durationMs: 90 },
      { frequencyHz: 587.33, durationMs: 120 },
    ],
    interToneGapMs: 6,
  },
  E2: {
    id: "E2",
    label: "unmuted cue",
    tones: [
      { frequencyHz: 440.0, durationMs: 80 },
      { frequencyHz: 493.88, durationMs: 90 },
      { frequencyHz: 523.25, durationMs: 110 },
    ],
    interToneGapMs: 4,
  },
  E3: {
    id: "E3",
    label: "working cue",
    tones: [
      { frequencyHz: 440.0, durationMs: 80 },
      { frequencyHz: 440.0, durationMs: 80 },
      { frequencyHz: 440.0, durationMs: 90 },
    ],
    interToneGapMs: 2,
  },
  E4: {
    id: "E4",
    label: "resolve cue",
    tones: [
      { frequencyHz: 261.63, durationMs: 115 },
      { frequencyHz: 329.63, durationMs: 125 },
    ],
    interToneGapMs: 3,
  },
  E5: {
    id: "E5",
    label: "halt cue",
    tones: [
      { frequencyHz: 659.25, durationMs: 115 },
      { frequencyHz: 523.25, durationMs: 135 },
    ],
    interToneGapMs: 3,
  },
  "mute-tone": {
    id: "mute-tone",
    label: "mute cue",
    tones: [
      { frequencyHz: 493.88, durationMs: 80 },
      { frequencyHz: 440.0, durationMs: 120 },
    ],
    interToneGapMs: 5,
  },
};

export const ACK_SPECS: Readonly<Record<AckId, AckSpec>> = {
  "route-suggestion": { id: "route-suggestion", label: "suggestion whoosh", pattern: "whoosh" },
  "route-steer": { id: "route-steer", label: "steer tick-tick", pattern: "tick-tick" },
  "route-declined": { id: "route-declined", label: "addressed-pass declined tick", pattern: "declined-tick" },
  working: { id: "working", label: "timeout working pulse", pattern: "pulse" },
};

export const PRERENDERED_EARCONS: Readonly<Record<EarconId, PcmClip>> = Object.freeze({
  E1: renderEarcon(EARCON_SPECS.E1),
  E2: renderEarcon(EARCON_SPECS.E2),
  E3: renderEarcon(EARCON_SPECS.E3),
  E4: renderEarcon(EARCON_SPECS.E4),
  E5: renderEarcon(EARCON_SPECS.E5),
  "mute-tone": renderEarcon(EARCON_SPECS["mute-tone"]),
});

export const PRERENDERED_ACKS: Readonly<Record<AckId, PcmClip>> = Object.freeze({
  "route-suggestion": renderAck(ACK_SPECS["route-suggestion"]),
  "route-steer": renderAck(ACK_SPECS["route-steer"]),
  "route-declined": renderAck(ACK_SPECS["route-declined"]),
  working: renderAck(ACK_SPECS.working),
});

export async function playEarcon(output: AudioOutput, id: EarconId, meta: AudioDispatchMeta = {}): Promise<void> {
  await output.playPcm(PRERENDERED_EARCONS[id], meta);
}

export async function playAck(output: AudioOutput, id: AckId, meta: AudioDispatchMeta = {}): Promise<void> {
  await output.playPcm(PRERENDERED_ACKS[id], meta);
}

export function createEarconSink(
  output: AudioOutput,
  optionsOrNow: EarconSinkOptions | (() => number) = {},
): EarconSink {
  const options = typeof optionsOrNow === "function" ? { now: optionsOrNow } : optionsOrNow;
  const now = options.now ?? (() => performance.now());
  const maxLatencyMs = options.maxLatencyMs ?? DEFAULT_EARCON_MAX_LATENCY_MS;

  return {
    async emit(event: EarconEmission): Promise<void> {
      assertEarconLatency(event.latencyMs, maxLatencyMs);
      await playEarcon(output, event.id, {
        correlationId: event.correlationId,
        source: event.source,
        emittedAtMs: now(),
      });
    },
  };
}

export function assertEarconLatency(latencyMs: number, maxLatencyMs = DEFAULT_EARCON_MAX_LATENCY_MS): void {
  if (latencyMs > maxLatencyMs) {
    throw new Error(`Earcon fired after ${latencyMs}ms; expected <= ${maxLatencyMs}ms.`);
  }
}

export function zeroCrossingRateCv(clip: PcmClip, windowMs = 20): number {
  const windowSize = Math.max(1, Math.round((clip.sampleRateHz * windowMs) / 1_000));
  const rates: number[] = [];

  for (let start = 0; start + windowSize <= clip.pcm.length; start += windowSize) {
    let crossings = 0;
    let previous = clip.pcm[start];
    for (let index = start + 1; index < start + windowSize; index += 1) {
      const current = clip.pcm[index];
      if ((previous < 0 && current >= 0) || (previous >= 0 && current < 0)) {
        crossings += 1;
      }
      previous = current;
    }
    rates.push(crossings / windowSize);
  }

  const activeRates = rates.filter((rate) => rate > 0);
  if (activeRates.length === 0) {
    return 0;
  }

  const mean = activeRates.reduce((sum, rate) => sum + rate, 0) / activeRates.length;
  const variance = activeRates.reduce((sum, rate) => sum + (rate - mean) ** 2, 0) / activeRates.length;
  return Math.sqrt(variance) / mean;
}

function renderEarcon(spec: EarconSpec): PcmClip {
  const samples: number[] = [];
  const gapSamples = Math.round((DEFAULT_EARCON_SAMPLE_RATE_HZ * (spec.interToneGapMs ?? 0)) / 1_000);

  for (const [segmentIndex, tone] of spec.tones.entries()) {
    const toneSamples = Math.round((DEFAULT_EARCON_SAMPLE_RATE_HZ * tone.durationMs) / 1_000);
    for (let sample = 0; sample < toneSamples; sample += 1) {
      const phase = (2 * Math.PI * tone.frequencyHz * sample) / DEFAULT_EARCON_SAMPLE_RATE_HZ;
      samples.push(Math.sin(phase) * envelope(sample, toneSamples) * DEFAULT_EARCON_VOLUME);
    }

    if (segmentIndex < spec.tones.length - 1) {
      for (let sample = 0; sample < gapSamples; sample += 1) {
        samples.push(0);
      }
    }
  }

  return clip(spec.id, "A", "tonal-earcon", samples);
}

function renderAck(spec: AckSpec): PcmClip {
  switch (spec.pattern) {
    case "whoosh":
      return clip(spec.id, "B", "non-tonal-ack", noise(180, 0x51c0ffee, (index, total) => {
        const position = index / total;
        return (0.02 + position * 0.16) * Math.sin(Math.PI * position);
      }));
    case "tick-tick":
      return clip(spec.id, "B", "non-tonal-ack", tickPattern([0, 72], 130, 0x5e7e12));
    case "declined-tick":
      return clip(spec.id, "B", "non-tonal-ack", tickPattern([0], 60, 0xdecc11e));
    case "pulse":
      return clip(spec.id, "B", "non-tonal-ack", tickPattern([0, 45], 105, 0x90a15e));
    default:
      assertNever(spec.pattern);
  }
}

function tickPattern(offsetsMs: readonly number[], durationMs: number, seed: number): number[] {
  const totalSamples = Math.round((DEFAULT_EARCON_SAMPLE_RATE_HZ * durationMs) / 1_000);
  const samples = Array.from({ length: totalSamples }, () => 0);
  const tickSamples = Math.round((DEFAULT_EARCON_SAMPLE_RATE_HZ * 18) / 1_000);
  let state = seed;

  for (const offsetMs of offsetsMs) {
    const offset = Math.round((DEFAULT_EARCON_SAMPLE_RATE_HZ * offsetMs) / 1_000);
    for (let sample = 0; sample < tickSamples && offset + sample < samples.length; sample += 1) {
      state = xorshift32(state);
      const burst = ((state / 0xffffffff) * 2 - 1) * envelope(sample, tickSamples) * 0.2;
      samples[offset + sample] += burst;
    }
  }

  return samples;
}

function noise(durationMs: number, seed: number, gain: (index: number, total: number) => number): number[] {
  const totalSamples = Math.round((DEFAULT_EARCON_SAMPLE_RATE_HZ * durationMs) / 1_000);
  const samples: number[] = [];
  let state = seed;

  for (let sample = 0; sample < totalSamples; sample += 1) {
    state = xorshift32(state);
    const white = (state / 0xffffffff) * 2 - 1;
    samples.push(white * gain(sample, totalSamples));
  }

  return samples;
}

function clip(
  id: EarconId | AckId,
  layer: PcmClip["layer"],
  kind: PcmClip["kind"],
  samples: readonly number[],
): PcmClip {
  const pcm = new Int16Array(samples.length);
  for (const [index, sample] of samples.entries()) {
    pcm[index] = Math.max(-32767, Math.min(32767, Math.round(sample * 32767)));
  }

  return Object.freeze({
    id,
    layer,
    kind,
    sampleRateHz: DEFAULT_EARCON_SAMPLE_RATE_HZ,
    channels: 1,
    pcm,
    durationMs: (samples.length / DEFAULT_EARCON_SAMPLE_RATE_HZ) * 1_000,
  });
}

function envelope(sample: number, totalSamples: number): number {
  const rampSamples = Math.max(1, Math.round(DEFAULT_EARCON_SAMPLE_RATE_HZ * 0.004));
  const attack = Math.min(1, sample / rampSamples);
  const release = Math.min(1, (totalSamples - sample - 1) / rampSamples);
  return Math.max(0, Math.min(attack, release));
}

function xorshift32(input: number): number {
  let value = input >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return value >>> 0;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled ack pattern ${String(value)}.`);
}
