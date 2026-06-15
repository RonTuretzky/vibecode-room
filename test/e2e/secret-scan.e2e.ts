import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { runProbe, type ProbeAssertion } from "../../poc/harness";
import { TraceProcessor } from "../../src/obs/trace";
import { REDACTED_SECRET, scanSecretLikeFiles } from "../../src/security/secrets";
import { runSpineSmoke } from "../../src/spine/smoke";

const BUILD_DIR = "artifacts/smithering/build/subscription-credentials-redaction";
const SESSION_DIR = `${BUILD_DIR}/secret-scan-session`;
const TRACE_DIR = `${BUILD_DIR}/trace`;
const PROBE_REPORT_ROOT = `${SESSION_DIR}/reports/probes`;

describe("SEC-1 whole-session secret scan", () => {
  test("full trace/log/report tree has zero key-shaped strings after a session run", async () => {
    await rm(SESSION_DIR, { recursive: true, force: true });
    await mkdir(SESSION_DIR, { recursive: true });
    await mkdir(join(SESSION_DIR, "logs"), { recursive: true });
    await mkdir(join(SESSION_DIR, "reports"), { recursive: true });
    await mkdir(join(SESSION_DIR, "traces"), { recursive: true });
    await mkdir(TRACE_DIR, { recursive: true });
    await mkdir(PROBE_REPORT_ROOT, { recursive: true });

    const rawValues = [
      fakeOpenAiKey(),
      fakeBearer(),
      fakeDeepgramKey(),
      fakeUnknownToken(),
      fakeUnknownSeparatedToken(),
      fakeUnknownCommonAlphabetToken(),
      fakeUnknownAlphabeticToken(),
      fakeUnknownSlashOnlyToken(),
      fakeUnknownPaddingOnlyToken(),
      fakeProviderPrefixedAlphabeticToken(),
      fakeProviderPrefixedNumericToken(),
    ];
    const rawKeyNames = [fakeOpenAiKey(), `Authorization: ${fakeBearer()}`, fakeUnknownSeparatedToken()];
    const processor = new TraceProcessor();
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
                separated: rawValues[4],
                commonAlphabet: rawValues[5],
                alphabeticOpaque: rawValues[6],
                slashOnlyOpaque: rawValues[7],
                paddingOnlyOpaque: rawValues[8],
                providerPrefixedOpaque: rawValues[9],
                providerPrefixedNumeric: rawValues[10],
                [rawKeyNames[0]]: "harmless-openai-shaped-property-name",
                nested: {
                  [rawKeyNames[1]]: "harmless-authorization-shaped-property-name",
                  [rawKeyNames[2]]: "harmless-unknown-shaped-property-name",
                },
              },
            }
          : {},
    });
    await runRedactedProbeReport(rawValues, rawKeyNames);

    const traceJsonl = processor.toJsonl();
    await writeFile(join(SESSION_DIR, "traces", "trace.jsonl"), traceJsonl);
    await writeFile(join(SESSION_DIR, "reports", "report.json"), JSON.stringify({ events: processor.events(), decisions: result.decisions }, null, 2));
    await writeFile(join(SESSION_DIR, "logs", "session.log"), `redaction=${traceJsonl.includes(REDACTED_SECRET) ? "active" : "inactive"}\n`);
    await writeFile(join(SESSION_DIR, "logs", "session"), `redaction=${traceJsonl.includes(REDACTED_SECRET) ? "active" : "inactive"}\n`);
    await writeFile(join(TRACE_DIR, "secret-scan-session.jsonl"), traceJsonl);
    if (process.env.PANOPTICON_RBG_PLANT_SECRET_IN_SESSION === "1") {
      await writeFile(join(SESSION_DIR, "reports", "planted-leak.json"), JSON.stringify({ providerMeta: rawValues[0] }, null, 2));
      await writeFile(join(SESSION_DIR, "logs", "planted-leak"), JSON.stringify({ providerMeta: rawValues[10] }, null, 2));
    }

    const scans = await Promise.all([SESSION_DIR, TRACE_DIR, PROBE_REPORT_ROOT].map((root) => scanSecretLikeFiles(root)));
    const findingCount = scans.reduce((count, scan) => count + scan.findings.length, 0);
    if (findingCount > 0) {
      throw new Error(`whole-session secret scan found key-shaped strings (${findingCount} findings)`);
    }

    const report = await Bun.file(join(SESSION_DIR, "reports", "report.json")).text();
    if ([...rawValues, ...rawKeyNames].some((raw) => report.includes(raw))) {
      throw new Error("raw key-shaped string leaked into whole-session report");
    }

    expect(traceJsonl).toContain(REDACTED_SECRET);
    expect(processor.events().some((event) => event.event === "secret.redacted")).toBe(true);
  });
});

async function runRedactedProbeReport(rawValues: readonly string[], rawKeyNames: readonly string[]): Promise<void> {
  const assertion: ProbeAssertion = {
    id: "redacted-probe-report",
    behavior: "probe report meta is redacted before durable emission",
    falsify: () => {
      throw new Error("red probe branch proves the assertion can fail");
    },
    run: () => {
      expect(true).toBe(true);
    },
  };

  await runProbe({
    probeId: "secret-scan-e2e-probe",
    assertions: [assertion],
    reportRoot: PROBE_REPORT_ROOT,
    cleanReportDir: true,
    correlationId: "secret-scan-e2e-probe",
    meta: {
      authorization: rawValues[1],
      provider: {
        apiKey: rawValues[0],
        deepgram: rawValues[2],
        unknown: rawValues[4],
        alphabeticOpaque: rawValues[6],
        slashOnlyOpaque: rawValues[7],
        paddingOnlyOpaque: rawValues[8],
        providerPrefixedOpaque: rawValues[9],
        providerPrefixedNumeric: rawValues[10],
        [rawKeyNames[0]]: "probe-key-name",
        nested: {
          [rawKeyNames[1]]: "probe-authorization-key-name",
          [rawKeyNames[2]]: "probe-unknown-key-name",
        },
      },
    },
  });
}

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

function fakeUnknownSeparatedToken(): string {
  return `provider_live_${"Y".repeat(12)}5${"Z".repeat(12)}`;
}

function fakeUnknownCommonAlphabetToken(): string {
  return `${"QwErTyUiOpAsDfGhJkLzXcVbNm"}+/=${"MnBvCxZlKjHgFdSaPoIuYtReWq"}~`;
}

function fakeUnknownAlphabeticToken(): string {
  return `${"alphabeticopaque".repeat(4)}seed`;
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
  return ["xoxb", "4".repeat(12), "5".repeat(12), "6".repeat(12)].join("-");
}
