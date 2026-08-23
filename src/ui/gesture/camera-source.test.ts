import { describe, expect, test } from "bun:test";
import { applyCameraIntents, getSceneCameraControl, registerSceneCameraControl, type SceneCameraControl } from "./camera-source";

const makeControl = (): SceneCameraControl => ({
  orbitBy: () => {},
  panBy: () => {},
  zoomBy: () => {},
  walkBy: () => {},
  flick: () => {},
  setTracking: () => {},
});

describe("scene camera control registry", () => {
  test("register exposes the control; unregister clears it", () => {
    expect(getSceneCameraControl()).toBeNull();
    const control = makeControl();
    const unregister = registerSceneCameraControl(control);
    expect(getSceneCameraControl()).toBe(control);
    unregister();
    expect(getSceneCameraControl()).toBeNull();
  });

  test("stale unregister of a superseded control is a no-op", () => {
    const first = makeControl();
    const unregisterFirst = registerSceneCameraControl(first);
    const second = makeControl();
    const unregisterSecond = registerSceneCameraControl(second);
    unregisterFirst(); // superseded -> must not clear the current control
    expect(getSceneCameraControl()).toBe(second);
    unregisterSecond();
    expect(getSceneCameraControl()).toBeNull();
  });

  test("applyCameraIntents routes walk intents to walkBy with the signed speed AND its dt", () => {
    const calls: Array<[number, number]> = [];
    const control = makeControl();
    control.walkBy = (speed, dtSec) => calls.push([speed, dtSec]);
    const unregister = registerSceneCameraControl(control);
    applyCameraIntents(
      [{ kind: "walk", speed: 0.6, dt: 1 / 60 }, { kind: "walk", speed: -0.25, dt: 1 / 120 }, { kind: "walk" }],
      1080,
    );
    // dt rides along untouched (the scene integrates speed·dt); absent fields
    // default to a stop over a nominal 30 Hz frame, never NaN.
    expect(calls).toEqual([
      [0.6, 1 / 60],
      [-0.25, 1 / 120],
      [0, 1 / 30],
    ]);
    unregister();
  });
});
