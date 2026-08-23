import { describe, expect, test } from "bun:test";
import {
  TRANSCRIPT_RESTORE_WINDOW_MS,
  TRANSCRIPT_STORE_CAP,
  TranscriptStore,
  type StoredTranscriptLine,
} from "./transcript-store";

// An in-memory fs: the store's whole seam surface, no disk.
function fakeFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  return {
    files,
    read: (path: string) => {
      const body = files.get(path);
      if (body === undefined) {
        throw new Error("ENOENT");
      }
      return body;
    },
    write: (path: string, body: string) => void files.set(path, body),
    rename: (from: string, to: string) => {
      const body = files.get(from);
      if (body === undefined) {
        throw new Error("ENOENT");
      }
      files.set(to, body);
      files.delete(from);
    },
  };
}

const line = (text: string, atMs: number): StoredTranscriptLine => ({
  time: "12:00:00",
  speaker: "speaker_1",
  text,
  kind: "room",
  atMs,
});

describe("the conversation survives the self reload", () => {
  test("round trip: appended finals come back on the next boot", () => {
    const fs = fakeFs();
    const now = 1_000_000_000;
    const first = new TranscriptStore({ path: "p.json", clock: () => now, ...fs });
    first.append(line("we should build a birdhouse app", now - 5_000));
    first.append(line("with a webcam feed", now - 2_000));
    first.dispose(); // flushes synchronously

    const second = new TranscriptStore({ path: "p.json", clock: () => now + 15_000, ...fs });
    expect(second.restore().map((entry) => entry.text)).toEqual([
      "we should build a birdhouse app",
      "with a webcam feed",
    ]);
  });

  test("a stale file is a previous SESSION, not a reload: restores nothing", () => {
    const fs = fakeFs();
    const spoke = 1_000_000_000;
    const first = new TranscriptStore({ path: "p.json", clock: () => spoke, ...fs });
    first.append(line("old evening", spoke));
    first.dispose();

    const later = spoke + TRANSCRIPT_RESTORE_WINDOW_MS + 60_000;
    const second = new TranscriptStore({ path: "p.json", clock: () => later, ...fs });
    expect(second.restore()).toEqual([]);
  });

  test("missing or corrupt files restore nothing and never throw", () => {
    const fs = fakeFs({ "corrupt.json": "{not json" });
    expect(new TranscriptStore({ path: "absent.json", ...fs }).restore()).toEqual([]);
    expect(new TranscriptStore({ path: "corrupt.json", ...fs }).restore()).toEqual([]);
  });

  test("the store is bounded: only the freshest CAP lines persist", () => {
    const fs = fakeFs();
    const now = 2_000_000_000;
    const store = new TranscriptStore({ path: "p.json", clock: () => now, ...fs });
    for (let index = 0; index < TRANSCRIPT_STORE_CAP + 25; index += 1) {
      store.append(line(`line ${index}`, now - 1_000 + index));
    }
    store.dispose();
    const restored = new TranscriptStore({ path: "p.json", clock: () => now + 1_000, ...fs }).restore();
    expect(restored.length).toBe(TRANSCRIPT_STORE_CAP);
    expect(restored[0]!.text).toBe("line 25");
  });

  test("writes are atomic: the tmp file never survives a completed flush", () => {
    const fs = fakeFs();
    const store = new TranscriptStore({ path: "p.json", clock: () => 3_000_000_000, ...fs });
    store.append(line("hello", 3_000_000_000));
    store.dispose();
    expect(fs.files.has("p.json")).toBe(true);
    expect(fs.files.has("p.json.tmp")).toBe(false);
  });
});
