import { describe, expect, test } from "bun:test";
import type { AckId, EarconId } from "../types";
import {
  ACK_SPECS,
  EARCON_SPECS,
  PRERENDERED_ACKS,
  PRERENDERED_EARCONS,
  assertEarconLatency,
  createEarconSink,
  playAck,
  playEarcon,
  zeroCrossingRateCv,
  type AudioOutput,
  type PcmClip,
} from "./earcons";

describe("Layer A earcons and Layer B acks", () => {
  test("all Layer A earcons are prerendered PCM and redesigned compound tones stay under ZCR-CV 0.15", () => {
    for (const id of Object.keys(EARCON_SPECS) as EarconId[]) {
      const clip = PRERENDERED_EARCONS[id];

      expect(clip.id).toBe(id);
      expect(clip.layer).toBe("A");
      expect(clip.kind).toBe("tonal-earcon");
      expect(clip.pcm).toBeInstanceOf(Int16Array);
      expect(clip.pcm.length).toBeGreaterThan(0);
      expect(zeroCrossingRateCv(clip)).toBeLessThan(0.15);
    }
  });

  test("Layer B routing acks are non-tonal, disjoint, and pairwise distinct", () => {
    const fingerprints = new Set<string>();

    for (const id of Object.keys(ACK_SPECS) as AckId[]) {
      const clip = PRERENDERED_ACKS[id];

      expect(clip.id).toBe(id);
      expect(clip.layer).toBe("B");
      expect(clip.kind).toBe("non-tonal-ack");
      expect(PRERENDERED_EARCONS).not.toHaveProperty(id);
      fingerprints.add(fingerprint(clip));
    }

    expect(fingerprints.size).toBe(Object.keys(ACK_SPECS).length);
  });

  test("earcons and acks dispatch prerendered PCM directly to AudioOutput", async () => {
    const output = new RecordingAudioOutput();

    await playEarcon(output, "E1", { correlationId: "corr-earcon" });
    await playAck(output, "route-steer", { correlationId: "corr-ack" });

    expect(output.calls).toEqual([
      expect.objectContaining({ clip: PRERENDERED_EARCONS.E1, meta: { correlationId: "corr-earcon" } }),
      expect.objectContaining({ clip: PRERENDERED_ACKS["route-steer"], meta: { correlationId: "corr-ack" } }),
    ]);
  });

  test("Cue TextCue sink enforces the 300ms hot-plane budget", async () => {
    const output = new RecordingAudioOutput();
    const sink = createEarconSink(output, { now: () => 1_234, maxLatencyMs: 300 });

    await sink.emit({
      id: "E1",
      source: "cue-textcue",
      correlationId: "corr-fast",
      latencyMs: 299,
      matchedWord: "viber",
    });

    expect(output.calls).toHaveLength(1);
    expect(() => assertEarconLatency(301, 300)).toThrow("expected <= 300ms");
  });
});

class RecordingAudioOutput implements AudioOutput {
  readonly calls: Array<{ clip: PcmClip; meta: unknown }> = [];

  playPcm(clip: PcmClip, meta?: unknown): void {
    this.calls.push({ clip, meta });
  }
}

function fingerprint(clip: PcmClip): string {
  return `${clip.durationMs}:${Array.from(clip.pcm.slice(0, 256)).join(",")}`;
}
