import { describe, expect, test } from "bun:test";
import { getSceneCameraControl, registerSceneCameraControl, type SceneCameraControl } from "./camera-source";

const makeControl = (): SceneCameraControl => ({
  orbitBy: () => {},
  panBy: () => {},
  zoomBy: () => {},
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
});
