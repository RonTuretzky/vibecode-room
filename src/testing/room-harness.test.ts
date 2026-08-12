import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FORBIDDEN_PORTS, findFreePort, MIC_FRAME_BYTES, MIC_FRAME_MS, parseSseBlock, readLedger, serverEnv } from "./room-harness";

// Only the PURE parts are covered here — booting a server belongs to the
// browser suite (e2e/*.live-pw.ts), which is what actually drives the room.
// These tests exist because the harness's safety properties (never touch the
// live room's port, never inherit real credentials) must not be able to
// regress silently.

const baseInput = {
  repoRoot: "/repo",
  port: 8901,
  binDir: "/tmp/bin",
  scriptPath: "/tmp/script.json",
  ledgerPath: "/tmp/ledger.jsonl",
  options: {},
};

describe("room harness safety", () => {
  test("the live room's port is refused outright", () => {
    expect(FORBIDDEN_PORTS.has(8788)).toBe(true);
    expect(FORBIDDEN_PORTS.has(8787)).toBe(true);
    expect(FORBIDDEN_PORTS.has(7331)).toBe(true);
  });

  test("free-port search never returns a forbidden port", async () => {
    const port = await findFreePort(8786);
    expect(FORBIDDEN_PORTS.has(port)).toBe(false);
  });

  test("every credential a stray .env could supply is explicitly blanked", () => {
    const env = serverEnv(baseInput);
    for (const key of [
      "DEEPGRAM_API_KEY",
      "ANTHROPIC_API_KEY",
      "CEREBRAS_API_KEY",
      "ELEVENLABS_API_KEY",
      "VIBERSYN_GITHUB_PAT",
      "GITHUB_PAT",
      "GH_TOKEN",
      "VIBERSYN_SALEM_SID",
      "VIBERSYN_SMITHERS_GATEWAY_URL",
      "VIBERSYN_DEPLOY_MAP",
      "LANGFUSE_OTLP_ENDPOINT",
    ]) {
      expect(env[key], `${key} must be blanked, not inherited`).toBe("");
    }
  });

  test("the boot hazards are neutralized: no LAN listener, no pinned GitHub clone", () => {
    const env = serverEnv(baseInput);
    // A non-empty VIBERSYN_PINNED_IMPORTS default clones khalildh/handstrudel
    // at every boot (src/server/index.ts); "" (not unset) disables it.
    expect(env.VIBERSYN_PINNED_IMPORTS).toBe("");
    expect(env.VIBERSYN_PHONE_LISTENER).toBe("0");
    expect(env.HOST).toBe("127.0.0.1");
  });

  test("nothing may write a repo, open a PR, or spawn an agent CLI", () => {
    const env = serverEnv(baseInput);
    expect(env.VIBERSYN_TREE_GIT).toBe("0");
    expect(env.VIBERSYN_STEER_APPLIER).toBe("0");
    expect(env.VIBERSYN_AUTO_ACCEPT).toBe("0");
    expect(env.VIBERSYN_IDEA_DETECTOR).toBe("heuristic");
    expect(env.VIBERSYN_DECISION_LLM).toBe("heuristic");
  });

  test("the injector shim directory is first on PATH", () => {
    const env = serverEnv(baseInput);
    expect(env.PATH.startsWith("/tmp/bin:")).toBe(true);
    expect(env.VIBERSYN_ASR_PROVIDER).toBe("voxterm");
    expect(env.VIBERSYN_FAKE_VOXTERM_SCRIPT).toBe("/tmp/script.json");
  });

  test("caller overrides win, so a scenario can flip a gate back on", () => {
    const env = serverEnv({ ...baseInput, options: { env: { VIBERSYN_TREE_GIT: "1" } } });
    expect(env.VIBERSYN_TREE_GIT).toBe("1");
  });
});

describe("harness plumbing", () => {
  test("PCM framing matches the browser's own capture framing", () => {
    // src/ui/mic.ts: ScriptProcessorNode(4096) at 16kHz mono 16-bit.
    expect(MIC_FRAME_BYTES).toBe(8_192);
    expect(MIC_FRAME_MS).toBe(256);
  });

  test("SSE blocks parse into named, sized, timestamped frames", () => {
    const frame = parseSseBlock('event: snapshot\ndata: {"a":1}', 1_234);
    expect(frame).toEqual({ event: "snapshot", data: '{"a":1}', atMs: 1_234, bytes: 29 });
  });

  test("a comment-only SSE block (the keepalive) is not counted as a frame", () => {
    expect(parseSseBlock(": keepalive", 1)).toBeNull();
  });

  test("the emit ledger tolerates a torn trailing line", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-"));
    const path = join(dir, "ledger.jsonl");
    writeFileSync(
      path,
      '{"utteranceId":"u1","text":"one","final":true,"emittedAtMs":5}\n{"utteranceId":"u2","text":"tw',
    );
    const records = readLedger(path);
    expect(records).toHaveLength(1);
    expect(records[0]!.text).toBe("one");
  });

  test("a missing ledger reads as no speech rather than throwing", () => {
    expect(readLedger("/nonexistent/ledger.jsonl")).toEqual([]);
  });
});
