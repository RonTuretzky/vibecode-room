// §8 invariant: no land without recorded RBG red+green; the merge gate machine-checks the
// evidence bundle rather than trusting agent booleans. RBG move: delete a red run / fail
// verify / reject review / drop a required file → land refused.
import { describe, expect, test } from "bun:test";
import {
  evaluateEvidenceBundle,
  REQUIRED_BUNDLE_FILES,
  type EvidenceInput,
  type GateRow,
} from "./core.ts";

const greenGate: GateRow = {
  criterionId: "AC11.1",
  method: "unit_test",
  tier: "pre-merge",
  status: "passed",
  rbgRecorded: true,
  testPath: "tests/ac11.test.ts",
  redRunPath: "evidence/AC11.1-rbg-red.log",
  greenRunPath: "evidence/AC11.1-green.log",
};

// A present() that treats a fixed allowlist of paths as existing + non-empty.
function presentFrom(paths: string[]): EvidenceInput["present"] {
  const set = new Set(paths);
  return (p) => !!p && set.has(p);
}

const allBundleFiles = [...REQUIRED_BUNDLE_FILES, greenGate.redRunPath!, greenGate.greenRunPath!];

function baseInput(overrides: Partial<EvidenceInput> = {}): EvidenceInput {
  return {
    gates: [greenGate],
    verify: { pass: true, ranTests: true, rbgConfirmed: true },
    review: { approved: true },
    present: presentFrom(allBundleFiles),
    requiredFiles: REQUIRED_BUNDLE_FILES,
    ...overrides,
  };
}

describe("evidence-completeness (gate-before-land)", () => {
  test("green — a complete bundle with red+green runs, verify pass, review approved lands", () => {
    const r = evaluateEvidenceBundle(baseInput());
    expect(r.ok).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  test("RBG — delete the red run → land refused", () => {
    const present = presentFrom(allBundleFiles.filter((p) => p !== greenGate.redRunPath));
    const r = evaluateEvidenceBundle(baseInput({ present }));
    expect(r.ok).toBe(false);
    expect(r.reasons.join("\n")).toMatch(/red run missing/i);
  });

  test("RBG — gates.json missing entirely → land refused", () => {
    const r = evaluateEvidenceBundle(baseInput({ gates: null }));
    expect(r.ok).toBe(false);
    expect(r.reasons.join("\n")).toMatch(/gates\.json missing/i);
  });

  test("RBG — a pre-merge gate without rbgRecorded → land refused", () => {
    const r = evaluateEvidenceBundle(baseInput({ gates: [{ ...greenGate, rbgRecorded: false }] }));
    expect(r.ok).toBe(false);
    expect(r.reasons.join("\n")).toMatch(/no recorded red-before-green/i);
  });

  test("RBG — verifier did not pass → land refused (boolean is not trusted; the record is)", () => {
    const r = evaluateEvidenceBundle(baseInput({ verify: { pass: false } }));
    expect(r.ok).toBe(false);
    expect(r.reasons.join("\n")).toMatch(/verify\.json pass/i);
  });

  test("RBG — missing verify.json → land refused", () => {
    const r = evaluateEvidenceBundle(baseInput({ verify: null }));
    expect(r.ok).toBe(false);
    expect(r.reasons.join("\n")).toMatch(/verify\.json missing/i);
  });

  test("RBG — cross-family review rejected → land refused", () => {
    const r = evaluateEvidenceBundle(baseInput({ review: { approved: false } }));
    expect(r.ok).toBe(false);
    expect(r.reasons.join("\n")).toMatch(/review\.json not approved/i);
  });

  test("RBG — a required durable file (review.json) is empty/absent → land refused", () => {
    const present = presentFrom(allBundleFiles.filter((p) => p !== "review.json"));
    const r = evaluateEvidenceBundle(baseInput({ present }));
    expect(r.ok).toBe(false);
    expect(r.reasons.join("\n")).toMatch(/required evidence file missing or empty: review\.json/i);
  });

  test("a bundle whose only pre-merge gate is 'skipped' is refused (nothing was actually gated)", () => {
    const r = evaluateEvidenceBundle(baseInput({ gates: [{ ...greenGate, status: "skipped" }] }));
    expect(r.ok).toBe(false);
    expect(r.reasons.join("\n")).toMatch(/status=skipped/i);
  });
});
