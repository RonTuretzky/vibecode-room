import { expect, test } from "bun:test";
import { resolveRoomEnv } from "./profiles";

test("empty default and explicit installation profiles preserve environment overrides", async () => {
  expect((await resolveRoomEnv({})).VIBERSYN_PINNED_IMPORTS).toBe("");
  const original = await resolveRoomEnv({ VIBERSYN_ROOM_PROFILE: "convent" });
  expect(original.VIBERSYN_PINNED_IMPORTS).toContain("handstrudel");
  expect((await resolveRoomEnv({ VIBERSYN_ROOM_PROFILE: "convent", VIBERSYN_PINNED_IMPORTS: "" })).VIBERSYN_PINNED_IMPORTS).toBe("");
  await expect(resolveRoomEnv({ VIBERSYN_ROOM_PROFILE: "../other" })).rejects.toThrow("Invalid");
  await expect(resolveRoomEnv({ VIBERSYN_ROOM_PROFILE: "no-such-room" })).rejects.toThrow("Cannot load");
});
