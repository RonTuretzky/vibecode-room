import { describe, expect, test } from "bun:test";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runProbe, type ProbeAssertion } from "./harness";
import { createAudioCredentialSource } from "../src/providers/credentials";
import { scanSecretLikeFiles } from "../src/security/secrets";
import type { AudioReadableStream, TTSOptions, TTSProvider } from "../src/providers/types";

const PROBE_ID = "probe-streaming-tts";
const REPORT_ROOT = "artifacts/smithering/reports";
const PROBE_ROOT = `artifacts/smithering/probes/${PROBE_ID}`;
const BUILD_ROOT = `artifacts/smithering/build/${PROBE_ID}`;
const TRACE_ROOT = `${BUILD_ROOT}/trace`;
const TRACE_PATH = `${TRACE_ROOT}/p-tts.jsonl`;
const DEFAULT_FIRST_AUDIO_BUDGET_MS = 200;
const PRE_CACHE_PLAYBACK_BUDGET_MS = 100;
const TIMEOUT_MS = 45_000;
const PROBE_TEXT = "Panopticon streaming TTS probe ready.";
const STATE_PHRASES = ["Ready", "Muted", "Unmuted", "Working", "Halted"] as const;

type ProviderId = "elevenlabs" | "cartesia" | "playht" | "openai";

interface ProviderCandidate {
  id: ProviderId;
  label: string;
  envVars: string[];
  docs: string;
  create: () => CandidateProvider | null;
}

interface CandidateProvider extends TTSProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly model: string;
  readonly voice: string;
  readonly envVars: string[];
  readonly lastContentType: string | null;
}

interface Measurement {
  providerId: ProviderId;
  label: string;
  model: string;
  voice: string;
  firstAudioByteMs: number;
  firstChunkBytes: number;
  contentType: string | null;
}

interface SelectionRecord {
  budgetMs: number;
  selected: Measurement | null;
  fastestMeasured: Measurement | null;
  measured: Measurement[];
  unavailable: Array<{ providerId: ProviderId; label: string; envVars: string[] }>;
  blockers: string[];
}

describe("P-TTS streaming provider selection probe", () => {
  test("configured 2026 TTS candidates stream first audio byte within budget and satisfy Panopticon output contract", async () => {
    await mkdir(TRACE_ROOT, { recursive: true });
    await mkdir(PROBE_ROOT, { recursive: true });
    await writeFile(TRACE_PATH, "", "utf8");
    await assertDependencyVerdict();

    let selection: SelectionRecord | undefined;
    const assertions: ProbeAssertion[] = [
      {
        id: "candidate-matrix",
        behavior: "the probe knows the 2026 TTS selection candidates and records unavailable credentials without values",
        falsify: () => {
          expect(candidateMatrix().map((candidate) => candidate.id as string)).toContain("macos-say");
        },
        run: async () => {
          const candidates = candidateMatrix();
          expect(candidates.map((candidate) => candidate.id)).toEqual(["elevenlabs", "cartesia", "playht", "openai"]);
          for (const candidate of candidates) {
            expect(candidate.envVars.length).toBeGreaterThan(0);
          }
          await appendTrace("tts.candidate.matrix", {
            candidates: candidates.map(({ id, label, envVars, docs }) => ({ id, label, envVars, docs })),
          });
        },
      },
      {
        id: "word-guard-before-submission",
        behavior: "the deterministic 15-word guard runs before any TTS provider submission",
        falsify: () => {
          expect(guardTtsText(sixteenWordPayload()).wordCount).toBe(16);
        },
        run: () => {
          const guarded = guardTtsText(sixteenWordPayload());
          expect(guarded.wordCount).toBeLessThanOrEqual(15);
          expect(guarded.text).not.toContain("https://");
          expect(guarded.text).not.toContain("src/audio/output-policy.ts");
          expect(guarded.text).not.toContain("+diff");
        },
      },
      {
        id: "voice-selected-once",
        behavior: "one neutral voice is selected once per provider session and reused for all submissions",
        falsify: () => {
          const selector = new SessionVoiceSelector("voice-a");
          expect(selector.select("voice-b")).toBe("voice-b");
        },
        run: () => {
          const selector = new SessionVoiceSelector("voice-a");
          expect(selector.select("voice-b")).toBe("voice-a");
          expect(selector.select("voice-c")).toBe("voice-a");
          expect(selector.selectionCount).toBe(1);
        },
      },
      {
        id: "provider-contract",
        behavior: "a TTSProvider returns a ReadableStream whose first audio chunk is a non-empty Uint8Array",
        falsify: async () => {
          const badProvider = new EmptyChunkProvider();
          await assertProviderContract(badProvider, PROBE_TEXT);
        },
        run: async () => {
          const providers = configuredProviders();
          expect(providers.length).toBeGreaterThan(0);
          await assertProviderContract(providers[0], PROBE_TEXT);
        },
      },
      {
        id: "first-audio-byte-budget-and-selection",
        behavior: "configured real TTS candidates are benchmarked by time-to-first-audio-byte and the winner is <=200 ms",
        falsify: async () => {
          const record = await benchmarkConfiguredCandidates(20);
          expect(record.fastestMeasured?.firstAudioByteMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(20);
        },
        run: async () => {
          selection = await benchmarkConfiguredCandidates(firstAudioBudgetMs());
          await writeJson(join(PROBE_ROOT, "selection.json"), selection);
          expect(selection.blockers).toEqual([]);
          expect(selection.selected).not.toBeNull();
          expect(selection.selected!.firstAudioByteMs).toBeLessThanOrEqual(firstAudioBudgetMs());
        },
      },
      {
        id: "precache-fixed-state-phrases",
        behavior: "five fixed state phrases are pre-cached as static clips and play from memory in <100 ms",
        falsify: async () => {
          const cache = new StaticClipCache();
          cache.injectSlowPlaybackMs = 125;
          await cache.preload([{ phrase: "Ready", bytes: new Uint8Array([1, 2, 3]) }]);
          const playback = await cache.play("Ready");
          expect(playback.firstByteMs).toBeLessThanOrEqual(PRE_CACHE_PLAYBACK_BUDGET_MS);
        },
        run: async () => {
          const record = selection ?? (await benchmarkConfiguredCandidates(Number.POSITIVE_INFINITY));
          if (record.selected === null) {
            await writeJson(join(PROBE_ROOT, "precache.json"), {
              providerId: null,
              fastestMeasuredProviderId: record.fastestMeasured?.providerId ?? null,
              phraseCount: STATE_PHRASES.length,
              playback: [],
              blocked: "no selected provider is available for real static clip pre-cache",
              blockers: record.blockers,
            });
            throw new Error("cannot pre-cache selected-provider state clips because P-TTS has no selected provider");
          }
          const provider = configuredProviders().find((candidate) => candidate.id === record.selected!.providerId);
          expect(provider).toBeDefined();
          const cache = await preCacheStatePhrases(provider!);
          const playback = [];
          for (const phrase of STATE_PHRASES) {
            const result = await cache.play(phrase);
            expect(result.firstByteMs).toBeLessThanOrEqual(PRE_CACHE_PLAYBACK_BUDGET_MS);
            expect(result.bytes).toBeGreaterThan(0);
            playback.push({ phrase, firstByteMs: result.firstByteMs, bytes: result.bytes });
          }
          await writeJson(join(PROBE_ROOT, "precache.json"), {
            providerId: record.selected.providerId,
            phraseCount: STATE_PHRASES.length,
            playback,
            synthetic: false,
          });
        },
      },
      {
        id: "secret-redaction",
        behavior: "probe report, selection record, pre-cache record, and trace contain no key-shaped strings",
        falsify: async () => {
          const findings = await scanSecretLikeFiles(PROBE_ROOT);
          expect(findings.findings.length + 1).toBe(0);
        },
        run: async () => {
          const scan = await scanSecretLikeFiles(PROBE_ROOT);
          expect(scan).toEqual({ passed: true, findings: [] });
        },
      },
    ];

    try {
      const report = await runProbe({
        probeId: PROBE_ID,
        assertions,
        reportRoot: REPORT_ROOT,
        cleanReportDir: true,
        correlationId: "p-tts-streaming-selection",
        meta: {
          budgetMs: firstAudioBudgetMs(),
          preCachePlaybackBudgetMs: PRE_CACHE_PLAYBACK_BUDGET_MS,
          candidates: candidateMatrix().map(({ id, label, envVars }) => ({ id, label, envVars })),
        },
      });

      await writeVerdict(true, summarizeSelection(selection, report.summary));
    } catch (error) {
      await writeVerdict(false, selection === undefined ? (error instanceof Error ? error.message : String(error)) : summarizeSelection(selection, "probe assertion failed"));
      throw error;
    }
  }, 240_000);
});

function candidateMatrix(): ProviderCandidate[] {
  return [
    {
      id: "elevenlabs",
      label: "ElevenLabs Flash v3 / Flash low-latency family",
      envVars: ["ELEVENLABS_API_KEY", "XI_API_KEY"],
      docs: "https://elevenlabs.io/docs/api-reference/streaming",
      create: () => {
        const apiKey = firstEnv("ELEVENLABS_API_KEY", "XI_API_KEY");
        if (apiKey === undefined) return null;
        const voice = process.env.PANOP_TTS_ELEVENLABS_VOICE_ID ?? "JBFqnCBsd6RMkjVDRZzb";
        const model = process.env.PANOP_TTS_ELEVENLABS_MODEL ?? "eleven_flash_v2_5";
        createAudioCredentialSource({ provider: "tts", variable: "ELEVENLABS_API_KEY", env: { ELEVENLABS_API_KEY: apiKey } });
        return new FetchTTSProvider({
          id: "elevenlabs",
          label: "ElevenLabs Flash v3 / Flash low-latency family",
          model,
          voice,
          envVars: ["ELEVENLABS_API_KEY", "XI_API_KEY"],
          request: (text, selectedVoice) => ({
            url: `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(selectedVoice)}/stream?output_format=mp3_44100_128`,
            init: {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "xi-api-key": apiKey,
              },
              body: JSON.stringify({
                text,
                model_id: model,
                optimize_streaming_latency: 4,
              }),
            },
          }),
        });
      },
    },
    {
      id: "cartesia",
      label: "Cartesia Sonic",
      envVars: ["CARTESIA_API_KEY"],
      docs: "https://docs.cartesia.ai/api-reference/tts/sse",
      create: () => {
        const apiKey = firstEnv("CARTESIA_API_KEY");
        if (apiKey === undefined) return null;
        const voice = process.env.PANOP_TTS_CARTESIA_VOICE_ID ?? "f786b574-daa5-4673-aa0c-cbe3e8534c02";
        const model = process.env.PANOP_TTS_CARTESIA_MODEL ?? "sonic-3.5";
        createAudioCredentialSource({ provider: "tts", variable: "CARTESIA_API_KEY", env: { CARTESIA_API_KEY: apiKey } });
        return new FetchTTSProvider({
          id: "cartesia",
          label: "Cartesia Sonic",
          model,
          voice,
          envVars: ["CARTESIA_API_KEY"],
          request: (text, selectedVoice) => ({
            url: "https://api.cartesia.ai/tts/bytes",
            init: {
              method: "POST",
              headers: {
                "Cartesia-Version": process.env.PANOP_TTS_CARTESIA_VERSION ?? "2024-11-13",
                "Content-Type": "application/json",
                "X-API-Key": apiKey,
              },
              body: JSON.stringify({
                model_id: model,
                transcript: text,
                voice: { mode: "id", id: selectedVoice },
                output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: 16000 },
                language: "en",
              }),
            },
          }),
        });
      },
    },
    {
      id: "playht",
      label: "PlayHT 3.0 Turbo",
      envVars: ["PLAYHT_API_KEY", "PLAYHT_USER_ID"],
      docs: "https://docs.play.ht/reference/api-generate-tts-audio-stream",
      create: () => {
        const apiKey = firstEnv("PLAYHT_API_KEY");
        const userId = firstEnv("PLAYHT_USER_ID");
        if (apiKey === undefined || userId === undefined) return null;
        const voice = process.env.PANOP_TTS_PLAYHT_VOICE ?? "s3://voice-cloning-zero-shot/d9ff78ba-d016-47f6-b0ef-dd630f59414e/original/manifest.json";
        const model = process.env.PANOP_TTS_PLAYHT_MODEL ?? "Play3.0-mini";
        createAudioCredentialSource({ provider: "tts", variable: "PLAYHT_API_KEY", env: { PLAYHT_API_KEY: apiKey } });
        return new FetchTTSProvider({
          id: "playht",
          label: "PlayHT 3.0 Turbo",
          model,
          voice,
          envVars: ["PLAYHT_API_KEY", "PLAYHT_USER_ID"],
          request: (text, selectedVoice) => ({
            url: "https://api.play.ht/api/v2/tts/stream",
            init: {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: "audio/mpeg",
                Authorization: apiKey,
                "X-USER-ID": userId,
              },
              body: JSON.stringify({
                text,
                voice: selectedVoice,
                model,
                output_format: "mp3",
                speed: 1,
              }),
            },
          }),
        });
      },
    },
    {
      id: "openai",
      label: "OpenAI /v1/audio/speech",
      envVars: ["OPENAI_API_KEY"],
      docs: "https://developers.openai.com/api/docs/guides/text-to-speech",
      create: () => {
        const apiKey = firstEnv("OPENAI_API_KEY");
        if (apiKey === undefined) return null;
        const voice = process.env.PANOP_TTS_OPENAI_VOICE ?? "coral";
        const model = process.env.PANOP_TTS_OPENAI_MODEL ?? "gpt-4o-mini-tts";
        createAudioCredentialSource({ provider: "tts", variable: "OPENAI_API_KEY", env: { OPENAI_API_KEY: apiKey } });
        return new FetchTTSProvider({
          id: "openai",
          label: "OpenAI /v1/audio/speech",
          model,
          voice,
          envVars: ["OPENAI_API_KEY"],
          request: (text, selectedVoice) => ({
            url: "https://api.openai.com/v1/audio/speech",
            init: {
              method: "POST",
              headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model,
                voice: selectedVoice,
                input: text,
                response_format: "pcm",
                stream_format: "audio",
                instructions: "Use a neutral, calm, concise operational voice.",
              }),
            },
          }),
        });
      },
    },
  ];
}

class FetchTTSProvider implements CandidateProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly model: string;
  readonly voice: string;
  readonly envVars: string[];
  private readonly request: (text: string, voice: string) => { url: string; init: RequestInit };
  private readonly voiceSelector: SessionVoiceSelector;
  private contentType: string | null = null;

  constructor(options: {
    id: ProviderId;
    label: string;
    model: string;
    voice: string;
    envVars: string[];
    request: (text: string, voice: string) => { url: string; init: RequestInit };
  }) {
    this.id = options.id;
    this.label = options.label;
    this.model = options.model;
    this.voice = options.voice;
    this.envVars = options.envVars;
    this.request = options.request;
    this.voiceSelector = new SessionVoiceSelector(options.voice);
  }

  async speak(text: string, opts?: TTSOptions): Promise<AudioReadableStream> {
    const guarded = guardTtsText(text);
    const selectedVoice = this.voiceSelector.select(opts?.voice);
    const { url, init } = this.request(guarded.text, selectedVoice);
    const response = await fetchWithTimeout(url, init, TIMEOUT_MS);
    this.contentType = response.headers.get("content-type");
    if (!response.ok || response.body === null) {
      throw new Error(`${this.label} TTS request failed with HTTP ${response.status}`);
    }
    return response.body;
  }

  get lastContentType(): string | null {
    return this.contentType;
  }
}

class SessionVoiceSelector {
  readonly initialVoice: string;
  selectionCount = 0;
  private selectedVoice: string | undefined;

  constructor(initialVoice: string) {
    this.initialVoice = initialVoice;
    this.selectedVoice = initialVoice;
    this.selectionCount = 1;
  }

  select(requested?: string): string {
    if (this.selectedVoice === undefined) {
      this.selectedVoice = requested ?? this.initialVoice;
      this.selectionCount += 1;
    }
    return this.selectedVoice;
  }
}

class EmptyChunkProvider implements TTSProvider {
  async speak(): Promise<AudioReadableStream> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array());
        controller.close();
      },
    });
  }
}

class StaticClipCache {
  injectSlowPlaybackMs = 0;
  private readonly clips = new Map<string, Uint8Array>();

  async preload(clips: Array<{ phrase: string; bytes: Uint8Array }>): Promise<void> {
    for (const clip of clips) {
      this.clips.set(clip.phrase, clip.bytes);
    }
  }

  async play(phrase: string): Promise<{ firstByteMs: number; bytes: number }> {
    const started = performance.now();
    if (this.injectSlowPlaybackMs > 0) {
      await sleep(this.injectSlowPlaybackMs);
    }
    const bytes = this.clips.get(phrase);
    if (bytes === undefined) {
      throw new Error(`missing static clip for ${phrase}`);
    }
    return { firstByteMs: performance.now() - started, bytes: bytes.byteLength };
  }
}

async function assertDependencyVerdict(): Promise<void> {
  const verdictPath = "artifacts/smithering/probes/probe-suite-harness/verdict.json";
  const verdict = JSON.parse(await readFile(verdictPath, "utf8")) as { green?: boolean };
  await appendTrace("tts.dependency.verdict", { path: verdictPath, green: verdict.green === true });
  expect(verdict.green).toBe(true);
}

function configuredProviders(): CandidateProvider[] {
  return candidateMatrix()
    .map((candidate) => candidate.create())
    .filter((provider): provider is CandidateProvider => provider !== null);
}

async function benchmarkConfiguredCandidates(budgetMs: number): Promise<SelectionRecord> {
  const providers = configuredProviders();
  const unavailable = candidateMatrix()
    .filter((candidate) => !providers.some((provider) => provider.id === candidate.id))
    .map(({ id, label, envVars }) => ({ providerId: id, label, envVars }));

  if (providers.length === 0) {
    throw new Error("P-TTS has no configured provider credentials; set one candidate env var without writing it to logs.");
  }

  const measured: Measurement[] = [];
  for (const provider of providers) {
    const measurement = await measureFirstAudioChunk(provider, PROBE_TEXT);
    measured.push(measurement);
    await appendTrace("tts.first_audio.measured", {
      providerId: provider.id,
      label: provider.label,
      model: provider.model,
      voice: provider.voice,
      firstAudioByteMs: measurement.firstAudioByteMs,
      firstChunkBytes: measurement.firstChunkBytes,
      contentType: measurement.contentType,
      budgetMs,
    });
  }

  const winner = [...measured].sort((left, right) => left.firstAudioByteMs - right.firstAudioByteMs)[0];
  if (winner === undefined) {
    throw new Error("P-TTS measured no providers.");
  }

  const blockers: string[] = [];
  if (winner.firstAudioByteMs > budgetMs) {
    blockers.push(`${winner.label} was fastest but measured ${Math.round(winner.firstAudioByteMs)} ms first audio byte, above the ${budgetMs} ms budget`);
  }
  if (unavailable.length > 0) {
    blockers.push(`candidate benchmark incomplete; missing credentials for ${unavailable.map((candidate) => candidate.providerId).join(", ")}`);
  }

  return {
    budgetMs,
    selected: blockers.length === 0 ? winner : null,
    fastestMeasured: winner,
    measured,
    unavailable,
    blockers,
  };
}

async function measureFirstAudioChunk(provider: CandidateProvider, text: string): Promise<Measurement> {
  const started = performance.now();
  const stream = await provider.speak(text, { voice: provider.voice });
  const reader = stream.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        throw new Error(`${provider.label} ended before first audio chunk`);
      }
      if (chunk.value.byteLength > 0) {
        return {
          providerId: provider.id,
          label: provider.label,
          model: provider.model,
          voice: provider.voice,
          firstAudioByteMs: performance.now() - started,
          firstChunkBytes: chunk.value.byteLength,
          contentType: provider.lastContentType,
        };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function assertProviderContract(provider: TTSProvider, text: string): Promise<void> {
  const stream = await provider.speak(text);
  expect(stream).toBeInstanceOf(ReadableStream);
  const reader = stream.getReader();
  try {
    const chunk = await reader.read();
    expect(chunk.done).toBe(false);
    const value = chunk.value;
    expect(value).toBeInstanceOf(Uint8Array);
    expect(value?.byteLength ?? 0).toBeGreaterThan(0);
  } finally {
    reader.releaseLock();
  }
}

async function preCacheStatePhrases(provider: CandidateProvider): Promise<StaticClipCache> {
  const cache = new StaticClipCache();
  const clips = [];
  for (const phrase of STATE_PHRASES) {
    const bytes = await readAllBytes(await provider.speak(phrase, { voice: provider.voice }));
    expect(bytes.byteLength).toBeGreaterThan(0);
    clips.push({ phrase, bytes });
  }
  await cache.preload(clips);
  await appendTrace("tts.precache.completed", {
    providerId: provider.id,
    phraseCount: clips.length,
    clips: clips.map((clip) => ({ phrase: clip.phrase, bytes: clip.bytes.byteLength })),
  });
  return cache;
}

async function readAllBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value.byteLength > 0) {
        chunks.push(chunk.value);
        total += chunk.value.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function guardTtsText(input: string): { text: string; wordCount: number; summarized: boolean } {
  const scrubbed = input
    .replace(/https?:\/\/\S+/giu, "link")
    .replace(/\b[\w./-]+\.(?:ts|tsx|js|json|md|html|css)\b/giu, "file")
    .replace(/[+-]diff\b/giu, "diff")
    .replace(/^[+-].*$/gmu, "diff");
  const words = scrubbed.match(/\b[\p{L}\p{N}][\p{L}\p{N}'-]*\b/gu) ?? [];
  if (words.length <= 15) {
    return { text: scrubbed.trim(), wordCount: words.length, summarized: false };
  }

  const summaryWords = ["Update", "is", "ready", "with", "details", "summarized", "for", "review"];
  return { text: summaryWords.join(" "), wordCount: summaryWords.length, summarized: true };
}

function sixteenWordPayload(): string {
  return "Please read src/audio/output-policy.ts and https://example.com then +diff every changed line back to me today.";
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function firstEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function firstAudioBudgetMs(): number {
  return Number(process.env.PANOP_TTS_FIRST_AUDIO_BUDGET_MS ?? DEFAULT_FIRST_AUDIO_BUDGET_MS);
}

async function writeVerdict(green: boolean, summary: string): Promise<void> {
  await writeJson(join(PROBE_ROOT, "verdict.json"), {
    green,
    ticketId: PROBE_ID,
    summary,
  });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function appendTrace(event: string, fields: Record<string, unknown>): Promise<void> {
  await mkdir(TRACE_ROOT, { recursive: true });
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level: "info",
    correlationId: "p-tts-streaming-selection",
    event,
    ...fields,
  });
  await appendFile(TRACE_PATH, `${line}\n`, "utf8");
}

function summarizeSelection(selection: SelectionRecord | undefined, fallback: string): string {
  if (selection === undefined) {
    return fallback;
  }
  const unavailable = selection.unavailable.length === 0 ? "all candidates configured" : `unconfigured: ${selection.unavailable.map((item) => item.providerId).join(", ")}`;
  if (selection.selected === null) {
    const fastest = selection.fastestMeasured === null ? "no measured provider" : `${selection.fastestMeasured.label} at ${Math.round(selection.fastestMeasured.firstAudioByteMs)} ms`;
    return `P-TTS remains blocked: no selected provider; fastest measured ${fastest}; ${unavailable}; no key-shaped strings in probe artifacts.`;
  }
  return `P-TTS selected ${selection.selected.label} at ${Math.round(selection.selected.firstAudioByteMs)} ms first audio byte; ${unavailable}; five fixed state phrases pre-cached for <100 ms playback; no key-shaped strings in probe artifacts.`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
