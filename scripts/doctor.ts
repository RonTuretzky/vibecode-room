import { existsSync } from "node:fs";
import { resolveRoomEnv } from "../src/config/profiles";
import { roomApiOrigin } from "../src/config/network";

const env = await resolveRoomEnv(process.env);
console.log(`Room profile: ${env.VIBERSYN_ROOM_PROFILE ?? "default"}`);
console.log(`API: ${roomApiOrigin(env)}; development UI: http://127.0.0.1:5173`);
console.log(`Bun: ${Bun.version} (CI uses 1.3.14)`);
for (const cli of ["node", "git", "gh", "claude", "voxterm"]) {
  const purpose = cli === "node" ? " (22.12+ required for Vite development)" : cli === "git" ? "" : " (optional; needed for its live integration)";
  console.log(`${Bun.which(cli) ? "OK" : "MISSING"} ${cli}${purpose}`);
}
console.log(`${existsSync("node_modules") ? "OK" : "MISSING"} dependencies — bun install --frozen-lockfile`);
console.log(`${existsSync("dist/index.html") ? "OK" : "MISSING"} production UI — bun run build`);
console.log(`Resident imports: ${env.VIBERSYN_PINNED_IMPORTS?.trim() ? "configured" : "none"}`);
console.log(`Gateway: ${env.VIBERSYN_SMITHERS_GATEWAY_URL ? "configured" : "not configured; commissioned builds need a running gateway"}`);
console.log("Branch growth currently uses the bounded notes writer; arbitrary agent-driven branch edits are not implemented.");
for (const key of ["CEREBRAS_API_KEY", "DEEPGRAM_API_KEY", "VIBERSYN_SALEM_SID"]) {
  console.log(`${key}: ${env[key] ? "configured" : "not configured"}`);
}
console.log("Artifacts: builds/ and artifacts/vibersyn-runs/. Previous replaced outputs live in .history/ beside the project directories; removal is manual.");
