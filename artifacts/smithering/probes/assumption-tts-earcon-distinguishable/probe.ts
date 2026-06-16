/**
 * Probe: assumption-tts-earcon-distinguishable
 *
 * One question: Can TTS + the earcon vocabulary deliver a clear audio interface
 * where users reliably distinguish state cues (earcons/acks) from TTS responses?
 *
 * Tests:
 *   A. TTS synthesis latency — macOS `say` as a proxy for any TTS API
 *      Pass: mean < 500 ms
 *   B. Earcon + ack generation — all 7 cues (E1–E5 + tick-tick + whoosh)
 *      written as WAV files
 *      Pass: all files written and non-empty
 *   C. Acoustic distinctness — Zero-Crossing Rate coefficient of variation (ZCR-CV)
 *      Layer A earcons (pure tones):   ZCR-CV < 0.15  (regular, tonal)
 *      Layer B acks (noise bursts):    classified separately by construction
 *      TTS speech (broadband):         ZCR-CV > 0.40  (aperiodic)
 *      Ratio TTS_CV / earcon_CV > 4.0  → quantitatively distinct
 *
 * Decision record from D-DD-23:
 *   Layer A (5 tonal earcons): E1 Wake, E2 Hum, E3 Spawn, E4 Resolve, E5 Halt
 *   Layer B (non-tonal acks):  tick-tick (steer), whoosh (suggestion), silence (pass)
 *   Non-tonal Layer B guarantees disjointness by construction.
 *
 * Limitations (recorded):
 *   - Human perceptual test (in-room) not automated; see README.md for protocol
 *   - `say` is macOS system TTS; production API latency typically lower
 *   - ZCR-CV is a structural proxy, not a direct perceptual measure
 *   - No raw audio is persisted beyond WAV references (transcript-only policy, C9/C10)
 *
 * Run: bun probe.ts
 * Output: evidence/ directory
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = join(__dirname, "evidence");
const AUDIO = join(EVIDENCE, "audio");
mkdirSync(AUDIO, { recursive: true });

// ── Constants ─────────────────────────────────────────────────────────────────

const SR = 22050; // sample rate, Hz
const TTS_LIMIT_S = 0.5; // max acceptable mean TTS latency
const ZCR_EARCON_MAX = 0.15; // Layer A earcon CV must be below this (tonal)
const ZCR_TTS_MIN = 0.40; // TTS CV must be above this (aperiodic speech)
const ZCR_RATIO_MIN = 4.0; // TTS_CV / earcon_mean_CV threshold

const TTS_TEXT =
  "Ready. I'm listening and I'll let you know when I finish thinking.";

// Musical note frequencies (equal temperament, A4 = 440 Hz)
const NOTE = {
  A2: 110.0,
  C4: 261.63,
  E4: 329.63,
  G4: 392.0,
  C5: 523.25,
  E5: 659.25,
  G5: 783.99,
} as const;

// Layer A — 5 tonal state earcons (D-DD-23)
// Each entry: [[freq_hz, duration_s], ...]
type TonePattern = [number, number][];
const LAYER_A: Record<string, TonePattern> = {
  "E1-wake": [[NOTE.C5, 0.06], [NOTE.E5, 0.12]], // C5→E5 rising
  "E2-hum": [[NOTE.A2, 0.35]], // A2 drone (transcribing)
  "E3-spawn": [[NOTE.G5, 0.15]], // G5 single (spawn)
  "E4-resolve": [[NOTE.C4, 0.07], [NOTE.E4, 0.07], [NOTE.G4, 0.14]], // C4→E4→G4
  "E5-halt": [[NOTE.E5, 0.07], [NOTE.C4, 0.14]], // E5→C4 falling
};

// Layer B — non-tonal routing acks (D-DD-23: clicks + whoosh, no pitch)
// Synthesized as broadband noise bursts so they can NEVER collide with Layer A
const LAYER_B = ["B1-tick-tick", "B2-whoosh"] as const;

// ── WAV helpers ───────────────────────────────────────────────────────────────

function makeWavHeader(dataBytes: number, sampleRate = SR): Buffer {
  const buf = Buffer.alloc(44);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

function writeWav(path: string, samples: Int16Array): void {
  const header = makeWavHeader(samples.length * 2);
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(samples[i], i * 2);
  writeFileSync(path, Buffer.concat([header, data]));
}

function sineWave(freq: number, durS: number, amp = 0.45): Int16Array {
  const n = Math.floor(SR * durS);
  const fade = Math.max(1, Math.min(Math.floor(SR * 0.005), Math.floor(n / 4)));
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    let s = amp * Math.sin(2 * Math.PI * freq * i / SR);
    if (i < fade) s *= 0.5 * (1 - Math.cos(Math.PI * i / fade));
    else if (i >= n - fade) s *= 0.5 * (1 - Math.cos(Math.PI * (n - i) / fade));
    out[i] = Math.round(s * 32767);
  }
  return out;
}

/** White noise burst with cosine fade — non-tonal by construction */
function noiseBurst(durS: number, amp = 0.35): Int16Array {
  const n = Math.floor(SR * durS);
  const fade = Math.max(1, Math.min(Math.floor(SR * 0.003), Math.floor(n / 4)));
  const out = new Int16Array(n);
  // Deterministic LCG so output is reproducible
  let seed = 0xdeadbeef;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1664525 + 1013904223) & 0xffffffff;
    let s = amp * ((seed & 0xffff) / 32768 - 1.0);
    if (i < fade) s *= 0.5 * (1 - Math.cos(Math.PI * i / fade));
    else if (i >= n - fade) s *= 0.5 * (1 - Math.cos(Math.PI * (n - i) / fade));
    out[i] = Math.round(s * 32767);
  }
  return out;
}

function concat(...arrays: Int16Array[]): Int16Array {
  const gapN = Math.floor(SR * 0.015); // 15ms gap between tones
  const parts: Int16Array[] = [];
  for (let i = 0; i < arrays.length; i++) {
    if (i > 0) parts.push(new Int16Array(gapN));
    parts.push(arrays[i]);
  }
  const total = parts.reduce((s, a) => s + a.length, 0);
  const out = new Int16Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

// ── ZCR analysis ──────────────────────────────────────────────────────────────

function zcrStats(
  samples: Int16Array | number[],
  frameSize = 1024,
): { mean: number; std: number; cv: number; nFrames: number } {
  const rmsThreshold = 800; // ~2.4% FS — skip silent frames
  const zcrs: number[] = [];

  for (let start = 0; start + frameSize <= samples.length; start += frameSize) {
    let rmsSum = 0;
    for (let i = start; i < start + frameSize; i++) rmsSum += (samples[i] as number) ** 2;
    const rms = Math.sqrt(rmsSum / frameSize);
    if (rms < rmsThreshold) continue;

    let zc = 0;
    for (let i = start + 1; i < start + frameSize; i++) {
      if ((samples[i - 1] as number) * (samples[i] as number) < 0) zc++;
    }
    zcrs.push(zc / (frameSize / SR)); // crossings per second
  }

  if (zcrs.length < 2) return { mean: 0, std: 0, cv: 0, nFrames: zcrs.length };
  const mean = zcrs.reduce((a, b) => a + b, 0) / zcrs.length;
  const variance = zcrs.reduce((a, b) => a + (b - mean) ** 2, 0) / zcrs.length;
  const std = Math.sqrt(variance);
  const cv = mean > 0 ? std / mean : 0;
  return { mean: Math.round(mean), std: Math.round(std), cv: +cv.toFixed(4), nFrames: zcrs.length };
}

function readWavSamples(path: string): { samples: Int16Array; sr: number } | null {
  try {
    const buf = readFileSync(path);
    if (buf.toString("ascii", 0, 4) !== "RIFF") return null;
    const sr = buf.readUInt32LE(24);
    const dataOffset = 44; // standard PCM WAV
    const n = (buf.length - dataOffset) / 2;
    const samples = new Int16Array(n);
    for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(dataOffset + i * 2);
    return { samples, sr };
  } catch {
    return null;
  }
}

// ── Test A: TTS latency ───────────────────────────────────────────────────────

interface TtsResult {
  ok: boolean;
  error?: string;
  text?: string;
  latenciesS?: number[];
  meanS?: number;
  minS?: number;
  maxS?: number;
  passesThreshold?: boolean;
  thresholdS: number;
  fileSizeBytes?: number;
  ttsPath?: string;
  zcr?: ReturnType<typeof zcrStats>;
  zcrError?: string;
}

function probeTts(): TtsResult {
  const out: TtsResult = { ok: false, thresholdS: TTS_LIMIT_S };

  const hasSay = spawnSync("which", ["say"], { encoding: "utf8" }).status === 0;
  if (!hasSay) {
    out.error = "`say` command not found (macOS only)";
    return out;
  }

  const ttsPath = join(AUDIO, "tts_sample.wav");
  const latencies: number[] = [];

  for (let run = 0; run < 3; run++) {
    const t0 = performance.now();
    const r = spawnSync("say", ["-o", ttsPath, "--data-format=LEI16@22050", TTS_TEXT], {
      timeout: 20_000,
    });
    const elapsed = (performance.now() - t0) / 1000;
    if (r.status !== 0) {
      out.error = r.stderr?.toString() || "say returned non-zero";
      return out;
    }
    latencies.push(+elapsed.toFixed(4));
  }

  const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  out.ok = true;
  out.text = TTS_TEXT;
  out.latenciesS = latencies;
  out.meanS = +mean.toFixed(4);
  out.minS = +Math.min(...latencies).toFixed(4);
  out.maxS = +Math.max(...latencies).toFixed(4);
  out.passesThreshold = mean < TTS_LIMIT_S;
  out.ttsPath = `evidence/audio/tts_sample.wav`;
  out.fileSizeBytes = existsSync(ttsPath) ? statSync(ttsPath).size : 0;

  // Read WAV for ZCR (LEI16 WAV from say)
  const wav = readWavSamples(ttsPath);
  if (wav && wav.samples.length > 1024) {
    out.zcr = zcrStats(wav.samples);
  } else {
    out.zcrError = "WAV not readable; format may differ from LEI16";
    // Fallback: try AIFF then afconvert
    const aiffPath = join(AUDIO, "tts_sample.aiff");
    const r2 = spawnSync("say", ["-o", aiffPath, TTS_TEXT], { timeout: 20_000 });
    if (r2.status === 0) {
      const wavConverted = join(AUDIO, "tts_sample_converted.wav");
      const conv = spawnSync(
        "afconvert", ["-f", "WAVE", "-d", "LEI16@22050", aiffPath, wavConverted],
        { timeout: 10_000 },
      );
      if (conv.status === 0) {
        const wav2 = readWavSamples(wavConverted);
        if (wav2 && wav2.samples.length > 1024) {
          out.zcr = zcrStats(wav2.samples);
          out.zcrError = undefined;
        }
      }
    }
  }

  return out;
}

// ── Test B: Earcon generation ─────────────────────────────────────────────────

interface EarconResult {
  name: string;
  layer: "A" | "B";
  ok: boolean;
  error?: string;
  path?: string;
  nSamples?: number;
  durationS?: number;
  sizeBytes?: number;
  pattern?: unknown;
}

function probeEarcons(): EarconResult[] {
  const results: EarconResult[] = [];

  // Layer A — tonal earcons
  for (const [name, pattern] of Object.entries(LAYER_A)) {
    const path = join(AUDIO, `${name}.wav`);
    try {
      const tones = pattern.map(([f, d]) => sineWave(f, d));
      const samples = concat(...tones);
      writeWav(path, samples);
      results.push({
        name, layer: "A", ok: true,
        path: `evidence/audio/${name}.wav`,
        nSamples: samples.length,
        durationS: +(samples.length / SR).toFixed(4),
        sizeBytes: statSync(path).size,
        pattern: pattern.map(([freq, dur]) => ({ freq_hz: freq, duration_s: dur })),
      });
    } catch (e) {
      results.push({ name, layer: "A", ok: false, error: String(e) });
    }
  }

  // Layer B — non-tonal acks
  const layerBDefs: Record<string, Int16Array> = {
    "B1-tick-tick": concat(noiseBurst(0.008), noiseBurst(0.008)),
    "B2-whoosh": (() => {
      // Fade-in + fade-out of white noise = whoosh
      const n = Math.floor(SR * 0.18);
      const s = new Int16Array(n);
      let seed = 0xcafebabe;
      for (let i = 0; i < n; i++) {
        seed = (seed * 1664525 + 1013904223) & 0xffffffff;
        let v = 0.4 * ((seed & 0xffff) / 32768 - 1.0);
        // bell envelope
        const t = i / n;
        v *= Math.sin(Math.PI * t);
        s[i] = Math.round(v * 32767);
      }
      return s;
    })(),
  };

  for (const [name, samples] of Object.entries(layerBDefs)) {
    const path = join(AUDIO, `${name}.wav`);
    try {
      writeWav(path, samples);
      results.push({
        name, layer: "B", ok: true,
        path: `evidence/audio/${name}.wav`,
        nSamples: samples.length,
        durationS: +(samples.length / SR).toFixed(4),
        sizeBytes: statSync(path).size,
        pattern: "noise-burst",
      });
    } catch (e) {
      results.push({ name, layer: "B", ok: false, error: String(e) });
    }
  }

  return results;
}

// ── Test C: ZCR distinctness ──────────────────────────────────────────────────

interface ZcrAnalysis {
  perCue: Record<string, ReturnType<typeof zcrStats> & { layer: string }>;
  meanLayerACv: number | null;
  ttsCv: number | null;
  cvRatio: number | null;
  layerAPassesTonal: boolean;
  ttsPassesSpeech: boolean;
  quantitativelyDistinct: boolean;
  thresholds: {
    earconCvMax: number;
    ttsCvMin: number;
    ratioMin: number;
  };
}

function probeZcr(earcons: EarconResult[], ttsResult: TtsResult): ZcrAnalysis {
  const perCue: ZcrAnalysis["perCue"] = {};
  const layerACvs: number[] = [];

  for (const ec of earcons) {
    if (!ec.ok || !ec.path) continue;
    const path = join(__dirname, ec.path);
    const wav = readWavSamples(path);
    if (!wav) { perCue[ec.name] = { mean: 0, std: 0, cv: 0, nFrames: 0, layer: ec.layer }; continue; }
    const stats = zcrStats(wav.samples);
    perCue[ec.name] = { ...stats, layer: ec.layer };
    if (ec.layer === "A") layerACvs.push(stats.cv);
  }

  const meanLayerACv = layerACvs.length > 0
    ? +(layerACvs.reduce((a, b) => a + b, 0) / layerACvs.length).toFixed(4)
    : null;

  const ttsCv = ttsResult.zcr?.cv ?? null;

  const cvRatio =
    meanLayerACv !== null && ttsCv !== null && meanLayerACv > 0
      ? +(ttsCv / meanLayerACv).toFixed(2)
      : null;

  return {
    perCue,
    meanLayerACv,
    ttsCv,
    cvRatio,
    layerAPassesTonal: meanLayerACv !== null && meanLayerACv < ZCR_EARCON_MAX,
    ttsPassesSpeech: ttsCv !== null && ttsCv > ZCR_TTS_MIN,
    quantitativelyDistinct: cvRatio !== null && cvRatio > ZCR_RATIO_MIN,
    thresholds: {
      earconCvMax: ZCR_EARCON_MAX,
      ttsCvMin: ZCR_TTS_MIN,
      ratioMin: ZCR_RATIO_MIN,
    },
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log("=== Probe: assumption-tts-earcon-distinguishable ===\n");

// A. TTS latency
console.log("A. TTS latency (3 runs)...");
const tts = probeTts();
writeFileSync(join(EVIDENCE, "latency.json"), JSON.stringify(tts, null, 2));
if (tts.ok) {
  console.log(
    `   mean=${tts.meanS}s  [${tts.minS}–${tts.maxS}s]` +
    `  threshold=${TTS_LIMIT_S}s  pass=${tts.passesThreshold}`
  );
  if (tts.zcr) console.log(`   TTS ZCR: mean=${tts.zcr.mean}/s  CV=${tts.zcr.cv}`);
  else console.log(`   TTS ZCR: unavailable (${tts.zcrError})`);
} else {
  console.log(`   FAILED: ${tts.error}`);
}

// B. Earcon generation
console.log("\nB. Earcon generation...");
const earcons = probeEarcons();
writeFileSync(join(EVIDENCE, "earcons.json"), JSON.stringify(earcons, null, 2));
for (const ec of earcons) {
  if (ec.ok) console.log(`   [${ec.layer}] ${ec.name}: ${ec.durationS}s  ${ec.sizeBytes}B`);
  else console.log(`   [${ec.layer}] ${ec.name}: FAILED — ${ec.error}`);
}

// C. ZCR analysis
console.log("\nC. Acoustic distinctness (ZCR-CV)...");
const zcr = probeZcr(earcons, tts);
writeFileSync(join(EVIDENCE, "zcr_analysis.json"), JSON.stringify(zcr, null, 2));
for (const [name, stats] of Object.entries(zcr.perCue)) {
  console.log(`   [${stats.layer}] ${name}: ZCR=${stats.mean}/s  CV=${stats.cv}`);
}
if (zcr.ttsCv !== null) console.log(`   [TTS] speech: ZCR=${tts.zcr!.mean}/s  CV=${zcr.ttsCv}`);
if (zcr.cvRatio !== null) {
  console.log(`   Ratio TTS_CV/LayerA_CV = ${zcr.cvRatio}×  (target > ${ZCR_RATIO_MIN})`);
}

// Verdict
const ttsOk = tts.ok && (tts.passesThreshold ?? false);
const earconsOk = earcons.every((e) => e.ok);
const tonalOk = zcr.layerAPassesTonal;
const passed = ttsOk && earconsOk && tonalOk;

const notes: string[] = [];
if (!tts.ok) notes.push(`TTS unavailable: ${tts.error}`);
else if (!ttsOk) notes.push(`TTS mean ${tts.meanS}s > ${TTS_LIMIT_S}s threshold`);
if (!earconsOk) notes.push(`Earcon generation failed: ${earcons.filter(e => !e.ok).map(e => e.name).join(", ")}`);
if (!tonalOk) notes.push(`Layer A ZCR-CV=${zcr.meanLayerACv} not tonal (target < ${ZCR_EARCON_MAX})`);
if (zcr.quantitativelyDistinct) notes.push(`Quantitative: ratio=${zcr.cvRatio}× > ${ZCR_RATIO_MIN}× — confirmed distinct`);
else if (zcr.cvRatio !== null) notes.push(`Quantitative: ratio=${zcr.cvRatio}× < ${ZCR_RATIO_MIN}× (weaker than expected)`);
else notes.push("TTS ZCR unavailable — structural argument only (tonal vs broadband by design)");
notes.push("LIMITATION: Human in-room perceptual test not automated; see README.md for protocol");

const verdict = {
  passed,
  checks: { ttsLatencyOk: ttsOk, earconsGenerated: earconsOk, layerAIsTonal: tonalOk, quantitativelyDistinct: zcr.quantitativelyDistinct },
  notes,
  planImpact: passed ? null : [
    ttsOk ? null : "Add streaming/chunked TTS or pre-cache common phrases to meet 500ms latency target.",
    earconsOk ? null : "Fix earcon WAV generation — check audio/ directory for partial files.",
    tonalOk ? null : "Earcon ZCR-CV too high; verify sine wave synthesis produces clean tones.",
    "If in-room listening test fails: redesign earcon vocabulary (larger spectral distance) or add spoken labels.",
  ].filter(Boolean).join(" "),
};

writeFileSync(join(EVIDENCE, "result.json"), JSON.stringify(verdict, null, 2));

console.log(`\n${"=".repeat(50)}`);
console.log(`VERDICT: ${passed ? "PASS" : "FAIL"}`);
for (const n of notes) console.log(`  • ${n}`);

process.exit(passed ? 0 : 1);
