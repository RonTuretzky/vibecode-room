import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { describe, expect, test } from "bun:test";
import { matchWakeWord } from "../cue/wake-matcher";
import { transcriptObservationSchema, type CueDecision, type TranscriptObservation } from "../types";
import { ReplayASRProvider } from "./asr/replay";
import { ReplayDecisionLLM } from "./llm/replay";
import { NoopTTSProvider } from "./tts/noop";
import type { ASRProvider, DecisionInput, DecisionLLM, TTSProvider } from "./types";

const fixturePath = "fixtures/smoke/transcript.jsonl";

describe("ENG-T-04 provider boundary", () => {
  test("boundary substitution runs a consumer on replay/noop doubles with no mic or network", async () => {
    const fetchCalls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      fetchCalls.push(String(input));
      throw new Error("network is forbidden in provider-boundary tests");
    }) as unknown as typeof fetch;

    try {
      const asr = ReplayASRProvider.fromFile(fixturePath);
      const tts = new NoopTTSProvider();
      const llm = new ReplayDecisionLLM([
        {
          input: decisionInput("We should keep talking through the interface boundary first.", "utt-001"),
          output: decisionOutput(
            "We should keep talking through the interface boundary first.",
            "utt-001",
            matchWakeWord(observation("We should keep talking through the interface boundary first.", "utt-001")),
          ),
        },
        {
          input: decisionInput("Panop build the thinnest walking skeleton.", "utt-002"),
          output: decisionOutput(
            "Panop build the thinnest walking skeleton.",
            "utt-002",
            matchWakeWord(observation("Panop build the thinnest walking skeleton.", "utt-002")),
          ),
        },
      ]);
      const consumer = new ProviderBoundaryConsumer({ asr, tts, llm });

      const result = await consumer.run(emptyAudioStream());

      expect(result.observations).toHaveLength(2);
      expect(result.decisions.map((decision) => decision.kind)).toEqual(["pass", "action"]);
      expect(fetchCalls).toEqual([]);
      expect(asr.streamCalls).toHaveLength(1);
      expect(tts.calls).toEqual([{ text: "Panop build the thinnest walking skeleton.", opts: { voice: "noop" } }]);
      expect(llm.calls).toHaveLength(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("replay ASR yields the exact TranscriptObservation shape promised by the real provider", async () => {
    const asr = ReplayASRProvider.fromFile(fixturePath);
    const observations: TranscriptObservation[] = [];

    for await (const observation of asr.stream(emptyAudioStream())) {
      observations.push(observation);
      expect(transcriptObservationSchema.parse(observation)).toEqual(observation);
      expect(Object.keys(observation).sort()).toEqual([
        "isFinal",
        "latencyMs",
        "sessionId",
        "speaker",
        "text",
        "utteranceId",
      ]);
    }

    expect(observations[0]).toEqual({
      text: "We should keep talking through the interface boundary first.",
      isFinal: true,
      speaker: "speaker-1",
      sessionId: "smoke-session",
      latencyMs: 42,
      utteranceId: "utt-001",
    });
  });

  test("noop TTS records calls and returns an empty audio stream", async () => {
    const tts = new NoopTTSProvider();
    const stream = await tts.speak("Muted", { voice: "test" });
    const chunks = await collectStream(stream);

    expect(tts.calls).toEqual([{ text: "Muted", opts: { voice: "test" } }]);
    expect(chunks).toEqual([]);
  });

  test("replay DecisionLLM is temperature-0 and cached", async () => {
    const input = decisionInput("Panop status please", "utt-002");
    const output = decisionOutput("Panop status please", "utt-002", matchWakeWord(observation("Panop status please", "utt-002")));
    const llm = new ReplayDecisionLLM([{ input, output }]);

    await expect(llm.decide({ ...input, temperature: 1 as 0 })).rejects.toThrow("temperature 0");

    const first = await llm.decide(input);
    const second = await llm.decide(input);

    expect(first).toEqual(output);
    expect(second).toEqual(output);
    expect(llm.calls).toHaveLength(2);
    expect(llm.cacheHits).toHaveLength(1);
  });

  test("architecture lint rejects concrete-provider imports outside src/providers", async () => {
    const violations = await findConcreteProviderImports("src");

    if (process.env.PANOP_RBG_CONCRETE_PROVIDER_IMPORT === "1") {
      violations.push({
        path: "src/consumer/bad.ts",
        specifier: "../providers/asr/replay",
        line: 1,
      });
    }

    expect(violations).toEqual([]);
  });

  test("no bespoke keyword spotter provider is present in the provider boundary", async () => {
    const files = (await sourceFiles("src/providers")).filter((path) => !path.endsWith(".test.ts"));
    const contents = await Promise.all(files.map((path) => readFile(path, "utf8")));

    expect(contents.join("\n")).not.toMatch(/Keyword\s*Spotter/u);
  });
});

interface ProviderBoundaryConsumerProviders {
  asr: ASRProvider;
  tts: TTSProvider;
  llm: DecisionLLM;
}

class ProviderBoundaryConsumer {
  constructor(private readonly providers: ProviderBoundaryConsumerProviders) {}

  async run(audio: ReadableStream<Uint8Array>): Promise<{ observations: TranscriptObservation[]; decisions: CueDecision[] }> {
    const observations: TranscriptObservation[] = [];
    const decisions: CueDecision[] = [];

    for await (const observation of this.providers.asr.stream(audio)) {
      observations.push(observation);
      const output = await this.providers.llm.decide(decisionInput(observation.text, observation.utteranceId));
      decisions.push(output.decision);

      if (output.decision.kind === "action") {
        await this.providers.tts.speak(observation.text, { voice: "noop" });
      }
    }

    return { observations, decisions };
  }
}

function decisionInput(text: string, utteranceId: string): DecisionInput {
  return {
    model: "replay-temp-0",
    temperature: 0,
    correlationId: `corr-smoke-session-${utteranceId}`,
    messages: [{ role: "user", content: text }],
    metadata: { utteranceId },
  };
}

function decisionOutput(text: string, utteranceId: string, decision: CueDecision) {
  return {
    id: `decision-smoke-session-${utteranceId}`,
    model: "replay-temp-0",
    temperature: 0 as const,
    decision,
    raw: { text },
  };
}

function observation(text: string, utteranceId: string): TranscriptObservation {
  return {
    text,
    isFinal: true,
    speaker: "speaker_0",
    sessionId: "smoke-session",
    latencyMs: utteranceId === "utt-001" ? 35 : 47,
    utteranceId,
  };
}

function emptyAudioStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];

  while (true) {
    const read = await reader.read();
    if (read.done) {
      return chunks;
    }
    chunks.push(read.value);
  }
}

interface ImportViolation {
  path: string;
  specifier: string;
  line: number;
}

async function findConcreteProviderImports(root: string): Promise<ImportViolation[]> {
  const files = await sourceFiles(root);
  const violations: ImportViolation[] = [];

  for (const path of files) {
    if (isInsideProviders(path) || path.endsWith(".test.ts")) {
      continue;
    }

    const content = await readFile(path, "utf8");
    const importPattern = /import\s+(?:type\s+)?(?:[^'"]+?\s+from\s+)?["']([^"']+)["']/gu;
    let match: RegExpExecArray | null;
    while ((match = importPattern.exec(content)) !== null) {
      const specifier = match[1];
      if (isConcreteProviderSpecifier(path, specifier)) {
        violations.push({ path, specifier, line: lineNumber(content, match.index) });
      }
    }
  }

  return violations;
}

function isConcreteProviderSpecifier(fromPath: string, specifier: string): boolean {
  if (!specifier.includes("providers")) {
    return false;
  }

  const normalized = specifier.replaceAll("\\", "/");
  if (/providers\/(?:asr|tts|llm)\/(?:replay|noop|deepgram|openai|elevenlabs|cartesia|real)\b/u.test(normalized)) {
    return true;
  }

  if (normalized.startsWith(".")) {
    const resolved = relative(".", join(dirname(fromPath), normalized)).replaceAll(sep, "/");
    return /src\/providers\/(?:asr|tts|llm)\/(?:replay|noop|deepgram|openai|elevenlabs|cartesia|real)\b/u.test(resolved);
  }

  return false;
}

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(path)));
    } else if (entry.isFile() && path.endsWith(".ts")) {
      files.push(path);
    }
  }

  return files;
}

function isInsideProviders(path: string): boolean {
  return path.split(sep).includes("providers");
}

function lineNumber(content: string, index: number): number {
  return content.slice(0, index).split(/\r?\n/u).length;
}
