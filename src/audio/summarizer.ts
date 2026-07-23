// Hot-loop summarizer — the production leg of the ">15 words → summarize" guard.
//
// output-policy's ttsDecision applies the guard (output-policy.ts:67 in the
// audit), but no production caller ever supplied a summarizer, so every overlong
// spoken update silently fell through to the deterministic word-clamp (truncated
// mid-sentence). `selectSummarizer(env)` is the single seam that maps
// VIBERSYN_SUMMARIZER onto a concrete HotLoopSummaryLLM, mirroring the provider
// registries (see src/providers/*/registry.ts):
//
//   deterministic -> DeterministicClampSummarizer (no-key default; clampWords truncation)
//   cerebras      -> CerebrasSummarizer           (explicit, or auto when CEREBRAS_API_KEY resolves)
//
//   explicit env  >  credential auto-select  >  deterministic default
//
// The Cerebras leg is a ONE-SHOT summarize-to-N-words chat completion against
// the OpenAI-compatible endpoint. Any failure — missing key at call time,
// network error, timeout, empty answer — falls back to the deterministic clamp,
// so the hot loop can never wedge or throw on the summarizer.

import type { HotLoopSummaryLLM, SummaryInput } from "./output-policy";
import { DEFAULT_OUTPUT_SUMMARY_MODEL } from "./output-policy";

export type SummarizerMode = "deterministic" | "cerebras";

export const CEREBRAS_CHAT_COMPLETIONS_URL = "https://api.cerebras.ai/v1/chat/completions";
// Cerebras's Gemma 4 (31B) — the same hot-loop default as the cue-cerebras
// decider (see providers/llm/cue-cerebras.ts); CEREBRAS_MODEL overrides.
export const DEFAULT_CEREBRAS_SUMMARIZER_MODEL = "gemma-4-31b";
// A summary that misses this budget is worthless to the hot loop — the caller's
// deterministic clamp is instant. Keep it tight and rely on the fallback.
export const DEFAULT_SUMMARIZER_TIMEOUT_MS = 4_000;

export interface CerebrasChatMessage {
  role: "system" | "user";
  content: string;
}

export interface CerebrasChatRequest {
  model: string;
  messages: CerebrasChatMessage[];
  temperature: number;
  max_completion_tokens: number;
}

export interface CerebrasChatResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

/**
 * Injectable network seam. The default transport reads CEREBRAS_API_KEY at call
 * time so the raw key never crosses the CerebrasSummarizer constructor; unit
 * tests substitute a stub so no real request is made.
 */
export type CerebrasChatTransport = (
  request: CerebrasChatRequest,
  signal?: AbortSignal,
) => Promise<CerebrasChatResponse>;

export interface CerebrasSummarizerOptions {
  transport?: CerebrasChatTransport;
  /** Real Cerebras model id substituted for the policy's placeholder model. */
  model?: string;
  timeoutMs?: number;
}

export interface SummarizerSelectionEnv {
  VIBERSYN_SUMMARIZER?: string;
  CEREBRAS_API_KEY?: string;
  CEREBRAS_MODEL?: string;
  [key: string]: string | undefined;
}

export interface SummarizerSelectionOptions {
  /** Injectable transport (tests/e2e substitute a stub for no network). */
  transport?: CerebrasChatTransport;
  /** Override the Cerebras model id. */
  model?: string;
  /** Override the per-call summary timeout. */
  timeoutMs?: number;
}

export interface SummarizerSelection {
  mode: SummarizerMode;
  summarizer: HotLoopSummaryLLM;
}

// Deterministic fallback: keep the first maxWords words verbatim. This is the
// same truncation ttsDecision itself applies as a last resort — honest but
// mid-sentence, which is exactly why the Cerebras leg exists.
export function clampWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/u).filter(Boolean);
  if (words.length <= maxWords) {
    return text.trim();
  }
  return words.slice(0, maxWords).join(" ");
}

export class DeterministicClampSummarizer implements HotLoopSummaryLLM {
  summarize(input: SummaryInput): string {
    return clampWords(input.text, input.maxWords);
  }
}

export class CerebrasSummarizer implements HotLoopSummaryLLM {
  readonly #transport: CerebrasChatTransport;
  readonly #model: string;
  readonly #timeoutMs: number;

  constructor(options: CerebrasSummarizerOptions = {}) {
    this.#transport = options.transport ?? createCerebrasFetchTransport();
    this.#model = options.model ?? DEFAULT_CEREBRAS_SUMMARIZER_MODEL;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_SUMMARIZER_TIMEOUT_MS;
  }

  async summarize(input: SummaryInput): Promise<string> {
    try {
      const response = await this.#transport(this.buildRequest(input), AbortSignal.timeout(this.#timeoutMs));
      const spoken = cleanSummary(response.choices?.[0]?.message?.content ?? "");
      if (spoken.length === 0) {
        return clampWords(input.text, input.maxWords);
      }
      // The model can overrun its word budget; the guard is hard, so clamp here
      // too (ttsDecision clamps again — belt and braces).
      return clampWords(spoken, input.maxWords);
    } catch {
      return clampWords(input.text, input.maxWords);
    }
  }

  buildRequest(input: SummaryInput): CerebrasChatRequest {
    return {
      model: this.resolveModel(input.model),
      messages: [
        {
          role: "system",
          content:
            "You compress agent status updates for an ambient room assistant's SPOKEN output. " +
            `Reply with ONLY the summary: at most ${input.maxWords} words, plain spoken English, ` +
            "no quotes, no markdown, no file paths, no URLs, no code.",
        },
        { role: "user", content: `Summarize in at most ${input.maxWords} words:\n${input.text}` },
      ],
      temperature: 0,
      max_completion_tokens: Math.max(48, input.maxWords * 4),
    };
  }

  // The output-policy config carries a PLACEHOLDER model label
  // ("hot-loop-cheap-fast") unless VIBERSYN_OUTPUT_SUMMARY_MODEL names a real
  // one; substitute the concrete Cerebras model for the placeholder.
  private resolveModel(requested: string): string {
    const trimmed = requested.trim();
    if (trimmed.length === 0 || trimmed === DEFAULT_OUTPUT_SUMMARY_MODEL) {
      return this.#model;
    }
    return trimmed;
  }
}

export function selectSummarizer(
  env: SummarizerSelectionEnv,
  options: SummarizerSelectionOptions = {},
): SummarizerSelection {
  const mode = resolveSummarizerMode(env, options);
  switch (mode) {
    case "deterministic":
      return { mode, summarizer: new DeterministicClampSummarizer() };
    case "cerebras":
      return {
        mode,
        summarizer: new CerebrasSummarizer({
          transport: options.transport ?? createCerebrasFetchTransport(fetch, env),
          model: options.model ?? env.CEREBRAS_MODEL,
          timeoutMs: options.timeoutMs,
        }),
      };
  }
}

function resolveSummarizerMode(
  env: SummarizerSelectionEnv,
  options: SummarizerSelectionOptions,
): SummarizerMode {
  const explicit = env.VIBERSYN_SUMMARIZER?.trim().toLowerCase();
  if (explicit !== undefined && explicit.length > 0) {
    if (explicit === "deterministic") {
      return explicit;
    }
    if (explicit === "cerebras") {
      if (!hasResolvableCerebrasCredential(env) && options.transport === undefined) {
        throw new Error(
          "VIBERSYN_SUMMARIZER=cerebras requires CEREBRAS_API_KEY to be set. " +
            "Set it, or use VIBERSYN_SUMMARIZER=deterministic for the no-key clamp default.",
        );
      }
      return explicit;
    }
    throw new Error(
      `Unknown VIBERSYN_SUMMARIZER "${env.VIBERSYN_SUMMARIZER}". Expected one of: deterministic, cerebras.`,
    );
  }

  // Unset: auto-select the real Cerebras summarizer when its credential resolves
  // (mirroring the ASR/Deepgram, TTS/ElevenLabs, and DecisionLLM/Claude
  // auto-selects); otherwise the deterministic clamp — no key, no network.
  return hasResolvableCerebrasCredential(env) || options.transport !== undefined ? "cerebras" : "deterministic";
}

function hasResolvableCerebrasCredential(env: SummarizerSelectionEnv): boolean {
  return typeof env.CEREBRAS_API_KEY === "string" && env.CEREBRAS_API_KEY.length > 0;
}

export function createCerebrasFetchTransport(
  fetchImpl: typeof fetch = fetch,
  env: Record<string, string | undefined> = process.env,
): CerebrasChatTransport {
  return async (request, signal) => {
    const apiKey = env.CEREBRAS_API_KEY;
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error("CEREBRAS_API_KEY is not set; cannot reach the Cerebras chat completions API.");
    }

    const response = await fetchImpl(CEREBRAS_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(request),
      signal,
    });

    if (!response.ok) {
      throw new Error(`Cerebras chat completions request failed with status ${response.status}.`);
    }

    return (await response.json()) as CerebrasChatResponse;
  };
}

// The model may wrap its answer in quotes or spread it over lines despite the
// system prompt; a spoken summary is a single unquoted line.
function cleanSummary(content: string): string {
  return content
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^["'“‘]+/u, "")
    .replace(/["'”’]+$/u, "")
    .trim();
}
