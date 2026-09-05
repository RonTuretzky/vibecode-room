import { localBaseUrl, localModel } from "../config/local";
import type { RoomEnv } from "../config/profiles";

export interface LocalMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
export interface LocalCompletionOptions {
  env?: RoomEnv;
  purpose?: "fast" | "code";
  signal?: AbortSignal;
  timeoutMs?: number;
  maxTokens?: number;
  schema?: Record<string, unknown>;
}

// Shared across all room features: no burst of simultaneous decoding jobs and
// no unbounded background queue. An aborted queued request never reaches LM Studio.
let active = 0;
const waiters: Array<() => void> = [];
async function acquire(signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted();
  if (active >= 2) {
    if (waiters.length >= 24)
      throw new Error("Local AI is busy; please retry shortly.");
    await new Promise<void>((resolve, reject) => {
      const ready = () => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        const i = waiters.indexOf(ready);
        if (i >= 0) waiters.splice(i, 1);
        reject(signal.reason);
      };
      waiters.push(ready);
      signal.addEventListener("abort", abort, { once: true });
    });
  } else active++;
  if (signal.aborted) {
    release();
    signal.throwIfAborted();
  }
  return release;
}
function release(): void {
  const next = waiters.shift();
  if (next) next();
  else active--;
}

export async function localComplete(
  messages: LocalMessage[],
  options: LocalCompletionOptions = {},
): Promise<string> {
  const env = options.env ?? process.env;
  const url = localBaseUrl(env);
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? 120_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  const done = await acquire(signal);
  try {
    const response = await fetch(`${url}/chat/completions`, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        "content-type": "application/json",
        ...(env.VIBERSYN_LOCAL_LLM_TOKEN
          ? { authorization: `Bearer ${env.VIBERSYN_LOCAL_LLM_TOKEN}` }
          : {}),
      },
      body: JSON.stringify({
        model: localModel(env, options.purpose),
        messages: [
          {
            role: "system",
            content: [
              "Reasoning: low",
              ...messages
                .filter((message) => message.role === "system")
                .map((message) => message.content),
              ...(options.schema
                ? [
                    `Answer the user's task with a JSON INSTANCE containing actual results. Do not return the schema itself, placeholders, or prose. The instance must satisfy this JSON Schema: ${JSON.stringify(options.schema)}`,
                  ]
                : []),
            ].join("\n\n"),
          },
          ...messages.filter((message) => message.role !== "system"),
        ],
        temperature: 0,
        max_tokens: options.maxTokens ?? 4096,
        // GPT-OSS uses Harmony tokens that LM Studio's grammar can corrupt.
        // Prompt + application validation is the default, including for model
        // aliases. Enable constrained decoding only for a compatible model.
        ...(options.schema && env.VIBERSYN_LOCAL_STRUCTURED_OUTPUT === "1"
          ? {
              response_format: {
                type: "json_schema",
                json_schema: {
                  name: "room_reply",
                  strict: true,
                  schema: options.schema,
                },
              },
            }
          : {}),
      }),
    });
    if (!response.ok)
      throw new Error(
        `LM Studio returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`,
      );
    const body = (await response.json()) as {
      choices?: Array<{
        finish_reason?: string;
        message?: { content?: string };
      }>;
    };
    const choice = body.choices?.[0];
    if (choice?.finish_reason === "length")
      throw new Error(
        "Local model response exceeded its token budget; select a larger budget or a shorter task.",
      );
    const text = choice?.message?.content?.trim();
    if (!text)
      throw new Error(
        "LM Studio returned no answer. Check the selected model and context size.",
      );
    return text
      .replace(/^<think>[\s\S]*?<\/think>\s*/, "")
      .replace(
        /^<\|channel\|>final\s*(?:<\|constrain\|>\w+\s*)?<\|message\|>/,
        "",
      )
      .trim();
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new Error(
      `Local AI: ${error instanceof Error ? error.message : String(error)}. No cloud fallback was used.`,
    );
  } finally {
    done();
  }
}

export function localPromptRunner(env: RoomEnv) {
  return (prompt: string, opts: { timeoutMs: number }) =>
    localComplete([{ role: "user", content: prompt }], {
      env,
      timeoutMs: opts.timeoutMs,
    });
}

export function parseLocalJson(text: string): unknown {
  return JSON.parse(
    text
      .trim()
      .replace(/^```(?:jsonc?)?\s*/i, "")
      .replace(/\s*```$/, ""),
  );
}

export async function probeLocalAi(env: RoomEnv = process.env): Promise<{
  ok: boolean;
  reason?: string;
  models?: string[];
  endpoint?: string;
}> {
  try {
    const endpoint = localBaseUrl(env);
    const response = await fetch(`${endpoint}/models`, {
      redirect: "error",
      signal: AbortSignal.timeout(1800),
      headers: env.VIBERSYN_LOCAL_LLM_TOKEN
        ? { authorization: `Bearer ${env.VIBERSYN_LOCAL_LLM_TOKEN}` }
        : {},
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { data?: Array<{ id: string }> };
    const models = (body.data ?? []).map((m) => m.id);
    for (const purpose of ["fast", "code"] as const)
      if (!models.includes(localModel(env, purpose)))
        throw new Error(
          `Model ${localModel(env, purpose)} is unavailable. Select an installed LM Studio model.`,
        );
    return { ok: true, models, endpoint };
  } catch (error) {
    return {
      ok: false,
      reason: `LM Studio: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
