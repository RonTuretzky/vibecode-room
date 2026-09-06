import { describe, expect, test } from "bun:test";
import { NavigationHolds, navigationAxes, NAVIGATION_KEYS } from "./spatial-navigation";
import { parseGuestMessage } from "../server/remote-hands";

describe("spatial navigation", () => {
  test("independent input owners cannot release each other's directions", () => {
    const holds = new NavigationHolds();
    holds.set("local", ["w", "arrowleft"]);
    holds.set("guest", ["w", "="]);
    holds.set("guest", []);
    expect([...holds.keys()]).toEqual(["w", "arrowleft"]);
    holds.set("local", []);
    expect(holds.keys().size).toBe(0);
  });
  test("diagonal travel is normalized and opposing commands cancel", () => {
    const diagonal = navigationAxes(new Set(["w", "d"]));
    expect(Math.hypot(diagonal.forward, diagonal.right)).toBeCloseTo(1);
    expect(navigationAxes(new Set(NAVIGATION_KEYS))).toEqual({ forward: 0, right: 0, turn: 0, elevation: 0, zoom: 0 });
  });
  test("guest relay accepts navigation only, including look, zoom and home", () => {
    expect(parseGuestMessage(JSON.stringify({ type: "keys", held: [...NAVIGATION_KEYS, "Enter", "q", "ArrowLeft", "w"] })))
      .toEqual({ kind: "keys", held: [...NAVIGATION_KEYS] });
    const holds = new NavigationHolds();
    holds.set("guest", ["Enter", "w"]);
    expect([...holds.keys()]).toEqual(["w"]);
  });
});
