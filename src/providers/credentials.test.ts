import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { TraceProcessor } from "../obs/trace";
import { REDACTED_SECRET, redactSecretValues, scanSecretLikeFiles, scanSecretLikeText } from "../security/secrets";
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

  test("DecisionLLM model access rejects raw provider keys under non-canonical env names", () => {
    const rawOpenAi = fakeOpenAiKey();
    const rawAnthropic = fakeAnthropicKey();
    const rawBearer = fakeBearer();
    const cases = [
      ["MODEL_API_KEY", rawOpenAi],
      ["CODEX_API_KEY", rawOpenAi],
      ["LLM_TOKEN", rawBearer],
      ["PROVIDER_CREDENTIAL", rawAnthropic],
      ["UNRELATED_VALUE", fakeProviderPrefixedSlackToken()],
    ] as const;

    for (const [variable, value] of cases) {
      if (process.env.PANOPTICON_RBG_ALLOW_NONCANONICAL_MODEL_KEYS === "1") {
        expect(() => createModelCredentialSource({ provider: "openai-codex", env: { [variable]: value } })).not.toThrow();
      } else {
        expectThrowsWithoutEcho(() => createModelCredentialSource({ provider: "openai-codex", env: { [variable]: value } }));
      }
    }

    expect(createModelCredentialSource({ provider: "openai-codex", env: { MODEL_PROFILE: "host-subscription" } })).toEqual({
      kind: "host-subscription",
      provider: "openai-codex",
      command: "codex",
    });
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
    expect(() => createModelCredentialSource({ provider: "openai-codex", command: "codex --profile=default" })).toThrow(
      /unsupported argument/u,
    );
    expect(() => createModelCredentialSource({ provider: "anthropic-claude", command: "claude --model=default" })).toThrow(
      /unsupported argument/u,
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
    const rawValues = [
      fakeBearer(),
      fakeOpenAiKey(),
      fakeDeepgramKey(),
      fakeElevenLabsKey(),
      fakeJwt(),
      fakeUnknownToken(),
      fakeUnknownSeparatedToken(),
      fakeUnknownEmbeddedToken(),
      fakeUnknownCommonAlphabetToken(),
      fakeUnknownAlphabeticToken(),
      fakeUnknownSlashOnlyToken(),
      fakeUnknownPaddingOnlyToken(),
      fakeProviderPrefixedAlphabeticToken(),
      fakeProviderPrefixedNumericToken(),
      fakeProviderPrefixedAlphaNumericToken(),
      fakeProviderPrefixedSlackToken(),
    ];
    const processor = new TraceProcessor();

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
          separated: rawValues[6],
          embedded: `provider returned opaque token ${rawValues[7]} during setup`,
          commonAlphabet: rawValues[8],
          alphabeticOpaque: rawValues[9],
          slashOnlyOpaque: rawValues[10],
          paddingOnlyOpaque: rawValues[11],
          providerPrefixedOpaque: rawValues[12],
          providerPrefixedNumeric: rawValues[13],
          providerPrefixedAlphaNumeric: rawValues[14],
          providerPrefixedSlack: rawValues[15],
        },
        list: [`safe-${"x".repeat(8)}`, rawValues[1]],
      },
    });

    const jsonl = processor.toJsonl();
    assertNoRawValues(jsonl, rawValues, "trace JSONL");
    expect(jsonl).toContain(REDACTED_SECRET);

    const redactionEvents = processor.events().filter((event) => event.event === "secret.redacted");
    expect(redactionEvents).toHaveLength(1);
    expect(redactionEvents[0].meta).toEqual({ count: 17, sourceEvent: "observe.final" });
  });

  test("LogEvent identifiers redact credential-shaped values before JSONL emission", () => {
    const rawValues = [fakeOpenAiKey(), fakeProviderPrefixedSlackToken(), fakeProviderPrefixedAlphaNumericToken()];
    const processor = new TraceProcessor();

    const event = processor.record({
      event: `observe.${rawValues[0]}`,
      sessionId: `session-${rawValues[1]}`,
      correlationId: `corr-${rawValues[2]}`,
      startedAtMs: 12,
      endedAtMs: 16,
      meta: { safe: "kept" },
    });

    const jsonl = processor.toJsonl();
    if (process.env.PANOPTICON_RBG_UNREDACTED_TRACE_IDS === "1") {
      if (!rawValues.every((rawValue) => jsonl.includes(rawValue))) {
        throw new Error("synthetic unredacted trace identifier leak check failed as expected");
      }
    }

    assertNoRawValues(jsonl, rawValues, "trace JSONL identifiers");
    expect(event.event).toBe("redacted.secret");
    expect(event.sessionId).toContain(REDACTED_SECRET);
    expect(event.correlationId).toContain(REDACTED_SECRET);
    expect(processor.events()[0].meta).toEqual({ count: 3, sourceEvent: "redacted.secret" });
  });

  test("LogEvent meta redacts credential-shaped object keys before emission", () => {
    const rawKeyNames = [fakeOpenAiKey(), `Authorization: ${fakeBearer()}`, fakeUnknownSeparatedToken()];
    const processor = new TraceProcessor();

    processor.record({
      event: "observe.final",
      sessionId,
      correlationId,
      startedAtMs: 16,
      endedAtMs: 19,
      meta: {
        [rawKeyNames[0]]: "harmless-openai-shaped-property-name",
        nested: {
          [rawKeyNames[1]]: "harmless-authorization-shaped-property-name",
          ordinary: {
            [rawKeyNames[2]]: "harmless-unknown-shaped-property-name",
          },
        },
      },
    });

    const jsonl = processor.toJsonl();
    if (process.env.PANOPTICON_RBG_UNREDACTED_META_KEYS === "1") {
      const leakySerialized = JSON.stringify({ meta: { [rawKeyNames[0]]: "unredacted property-name fixture" } });
      const findingCount = scanSecretLikeText(leakySerialized).reduce((total, finding) => total + finding.count, 0);
      throw new Error(`synthetic unredacted property-name leak detected (${findingCount} findings)`);
    }

    assertNoRawValues(jsonl, rawKeyNames, "trace JSONL property names");
    expect(scanSecretLikeText(jsonl)).toEqual([]);
    expect(jsonl).toContain(REDACTED_SECRET);

    const emitted = processor.events().find((event) => event.event === "observe.final");
    expect(emitted?.meta).toEqual({
      [REDACTED_SECRET]: "harmless-openai-shaped-property-name",
      nested: {
        [REDACTED_SECRET]: REDACTED_SECRET,
        ordinary: {
          [REDACTED_SECRET]: "harmless-unknown-shaped-property-name",
        },
      },
    });
    expect(processor.events().filter((event) => event.event === "secret.redacted")[0].meta).toEqual({
      count: 4,
      sourceEvent: "observe.final",
    });
  });

  test("probe-style reports can be redacted and scanned without leaking raw values", async () => {
    const root = join(tmpdir(), `panopticon-secret-report-${crypto.randomUUID()}`);
    const rawValues = [fakeOpenAiKey(), fakeBearer(), fakeDeepgramKey(), fakeUnknownEmbeddedToken()];
    const processor = new TraceProcessor();
    const event = processor.record({
      event: "route.pass",
      sessionId,
      correlationId,
      startedAtMs: 20,
      endedAtMs: 22,
      meta: { report: { token: rawValues[0], auth: rawValues[1], dg: rawValues[2], opaque: rawValues[3] } },
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

  test("unknown-token fallback redacts embedded, separator-bearing, common alphabet, and alphabetic-only opaque tokens before scans see them", () => {
    const rawValues = [
      fakeUnknownEmbeddedToken(),
      fakeUnknownSeparatedToken(),
      fakeUnknownCommonAlphabetToken(),
      fakeUnknownAlphabeticToken(),
      fakeUnknownSlashOnlyToken(),
      fakeUnknownPaddingOnlyToken(),
      fakeProviderPrefixedAlphabeticToken(),
      fakeProviderPrefixedNumericToken(),
      fakeProviderPrefixedAlphaNumericToken(),
      fakeProviderPrefixedSlackToken(),
    ];
    const text = `provider note ${rawValues.join(" and ")} should not leave memory`;

    expect(scanSecretLikeText(text).some((finding) => finding.pattern === "unknown-high-entropy-token")).toBe(true);
    expect(scanSecretLikeText(`interface ProviderBoundaryConsumerProviders { value: string }`)).toEqual([]);
    expect(
      scanSecretLikeText(JSON.stringify({ opaque: fakeUnknownAlphabeticToken() })).some(
        (finding) => finding.pattern === "unknown-high-entropy-token",
      ),
    ).toBe(true);
    expect(
      scanSecretLikeText(JSON.stringify({ opaque: fakeUnknownSlashOnlyToken() })).some(
        (finding) => finding.pattern === "unknown-high-entropy-token",
      ),
    ).toBe(true);
    expect(
      scanSecretLikeText(JSON.stringify({ opaque: fakeUnknownPaddingOnlyToken() })).some(
        (finding) => finding.pattern === "unknown-high-entropy-token",
      ),
    ).toBe(true);
    expect(
      scanSecretLikeText(JSON.stringify({ opaque: fakeProviderPrefixedAlphabeticToken() })).some(
        (finding) => finding.pattern === "unknown-high-entropy-token",
      ),
    ).toBe(true);
    expect(
      scanSecretLikeText(JSON.stringify({ opaque: fakeProviderPrefixedNumericToken() })).some(
        (finding) => finding.pattern === "unknown-high-entropy-token",
      ),
    ).toBe(true);
    expect(
      scanSecretLikeText(JSON.stringify({ opaque: fakeProviderPrefixedAlphaNumericToken() })).some(
        (finding) => finding.pattern === "unknown-high-entropy-token",
      ),
    ).toBe(true);
    expect(
      scanSecretLikeText(JSON.stringify({ opaque: fakeProviderPrefixedSlackToken() })).some(
        (finding) => finding.pattern === "unknown-high-entropy-token",
      ),
    ).toBe(true);
    if (process.env.PANOPTICON_RBG_ALLOW_MULTI_SEGMENT_SECRET === "1") {
      expect(scanSecretLikeText(JSON.stringify({ opaque: fakeProviderPrefixedSlackToken() }))).toEqual([]);
    }

    const redacted = redactSecretValues({ note: text });
    const serialized = JSON.stringify(redacted.value);
    assertNoRawValues(serialized, rawValues, "redacted unknown-token fallback");
    expect(serialized).toContain(REDACTED_SECRET);
    expect(scanSecretLikeText(serialized)).toEqual([]);
    expect(redacted.count).toBe(10);
  });

  test("secret scan covers extensionless files in trace and report trees", async () => {
    const root = join(tmpdir(), `panopticon-extensionless-secret-${crypto.randomUUID()}`);

    try {
      await mkdir(join(root, "logs"), { recursive: true });
      await writeFile(join(root, "logs", "session"), JSON.stringify({ providerMeta: fakeOpenAiKey() }));

      const scan = await scanSecretLikeFiles(root);
      if (scan.passed) {
        throw new Error("extensionless trace/log/report file with key-shaped content was not scanned");
      }
      expect(scan.findings.length).toBeGreaterThanOrEqual(1);
      expect(scan.findings[0].path.endsWith("/logs/session")).toBe(true);
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

function fakeUnknownSeparatedToken(): string {
  return `acme_live_${"P".repeat(14)}9${"Q".repeat(14)}`;
}

function fakeUnknownEmbeddedToken(): string {
  return `${"R".repeat(10)}_${"S".repeat(10)}0${"T".repeat(10)}`;
}

function fakeUnknownCommonAlphabetToken(): string {
  return `${"AbCdEfGhIjKlMnOpQrStUvWxYz"}+/=${"ZaYbXcWdVeUfTgShRiQpOnMlKj"}~`;
}

function fakeUnknownAlphabeticToken(): string {
  return `${"alphaopaquecredential".repeat(3)}seed`;
}

function fakeUnknownSlashOnlyToken(): string {
  return `${"slashopaquecredential".repeat(2)}/${"continuationopaquevalue".repeat(2)}`;
}

function fakeUnknownPaddingOnlyToken(): string {
  return `${"paddedopaquecredential".repeat(3)}==`;
}

function fakeProviderPrefixedAlphabeticToken(): string {
  return `ghp_${"alphabeticprovideropaque".repeat(2)}`;
}

function fakeProviderPrefixedNumericToken(): string {
  return ["xoxb", "1".repeat(12), "2".repeat(12), "3".repeat(12)].join("-");
}

function fakeProviderPrefixedAlphaNumericToken(): string {
  return ["acme", "alphabeticprovideropaque".repeat(2), "7".repeat(18)].join("-");
}

function fakeProviderPrefixedSlackToken(): string {
  return ["xoxb", "4".repeat(12), "5".repeat(12), "slackprovideropaque".repeat(2)].join("-");
}
