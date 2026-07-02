import { describe, expect, test } from "bun:test";
import { TranscriptWindow, groundSpan, renderTurns } from "./transcript-window";

describe("TranscriptWindow", () => {
  test("assigns stable, monotonic, zero-padded ids and trims whitespace", () => {
    const w = new TranscriptWindow();
    const a = w.append({ speaker: "speaker_0", text: "  first idea  ", atMs: 0 });
    const b = w.append({ speaker: "speaker_0", text: "second", atMs: 10 });
    expect(a?.id).toBe("turn-0001");
    expect(a?.text).toBe("first idea");
    expect(b?.id).toBe("turn-0002");
  });

  test("ignores empty/whitespace finals (no turn, no id burn)", () => {
    const w = new TranscriptWindow();
    expect(w.append({ speaker: null, text: "   ", atMs: 0 })).toBeNull();
    const real = w.append({ speaker: null, text: "real", atMs: 1 });
    expect(real?.id).toBe("turn-0001");
    expect(w.size()).toBe(1);
  });

  test("prunes by maxTurns but ids keep climbing (never reused)", () => {
    const w = new TranscriptWindow({ maxTurns: 2, maxAgeMs: 1_000_000 });
    w.append({ speaker: null, text: "one", atMs: 0 });
    w.append({ speaker: null, text: "two", atMs: 1 });
    const third = w.append({ speaker: null, text: "three", atMs: 2 });
    expect(w.size()).toBe(2);
    expect(w.turns().map((t) => t.text)).toEqual(["two", "three"]);
    expect(third?.id).toBe("turn-0003");
    expect(w.findTurn("turn-0001")).toBeUndefined();
  });

  test("prunes by age relative to the newest turn", () => {
    const w = new TranscriptWindow({ maxTurns: 100, maxAgeMs: 100 });
    w.append({ speaker: null, text: "old", atMs: 0 });
    w.append({ speaker: null, text: "mid", atMs: 90 });
    w.append({ speaker: null, text: "new", atMs: 250 });
    // cutoff = 250 - 100 = 150 → only "new" (250) survives; mid(90)/old(0) drop.
    expect(w.turns().map((t) => t.text)).toEqual(["new"]);
  });

  test("resolveSpan returns ground-truth quote across an inclusive id range", () => {
    const w = new TranscriptWindow();
    w.append({ speaker: null, text: "a crypto laundromat", atMs: 0 });
    w.append({ speaker: null, text: "with revenue share", atMs: 1 });
    w.append({ speaker: null, text: "and liquid ownership", atMs: 2 });
    const span = w.resolveSpan("turn-0001", "turn-0003");
    expect(span?.quote).toBe("a crypto laundromat with revenue share and liquid ownership");
    expect(span?.turns).toHaveLength(3);
  });

  test("resolveSpan tolerates reversed endpoints and missing ids", () => {
    const w = new TranscriptWindow();
    w.append({ speaker: null, text: "one", atMs: 0 });
    w.append({ speaker: null, text: "two", atMs: 1 });
    expect(w.resolveSpan("turn-0002", "turn-0001")?.quote).toBe("one two");
    expect(w.resolveSpan("turn-0001", "turn-0099")).toBeNull();
  });

  test("groundSpan repairs the quote when ids resolve, else passes through", () => {
    const w = new TranscriptWindow();
    w.append({ speaker: null, text: "real text", atMs: 0 });
    const repaired = groundSpan(w, { startTurnId: "turn-0001", endTurnId: "turn-0001", quote: "hallucinated" });
    expect(repaired.quote).toBe("real text");
    const passthrough = groundSpan(w, { startTurnId: "turn-9999", endTurnId: "turn-9999", quote: "kept" });
    expect(passthrough.quote).toBe("kept");
  });

  test("renderTurns labels each line with its stable id", () => {
    const w = new TranscriptWindow();
    w.append({ speaker: "speaker_0", text: "hello", atMs: 0 });
    w.append({ speaker: null, text: "world", atMs: 1 });
    expect(renderTurns(w.turns())).toBe("[turn-0001] speaker_0: hello\n[turn-0002] speaker: world");
  });
});
