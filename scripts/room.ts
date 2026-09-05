import { resolveRoomEnv } from "../src/config/profiles";

const args = process.argv.slice(2);
const profile = args.find((arg) => arg.startsWith("--profile="))?.slice("--profile=".length);
const env = await resolveRoomEnv({ ...process.env, ...(profile ? { VIBERSYN_ROOM_PROFILE: profile } : {}), VIBERSYN_ROOM_PROFILE_LOADED: "1" });
const child = Bun.spawn(["bash", "run-room.sh", ...args.filter((arg) => !arg.startsWith("--profile="))], {
  env, stdin: "inherit", stdout: "inherit", stderr: "inherit",
});
process.once("SIGINT", () => child.kill("SIGINT"));
process.once("SIGTERM", () => child.kill("SIGTERM"));
process.exit(await child.exited);
