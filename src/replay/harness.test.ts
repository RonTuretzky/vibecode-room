import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import {
  ReplayDecisionCache,
  assertAiOutputInvariants,
  canonicalJson,
  runReplayHarness,
  stableHash,
  type DecisionInput,
  type DecisionLLM,
  type ReplayTraceEvent,
} from "./harness";
import type { TranscriptObservation } from "../types";

interface HarnessOutput {
  route: "observe.pass" | "suggestion.fire";
  pitch?: string;
  mcqs: string[];
  text: string;
  firedAtMs: number;
}

describe("ENG-T-02 record-replay harness", () => {
  test("feeding the same JSONL twice through temp-0 decision doubles yields byte-identical streams", async () => {
    const path = await writeFixture(observations());
    const first = await runReplayHarness(path, deterministicDecisionLlm());
    const second = await runReplayHarness(path, deterministicDecisionLlm());

    expect(second.jsonl).toBe(first.jsonl);
    expect(second.records.map((record) => record.ioHash)).toEqual(first.records.map((record) => record.ioHash));
    expect(first.records).toHaveLength(4);
    expect(first.records.every((record) => record.input.temperature === 0)).toBe(true);
    expect(first.records.every((record) => /^[a-f0-9]{64}$/u.test(record.ioHash))).toBe(true);
  });

  test("input to output hashes are stable and derived from canonical JSON", async () => {
    const path = await writeFixture(observations());
    const result = await runReplayHarness(path, deterministicDecisionLlm());

    for (const record of result.records) {
      expect(record.inputHash).toBe(stableHash(record.input));
      expect(record.outputHash).toBe(stableHash(record.output));
      expect(record.ioHash).toBe(stableHash({ inputHash: record.inputHash, outputHash: record.outputHash }));
      expect(canonicalJson(record)).toBe(JSON.stringify(JSON.parse(canonicalJson(record))));
    }
  });

  test("cached re-runs return deterministic output without invoking a changed or unavailable LLM", async () => {
    const path = await writeFixture(observations());
    const cache = new ReplayDecisionCache();
    const first = await runReplayHarness(path, deterministicDecisionLlm(), { cache });
    let calls = 0;
    const unavailableLlm: DecisionLLM<HarnessOutput> = {
      decide() {
        calls += 1;
        throw new Error("cache miss reached the decision LLM");
      },
    };
    const second = await runReplayHarness(path, unavailableLlm, { cache });

    expect(second.jsonl).toBe(first.jsonl);
    expect(second.records.map(({ cacheHit }) => cacheHit)).toEqual([true, true, true, true]);
    expect(second.records.map(({ outputHash }) => outputHash)).toEqual(first.records.map(({ outputHash }) => outputHash));
    expect(calls).toBe(0);
    expect(cache.size()).toBe(4);
  });

  test("trace events are structured and carry replay correlation hashes for every decision", async () => {
    const path = await writeFixture(observations());
    const trace: ReplayTraceEvent[] = [];
    const result = await runReplayHarness(path, deterministicDecisionLlm(), {
      trace: (event) => trace.push(event),
    });

    expect(trace).toHaveLength(result.records.length);
    for (const [index, event] of trace.entries()) {
      expect(event).toMatchObject({
        level: "info",
        event: "replay.decision",
        sessionId: result.records[index]?.observation.sessionId,
        meta: {
          utteranceId: result.records[index]?.observation.utteranceId,
          observationIndex: index,
          inputHash: result.records[index]?.inputHash,
          outputHash: result.records[index]?.outputHash,
          ioHash: result.records[index]?.ioHash,
          temperature: 0,
        },
      });
      expect(event.correlationId).toStartWith("replay-");
    }
  });

  test("empty JSONL is a deterministic no-op stream", async () => {
    const path = await writeFixture([]);
    const result = await runReplayHarness(path, deterministicDecisionLlm());

    expect(result.records).toEqual([]);
    expect(result.jsonl).toBe("");
  });

  test("AI-output invariant helpers reject over-limit MCQs and word counts without exact text assertions", () => {
    const relaxedLimits =
      process.env.PANOPTICON_RBG_RELAX_INVARIANTS === "1" ? { maxMcqs: 4, maxWords: 16 } : undefined;

    expect(() =>
      assertAiOutputInvariants({
        mcqs: ["one", "two", "three", "four"],
        text: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen",
        firedAtMs: 20,
      }, relaxedLimits),
    ).toThrow(/MCQs|words/u);
  });

  test("AI-output invariant helpers accept boundary values and reject budget overruns", () => {
    expect(() =>
      assertAiOutputInvariants({
        mcqs: ["one", "two", "three"],
        text: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen",
        firedAtMs: 100,
      }, { budgetMs: 100 }),
    ).not.toThrow();

    expect(() =>
      assertAiOutputInvariants({
        mcqs: [],
        text: "short status",
        firedAtMs: 101,
      }, { budgetMs: 100 }),
    ).toThrow(/budget|fired/u);
  });
});

function deterministicDecisionLlm(): DecisionLLM<HarnessOutput> {
  return {
    decide(input: DecisionInput): HarnessOutput {
      if (process.env.PANOPTICON_RBG_NONDETERMINISTIC === "1") {
        return {
          route: "suggestion.fire",
          pitch: "Build a replay harness",
          mcqs: ["Which fixture?"],
          text: `nondeterministic ${Math.random()}`,
          firedAtMs: Date.now() % 1000,
        };
      }

      const wordCount = input.observation.text.trim().split(/\s+/u).filter(Boolean).length;
      if (wordCount < 8 || !input.observation.isFinal) {
        return {
          route: "observe.pass",
          mcqs: [],
          text: "silent",
          firedAtMs: input.observation.latencyMs,
        };
      }

      return {
        route: "suggestion.fire",
        pitch: "Build a replay harness",
        mcqs: ["Which fixture?", "Which route?"],
        text: "Replay suggests one scoped build path",
        firedAtMs: input.observation.latencyMs,
      };
    },
  };
}

async function writeFixture(items: TranscriptObservation[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "panopticon-replay-"));
  const path = join(dir, "transcript.jsonl");
  await writeFile(path, items.map((item) => JSON.stringify(item)).join("\n"), "utf8");
  cleanupDirs.add(dir);
  return path;
}

const cleanupDirs = new Set<string>();

afterEach(async () => {
  for (const dir of cleanupDirs) {
    await rm(dir, { recursive: true, force: true });
    cleanupDirs.delete(dir);
  }
});

function observations(): TranscriptObservation[] {
  return [
    {
      text: "short ambient",
      isFinal: true,
      speaker: "speaker-1",
      sessionId: "replay-session",
      latencyMs: 12,
      utteranceId: "utt-001",
    },
    {
      text: "We should build a deterministic replay harness for the decision loop",
      isFinal: true,
      speaker: "speaker-2",
      sessionId: "replay-session",
      latencyMs: 47,
      utteranceId: "utt-002",
    },
    {
      text: "partial thought about Panop",
      isFinal: false,
      speaker: null,
      sessionId: "replay-session",
      latencyMs: 8,
      utteranceId: "utt-003",
    },
    {
      text: "This later utterance should carry prior output hash context deterministically",
      isFinal: true,
      speaker: "speaker-1",
      sessionId: "replay-session",
      latencyMs: 64,
      utteranceId: "utt-004",
    },
  ];
}
