import { describe, expect, test } from "bun:test";
import { pickMicDevice } from "./mic";


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
