import { resolveRoomEnv } from "../src/config/profiles";
import { localModel } from "../src/config/local";
import { probeLocalAi, localComplete } from "../src/providers/local";
import { whisperPython } from "../src/providers/asr/local";

const env = await resolveRoomEnv({
  ...process.env,
  VIBERSYN_ROOM_PROFILE: "local",
});
const status = await probeLocalAi(env);
if (!status.ok) {
  console.error(status.reason);
  console.error(
    "Open LM Studio, enable its local server on port 1234, and select an installed model with VIBERSYN_LOCAL_MODEL. No cloud provider will be used.",
  );
  process.exit(1);
}
console.log(
  `LM Studio connected: ${status.endpoint}\nCoding: ${localModel(env, "code")}\nConversation: ${localModel(env)}`,
);
console.log(
  await localComplete([{ role: "user", content: "Say: Local AI is ready." }], {
    env,
    maxTokens: 1024,
  }),
);
console.log(
  "Preparing the local Whisper model (downloads the weights once if needed; audio stays on this computer).",
);
const child = Bun.spawn(
  [
    whisperPython(env),
    "-c",
    'import os, whisper; whisper.load_model(os.environ.get("VIBERSYN_LOCAL_WHISPER_MODEL", "base.en"), device="cpu", download_root=os.environ.get("VIBERSYN_LOCAL_WHISPER_CACHE")); print("Local transcription ready.")',
  ],
  { env, stdout: "inherit", stderr: "inherit" },
);
if ((await child.exited) !== 0) {
  console.error(
    "Whisper setup failed. Install openai-whisper in a Python environment and set VIBERSYN_LOCAL_WHISPER_PYTHON to that environment's python executable.",
  );
  process.exit(1);
}
if (process.platform !== "darwin")
  console.warn(
    "Local speech output currently supports macOS. Text and transcription remain available on other platforms.",
  );
console.log("Preparing Chromium for the local coding agent's browser checks.");
const browserSetup = Bun.spawn(
  [process.execPath, "x", "playwright", "install", "chromium"],
  { env, stdout: "inherit", stderr: "inherit" },
);
if ((await browserSetup.exited) !== 0) process.exit(1);
console.log(
  "Ready. Run bun run build, then bun run local. For the multi-window room: bun run room --profile=local.",
);
