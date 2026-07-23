import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectorRuntime, type ProjectorRuntime } from "./composition";
import type { TranscriptObservation } from "../types";

// FULL voice grammar wiring (src/routing/dispatch -> live runtime): every
// non-wake, non-callsign-addressed FINAL runs through the documented command
// set — pause all / status / targeted pause / stop safety consumption — and
// executes against the REAL ProcessRegistry. The seeded demo fleet
// (atlas/cobalt) provides live processes; replay ASR drives the mic path with
// no network, device, or model spawn.

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("voice grammar (routing/dispatch) drives the live registry", () => {
  test("'pause all' pauses every seeded process", async () => {
    const { runtime, drive } = await makeRuntime();
    expect(runtime.registry.activeRecords()).toHaveLength(2);

    await drive([final("pause all", "utt-pause-all")]);

    const states = runtime.registry.records().map((record) => record.state);
    expect(states).toEqual(["paused", "paused"]);
  });

  test("bare 'status' speaks the real fleet summary (output.tts trace)", async () => {
    const { runtime, drive } = await makeRuntime();

    await drive([final("status", "utt-status")]);

    const spoken = runtime.trace
      .events()
      .filter((event) => event.event === "output.tts")
      .map((event) => String(event.meta.text).toLowerCase());
    expect(spoken.some((text) => text.includes("atlas"))).toBe(true);
  });

  test("an ambient mention of 'status' is NOT hijacked (falls through to detection)", async () => {
    const { runtime, drive } = await makeRuntime();

    await drive([final("let's build a status board to track the migration dry run", "utt-ambient-status")]);

    // No spoken fleet summary — the utterance stayed room material.
    const spoken = runtime.trace
      .events()
      .filter((event) => event.event === "output.tts")
      .map((event) => String(event.meta.text).toLowerCase());
    expect(spoken.some((text) => text.includes("atlas"))).toBe(false);
  });

  test("a mid-sentence callsign pause routes to that process only", async () => {
    const { runtime, drive } = await makeRuntime();

    // "atlas" sits past the fuzzy start-anchored matcher's window, so this
    // reaches the grammar's exact-token callsign path.
    await drive([final("could you please tell atlas to pause", "utt-atlas-pause")]);

    const atlas = runtime.registry.records().find((record) => record.callsign.toLowerCase() === "atlas");
    const cobalt = runtime.registry.records().find((record) => record.callsign.toLowerCase() === "cobalt");
    expect(atlas?.state).toBe("paused");
    expect(cobalt?.state).not.toBe("paused");
  });

  test("a bare safety 'stop' while click-steering is consumed, never leaked as steer text", async () => {
    const { runtime, drive } = await makeRuntime();
    const atlas = runtime.registry.records().find((record) => record.callsign.toLowerCase() === "atlas");
    expect(atlas).toBeDefined();
    if (atlas === undefined) return;
    runtime.setSteeringTarget(atlas.upid, "corr-grammar-steer-select");

    await drive([final("stop", "utt-stop")]);

    // The grammar consumed the safety word (addressed near-miss with no
    // unambiguous target): no steer reached the process's agent loop, and the
    // process was not halted either (no callsign/window resolved a target).
    const steers = runtime.trace.events().filter((event) => event.event === "process.steer");
    expect(steers).toHaveLength(0);
    expect(runtime.registry.records().find((record) => record.upid === atlas.upid)?.state).not.toBe("dead");
  });

  test("'vibersyn build ot' offers the near-miss soft landing (voice.nearmiss + spoken prompt)", async () => {
    const { runtime, drive } = await makeRuntime();

    await drive([final("vibersyn build ot", "utt-nearmiss")]);

    const near = runtime.trace.events().filter((event) => event.event === "voice.nearmiss");
    expect(near).toHaveLength(1);
    expect(String(near[0]?.meta.suggestion)).toContain("build it");
    const spoken = runtime.trace
      .events()
      .filter((event) => event.event === "output.tts")
      .map((event) => String(event.meta.text));
    expect(spoken.some((text) => text.includes("build it"))).toBe(true);
  });
});

// --- harness (mirrors composition.test.ts) -----------------------------------

async function makeRuntime(): Promise<{ runtime: ProjectorRuntime; drive: (obs: TranscriptObservation[]) => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "vibersyn-grammar-"));
  tempDirs.push(dir);
  const path = join(dir, "mic.jsonl");
  writeFileSync(path, "", "utf8");
  const runtime = await createProjectorRuntime(
    {
      VIBERSYN_INITIAL_MUTED: "0",
      VIBERSYN_MIC_REPLAY_PATH: path,
      VIBERSYN_SEED_DEMO_FLEET: "1",
      // Deterministic detection: heuristic detector, eager schedule, no tick.
      VIBERSYN_IDEA_DETECTOR: "heuristic",
      VIBERSYN_DETECT_MIN_NEW_TURNS: "1",
      VIBERSYN_DETECT_MIN_INTERVAL_MS: "0",
      VIBERSYN_DETECT_TICK_MS: "0",
    },
    { buildsRoot: join(dir, "builds"), builderAgent: async () => undefined },
  );
  const drive = async (obs: TranscriptObservation[]): Promise<void> => {
    writeFileSync(path, obs.map((entry) => JSON.stringify(entry)).join("\n"), "utf8");
    const session = runtime.startMicSession("corr-grammar-mic");
    await session.stop();
    await runtime.detection.flush();
  };
  return { runtime, drive };
}

function final(text: string, utteranceId: string): TranscriptObservation {
  return { text, isFinal: true, speaker: "Room", sessionId: "grammar-session", latencyMs: 20, utteranceId };
}
