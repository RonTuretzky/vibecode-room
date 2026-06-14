import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ProbeHarnessError,
  assertNoKeyShapedStrings,
  redactSecrets,
  runProbe,
  type ProbeAssertion,
} from "./harness";
import { REDACTED_SECRET } from "../src/security/secrets";

const REPORT_ROOT = "artifacts/smithering/reports";
const SAMPLE_ID = "harness-sample-probe";
const NON_FAIL_ID = "harness-non-failable-probe";
const FAIL_ID = "harness-failing-probe";
const REDACT_ID = "harness-redaction-probe";
const EMPTY_ID = "harness-empty-probe";

describe("probe harness", () => {
  test("sample probe writes a structured report with red-before-green evidence and clean secret scan", async () => {
    const assertion: ProbeAssertion = {
      id: "shape",
      behavior: "real API result exposes the relied-on shape",
      falsify: () => {
        expect({ ok: true }).toHaveProperty("missing");
      },
      run: () => {
        expect({ ok: true }).toEqual({ ok: true });
      },
    };

    const report = await runProbe({
      probeId: SAMPLE_ID,
      assertions: [assertion],
      reportRoot: REPORT_ROOT,
      cleanReportDir: true,
      correlationId: "probe-harness-test-sample",
      meta: { provider: "sample-real-api-double" },
    });

    expect(report.status).toBe("passed");
    expect(report.secretScan.passed).toBe(true);
    expect(report.assertions.map((entry) => `${entry.phase}:${entry.status}`)).toEqual([
      "red:failed-as-expected",
      "green:passed",
    ]);

    const reportPath = join(REPORT_ROOT, SAMPLE_ID, "report.json");
    const rbgPath = join(REPORT_ROOT, SAMPLE_ID, "rbg.jsonl");
    expect(existsSync(reportPath)).toBe(true);
    expect(existsSync(rbgPath)).toBe(true);
    expect(await assertNoKeyShapedStrings(join(REPORT_ROOT, SAMPLE_ID))).toEqual({
      passed: true,
      findings: [],
    });
  });

  test("a probe whose assertion cannot fail is refused as evidence", async () => {
    const nonFailable: ProbeAssertion = {
      id: "cannot-fail",
      behavior: "bad probe forgets to falsify its behavior",
      falsify: () => {
        expect(true).toBe(true);
      },
      run: () => {
        expect(true).toBe(true);
      },
    };

    const action = runProbe({
      probeId: NON_FAIL_ID,
      assertions: [nonFailable],
      reportRoot: REPORT_ROOT,
      cleanReportDir: true,
      correlationId: "probe-harness-test-non-failable",
    });

    if (process.env.PANOP_HARNESS_RBG_MODE === "non_failable_expect_green") {
      await expect(action).resolves.toBeDefined();
      return;
    }

    await expect(action).rejects.toThrow(ProbeHarnessError);
    const report = JSON.parse(await readFile(join(REPORT_ROOT, NON_FAIL_ID, "report.json"), "utf8"));
    expect(report.status).toBe("failed");
    expect(report.summary).toBe("no failable assertion");
    expect(report.assertions).toContainEqual(
      expect.objectContaining({ phase: "red", status: "not-failable" }),
    );
    expect(report.assertions.some((entry: { phase: string }) => entry.phase === "green")).toBe(false);
  });

  test("probe failures are surfaced as normal test failures, not swallowed", async () => {
    const failing: ProbeAssertion = {
      id: "green-failure",
      behavior: "real API eventually returns the relied-on value",
      falsify: () => {
        throw new Error("red run failed as expected");
      },
      run: () => {
        throw new Error("real API returned an incompatible shape");
      },
    };

    await expect(
      runProbe({
        probeId: FAIL_ID,
        assertions: [failing],
        reportRoot: REPORT_ROOT,
        cleanReportDir: true,
        correlationId: "probe-harness-test-failure",
      }),
    ).rejects.toThrow("probe assertion failed");

    const report = JSON.parse(await readFile(join(REPORT_ROOT, FAIL_ID, "report.json"), "utf8"));
    expect(report.status).toBe("failed");
    expect(report.assertions).toContainEqual(
      expect.objectContaining({ phase: "green", status: "failed" }),
    );
  });

  test("redaction removes key-shaped strings before report secret-scan", async () => {
    const fakeKey = ["sk", "test", "A".repeat(48)].join("-");
    const rawBearer = ["Bearer", "B".repeat(48)].join(" ");
    const opaqueToken = `vendor_live_${"C".repeat(12)}7${"D".repeat(12)}`;

    expect(redactSecrets({ fakeKey, rawBearer, opaqueNote: `provider note ${opaqueToken}` })).toEqual({
      fakeKey: REDACTED_SECRET,
      rawBearer: REDACTED_SECRET,
      opaqueNote: `provider note ${REDACTED_SECRET}`,
    });

    const assertion: ProbeAssertion = {
      id: "redacts-errors",
      behavior: "assertion errors can include provider text without leaking secrets",
      falsify: () => {
        throw new Error(`provider denied ${fakeKey}`);
      },
      run: () => {
        expect(true).toBe(true);
      },
    };

    await runProbe({
      probeId: REDACT_ID,
      assertions: [assertion],
      reportRoot: REPORT_ROOT,
      cleanReportDir: true,
      correlationId: "probe-harness-test-redaction",
      meta: { authorization: rawBearer, providerNote: `opaque ${opaqueToken}` },
    });

    const content = await readFile(join(REPORT_ROOT, REDACT_ID, "report.json"), "utf8");
    expect(content).not.toContain(fakeKey);
    expect(content).not.toContain(rawBearer);
    expect(content).not.toContain(opaqueToken);
    expect(content).toContain(REDACTED_SECRET);
    expect(await assertNoKeyShapedStrings(join(REPORT_ROOT, REDACT_ID))).toEqual({
      passed: true,
      findings: [],
    });
  });

  test("a probe must declare at least one assertion", async () => {
    await expect(
      runProbe({
        probeId: EMPTY_ID,
        assertions: [],
        reportRoot: REPORT_ROOT,
        cleanReportDir: true,
      }),
    ).rejects.toThrow("probe must declare at least one assertion");
  });
});
