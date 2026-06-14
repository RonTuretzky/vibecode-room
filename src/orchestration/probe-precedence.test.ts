// §8 invariant: no ticket scheduled before its deps land AND before every blocking probe
// in its TRANSITIVE closure shows a recorded GREEN verdict (real artifact, not agent
// compliance). RBG move: mark a probe failed/unrun → the dependent never schedules.
import { describe, expect, test } from "bun:test";
import {
  blockingProbeClosure,
  isProbeTicket,
  isProbeVerdictGreen,
  transitiveDeps,
  type Ticket,
} from "./core.ts";

function tk(id: string, dependsOn: string[] = []): Ticket {
  return { id, title: id, instructions: "", requirementIds: [], verification: [], dependsOn, complexity: "medium" };
}

// root ← probe-suite ← probe-cue ← feature  (feature also depends on a non-probe lib)
const tickets = [
  tk("root"),
  tk("lib", ["root"]),
  tk("probe-suite", ["root"]),
  tk("probe-cue", ["probe-suite"]),
  tk("feature", ["lib", "probe-cue"]),
];
const byId = new Map(tickets.map((t) => [t.id, t]));

describe("probe identity", () => {
  test("only probe- ids are probes", () => {
    expect(isProbeTicket(tk("probe-cue"))).toBe(true);
    expect(isProbeTicket(tk("lib"))).toBe(false);
  });
});

describe("transitive probe closure", () => {
  test("feature transitively requires BOTH probe-cue and probe-suite (not just the direct dep)", () => {
    expect(transitiveDeps("feature", byId)).toEqual(new Set(["lib", "root", "probe-cue", "probe-suite"]));
    expect(blockingProbeClosure("feature", byId)).toEqual(["probe-cue", "probe-suite"]);
  });

  test("a leaf probe has no blocking probe in its own closure", () => {
    expect(blockingProbeClosure("probe-suite", byId)).toEqual([]);
  });
});

describe("verdict greenness (real artifact gates scheduling)", () => {
  test("only an explicit truthy flag counts as green", () => {
    expect(isProbeVerdictGreen({ green: true })).toBe(true);
    expect(isProbeVerdictGreen({ overallPassed: true })).toBe(true);
    expect(isProbeVerdictGreen({ pass: true })).toBe(true);
  });

  test("RBG — missing/unrun/red verdicts are NOT green, so the dependent stays blocked", () => {
    expect(isProbeVerdictGreen(undefined)).toBe(false); // unrun
    expect(isProbeVerdictGreen(null)).toBe(false);
    expect(isProbeVerdictGreen({ green: false })).toBe(false); // red
    expect(isProbeVerdictGreen({ overallPassed: false })).toBe(false);
    expect(isProbeVerdictGreen("green")).toBe(false); // a string, not a real verdict object
  });
});

// Scheduler eligibility mirrors the workflow's ticketEligible(): deps landed AND every
// transitive blocking probe green.
function eligible(id: string, landed: Set<string>, verdicts: Map<string, any>): boolean {
  const t = byId.get(id)!;
  if (!t.dependsOn.every((d) => landed.has(d))) return false;
  return blockingProbeClosure(id, byId).every((p) => isProbeVerdictGreen(verdicts.get(p)));
}

describe("scheduling gate", () => {
  test("feature schedules only once deps land AND both probes are green", () => {
    const landed = new Set(["root", "lib", "probe-suite", "probe-cue"]);
    const verdicts = new Map<string, any>([
      ["probe-suite", { green: true }],
      ["probe-cue", { green: true }],
    ]);
    expect(eligible("feature", landed, verdicts)).toBe(true);
  });

  test("RBG — a red transitive probe blocks feature even though every dep landed", () => {
    const landed = new Set(["root", "lib", "probe-suite", "probe-cue"]);
    const verdicts = new Map<string, any>([
      ["probe-suite", { green: false }], // the transitive probe is red
      ["probe-cue", { green: true }],
    ]);
    expect(eligible("feature", landed, verdicts)).toBe(false);
  });

  test("RBG — an unrun probe (no verdict artifact) blocks feature", () => {
    const landed = new Set(["root", "lib", "probe-suite", "probe-cue"]);
    const verdicts = new Map<string, any>([["probe-cue", { green: true }]]); // probe-suite never recorded
    expect(eligible("feature", landed, verdicts)).toBe(false);
  });
});
