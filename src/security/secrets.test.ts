import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { TraceProcessor } from "../obs/trace";
import { REDACTED_SECRET, scanSecretLikeFiles, scanSecretLikeText } from "./secrets";

describe("secret redaction fail-closed scanning", () => {
  test("redacts provider-prefixed numeric bot tokens before trace JSONL emission", () => {
    const rawToken = slackStyleNumericBotToken();
    const rawFindings = scanSecretLikeText(`bot token ${rawToken}`);
    const processor = new TraceProcessor();

    processor.record({
      event: "observe.final",
      sessionId: "session-sec-regression",
      correlationId: "corr-sec-regression",
      startedAtMs: 10,
      endedAtMs: 12,
      meta: { providerResponse: `issued credential ${rawToken}` },
    });

    const jsonl = processor.toJsonl();

    expect(rawFindings.some((finding) => finding.pattern === "provider-prefixed-numeric-token")).toBe(true);
    expect(processor.events().some((event) => event.event === "secret.redacted")).toBe(true);
    expect(jsonl).toContain(REDACTED_SECRET);
    expect(jsonl).not.toContain(rawToken);
  });

  test("scans extensionless regular files under report roots", async () => {
    const root = join(tmpdir(), `vibersyn-secret-scan-${crypto.randomUUID()}`);
    const extensionlessPath = join(root, "logs", "session");

    try {
      await mkdir(join(root, "logs"), { recursive: true });
      await writeFile(extensionlessPath, JSON.stringify({ modelKey: fakeModelKey() }));

      const scan = await scanSecretLikeFiles(root);

      expect(scan.passed).toBe(false);
      expect(scan.findings.some((finding) => finding.path === extensionlessPath)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function slackStyleNumericBotToken(): string {
  return ["xoxb", "12345678901", "23456789012", "34567890123"].join("-");
}

function fakeModelKey(): string {
  return ["sk", "proj", `${"A".repeat(18)}1${"B".repeat(18)}`].join("-");
}
