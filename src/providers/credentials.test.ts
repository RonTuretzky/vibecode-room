import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { TraceProcessor } from "../obs/trace";
import { REDACTED_SECRET, scanSecretLikeFiles } from "../security/secrets";
import { createAudioCredentialSource, createModelCredentialSource, rejectRawModelCredentials } from "./credentials";

const sessionId = "session-sec-001";
const correlationId = "corr-sec-001";

describe("SEC-1 credential guard and trace redaction", () => {
  test("DecisionLLM model access is host-subscription provenance and raw model keys are rejected", () => {
    const rawOpenAi = fakeOpenAiKey();
    const rawAnthropic = fakeAnthropicKey();

    expect(createModelCredentialSource({ provider: "openai-codex", env: {} })).toEqual({
      kind: "host-subscription",
      provider: "openai-codex",
      command: "codex",
    });
    expect(createModelCredentialSource({ provider: "anthropic-claude", command: "claude --print" })).toEqual({
      kind: "host-subscription",
      provider: "anthropic-claude",
      command: "claude --print",
    });

    expect(() => rejectRawModelCredentials({ rawApiKey: rawOpenAi })).toThrow(/Raw provider key rejected/u);
    expect(() => createModelCredentialSource({ provider: "openai-codex", env: { OPENAI_API_KEY: rawOpenAi } })).toThrow(
      /OPENAI_API_KEY/u,
    );
    expect(() =>
      createModelCredentialSource({ provider: "anthropic-claude", env: { ANTHROPIC_API_KEY: rawAnthropic } }),
    ).toThrow(/ANTHROPIC_API_KEY/u);
  });

  test("host-subscription command is a narrow CLI allowlist and rejects credential smuggling", () => {
    const rawOpenAi = fakeOpenAiKey();

    expect(createModelCredentialSource({ provider: "anthropic-claude", command: "claude --print" })).toEqual({
      kind: "host-subscription",
      provider: "anthropic-claude",
      command: "claude --print",
    });

    expectThrowsWithoutEcho(() => createModelCredentialSource({ provider: "openai-codex", command: `codex --api-key=${rawOpenAi}` }));
    expectThrowsWithoutEcho(() => createModelCredentialSource({ provider: "openai-codex", command: `OPENAI_API_KEY=${rawOpenAi} codex` }));
    expect(() => createModelCredentialSource({ provider: "openai-codex", command: "node codex" })).toThrow(/must start/u);
    expect(() => createModelCredentialSource({ provider: "anthropic-claude", command: "claude $(printenv)" })).toThrow(
      /plain allowlisted/u,
    );
  });

  test("audio credential provenance exposes only a redacted environment variable name", () => {
    const source = createAudioCredentialSource({
      provider: "deepgram",
      variable: "DEEPGRAM_API_KEY",
      env: { DEEPGRAM_API_KEY: fakeDeepgramKey() },
    });

    expect(source).toEqual({
      kind: "environment",
      provider: "deepgram",
      variable: "DEEPGRAM_API_KEY",
      redacted: true,
    });
  });

  test("LogEvent meta redacts bearer, provider keys, JWTs, authorization headers, arrays, and secret-like unknowns", () => {
    const rawValues = [fakeBearer(), fakeOpenAiKey(), fakeDeepgramKey(), fakeElevenLabsKey(), fakeJwt(), fakeUnknownToken()];
    const processor = new TraceProcessor({
      defaultSecretRedaction: process.env.PANOPTICON_RBG_DISABLE_SECRET_REDACTION !== "1",
    });

    processor.record({
      event: "observe.final",
      sessionId,
      correlationId,
      startedAtMs: 10,
      endedAtMs: 15,
      meta: {
        authorization: `Authorization: ${rawValues[0]}`,
        modelKey: rawValues[1],
        nested: {
          provider: rawValues[2],
          elevenlabs: rawValues[3],
          jwt: rawValues[4],
          blob: rawValues[5],
        },
        list: [`safe-${"x".repeat(8)}`, rawValues[1]],
      },
    });

    const jsonl = processor.toJsonl();
    assertNoRawValues(jsonl, rawValues, "trace JSONL");
    expect(jsonl).toContain(REDACTED_SECRET);

    const redactionEvents = processor.events().filter((event) => event.event === "secret.redacted");
    expect(redactionEvents).toHaveLength(1);
    expect(redactionEvents[0].meta).toEqual({ count: 7, sourceEvent: "observe.final" });
  });

  test("probe-style reports can be redacted and scanned without leaking raw values", async () => {
    const root = join(tmpdir(), `panopticon-secret-report-${crypto.randomUUID()}`);
    const rawValues = [fakeOpenAiKey(), fakeBearer(), fakeDeepgramKey()];
    const processor = new TraceProcessor({
      defaultSecretRedaction: process.env.PANOPTICON_RBG_DISABLE_SECRET_REDACTION !== "1",
    });
    const event = processor.record({
      event: "route.pass",
      sessionId,
      correlationId,
      startedAtMs: 20,
      endedAtMs: 22,
      meta: { report: { token: rawValues[0], auth: rawValues[1], dg: rawValues[2] } },
    });

    try {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "report.json"), JSON.stringify({ event }, null, 2));
      await writeFile(join(root, "trace.jsonl"), processor.toJsonl());
      const scan = await scanSecretLikeFiles(root);
      if (!scan.passed) {
        throw new Error(`raw key-shaped string leaked into report tree (${scan.findings.length} findings)`);
      }
      assertNoRawValues(await Bun.file(join(root, "report.json")).text(), rawValues, "report JSON");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function assertNoRawValues(haystack: string, rawValues: readonly string[], label: string): void {
  if (rawValues.some((value) => haystack.includes(value))) {
    throw new Error(`raw key-shaped string leaked into ${label}`);
  }
}

function expectThrowsWithoutEcho(fn: () => unknown): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
}

function fakeOpenAiKey(): string {
  return ["sk", "proj", `${"A".repeat(18)}1${"B".repeat(18)}`].join("-");
}

function fakeAnthropicKey(): string {
  return ["sk", "ant", `${"C".repeat(18)}2${"D".repeat(18)}`].join("-");
}

function fakeBearer(): string {
  return ["Bearer", `${"E".repeat(18)}3${"F".repeat(18)}`].join(" ");
}

function fakeDeepgramKey(): string {
  return ["dg", `${"G".repeat(18)}4${"H".repeat(18)}`].join("_");
}

function fakeElevenLabsKey(): string {
  return ["xi", `${"I".repeat(18)}5${"J".repeat(18)}`].join("_");
}

function fakeJwt(): string {
  return [`eyJ${"K".repeat(16)}`, `${"L".repeat(18)}6`, `${"M".repeat(18)}7`].join(".");
}

function fakeUnknownToken(): string {
  return `${"N".repeat(16)}8${"O".repeat(16)}`;
}
