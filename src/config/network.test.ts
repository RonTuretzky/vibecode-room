import { expect, test } from "bun:test";
import { resolveRoomPort, roomApiOrigin } from "./network";

test("all launchers and proxies share defaults and environment precedence", () => {
  expect(resolveRoomPort({})).toBe(8787);
  expect(roomApiOrigin({ PORT: "9123" })).toBe("http://127.0.0.1:9123");
  expect(resolveRoomPort({ PORT: "9123", VIBERSYN_PORT: "9124" })).toBe(9124);
  for (const raw of ["-1", "0", "65536", "8787x", "1.5"]) {
    expect(() => resolveRoomPort({ VIBERSYN_PORT: raw })).toThrow("Invalid room port");
  }
});
