// §8 invariants: DAG is acyclic + refs resolve; waves are topological levels.
// RBG move per row: add a back-edge / a dangling ref and assert the build refuses to plan.
import { describe, expect, test } from "bun:test";
import { computeWaves, parseTickets, type Ticket } from "./core.ts";

function tk(id: string, dependsOn: string[] = [], complexity = "medium"): Ticket {
  return { id, title: id, instructions: "", requirementIds: [], verification: [], dependsOn, complexity };
}

describe("dag-acyclic", () => {
  test("computeWaves places each ticket at depth = 1 + max(dep depth)", () => {
    const waves = computeWaves([tk("a"), tk("b", ["a"]), tk("c", ["a"]), tk("d", ["b", "c"])]);
    expect(waves.map((w) => w.index)).toEqual([0, 1, 2]);
    expect(waves[0].tickets.map((t) => t.id)).toEqual(["a"]);
    expect(waves[1].tickets.map((t) => t.id)).toEqual(["b", "c"]); // antichain, id-sorted
    expect(waves[2].tickets.map((t) => t.id)).toEqual(["d"]);
  });

  test("RBG — a back-edge (cycle) makes planning throw, not silently schedule", () => {
    // green: acyclic plans fine
    expect(() => computeWaves([tk("a"), tk("b", ["a"])])).not.toThrow();
    // red: introduce a→b and b→a back-edge
    expect(() => computeWaves([tk("a", ["b"]), tk("b", ["a"])])).toThrow(/cycle/i);
  });

  test("RBG — a dangling dependsOn reference makes planning throw", () => {
    expect(() => computeWaves([tk("a", ["does-not-exist"])])).toThrow(/unresolved/i);
  });
});

describe("ticket parsing degrades safely but keeps ids", () => {
  test("parseTickets accepts the { tickets: [...] } envelope and drops id-less rows", () => {
    const tickets = parseTickets({ tickets: [{ id: "x" }, { title: "no id" }, { id: "y", dependsOn: ["x"] }] });
    expect(tickets.map((t) => t.id)).toEqual(["x", "y"]);
    expect(tickets[1].dependsOn).toEqual(["x"]);
  });

  test("unknown complexity normalizes to medium", () => {
    const [t] = parseTickets([{ id: "z", complexity: "gigantic" }]);
    expect(t.complexity).toBe("medium");
  });
});
