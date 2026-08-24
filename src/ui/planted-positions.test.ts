import { describe, expect, test } from "bun:test";
import { PLANTED_STORAGE_KEY, loadPlantedPositions, newUpidAfterAccept, savePlantedPosition } from "./planted-positions";

function fakeStorage(initial: Record<string, string> = {}): Pick<Storage, "getItem" | "setItem"> & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

describe("planted positions", () => {
  test("round-trips positions per upid", () => {
    const storage = fakeStorage();
    savePlantedPosition("upid_a", { x: 12.5, z: -40 }, storage);
    savePlantedPosition("upid_b", { x: -3, z: 7 }, storage);
    expect(loadPlantedPositions(storage)).toEqual({ upid_a: { x: 12.5, z: -40 }, upid_b: { x: -3, z: 7 } });
    // Re-planting the same upid moves it.
    savePlantedPosition("upid_a", { x: 1, z: 2 }, storage);
    expect(loadPlantedPositions(storage).upid_a).toEqual({ x: 1, z: 2 });
  });

  test("garbage in storage degrades to no positions, never a throw", () => {
    expect(loadPlantedPositions(fakeStorage({ [PLANTED_STORAGE_KEY]: "not json" }))).toEqual({});
    expect(
      loadPlantedPositions(fakeStorage({ [PLANTED_STORAGE_KEY]: JSON.stringify({ ok: { x: 1, z: 2 }, bad: { x: "NaN" }, worse: 7 }) })),
    ).toEqual({ ok: { x: 1, z: 2 } });
    expect(loadPlantedPositions(null)).toEqual({});
  });

  test("newUpidAfterAccept binds exactly one fresh upid", () => {
    expect(newUpidAfterAccept(["a"], ["a", "b"])).toBe("b");
    // No new process (mock accept) or an ambiguous burst → no binding.
    expect(newUpidAfterAccept(["a"], ["a"])).toBeNull();
    expect(newUpidAfterAccept(["a"], ["a", "b", "c"])).toBeNull();
    // A process disappearing while another appears still binds the new one.
    expect(newUpidAfterAccept(["a", "b"], ["a", "c"])).toBe("c");
  });
});
