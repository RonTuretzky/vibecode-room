// e2e: a registry-selected TTS provider behaves correctly for each backend, with
// zero network. The registry is exercised exactly as a consumer would: through
// the providers barrel, by VIBERSYN_TTS_PROVIDER, returning only the TTSProvider
// seam.
//
//   - noop selection records the phrase (silent-but-recorded) and yields an
//     empty audio stream — offline/replay stays quiet.
//   - elevenlabs selection (stubbed transport) streams synthetic bytes through
//     speak(), proving the real provider is wired without opening a socket.

import { describe, expect, test } from "bun:test";
import {
  NoopTTSProvider,
  selectTtsProvider,
  type TtsProviderMode,
  type TTSTransport,
} from "../../src/providers";

const phrase = "Viber build the thinnest walking skeleton.";

describe("registry-selected TTS speaks for each backend (e2e)", () => {
  test("noop selection records the phrase and yields an empty audio stream with no network", async () => {
    const fetchCalls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      fetchCalls.push(String(input));
      throw new Error("network is forbidden in the TTS registry e2e");
    }) as unknown as typeof fetch;

    try {
      const selection = selectTtsProvider({ VIBERSYN_TTS_PROVIDER: "noop" });
      expect(selection.mode satisfies TtsProviderMode).toBe("noop");
      expect(selection.provider).toBeInstanceOf(NoopTTSProvider);

      const stream = await selection.provider.speak(phrase, { voice: "noop" });
      const chunks = await readAll(stream);

      // Silent-but-recorded: no bytes, but the phrase is captured.
      expect(totalBytes(chunks)).toBe(0);
      expect((selection.provider as NoopTTSProvider).calls).toEqual([
        { text: phrase, opts: { voice: "noop" } },
      ]);
      expect(fetchCalls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("elevenlabs selection (stubbed) streams synthetic bytes through speak() with no real network", async () => {
    const requests: string[] = [];
    const synthetic = [Uint8Array.from([0x49, 0x44, 0x33]), Uint8Array.from([0x10, 0x20])];
    const transport: TTSTransport = async (request) => {
      requests.push(request.url);
      return streamOf(synthetic);
    };

    const selection = selectTtsProvider(
      { VIBERSYN_TTS_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: fakeElevenLabsKey() },
      { transport },
    );

    expect(selection.mode satisfies TtsProviderMode).toBe("elevenlabs");

    const stream = await selection.provider.speak(phrase, { voice: "voice-xyz-001" });
    const chunks = await readAll(stream);

    expect(totalBytes(chunks)).toBeGreaterThan(0);
    expect(concat(chunks)).toEqual(Uint8Array.from([0x49, 0x44, 0x33, 0x10, 0x20]));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("/v1/text-to-speech/voice-xyz-001/stream");
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
