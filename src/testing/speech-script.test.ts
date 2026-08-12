import { describe, expect, test } from "bun:test";
import { MIC_ENDPOINTING_BASE_MS } from "../server/composition";
import {
  compileScript,
  cumulativeInterims,
  DEFAULT_ENDPOINT_MS,
  DEFAULT_INTERIM_EVERY_MS,
  say,
} from "./speech-script";

describe("speech script compiler", () => {
  test("the default endpointing gap is the room's own endpointing target", () => {
    // The compiler mirrors this constant instead of importing it at module
    // scope; if the room retunes its VAD, this test is the tripwire.
    expect(DEFAULT_ENDPOINT_MS).toBe(MIC_ENDPOINTING_BASE_MS);
  });

  test("interims are cumulative word prefixes and exclude the committed text", () => {
    expect(cumulativeInterims("build a status wall")).toEqual(["build", "build a", "build a status"]);
  });

  test("a single sentence compiles to interims then one final after the endpointing gap", () => {
    const compiled = compileScript(say("build a status wall"));
    const finals = compiled.frames.filter((frame) => frame.final);
    const interims = compiled.frames.filter((frame) => !frame.final);

    expect(interims).toHaveLength(3);
    expect(finals).toHaveLength(1);
    expect(finals[0]!.text).toBe("build a status wall");
    expect(compiled.finals).toEqual(["build a status wall"]);
    // Last interim at 3 × 220ms, then the 900ms endpointing silence.
    expect(interims[2]!.atMs).toBe(3 * DEFAULT_INTERIM_EVERY_MS);
    expect(finals[0]!.atMs).toBe(3 * DEFAULT_INTERIM_EVERY_MS + DEFAULT_ENDPOINT_MS);
  });

  test("every interim of an utterance shares the final's utteranceId", () => {
    const compiled = compileScript(say("one two three"));
    const ids = new Set(compiled.frames.map((frame) => frame.utteranceId));
    expect(ids.size).toBe(1);
  });

  test("frames are monotonically ordered and a pause pushes the next utterance out", () => {
    const compiled = compileScript({
      utterances: [{ text: "first line here" }, { text: "second line here", pauseBeforeMs: 2_000 }],
    });
    const times = compiled.frames.map((frame) => frame.atMs);
    expect([...times].sort((a, b) => a - b)).toEqual(times);

    const finals = compiled.frames.filter((frame) => frame.final);
    expect(finals[1]!.atMs - finals[0]!.atMs).toBeGreaterThanOrEqual(2_000);
  });

  test("speaker is omitted by default — production never asks for diarization", () => {
    // src/providers/asr/deepgram.ts connectionUrl() sets diarize_model but never
    // diarize=true, so every real line lands on the wall as "Room". A default
    // script that stamped speakers would be testing a room that does not exist.
    const compiled = compileScript(say("nobody is labelled"));
    expect(compiled.frames.every((frame) => frame.speaker === undefined)).toBe(true);

    const labelled = compileScript({ utterances: [{ text: "labelled line", speaker: 1 }] });
    expect(labelled.frames.every((frame) => frame.speaker === 1)).toBe(true);
  });

  test("midFinalsEveryWords reproduces the mid-sentence is_final fragments the room really receives", () => {
    const compiled = compileScript({
      utterances: [{ text: "one two three four five six", midFinalsEveryWords: 2 }],
    });
    const finals = compiled.frames.filter((frame) => frame.final);
    // Two fragments (after words 2 and 4) plus the committed whole.
    expect(finals.map((frame) => frame.text)).toEqual(["one two", "three four", "one two three four five six"]);
    // Fragments carry their own utterance ids: the room cannot tell they belong
    // to one sentence, which is exactly the production behaviour under test.
    expect(new Set(finals.map((frame) => frame.utteranceId)).size).toBe(3);
  });

  test("interims: [] models a recognizer that only commits", () => {
    const compiled = compileScript({ utterances: [{ text: "silent partials", interims: [] }] });
    expect(compiled.frames).toHaveLength(1);
    expect(compiled.frames[0]!.final).toBe(true);
  });

  test("duration covers the last frame plus the tail silence", () => {
    const compiled = compileScript({ utterances: [{ text: "one two" }], tailSilenceMs: 1_500 });
    const last = compiled.frames[compiled.frames.length - 1]!;
    expect(compiled.durationMs).toBe(last.atMs + 1_500);
  });

  test("an empty utterance is a scripting error, not a silent no-op", () => {
    expect(() => compileScript({ utterances: [{ text: "   " }] })).toThrow(/empty text/u);
  });
});
