import type { RoomEnv } from "./profiles";

export const localAiEnabled = (env: RoomEnv = process.env): boolean =>
  env.VIBERSYN_LOCAL_AI === "1" || env.VIBERSYN_ROOM_PROFILE === "local";

/** Local AI is a policy, not a default that inherited cloud credentials override. */
export function enforceLocalAi(env: RoomEnv): RoomEnv {
  if (!localAiEnabled(env)) return env;
  const result: RoomEnv = { ...env, VIBERSYN_LOCAL_AI: "1" };
  for (const key of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "CEREBRAS_API_KEY",
    "DEEPGRAM_API_KEY",
    "ELEVENLABS_API_KEY",
    "LANGFUSE_PUBLIC_KEY",
    "LANGFUSE_SECRET_KEY",
    "LANGFUSE_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "VIBERSYN_SMITHERS_GATEWAY_URL",
    "VIBERSYN_SMITHERS_GATEWAY_TOKEN",
  ])
    result[key] = "";
  for (const key of [
    "DECISION_LLM",
    "IDEA_DETECTOR",
    "RESEARCH_SUGGESTER",
    "RESEARCH_AGENT",
    "RESEARCH_LLM",
    "SUMMARIZER",
    "ASR_PROVIDER",
    "TTS_PROVIDER",
  ])
    result[`VIBERSYN_${key}`] = "local";
  result.VIBERSYN_BUILD_BACKENDS = "native";
  result.VIBERSYN_DECK_COPY_CLI = "0";
  return result;
}

export function localBaseUrl(env: RoomEnv = process.env): string {
  const url = new URL(env.VIBERSYN_LOCAL_LLM_URL || "http://127.0.0.1:1234/v1");
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Local AI requires a loopback LM Studio URL, e.g. http://127.0.0.1:1234/v1",
    );
  }
  return url.toString().replace(/\/+$/, "");
}

export const localModel = (
  env: RoomEnv = process.env,
  purpose: "fast" | "code" = "fast",
): string =>
  (purpose === "code"
    ? env.VIBERSYN_LOCAL_CODE_MODEL
    : env.VIBERSYN_LOCAL_FAST_MODEL) ||
  env.VIBERSYN_LOCAL_MODEL ||
  "openai/gpt-oss-20b";
