import { describe, expect, test } from "bun:test";
import { FLATLINE_MS, foldFlatline, pickFallbackDevice, pickMicDevice, type FlatlineState } from "./mic";


// DEVICE POLICY: the room must hear the ROOM's mic, not whichever input macOS
// happens to default to. Live finding: a RØDE Wireless GO receiver sat plugged
// in for days while the room captured the laptop's builtin — the default
// device — and nothing on the wall said so.
describe("pickMicDevice prefers the room mic", () => {
  const rode = { kind: "audioinput", label: "Wireless GO RX", deviceId: "usb-rode" };
  const builtin = { kind: "audioinput", label: "MacBook Pro Microphone", deviceId: "builtin" };
  const virtualDev = { kind: "audioinput", label: "ZoomAudioDevice", deviceId: "zoom" };
  const defaultAlias = { kind: "audioinput", label: "Default - MacBook Pro Microphone", deviceId: "default" };
  const speaker = { kind: "audiooutput", label: "MacBook Pro Speakers", deviceId: "spk" };

  test("an external mic beats the builtin default", () => {
    expect(pickMicDevice([defaultAlias, builtin, rode, speaker])).toEqual({ deviceId: "usb-rode", label: "Wireless GO RX" });
  });

  test("virtual devices (Zoom, aggregate, loopback) never win the auto pick", () => {
    expect(pickMicDevice([virtualDev, builtin])?.deviceId).toBe("builtin");
  });

  test("an explicit ?mic= label substring wins, case-insensitively", () => {
    expect(pickMicDevice([builtin, rode], "wireless")?.deviceId).toBe("usb-rode");
    expect(pickMicDevice([builtin, rode], "MACBOOK")?.deviceId).toBe("builtin");
  });

  test("an explicit ask that matches nothing falls back to the policy, not to silence", () => {
    expect(pickMicDevice([builtin, rode], "shure")?.deviceId).toBe("usb-rode");
  });

  test("builtin-only setups keep the builtin; outputs and empty lists are ignored", () => {
    expect(pickMicDevice([builtin, speaker])?.deviceId).toBe("builtin");
    expect(pickMicDevice([speaker])).toBeNull();
    expect(pickMicDevice([])).toBeNull();
  });
});

// DEAD-MIC DETECTION: a powered receiver with no transmitter link keeps its
// device alive and feeds exact digital zeros — the room must read that as a
// dead DEVICE (real rooms always have a noise floor) and switch, visibly.
describe("flatline detection + fallback pick", () => {
  test("zeros alone are not enough — the run must span FLATLINE_MS", () => {
    let state: FlatlineState = { lastLiveAtMs: 0 };
    let out = foldFlatline(state, 0, FLATLINE_MS - 1);
    expect(out.flatlined).toBe(false);
    out = foldFlatline(out.state, 0, FLATLINE_MS);
    expect(out.flatlined).toBe(true);
  });

  test("any nonzero sample resets the run — a quiet room never trips it", () => {
    let state: FlatlineState = { lastLiveAtMs: 0 };
    state = foldFlatline(state, 0, 5_000).state;
    state = foldFlatline(state, 0.0004, 6_000).state; // ambient noise floor
    const out = foldFlatline(state, 0, 6_000 + FLATLINE_MS - 1);
    expect(out.flatlined).toBe(false);
  });

  test("fallback excludes the dead device and re-runs the room-mic policy", () => {
    const rode = { kind: "audioinput", label: "Wireless GO RX", deviceId: "usb-rode" };
    const builtin = { kind: "audioinput", label: "MacBook Pro Microphone", deviceId: "builtin" };
    expect(pickFallbackDevice([rode, builtin], "Wireless GO RX")?.deviceId).toBe("builtin");
    // Dead device is the only input: nothing to switch to — report, not loop.
    expect(pickFallbackDevice([rode], "Wireless GO RX")).toBeNull();
  });
});
