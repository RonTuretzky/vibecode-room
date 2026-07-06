// §8 e2e dry-run (the orchestration analog of the canonical spine): drive the scheduler
// over a synthetic 3-ticket DAG end-to-end — schedule → worktree → fake implement →
// cross-family review → verify → optimistic land → trace reconstruction — using ONLY the
// real core helpers, asserting the full build trace reconstructs and the invariants hold.
//
// MERGE POLICY (brief O2): the landing policy is OPTIMISTIC merge + postsubmit eviction
// (land-then-learn — faster than the old serialized single-writer lane). This dry-run
// still drives the gate evidence + DAG-order checks deterministically; it does NOT yet
// model concurrent optimistic landing or postsubmit eviction of a bad land.
// TODO(optimistic-merge): once the real optimistic-merge + postsubmit-eviction lane exists,
// extend this dry-run to land eligible tickets concurrently and assert a postsubmit-red
// ticket is evicted (reverted) rather than blocking its successors at land time.
import { describe, expect, test } from "bun:test";
import {
  blockingProbeClosure,
  computeWaves,
  evaluateEvidenceBundle,
  isProbeVerdictGreen,
  REQUIRED_BUNDLE_FILES,
  type GateRow,
  type Ticket,
} from "./core.ts";

function tk(id: string, dependsOn: string[] = []): Ticket {
  return { id, title: id, instructions: "", requirementIds: [], verification: [], dependsOn, complexity: "medium" };
}

// root → probe-x → feature. probe-x must record a green verdict before feature schedules.
const tickets: Ticket[] = [tk("root"), tk("probe-x", ["root"]), tk("feature", ["probe-x"])];
const byId = new Map(tickets.map((t) => [t.id, t]));

type SimState = {
  landed: Set<string>;
  verdicts: Map<string, any>;
  bundles: Map<string, { gates: GateRow[]; files: Set<string>; verifyPass: boolean; reviewApproved: boolean }>;
  trace: Array<{ event: string; ticketId: string }>;
};

function passingBundle(id: string) {
  const red = `evidence/${id}-rbg-red.log`;
  const green = `evidence/${id}-green.log`;
  const gate: GateRow = {
    criterionId: `${id}-AC1`,
    method: "unit_test",
    tier: "pre-merge",
    status: "passed",
    rbgRecorded: true,
    redRunPath: red,
    greenRunPath: green,
  };
  return {
    gates: [gate],
    files: new Set<string>([...REQUIRED_BUNDLE_FILES, red, green]),
    verifyPass: true,
    reviewApproved: true,
  };
}

function eligible(id: string, s: SimState): boolean {
  const t = byId.get(id)!;
  if (!t.dependsOn.every((d) => s.landed.has(d))) return false;
  return blockingProbeClosure(id, byId).every((p) => isProbeVerdictGreen(s.verdicts.get(p)));
}

// The land lane's deterministic gate (code authority), mirroring landTicketBranch.
function tryLand(id: string, s: SimState): boolean {
  const b = s.bundles.get(id);
  if (!b) {
    s.trace.push({ event: "merge.lane.bounce", ticketId: id });
    return false;
  }
  const verdict = evaluateEvidenceBundle({
    gates: b.gates,
    verify: { pass: b.verifyPass },
    review: { approved: b.reviewApproved },
    present: (p) => !!p && b.files.has(p),
    requiredFiles: REQUIRED_BUNDLE_FILES,
  });
  if (!verdict.ok) {
    s.trace.push({ event: "merge.lane.bounce", ticketId: id });
    return false;
  }
  s.landed.add(id);
  s.trace.push({ event: "merge.lane.land", ticketId: id });
  return true;
}

// Walk the DAG in waves, simulating each ticket's worker producing a passing bundle, a
// probe additionally recording its green verdict, then the optimistic land step.
function runBuild(s: SimState, opts: { probeGreen: boolean } = { probeGreen: true }) {
  for (const wave of computeWaves(tickets)) {
    // implement → review → verify (fresh-context workers), in id order within the antichain.
    for (const t of wave.tickets) {
      if (!eligible(t.id, s)) continue;
      s.trace.push({ event: "build.ticket.start", ticketId: t.id });
      s.bundles.set(t.id, passingBundle(t.id));
      if (t.id.startsWith("probe-")) s.verdicts.set(t.id, { green: opts.probeGreen });
    }
    // Optimistic landing (brief O2): every gate-green ticket lands as soon as it is ready
    // (postsubmit eviction handles a bad land later); id order is deterministic for the trace.
    for (const t of [...wave.tickets].sort((a, b) => a.id.localeCompare(b.id))) {
      if (eligible(t.id, s) && s.bundles.has(t.id)) tryLand(t.id, s);
    }
  }
}

describe("e2e dry-run over a synthetic DAG", () => {
  test("green — all three tickets schedule, land in DAG order, and the trace reconstructs the chain", () => {
    const s: SimState = { landed: new Set(), verdicts: new Map(), bundles: new Map(), trace: [] };
    runBuild(s);
    expect([...s.landed]).toEqual(["root", "probe-x", "feature"]);

    // Trace reconstruction: every landed ticket has a start→land chain keyed by ticketId.
    for (const id of ["root", "probe-x", "feature"]) {
      const started = s.trace.find((e) => e.event === "build.ticket.start" && e.ticketId === id);
      const landed = s.trace.find((e) => e.event === "merge.lane.land" && e.ticketId === id);
      expect(started).toBeDefined();
      expect(landed).toBeDefined();
    }
    // Land order is the topological order (optimistic landing — deps land before dependents).
    const landOrder = s.trace.filter((e) => e.event === "merge.lane.land").map((e) => e.ticketId);
    expect(landOrder).toEqual(["root", "probe-x", "feature"]);
  });

  test("RBG — a red probe verdict halts the chain: feature never schedules or lands", () => {
    const s: SimState = { landed: new Set(), verdicts: new Map(), bundles: new Map(), trace: [] };
    runBuild(s, { probeGreen: false });
    expect(s.landed.has("root")).toBe(true);
    expect(s.landed.has("probe-x")).toBe(true); // the probe itself still ran + landed
    expect(s.landed.has("feature")).toBe(false); // but its dependent is gated off the red verdict
    expect(s.trace.some((e) => e.event === "build.ticket.start" && e.ticketId === "feature")).toBe(false);
  });

  test("RBG — a ticket with an incomplete bundle (missing green run) bounces at the lane", () => {
    const s: SimState = { landed: new Set(), verdicts: new Map(), bundles: new Map(), trace: [] };
    // root produces a bundle missing its green run → must bounce, blocking the whole chain.
    s.trace.push({ event: "build.ticket.start", ticketId: "root" });
    const broken = passingBundle("root");
    broken.files.delete("evidence/root-green.log");
    s.bundles.set("root", broken);
    expect(tryLand("root", s)).toBe(false);
    expect(s.landed.has("root")).toBe(false);
    expect(s.trace.some((e) => e.event === "merge.lane.bounce" && e.ticketId === "root")).toBe(true);
  });
});
