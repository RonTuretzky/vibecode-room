/** One address contract for the API, preview proxies, and development server. */
export const DEFAULT_ROOM_PORT = 8787;

export function resolveRoomPort(env: Record<string, string | undefined>): number {
  const raw = env.VIBERSYN_PORT ?? env.PORT;
  if (raw === undefined || raw.trim() === "") return DEFAULT_ROOM_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid room port ${JSON.stringify(raw)}: use an integer from 1 to 65535.`);
  }
  return port;
}

export function roomApiOrigin(env: Record<string, string | undefined>): string {
  return `http://127.0.0.1:${resolveRoomPort(env)}`;
}
