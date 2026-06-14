import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { TraceProcessor } from "../../src/obs/trace";
import { REDACTED_SECRET, scanSecretLikeFiles } from "../../src/security/secrets";
import { runSpineSmoke } from "../../src/spine/smoke";

const BUILD_DIR = "artifacts/smithering/build/subscription-credentials-redaction";
const SESSION_DIR = `${BUILD_DIR}/secret-scan-session`;
const TRACE_DIR = `${BUILD_DIR}/trace`;

describe("SEC-1 whole-session secret scan", () => {
  test("full trace/log/report tree has zero key-shaped strings after a session run", async () => {
    await rm(SESSION_DIR, { recursive: true, force: true });
    await mkdir(SESSION_DIR, { recursive: true });
    await mkdir(join(SESSION_DIR, "logs"), { recursive: true });
    await mkdir(join(SESSION_DIR, "reports"), { recursive: true });
    await mkdir(join(SESSION_DIR, "traces"), { recursive: true });
    await mkdir(TRACE_DIR, { recursive: true });

    const rawValues = [fakeOpenAiKey(), fakeBearer(), fakeDeepgramKey(), fakeUnknownToken()];
    const processor = new TraceProcessor({
      defaultSecretRedaction: process.env.PANOPTICON_RBG_DISABLE_SECRET_REDACTION !== "1",
    });
    const result = await runSpineSmoke("fixtures/smoke/transcript.jsonl", {
      trace: processor,
      observationMeta: (_observation, index) =>
        index === 0
          ? {
              providerMeta: {
                apiKey: rawValues[0],
                authorization: rawValues[1],
                deepgram: rawValues[2],
                blob: rawValues[3],
              },
            }
          : {},
    });

    const traceJsonl = processor.toJsonl();
    await writeFile(join(SESSION_DIR, "traces", "trace.jsonl"), traceJsonl);
    await writeFile(join(SESSION_DIR, "reports", "report.json"), JSON.stringify({ events: processor.events(), decisions: result.decisions }, null, 2));
    await writeFile(join(SESSION_DIR, "logs", "session.log"), `redaction=${traceJsonl.includes(REDACTED_SECRET) ? "active" : "inactive"}\n`);
    await writeFile(join(TRACE_DIR, "secret-scan-session.jsonl"), traceJsonl);

    const scan = await scanSecretLikeFiles(SESSION_DIR);
    if (!scan.passed) {
      throw new Error(`whole-session secret scan found key-shaped strings (${scan.findings.length} findings)`);
    }

    const report = await Bun.file(join(SESSION_DIR, "reports", "report.json")).text();
    if (rawValues.some((raw) => report.includes(raw))) {
      throw new Error("raw key-shaped string leaked into whole-session report");
    }

    expect(traceJsonl).toContain(REDACTED_SECRET);
    expect(processor.events().some((event) => event.event === "secret.redacted")).toBe(true);
  });
});

function fakeOpenAiKey(): string {
  return ["sk", "proj", `${"P".repeat(18)}1${"Q".repeat(18)}`].join("-");
}

function fakeBearer(): string {
  return ["Bearer", `${"R".repeat(18)}2${"S".repeat(18)}`].join(" ");
}

function fakeDeepgramKey(): string {
  return ["deepgram", `${"T".repeat(18)}3${"U".repeat(18)}`].join("_");
}

function fakeUnknownToken(): string {
  return `${"V".repeat(10)}${"w".repeat(10)}4${"X".repeat(10)}`;
}
