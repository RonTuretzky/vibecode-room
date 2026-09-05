import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type RoomEnv = Record<string, string | undefined>;

/** Profiles contain defaults only. Explicit environment values, including empty
 * strings, always win. Secrets belong in the environment, never a profile. */
export async function resolveRoomEnv(env: RoomEnv, root = process.cwd()): Promise<RoomEnv> {
  const name = env.VIBERSYN_ROOM_PROFILE ?? "default";
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("Invalid VIBERSYN_ROOM_PROFILE name.");
  const path = resolve(root, "room-profiles", `${name}.json`);
  let profile: unknown;
  try {
    profile = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot load room profile ${name} at ${path}: ${String(error)}`);
  }
  const defaults = (profile as { env?: unknown })?.env;
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) {
    throw new Error(`Room profile ${name} must contain an env object.`);
  }
  for (const [key, value] of Object.entries(defaults)) {
    if (!/^(VIBERSYN_[A-Z0-9_]+|HOST|PORT|ROOM_CONFIG|WALL_[A-Z0-9_]+|SINGLE_VIEW)$/.test(key) || typeof value !== "string") {
      throw new Error(`Invalid room profile setting ${key}: expected a supported environment key and string value.`);
    }
  }
  return { ...(defaults as Record<string, string>), ...Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)) };
}
