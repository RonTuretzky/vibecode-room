import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { redactSecretValues, scanSecretLikeFiles, type SecretScanResult } from "../src/security/secrets";

export type ProbeStatus = "passed" | "failed";
export type AssertionStatus = "failed-as-expected" | "passed" | "not-failable" | "failed";

export interface ProbeAssertion {
  id: string;
  behavior: string;
  run: () => Promise<void> | void;
  falsify: () => Promise<void> | void;
}

export interface ProbeRunOptions {
  probeId: string;
  assertions: ProbeAssertion[];
  reportRoot?: string;
  cleanReportDir?: boolean;
  correlationId?: string;
  meta?: Record<string, unknown>;
}

export interface AssertionRunRecord {
  id: string;
  behavior: string;
  phase: "red" | "green";
  status: AssertionStatus;
  error?: string;
}

export interface ProbeReport {
  probeId: string;
  status: ProbeStatus;
  summary: string;
  correlationId: string;
  startedAt: string;
  finishedAt: string;
  assertions: AssertionRunRecord[];
  reportDir: string;
  secretScan: SecretScanResult;
  meta: Record<string, unknown>;
}

export class ProbeHarnessError extends Error {
  readonly report: ProbeReport;

  constructor(message: string, report: ProbeReport) {
    super(message);
    this.name = "ProbeHarnessError";
    this.report = report;
  }
}

const DEFAULT_REPORT_ROOT = "artifacts/smithering/reports";

export function redactSecrets(value: unknown): unknown {
  return redactSecretValues(value).value;
}

export async function assertNoKeyShapedStrings(rootDir: string): Promise<SecretScanResult> {
  const scan = await scanSecretLikeFiles(rootDir);
  return {
    passed: scan.passed,
    findings: scan.findings.map((finding) => ({
      ...finding,
      path: relative(process.cwd(), finding.path),
    })),
  };
}

export async function runProbe(options: ProbeRunOptions): Promise<ProbeReport> {
  if (options.assertions.length === 0) {
    throw new Error("probe must declare at least one assertion");
  }

  const startedAt = new Date().toISOString();
  const reportRoot = options.reportRoot ?? DEFAULT_REPORT_ROOT;
  const reportDir = join(reportRoot, options.probeId);
  const correlationId = options.correlationId ?? `probe-${options.probeId}`;

  if (options.cleanReportDir) {
    await rm(reportDir, { recursive: true, force: true });
  }
  await mkdir(reportDir, { recursive: true });

  const records: AssertionRunRecord[] = [];
  let status: ProbeStatus = "passed";
  let summary = "probe assertions were failable and passed";

  for (const assertion of options.assertions) {
    try {
      await assertion.falsify();
      records.push({
        id: assertion.id,
        behavior: assertion.behavior,
        phase: "red",
        status: "not-failable",
        error: "falsify() returned without throwing",
      });
      status = "failed";
      summary = "no failable assertion";
    } catch (error) {
      records.push({
        id: assertion.id,
        behavior: assertion.behavior,
        phase: "red",
        status: "failed-as-expected",
        error: errorMessage(error),
      });
    }
  }

  if (status === "passed") {
    for (const assertion of options.assertions) {
      try {
        await assertion.run();
        records.push({
          id: assertion.id,
          behavior: assertion.behavior,
          phase: "green",
          status: "passed",
        });
      } catch (error) {
        records.push({
          id: assertion.id,
          behavior: assertion.behavior,
          phase: "green",
          status: "failed",
          error: errorMessage(error),
        });
        status = "failed";
        summary = "probe assertion failed";
      }
    }
  }

  const partialReport = {
    probeId: options.probeId,
    status,
    summary,
    correlationId,
    startedAt,
    finishedAt: new Date().toISOString(),
    assertions: records,
    reportDir,
    secretScan: { passed: false, findings: [] },
    meta: options.meta ?? {},
  } satisfies ProbeReport;

  const redactedPartial = redactSecrets(partialReport) as ProbeReport;
  await writeFile(join(reportDir, "report.json"), JSON.stringify(redactedPartial, null, 2) + "\n");
  await writeFile(join(reportDir, "rbg.jsonl"), records.map((record) => JSON.stringify(redactSecrets(record))).join("\n") + "\n");

  const secretScan = await assertNoKeyShapedStrings(reportDir);
  const report = { ...redactedPartial, secretScan };
  await writeFile(join(reportDir, "secret-scan.json"), JSON.stringify(secretScan, null, 2) + "\n");
  await writeFile(join(reportDir, "report.json"), JSON.stringify(report, null, 2) + "\n");

  if (!secretScan.passed) {
    const failedReport = { ...report, status: "failed" as const, summary: "report secret scan failed" };
    await writeFile(join(reportDir, "report.json"), JSON.stringify(failedReport, null, 2) + "\n");
    throw new ProbeHarnessError(failedReport.summary, failedReport);
  }

  if (status !== "passed") {
    throw new ProbeHarnessError(summary, report);
  }

  return report;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return String(redactSecrets(error.message));
  }
  return String(redactSecrets(String(error)));
}
