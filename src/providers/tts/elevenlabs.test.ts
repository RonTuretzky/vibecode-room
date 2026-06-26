import { describe, expect, test } from "bun:test";
import { scanSecretLikeText } from "../../security/secrets";
import {
  ElevenLabsFlashTTSProvider,
  createElevenLabsFlashTTSFromEnv,
  type TTSTransport,
  type TTSTransportRequest,
} from "./elevenlabs";

describe("P-TTS ElevenLabs Flash streaming provider", () => {
  test("[unit] speak() streams synthetic audio bytes and the request carries the input text and voice", async () => {
    const requests: TTSTransportRequest[] = [];
    const synthetic = [Uint8Array.from([0x49, 0x44, 0x33]), Uint8Array.from([0x10, 0x20, 0x30, 0x40])];
    const transport: TTSTransport = async (request) => {
      requests.push(request);
      return streamOf(synthetic);
    };

    const provider = new ElevenLabsFlashTTSProvider({
      env: { ELEVENLABS_API_KEY: fakeElevenLabsKey() },
      transport,
    });

    const stream = await provider.speak("Build the thinnest walking skeleton.", { voice: "voice-xyz-001" });
    expect(stream).toBeInstanceOf(ReadableStream);

    const chunks = await readAll(stream);
    expect(totalBytes(chunks)).toBeGreaterThan(0);
    expect(concat(chunks)).toEqual(Uint8Array.from([0x49, 0x44, 0x33, 0x10, 0x20, 0x30, 0x40]));

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request.method).toBe("POST");
    expect(request.url).toContain("/v1/text-to-speech/voice-xyz-001/stream");
    expect(request.url).toContain("optimize_streaming_latency=");
    expect(request.headers["xi-api-key"]).toBe(fakeElevenLabsKey());
    const payload = JSON.parse(request.body) as { text: string; model_id: string };
    expect(payload.text).toBe("Build the thinnest walking skeleton.");
    expect(payload.model_id).toContain("flash");
  });

  test("[unit] first audio chunk is readable before synthesis completes (non-blocking stream)", async () => {
    let produced = 0;
    const total = 3;
    const transport: TTSTransport = async () =>
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (produced >= total) {
              controller.close();
              return;
            }
            produced += 1;
            controller.enqueue(Uint8Array.from([produced]));
          },
        },
        { highWaterMark: 0 },
      );

    const provider = new ElevenLabsFlashTTSProvider({
      env: { ELEVENLABS_API_KEY: fakeElevenLabsKey() },
      transport,
    });

    const stream = await provider.speak("partial synthesis");
    const reader = stream.getReader();
    try {
      const first = await reader.read();
      expect(first.done).toBe(false);
      expect(first.value?.byteLength).toBeGreaterThan(0);
      // Only the first chunk has been pulled; the rest of synthesis is still pending.
      expect(produced).toBeLessThan(total);
    } finally {
      reader.releaseLock();
      await stream.cancel().catch(() => {});
    }
  });

  test("[integration] honors the audio credential seam: missing/ambiguous sources rejected, stubbed path succeeds", async () => {
    // Rejected: no credential present in the environment at all.
    expect(() => new ElevenLabsFlashTTSProvider({ env: {} })).toThrow(/ELEVENLABS_API_KEY/u);

    // Rejected: an ambiguous, non-token value under a non-credential variable is
    // refused by createAudioCredentialSource — no raw/ambiguous inline keys.
    expect(() => new ElevenLabsFlashTTSProvider({ env: { TTS_KEY: "nope" }, variable: "TTS_KEY" })).toThrow(
      /does not look like a provider token/u,
    );

    // Stubbed path: a sanctioned token-shaped credential yields a redacted
    // environment credential source and a working byte stream — no real network.
    const provider = new ElevenLabsFlashTTSProvider({
      env: { ELEVENLABS_API_KEY: fakeElevenLabsKey() },
      transport: async () => streamOf([Uint8Array.from([1, 2, 3, 4])]),
    });

    expect(provider.credentialSource).toEqual({
      kind: "environment",
      provider: "tts",
      variable: "ELEVENLABS_API_KEY",
      redacted: true,
    });
    // The descriptor records provenance only — never the raw key value.
    expect(scanSecretLikeText(JSON.stringify(provider.credentialSource))).toEqual([]);

    const stream = await provider.speak("hello");
    expect(totalBytes(await readAll(stream))).toBeGreaterThan(0);
  });

  test("[integration] createElevenLabsFlashTTSFromEnv self-skips without the key and wires the provider when present", () => {
    const skipped = createElevenLabsFlashTTSFromEnv({});
    expect(skipped.provider).toBeNull();
    expect(skipped.skippedReason).toContain("ELEVENLABS_API_KEY");
    expect(skipped.credentialSource).toEqual({
      kind: "environment",
      provider: "tts",
      variable: "ELEVENLABS_API_KEY",
      redacted: true,
    });

    const configured = createElevenLabsFlashTTSFromEnv(
      { ELEVENLABS_API_KEY: fakeElevenLabsKey() },
      async () => streamOf([Uint8Array.from([9])]),
    );
    expect(configured.provider).toBeInstanceOf(ElevenLabsFlashTTSProvider);
    expect(configured.skippedReason).toBeNull();
  });

  test("[unit] speak() rejects empty text before touching the transport", async () => {
    let touched = false;
    const provider = new ElevenLabsFlashTTSProvider({
      env: { ELEVENLABS_API_KEY: fakeElevenLabsKey() },
      transport: async () => {
        touched = true;
        return streamOf([Uint8Array.from([0])]);
      },
    });

    await expect(provider.speak("   ")).rejects.toThrow(/non-empty text/u);
    expect(touched).toBe(false);
  });
});

function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return chunks;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

function totalBytes(chunks: readonly Uint8Array[]): number {
  return chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(totalBytes(chunks));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// Built at runtime (never a literal) so the source tree stays free of key-shaped strings.
function fakeElevenLabsKey(): string {
  return ["xi", `${"a".repeat(18)}1${"b".repeat(18)}`].join("-");
}
