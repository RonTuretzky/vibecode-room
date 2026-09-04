import { resolveRoomEnv } from "../src/config/profiles";
import { resolveRoomPort } from "../src/config/network";

const env = await resolveRoomEnv(process.env);
Object.assign(process.env, env);
resolveRoomPort(env);
// Vite's HTTP/WebSocket proxy expects Node's socket implementation. Running
// createServer inside Bun can crash on a rejected WebSocket upgrade.
const node = Bun.which("node");
if (!node) throw new Error("Development requires Node.js 22.12+ to run Vite.");
const ui = Bun.spawn([node, "node_modules/vite/bin/vite.js", ...process.argv.slice(2)], {
  env, stdin: "inherit", stdout: "inherit", stderr: "inherit",
});
const api = Bun.spawn([process.execPath, "--watch", "src/server/index.ts"], {
  env, stdin: "inherit", stdout: "inherit", stderr: "inherit",
});
let closing = false;
async function stop(code: number) {
  if (closing) return;
  closing = true;
  api.kill();
  ui.kill();
  await Promise.allSettled([api.exited, ui.exited]);
  process.exit(code);
}
process.once("SIGINT", () => void stop(0));
process.once("SIGTERM", () => void stop(0));
void api.exited.then((code) => stop(code));
void ui.exited.then((code) => stop(code));
