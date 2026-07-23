import { readdir, stat } from "node:fs/promises";
import { extname, join, sep } from "node:path";
import { createCerebrasRetryFetch, type CerebrasBackoffOptions } from "../cerebras-retry";
import type { BuildBackend, BuildBackendId, BuildRequest, BuildResult } from "../types";

/**
 * The "eliza" BuildBackend: an ElizaOS-character-faithful CONCEPT-MOCK loop.
 *
 * KICKOFF SCOPE (two-stage pivot): the character plans then implements ONE
 * small self-contained concept-mock page (hero screen, visual identity,
 * headline pitch line, one lightly-sketched interaction) — never the full app
 * (that is the separate commission stage). The old critique/revise rounds are
 * gone from the fresh build: plan -> implement, small single-file output,
 * tight per-call timeout. This also fixes the JSON-truncation failures the
 * full-app outputs used to hit — a single small index.html fits comfortably in
 * one completion (the 429 backoff transport is unchanged). Corrections (steer)
 * keep the single revise pass.
 *
 * What is REAL ElizaOS here (loaded at runtime from @elizaos/core@1.7.x):
 *   - the coder Character (full Character schema: system/bio/topics/adjectives/
 *     style/templates) rendered through core.composePromptFromState (handlebars),
 *   - Memory/Content message shapes for the pitch and the agent's responses,
 *   - the Action shape ({name, similes, description, validate, handler}) for
 *     WRITE_APP_FILES, invoked processActions-style off response.content.actions,
 *   - core.stringToUuid for agent/room/entity/message ids.
 * What is an ADAPTER and why is documented in .context/eliza-notes.md — most
 * importantly, the full AgentRuntime is not used because 1.7.x hard-requires a
 * database adapter from @elizaos/plugin-sql, and core.parseJSONObjectFromText
 * is not used because its normalizer corrupts nested {files:{...}} payloads.
 *
 * The dependency is loaded dynamically so this module (and its tests, and the
 * selector's available() probe) work before `bun add @elizaos/core` has run:
 * a missing/incompatible package degrades to {ok:false, reason} instead of a
 * crash at import time. Model calls go to ElizaOS's OpenAI-compatible provider
 * configuration pointed at Cerebras (base https://api.cerebras.ai/v1, key
 * CEREBRAS_API_KEY, model CEREBRAS_MODEL ?? gemma-4-31b). There are no
 * subprocesses — every model call is a fetch aborted via the BuildRequest
 * signal, so the ~2s emergency-stop budget is met by construction.
 */

export const ELIZA_BACKEND_LABEL = "ElizaOS";
export const ELIZA_ENTRYPOINT = "index.html";
export const ELIZA_CORE_PACKAGE = "@elizaos/core";
export const CEREBRAS_OPENAI_BASE_URL = "https://api.cerebras.ai/v1";

// Tight per-call ceiling: a mock lane targets ~60s total (plan + implement).
const DEFAULT_CALL_TIMEOUT_MS = 45_000;
// Whole-call ceiling when the default retrying transport is in play: covers
// throttle-queue waiting + 429/timeout backoff during a concurrent multi-idea
// fan-out. The 45s per-attempt cap above still bounds each wire request.
const DEFAULT_OVERALL_CALL_TIMEOUT_MS = 150_000;
const DEFAULT_MAX_COMPLETION_TOKENS = 16_384;
const MAX_PROMPT_FILE_CHARS = 20_000;
const MAX_READ_FILE_BYTES = 512 * 1024;
const TEXT_EXTENSIONS = new Set([".html", ".htm", ".css", ".js", ".mjs", ".json", ".svg", ".txt", ".md", ".xml"]);

// --- ElizaOS structural types ----------------------------------------------
// Field-for-field subsets of @elizaos/core@1.7.2's declarations (types/agent.d.ts,
// types/memory.d.ts, types/primitives.d.ts, types/components.d.ts). Declared
// locally instead of `import type` so typecheck stays green before the
// integrator installs the package; the real objects satisfy these shapes.

export interface ElizaContent {
  thought?: string;
  text?: string;
  actions?: string[];
  source?: string;
  [key: string]: unknown;
}

export interface ElizaMemory {
  id?: string;
  entityId: string;
  agentId?: string;
  roomId: string;
  createdAt?: number;
  content: ElizaContent;
}

export interface ElizaState {
  values: { [key: string]: unknown };
  data: { [key: string]: unknown };
  text: string;
  [key: string]: unknown;
}

export interface ElizaCharacter {
  name: string;
  username?: string;
  system?: string;
  templates?: { [key: string]: string };
  bio: string | string[];
  topics?: string[];
  adjectives?: string[];
  settings?: { [key: string]: string | boolean | number | Record<string, unknown> };
  style?: { all?: string[]; chat?: string[]; post?: string[] };
}

export interface ElizaActionResult {
  text?: string;
  values?: Record<string, unknown>;
  data?: Record<string, unknown>;
  success: boolean;
  error?: string;
}

export type ElizaHandlerCallback = (response: ElizaContent) => Promise<ElizaMemory[]>;

export interface ElizaRuntimeLike {
  agentId: string;
  character: ElizaCharacter;
  useModel(modelType: string, params: ElizaGenerateTextParams): Promise<string>;
}

export type ElizaHandler = (
  runtime: ElizaRuntimeLike,
  message: ElizaMemory,
  state?: ElizaState,
  options?: Record<string, unknown>,
  callback?: ElizaHandlerCallback,
) => Promise<ElizaActionResult | void | undefined>;

export interface ElizaAction {
  name: string;
  similes?: string[];
  description: string;
  validate: (runtime: ElizaRuntimeLike, message: ElizaMemory, state?: ElizaState) => Promise<boolean>;
  handler: ElizaHandler;
  [key: string]: unknown;
}

// --- @elizaos/core facade ---------------------------------------------------
// The slice of the real package this backend calls at runtime.

export interface ElizaCoreModule {
  composePromptFromState: (args: { state: ElizaState; template: string }) => string;
  stringToUuid: (target: string | number) => string;
  ModelType: Record<string, string>;
}

export type ElizaCoreLoad = { ok: true; core: ElizaCoreModule } | { ok: false; reason: string };

let elizaCoreLoad: Promise<ElizaCoreLoad> | undefined;

// Dynamic import through a variable specifier so neither bun nor tsc resolves
// the package eagerly — before `bun add @elizaos/core` this returns a reason
// instead of throwing at module load. The result is cached: the package cannot
// appear mid-run, and a restart re-probes after install.
export function loadElizaCore(): Promise<ElizaCoreLoad> {
  elizaCoreLoad ??= (async (): Promise<ElizaCoreLoad> => {
    let loaded: Record<string, unknown>;
    try {
      const specifier: string = ELIZA_CORE_PACKAGE;
      loaded = (await import(specifier)) as Record<string, unknown>;
    } catch (error) {
      return { ok: false, reason: `${ELIZA_CORE_PACKAGE} is not installed (bun add ${ELIZA_CORE_PACKAGE}@1.7.2): ${errorMessage(error)}` };
    }
    if (
      typeof loaded.composePromptFromState !== "function" ||
      typeof loaded.stringToUuid !== "function" ||
      !isRecord(loaded.ModelType)
    ) {
      return { ok: false, reason: `${ELIZA_CORE_PACKAGE} loaded but is missing the 1.7.x exports this backend uses (composePromptFromState/stringToUuid/ModelType)` };
    }
    return { ok: true, core: loaded as unknown as ElizaCoreModule };
  })();
  return elizaCoreLoad;
}

// --- model handler: ElizaOS OpenAI-compatible provider → Cerebras -----------
// Mirrors the shape of an ElizaOS TEXT_LARGE model handler (GenerateTextParams
// in, string out) with one deviation: an AbortSignal, which eliza's params lack
// but the emergency-stop contract requires.

export interface ElizaGenerateTextParams {
  prompt: string;
  system?: string;
  temperature?: number;
  maxTokens?: number;
  signal: AbortSignal;
}

export type ElizaModelHandler = (params: ElizaGenerateTextParams) => Promise<string>;

export interface CerebrasChatModelOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** Full transport override (tests). Replaces the default retrying fetch entirely. */
  fetchImpl?: typeof fetch;
  /** Tuning/injection for the default 429/5xx backoff transport (see ../cerebras-retry.ts). */
  retry?: CerebrasBackoffOptions;
  timeoutMs?: number;
  maxCompletionTokens?: number;
}

// OpenAI-compatible chat completions against Cerebras — the same wire protocol
// @elizaos/plugin-openai speaks when OPENAI_BASE_URL points at Cerebras. Tries
// response_format json_object first; a non-429 4xx retries once without it
// (some models reject the parameter; a 429 is a quota signal the backoff
// transport already retried, so re-sending it would just burn more quota).
// Default transport is fetchWithCerebrasBackoff: 429/5xx get exponential
// backoff + jitter (honoring Retry-After) and the shared concurrency throttle.
export function createCerebrasChatModel(options: CerebrasChatModelOptions = {}): ElizaModelHandler | null {
  const apiKey = options.apiKey ?? process.env.CEREBRAS_API_KEY;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    return null;
  }
  const model = options.model ?? process.env.CEREBRAS_MODEL ?? "gemma-4-31b";
  const baseUrl = (options.baseUrl ?? CEREBRAS_OPENAI_BASE_URL).replace(/\/$/u, "");
  const perCallTimeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  // With the default retrying transport the per-call budget guards each ATTEMPT
  // (armed once the request is on the wire — see perAttemptTimeoutMs), and the
  // whole call gets a wider ceiling so throttle-queue waits + backoff retries
  // during a concurrent fan-out do not kill the build. An injected fetchImpl
  // keeps the legacy whole-call semantics (the tests' contract).
  const usingDefaultTransport = options.fetchImpl === undefined;
  const fetchImpl =
    options.fetchImpl ?? createCerebrasRetryFetch({ perAttemptTimeoutMs: perCallTimeoutMs, ...options.retry });
  const timeoutMs = usingDefaultTransport ? Math.max(perCallTimeoutMs, DEFAULT_OVERALL_CALL_TIMEOUT_MS) : perCallTimeoutMs;
  const maxCompletionTokens = options.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS;
  return async ({ prompt, system, temperature, maxTokens, signal }) => {
    const attempt = async (withJsonFormat: boolean): Promise<Response> =>
      fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          temperature: temperature ?? 0,
          max_completion_tokens: maxTokens ?? maxCompletionTokens,
          messages: [
            ...(system === undefined ? [] : [{ role: "system", content: system }]),
            { role: "user", content: prompt },
          ],
          ...(withJsonFormat ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
    let response = await attempt(true);
    if (!response.ok && response.status >= 400 && response.status < 500 && response.status !== 429) {
      response = await attempt(false);
    }
    if (!response.ok) {
      throw new Error(`Cerebras HTTP ${response.status}: ${truncate(await response.text(), 300)}`);
    }
    const payload: unknown = await response.json();
    const content = chatCompletionContent(payload);
    if (content === null) {
      throw new Error("Cerebras returned no message content");
    }
    return content;
  };
}

function chatCompletionContent(payload: unknown): string | null {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    return null;
  }
  const choice: unknown = payload.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) {
    return null;
  }
  const content = choice.message.content;
  return typeof content === "string" && content.length > 0 ? content : null;
}

// --- the coder character ----------------------------------------------------
// A full ElizaOS Character. The stage templates live in character.templates
// (the schema's home for prompt templates) and are rendered with the real
// composePromptFromState, which substitutes {{keys}} from state.values.

export const ELIZA_CODER_CHARACTER: ElizaCharacter = {
  name: "Syn",
  username: "syn_shipwright",
  system: [
    "You are Syn, the resident concept artist for a live vibe-coding wall: you turn spoken idea pitches into small,",
    "seductive CONCEPT MOCKS — one self-contained page selling the imagined app, never the full app. Hard rules: the",
    `entrypoint is ${ELIZA_ENTRYPOINT} and it is the ONLY file, with all CSS/JS inline; NO CDN links, NO external URLs,`,
    "NO network calls, NO build steps, NO frameworks — vanilla HTML/CSS/JS only. Keep output SMALL. You always reply",
    "with a single JSON object and nothing else — no prose, no markdown fences.",
  ].join(" "),
  bio: [
    "Sells the dream in one screen rather than shipping a mediocre whole.",
    "Treats every pitch as imaginable and finds the hero shot that makes the room want it.",
    "Allergic to dependencies; believes an index.html should stand alone forever.",
  ],
  topics: ["concept mocks", "visual identity", "vanilla javascript", "css", "interaction design"],
  adjectives: ["evocative", "playful", "terse", "meticulous"],
  settings: {
    // How the model provider is pointed at Cerebras, in @elizaos/plugin-openai's
    // own configuration vocabulary (values are non-secret; the key stays in env).
    OPENAI_BASE_URL: CEREBRAS_OPENAI_BASE_URL,
    OPENAI_LARGE_MODEL: "gemma-4-31b",
  },
  style: {
    all: ["reply with strict JSON only", "prefer one small complete page over a sprawling sketch"],
    chat: ["never explain, just mock it up"],
  },
  templates: {
    plan: [
      "{{agentName}} is imagining a concept mock for the room.",
      "Idea pitch: {{pitch}}",
      "",
      "Imagine the app this pitch describes and plan a CONCEPT MOCK — one small self-contained page:",
      "the app's hero screen, a strong visual identity (name, palette, typography), a prominently displayed",
      "headline pitch line, and ONE key interaction lightly sketched. Full functionality is NOT the goal.",
      'Reply with ONLY JSON: {"pitch": "<one punchy headline pitch line for the app>",',
      '"spec": "<concise mock spec: hero layout, visual identity, the one sketched interaction>"}',
    ].join("\n"),
    implement: [
      "Idea pitch: {{pitch}}",
      "Headline: {{headline}}",
      "Spec: {{spec}}",
      "",
      `Write the COMPLETE concept mock as a single SMALL ${ELIZA_ENTRYPOINT} (all CSS/JS inline).`,
      `Reply with ONLY strict JSON: {"files": {"${ELIZA_ENTRYPOINT}": "<full file content>"}}.`,
      "This is a mock of the imagined app, not the app — keep it compact.",
      "Escape the content as a valid JSON string. No markdown fences, no commentary.",
    ].join("\n"),
    revise: [
      "Idea pitch: {{pitch}}",
      "{{specLine}}",
      "Current files (JSON map of path -> content):",
      "{{filesJson}}",
      "",
      "Fix these issues:",
      "{{issues}}",
      "",
      'Reply with ONLY strict JSON: {"files": {"<path>": "<full new file content>", ...}} containing ONLY the files you change or add.',
      "Each changed file must be complete and stay a small self-contained mock. No markdown fences, no commentary.",
    ].join("\n"),
  },
};

// --- state + message composition (pure) -------------------------------------

// The pitch as an ElizaOS Memory: the room speaks to the agent in a per-process
// room, exactly the shape AgentRuntime would store for an incoming message.
export function composePitchMessage(core: ElizaCoreModule, req: Pick<BuildRequest, "upid" | "ideaId" | "prompt" | "callsign">): ElizaMemory {
  const agentId = core.stringToUuid(`vibersyn-eliza-${ELIZA_CODER_CHARACTER.name}`);
  return {
    id: core.stringToUuid(`vibersyn-pitch-${req.upid}-${req.ideaId}`),
    entityId: core.stringToUuid(`vibersyn-entity-${req.callsign ?? "the-room"}`),
    agentId,
    roomId: core.stringToUuid(`vibersyn-room-${req.upid}`),
    createdAt: Date.now(),
    content: { text: req.prompt, source: "vibersyn", channelType: "GROUP" },
  };
}

// State for composePromptFromState: character-derived values plus the stage
// extras. Every {{key}} in the character templates must resolve from here (the
// colocated test enforces that).
export function composeBuildState(
  character: ElizaCharacter,
  message: ElizaMemory,
  extras: Record<string, string> = {},
): ElizaState {
  const bio = Array.isArray(character.bio) ? character.bio.join(" ") : character.bio;
  return {
    values: {
      agentName: character.name,
      bio,
      adjectives: (character.adjectives ?? []).join(", "),
      topics: (character.topics ?? []).join(", "),
      pitch: message.content.text ?? "",
      ...extras,
    },
    data: {},
    text: message.content.text ?? "",
  };
}

// --- the WRITE_APP_FILES action ---------------------------------------------
// A real ElizaOS Action: the agent's response Content carries
// actions: ["WRITE_APP_FILES"] plus a files map, and the loop dispatches it
// processActions-style (validate, then handler with options + callback).

export const writeAppFilesAction: ElizaAction = {
  name: "WRITE_APP_FILES",
  similes: ["EMIT_FILES", "SAVE_APP", "SHIP_IT"],
  description:
    "Write the self-contained web app files carried on the message content ({files: {path: content}}) into the build output directory, skipping unsafe paths and unchanged content.",
  validate: async (_runtime, message) => {
    const files = message.content.files;
    if (!isRecord(files)) {
      return false;
    }
    return Object.entries(files).some(([path, content]) => typeof content === "string" && sanitizeAppPath(path) !== null);
  },
  handler: async (_runtime, message, _state, options, callback) => {
    const outDir = typeof options?.outDir === "string" ? options.outDir : null;
    const project = options?.project instanceof Map ? (options.project as Map<string, string>) : null;
    if (outDir === null || project === null) {
      return { success: false, error: "WRITE_APP_FILES needs {outDir, project} handler options" };
    }
    const files = isRecord(message.content.files) ? message.content.files : {};
    const written: string[] = [];
    for (const [rawPath, content] of Object.entries(files)) {
      if (typeof content !== "string") {
        continue;
      }
      const safe = sanitizeAppPath(rawPath);
      if (safe === null || project.get(safe) === content) {
        continue;
      }
      await Bun.write(join(outDir, safe), content);
      project.set(safe, content);
      written.push(safe);
    }
    if (callback !== undefined) {
      await callback({ text: `wrote ${written.length} file(s)`, actions: [writeAppFilesAction.name], written });
    }
    return {
      success: true,
      text: `wrote ${written.length} file(s)`,
      values: { entrypointPresent: project.has(ELIZA_ENTRYPOINT) },
      data: { written },
    };
  },
};

// Dispatch one named action against a response memory, the way
// AgentRuntime.processActions resolves content.actions: validate gates handler.
export async function processAction(
  action: ElizaAction,
  runtime: ElizaRuntimeLike,
  message: ElizaMemory,
  state: ElizaState,
  options: Record<string, unknown>,
  callback?: ElizaHandlerCallback,
): Promise<ElizaActionResult> {
  if (!(message.content.actions ?? []).includes(action.name)) {
    return { success: false, error: `response content does not request ${action.name}` };
  }
  if (!(await action.validate(runtime, message, state))) {
    return { success: false, error: `${action.name} validate() rejected the response content` };
  }
  const result = await action.handler(runtime, message, state, options, callback);
  return result ?? { success: true };
}

// --- reply parsing (pure; unit-tested) --------------------------------------
// NOTE: deliberately NOT core.parseJSONObjectFromText — its normalizeJsonString
// pass corrupts nested objects and booleans (see .context/eliza-notes.md), which
// is fatal for {"files": {...}} and {"pass": false} payloads.

export interface ElizaPlan {
  // The headline pitch line — this becomes the BuildResult.summary.
  summary: string;
  spec: string;
}

// A bad plan never fails the mock — fall back to a pitch-line plan from the
// room's pitch. Accepts the new {"pitch", "spec"} shape and tolerates a legacy
// {"summary"} key.
export function parsePlanContent(obj: Record<string, unknown> | null, pitch: string): ElizaPlan {
  const fallback: ElizaPlan = {
    summary: `${truncate(pitch.trim(), 160)} — concept mock, ready to commission.`,
    spec: `A one-page concept mock of the pitch: hero screen, visual identity, headline pitch line, one sketched interaction. Pitch: ${pitch}`,
  };
  if (obj === null) {
    return fallback;
  }
  const headline =
    typeof obj.pitch === "string" && obj.pitch.trim().length > 0
      ? obj.pitch.trim()
      : typeof obj.summary === "string" && obj.summary.trim().length > 0
        ? obj.summary.trim()
        : fallback.summary;
  const spec = typeof obj.spec === "string" && obj.spec.trim().length > 0 ? obj.spec.trim() : fallback.spec;
  return { summary: truncate(headline, 300), spec };
}

// {"files": {path: content}}; tolerates a bare top-level {path: content} map
// when every value is a string. A "files" key of the wrong shape is a refusal,
// not a bare map — never mistake it for a file named "files".
export function parseFilesContent(obj: Record<string, unknown> | null): Map<string, string> | null {
  if (obj === null) {
    return null;
  }
  const values = Object.values(obj);
  const source = isRecord(obj.files)
    ? obj.files
    : "files" in obj
      ? null
      : values.length > 0 && values.every((value) => typeof value === "string")
        ? obj
        : null;
  if (source === null) {
    return null;
  }
  const out = new Map<string, string>();
  for (const [path, content] of Object.entries(source)) {
    if (typeof content === "string") {
      out.set(path, content);
    }
  }
  return out.size > 0 ? out : null;
}

// Tolerant JSON-object extraction: bare JSON, then fenced ```json blocks, then
// the outermost {...} slice embedded in prose. (Same contract as the native
// backend's extractJsonObject; local so the backends stay decoupled.)
export function extractJsonContent(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];
  const fence = /```(?:json)?\s*([\s\S]*?)```/u.exec(trimmed);
  if (fence?.[1] !== undefined) {
    candidates.push(fence[1].trim());
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    candidates.push(trimmed.slice(start, end + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed)) {
        return parsed;
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

// Model-proposed paths must stay inside outDir: relative, no "..", no drive
// letters, forward slashes only. Returns the normalized path or null.
export function sanitizeAppPath(raw: string): string | null {
  const trimmed = raw.trim().replace(/^\.\//u, "");
  if (trimmed.length === 0 || trimmed.startsWith("/") || /^[a-zA-Z]:/u.test(trimmed)) {
    return null;
  }
  if (trimmed.includes("\\") || trimmed.includes("\0")) {
    return null;
  }
  const parts = trimmed.split("/");
  if (parts.some((part) => part === ".." || part === "." || part === "")) {
    return null;
  }
  return parts.join("/");
}

// --- the backend ------------------------------------------------------------

export interface ElizaBuildBackendOptions {
  /** Injected model handler for tests; default is Cerebras via the OpenAI-compatible endpoint. */
  model?: ElizaModelHandler;
  /** Injected core facade for tests (null simulates the package missing). */
  core?: ElizaCoreModule | null;
  /** Env source (tests inject; defaults to process.env). */
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  /** Per-model-call timeout. Default 45s (mock lanes target ~60s total). */
  timeoutMs?: number;
  character?: ElizaCharacter;
}

export class ElizaBuildBackend implements BuildBackend {
  readonly id: BuildBackendId = "eliza";
  readonly label = ELIZA_BACKEND_LABEL;
  readonly #options: ElizaBuildBackendOptions;
  readonly #env: Record<string, string | undefined>;
  readonly #character: ElizaCharacter;

  constructor(options: ElizaBuildBackendOptions = {}) {
    this.#options = options;
    this.#env = options.env ?? process.env;
    this.#character = options.character ?? ELIZA_CODER_CHARACTER;
  }

  async #core(): Promise<ElizaCoreLoad> {
    if (this.#options.core !== undefined) {
      return this.#options.core === null
        ? { ok: false, reason: `${ELIZA_CORE_PACKAGE} is not installed (bun add ${ELIZA_CORE_PACKAGE}@1.7.2)` }
        : { ok: true, core: this.#options.core };
    }
    return loadElizaCore();
  }

  #model(): ElizaModelHandler | null {
    return (
      this.#options.model ??
      createCerebrasChatModel({
        apiKey: this.#env.CEREBRAS_API_KEY,
        model: this.#env.CEREBRAS_MODEL,
        fetchImpl: this.#options.fetchImpl,
        timeoutMs: this.#options.timeoutMs,
      })
    );
  }

  async available(): Promise<{ ok: boolean; reason?: string }> {
    const load = await this.#core();
    if (!load.ok) {
      return { ok: false, reason: load.reason };
    }
    if (this.#model() === null) {
      return { ok: false, reason: "eliza backend needs CEREBRAS_API_KEY (OpenAI-compatible provider pointed at Cerebras)" };
    }
    return { ok: true };
  }

  async build(req: BuildRequest): Promise<BuildResult> {
    const load = await this.#core();
    if (!load.ok) {
      return { ok: false, entrypoint: null, summary: "ElizaOS mock could not start.", error: load.reason };
    }
    const model = this.#model();
    if (model === null) {
      return {
        ok: false,
        entrypoint: null,
        summary: "ElizaOS mock could not start.",
        error: "no model handler: CEREBRAS_API_KEY is not set",
      };
    }
    try {
      return await this.#run(req, load.core, model);
    } catch (error) {
      const aborted = req.signal.aborted;
      return {
        ok: false,
        entrypoint: null,
        summary: aborted ? "Mock aborted by emergency stop." : "ElizaOS mock failed before completion.",
        error: aborted ? "aborted" : errorMessage(error),
      };
    }
  }

  async #run(req: BuildRequest, core: ElizaCoreModule, model: ElizaModelHandler): Promise<BuildResult> {
    const { signal, onProgress } = req;
    signal.throwIfAborted();
    const character = this.#character;
    const runtime: ElizaRuntimeLike = {
      agentId: core.stringToUuid(`vibersyn-eliza-${character.name}`),
      character,
      useModel: (_modelType, params) => model(params),
    };
    const textLarge = core.ModelType.TEXT_LARGE ?? "TEXT_LARGE";
    const message = composePitchMessage(core, req);
    const generate = async (templateName: string, extras: Record<string, string>): Promise<string> => {
      const template = character.templates?.[templateName];
      if (template === undefined) {
        throw new Error(`character "${character.name}" has no "${templateName}" template`);
      }
      const state = composeBuildState(character, message, extras);
      const prompt = core.composePromptFromState({ state, template });
      return runtime.useModel(textLarge, { prompt, system: character.system, temperature: 0, signal });
    };

    if (typeof req.correction === "string" && req.correction.trim().length > 0) {
      return this.#runCorrection(req, core, runtime, message, generate, req.correction.trim());
    }

    // CONCEPT-MOCK loop: plan -> implement -> write. Deliberately no
    // critique/revise rounds at kickoff — small single-file output, fast lane.
    onProgress({ label: "imagining concept", percent: 10, detail: `character ${character.name}` });
    const plan = parsePlanContent(extractJsonContent(await generate("plan", {})), req.prompt);
    signal.throwIfAborted();

    onProgress({ label: "mocking", percent: 40, detail: truncate(plan.summary, 120) });
    let implemented = parseFilesContent(
      extractJsonContent(
        await generate("implement", {
          headline: plan.summary,
          spec: plan.spec,
        }),
      ),
    );
    if (implemented === null) {
      // Temperature-0 means a same-prompt re-run reproduces the same broken
      // output — so the ONE in-stage repair attempt nudges the prompt instead
      // (strict-JSON reminder appended to the spec), which reliably lands a
      // different, parseable completion.
      signal.throwIfAborted();
      onProgress({ label: "mocking (strict JSON retry)", percent: 55, detail: truncate(plan.summary, 120) });
      implemented = parseFilesContent(
        extractJsonContent(
          await generate("implement", {
            headline: plan.summary,
            spec:
              `${plan.spec}\n\nIMPORTANT: your ENTIRE reply must be one strictly valid JSON object — ` +
              `every newline inside file content escaped as \\n, every quote as \\", no trailing commas, ` +
              `no markdown fences, no text before or after the JSON.`,
          }),
        ),
      );
    }
    if (implemented === null) {
      throw new Error("implement stage returned no parseable {files} JSON");
    }
    signal.throwIfAborted();

    const project = new Map<string, string>();
    onProgress({ label: "staging mock", percent: 80, detail: `${implemented.size} file(s)` });
    await this.#dispatchWrite(req, runtime, message, implemented, project);

    if (!project.has(ELIZA_ENTRYPOINT)) {
      return { ok: false, entrypoint: null, summary: plan.summary, error: `the model never produced an ${ELIZA_ENTRYPOINT} entrypoint` };
    }
    onProgress({ label: "mock ready", percent: 100 });
    return { ok: true, entrypoint: ELIZA_ENTRYPOINT, summary: plan.summary };
  }

  // Steer mode: the mock already exists in outDir — read it, run ONE revise
  // pass with the spoken correction as the issue list, and dispatch the write.
  async #runCorrection(
    req: BuildRequest,
    _core: ElizaCoreModule,
    runtime: ElizaRuntimeLike,
    message: ElizaMemory,
    generate: (templateName: string, extras: Record<string, string>) => Promise<string>,
    correction: string,
  ): Promise<BuildResult> {
    const { signal, onProgress } = req;
    onProgress({ label: "reading mock", percent: 10 });
    const project = await readProjectFiles(req.outDir);
    if (project.size === 0) {
      return { ok: false, entrypoint: null, summary: "", error: "steer requested but the build directory has no mock to correct" };
    }
    signal.throwIfAborted();

    onProgress({ label: "applying correction", percent: 40, detail: truncate(correction, 120) });
    const revised = parseFilesContent(
      extractJsonContent(
        await generate("revise", {
          specLine: "",
          filesJson: serializeProject(project),
          issues: `1. Spoken correction from the room — apply it faithfully: ${correction}`,
        }),
      ),
    );
    if (revised === null) {
      return { ok: false, entrypoint: null, summary: "", error: "correction pass returned no parseable {files} JSON" };
    }
    signal.throwIfAborted();
    onProgress({ label: "writing files", percent: 80, detail: `${revised.size} file(s)` });
    await this.#dispatchWrite(req, runtime, message, revised, project);

    if (!project.has(ELIZA_ENTRYPOINT)) {
      return { ok: false, entrypoint: null, summary: "", error: `corrected mock has no ${ELIZA_ENTRYPOINT} entrypoint` };
    }
    onProgress({ label: "mock ready", percent: 100 });
    return { ok: true, entrypoint: ELIZA_ENTRYPOINT, summary: `Applied spoken correction: "${truncate(correction, 200)}".` };
  }

  // Wrap a files map in an agent response Memory and run WRITE_APP_FILES
  // through the processActions-style dispatcher.
  async #dispatchWrite(
    req: BuildRequest,
    runtime: ElizaRuntimeLike,
    pitch: ElizaMemory,
    files: ReadonlyMap<string, string>,
    project: Map<string, string>,
  ): Promise<void> {
    const response: ElizaMemory = {
      entityId: runtime.agentId,
      agentId: runtime.agentId,
      roomId: pitch.roomId,
      createdAt: Date.now(),
      content: {
        text: "",
        source: "vibersyn",
        actions: [writeAppFilesAction.name],
        inReplyTo: pitch.id,
        files: Object.fromEntries(files),
      },
    };
    const state = composeBuildState(runtime.character, pitch);
    const result = await processAction(writeAppFilesAction, runtime, response, state, { outDir: req.outDir, project });
    if (!result.success) {
      throw new Error(`WRITE_APP_FILES failed: ${errorMessage(result.error ?? "unknown action failure")}`);
    }
  }
}

// --- file plumbing ----------------------------------------------------------

async function readProjectFiles(outDir: string): Promise<Map<string, string>> {
  const project = new Map<string, string>();
  let names: string[];
  try {
    names = (await readdir(outDir, { recursive: true })) as string[];
  } catch {
    return project;
  }
  for (const name of names) {
    const rel = name.split(sep).join("/");
    if (!TEXT_EXTENSIONS.has(extname(rel).toLowerCase())) {
      continue;
    }
    const abs = join(outDir, name);
    try {
      const info = await stat(abs);
      if (!info.isFile() || info.size > MAX_READ_FILE_BYTES) {
        continue;
      }
      project.set(rel, await Bun.file(abs).text());
    } catch {
      // unreadable entry — skip
    }
  }
  return project;
}

function serializeProject(files: ReadonlyMap<string, string>): string {
  const record: Record<string, string> = {};
  for (const [path, content] of files) {
    record[path] =
      content.length > MAX_PROMPT_FILE_CHARS ? `${content.slice(0, MAX_PROMPT_FILE_CHARS)}\n/* …truncated… */` : content;
  }
  return JSON.stringify(record, null, 1);
}

// --- small helpers ----------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
