import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createCerebrasRetryFetch, type CerebrasBackoffOptions } from "../cerebras-retry";
import type { BuildBackend, BuildBackendId, BuildRequest, BuildResult } from "../types";

export const NATIVE_BACKEND_LABEL = "Native Loop";
export const NATIVE_ENTRYPOINT = "index.html";
export const CEREBRAS_CHAT_COMPLETIONS_URL = "https://api.cerebras.ai/v1/chat/completions";

const DEFAULT_MAX_ITERATIONS = 3;
const DEFAULT_CALL_TIMEOUT_MS = 180_000;
const KILL_ESCALATION_MS = 1_000;
const DEFAULT_MAX_COMPLETION_TOKENS = 16_384;
const MAX_PROMPT_FILE_CHARS = 20_000;
const MAX_READ_FILE_BYTES = 512 * 1024;
const TEXT_EXTENSIONS = new Set([".html", ".htm", ".css", ".js", ".mjs", ".json", ".svg", ".txt", ".md", ".xml"]);

// --- model seam -----------------------------------------------------------
// One inner model call: plain strings in, raw model text out. Injectable so the
// whole outer loop is unit-testable with a fake model (no network, no spawn).

export type BuildStage = "plan" | "implement" | "critique" | "revise";

export interface ModelCallRequest {
  stage: BuildStage;
  system: string;
  user: string;
  signal: AbortSignal;
}

export type ModelCall = (call: ModelCallRequest) => Promise<string>;

export interface NativeBuildBackendOptions {
  /** Injected model for tests; default is Cerebras with claude-CLI failover. */
  model?: ModelCall;
  /** Env source (tests inject; defaults to process.env). */
  env?: Record<string, string | undefined>;
  /** Explicit claude CLI path; default: repo shim at .context/claude-shim/claude, then PATH. */
  claudeCliPath?: string;
  fetchImpl?: typeof fetch;
  /** Critique→revise cycles after the first implement pass. Default 3. */
  maxIterations?: number;
  /** Per-model-call timeout. Default 180s. */
  timeoutMs?: number;
}

/**
 * The "native" BuildBackend: a self-built inner/outer agent loop with no
 * framework. Outer loop = PLAN (manifest + spec) → IMPLEMENT (strict JSON
 * {files}) → CRITIQUE (issues vs. the idea) → REVISE, early-exiting when the
 * critique passes, at most `maxIterations` critique cycles. Inner calls go to
 * the Cerebras chat-completions API (through the shared 429/5xx backoff +
 * concurrency throttle in ../cerebras-retry.ts) and fail over to the host
 * claude CLI after Cerebras fails twice — the CLI fallback is unchanged; each
 * Cerebras "failure" now happens only after backoff retries are exhausted.
 * Files are written with Bun.write into req.outDir; the
 * entrypoint is always index.html and the app must be self-contained (no CDN).
 * The AbortSignal is honored between every model call and aborts in-flight
 * fetches / kills subprocesses (emergency-stop budget ~2s).
 */
export class NativeBuildBackend implements BuildBackend {
  readonly id: BuildBackendId = "native";
  readonly label = NATIVE_BACKEND_LABEL;
  readonly #options: NativeBuildBackendOptions;
  readonly #env: Record<string, string | undefined>;
  readonly #maxIterations: number;

  constructor(options: NativeBuildBackendOptions = {}) {
    this.#options = options;
    this.#env = options.env ?? process.env;
    this.#maxIterations = Math.max(1, options.maxIterations ?? DEFAULT_MAX_ITERATIONS);
  }

  async available(): Promise<{ ok: boolean; reason?: string }> {
    if (this.#options.model !== undefined) {
      return { ok: true };
    }
    if ((this.#env.CEREBRAS_API_KEY ?? "").trim().length > 0) {
      return { ok: true };
    }
    if (resolveClaudeCli({ cliPath: this.#options.claudeCliPath, env: this.#env }) !== null) {
      return { ok: true };
    }
    return { ok: false, reason: "native backend needs CEREBRAS_API_KEY or a claude CLI (repo shim or PATH)" };
  }

  async build(req: BuildRequest): Promise<BuildResult> {
    const model =
      this.#options.model ??
      createFailoverModel({
        cerebras: createCerebrasModel({
          apiKey: this.#env.CEREBRAS_API_KEY,
          model: this.#env.CEREBRAS_MODEL,
          fetchImpl: this.#options.fetchImpl,
          timeoutMs: this.#options.timeoutMs,
        }),
        claude: createClaudeCliModel({
          cliPath: this.#options.claudeCliPath,
          env: this.#env,
          timeoutMs: this.#options.timeoutMs,
        }),
      });
    try {
      return await this.#run(req, model);
    } catch (error) {
      const aborted = req.signal.aborted;
      return {
        ok: false,
        entrypoint: null,
        summary: aborted ? "Build aborted by emergency stop." : "Native build failed before completion.",
        error: aborted ? "aborted" : errorMessage(error),
      };
    }
  }

  async #run(req: BuildRequest, model: ModelCall): Promise<BuildResult> {
    const { signal, onProgress } = req;
    signal.throwIfAborted();
    if (typeof req.correction === "string" && req.correction.trim().length > 0) {
      return this.#runCorrection(req, model, req.correction.trim());
    }

    onProgress({ label: "planning", percent: 5 });
    const planReply = await model({ stage: "plan", system: NATIVE_SYSTEM_PROMPT, user: planPrompt(req.prompt), signal });
    const plan = parsePlanReply(planReply, req.prompt);
    signal.throwIfAborted();

    onProgress({ label: "implementing", percent: 25, detail: plan.manifest.map((f) => f.path).join(", ") });
    const implementReply = await model({
      stage: "implement",
      system: NATIVE_SYSTEM_PROMPT,
      user: implementPrompt(req.prompt, plan),
      signal,
    });
    const implemented = parseFilesReply(implementReply);
    if (implemented === null) {
      throw new Error("implement stage returned no parseable {files} JSON");
    }
    const project = new Map<string, string>();
    mergeSanitized(project, implemented);
    signal.throwIfAborted();

    onProgress({ label: "writing files", percent: 45, detail: `${project.size} file(s)` });
    await writeProject(req.outDir, project);

    let passed = false;
    let lastIssues: string[] = [];
    const max = this.#maxIterations;
    const percentAt = (iteration: number, revising: boolean): number =>
      Math.min(95, Math.round(50 + ((iteration - 1) * 2 + (revising ? 1 : 0)) * (45 / (max * 2))));

    for (let iteration = 1; iteration <= max; iteration += 1) {
      signal.throwIfAborted();
      onProgress({ label: `critiquing (${iteration}/${max})`, percent: percentAt(iteration, false) });
      let critique: CritiqueVerdict;
      if (!project.has(NATIVE_ENTRYPOINT)) {
        critique = {
          pass: false,
          issues: [`No ${NATIVE_ENTRYPOINT} was produced; emit a complete ${NATIVE_ENTRYPOINT} entrypoint.`],
        };
      } else {
        const critiqueReply = await model({
          stage: "critique",
          system: NATIVE_SYSTEM_PROMPT,
          user: critiquePrompt(req.prompt, project),
          signal,
        });
        critique = parseCritiqueReply(critiqueReply);
      }
      if (critique.pass) {
        passed = true;
        lastIssues = [];
        break;
      }
      lastIssues = critique.issues;
      if (iteration === max) {
        break;
      }
      signal.throwIfAborted();
      onProgress({ label: `revising (${iteration}/${max - 1})`, percent: percentAt(iteration, true), detail: critique.issues[0] });
      const reviseReply = await model({
        stage: "revise",
        system: NATIVE_SYSTEM_PROMPT,
        user: revisePrompt(req.prompt, plan.spec, project, critique.issues),
        signal,
      });
      const revised = parseFilesReply(reviseReply);
      if (revised === null) {
        break; // the model couldn't produce fixes; ship what we have
      }
      const changed = mergeSanitized(project, revised);
      await writeProject(req.outDir, changed);
    }

    if (!project.has(NATIVE_ENTRYPOINT)) {
      return { ok: false, entrypoint: null, summary: plan.summary, error: `the model never produced an ${NATIVE_ENTRYPOINT} entrypoint` };
    }
    onProgress({ label: "ready", percent: 100 });
    const summary = passed || lastIssues.length === 0 ? plan.summary : `${plan.summary} Known rough edges: ${lastIssues.join("; ")}.`;
    return { ok: true, entrypoint: NATIVE_ENTRYPOINT, summary };
  }

  // Steer mode: the app already exists in outDir — read it, run ONE revise pass
  // with the spoken correction as the issue list, and write the changed files.
  async #runCorrection(req: BuildRequest, model: ModelCall, correction: string): Promise<BuildResult> {
    const { signal, onProgress } = req;
    onProgress({ label: "reading app", percent: 10 });
    const project = await readProjectFiles(req.outDir);
    if (project.size === 0) {
      return { ok: false, entrypoint: null, summary: "", error: "steer requested but the build directory has no app to correct" };
    }
    signal.throwIfAborted();

    onProgress({ label: "applying correction", percent: 40, detail: truncate(correction, 120) });
    const reply = await model({
      stage: "revise",
      system: NATIVE_SYSTEM_PROMPT,
      user: revisePrompt(req.prompt, null, project, [`Spoken correction from the room — apply it faithfully: ${correction}`]),
      signal,
    });
    const revised = parseFilesReply(reply);
    if (revised === null) {
      return { ok: false, entrypoint: null, summary: "", error: "correction pass returned no parseable {files} JSON" };
    }
    signal.throwIfAborted();
    const changed = mergeSanitized(project, revised);
    onProgress({ label: "writing files", percent: 80, detail: `${changed.size} file(s)` });
    await writeProject(req.outDir, changed);

    if (!project.has(NATIVE_ENTRYPOINT)) {
      return { ok: false, entrypoint: null, summary: "", error: `corrected app has no ${NATIVE_ENTRYPOINT} entrypoint` };
    }
    onProgress({ label: "ready", percent: 100 });
    return { ok: true, entrypoint: NATIVE_ENTRYPOINT, summary: `Applied spoken correction: "${truncate(correction, 200)}".` };
  }
}

// --- prompts --------------------------------------------------------------

export const NATIVE_SYSTEM_PROMPT = [
  "You are the builder for a live vibe-coding wall: you produce tiny, delightful, SELF-CONTAINED static web apps.",
  `Hard rules: the entrypoint is ${NATIVE_ENTRYPOINT}; all CSS/JS is inline or in sibling local files you also emit;`,
  "NO CDN links, NO external URLs, NO network calls, NO build steps, NO frameworks — vanilla HTML/CSS/JS only.",
  "You always reply with a single JSON object and nothing else — no prose, no markdown fences.",
].join(" ");

function planPrompt(pitch: string): string {
  return [
    `Idea pitch: ${pitch}`,
    "",
    `Plan a minimal but polished self-contained web app for this idea (1-4 files, ${NATIVE_ENTRYPOINT} required).`,
    'Reply with ONLY JSON: {"summary": "<one-paragraph human summary of the app you will build>",',
    '"spec": "<concise implementation spec: layout, interactions, state, styling>",',
    `"files": [{"path": "${NATIVE_ENTRYPOINT}", "purpose": "..."}]}`,
  ].join("\n");
}

function implementPrompt(pitch: string, plan: NativePlan): string {
  return [
    `Idea pitch: ${pitch}`,
    `Spec: ${plan.spec}`,
    `Planned files: ${plan.manifest.map((f) => `${f.path} — ${f.purpose}`).join("; ")}`,
    "",
    "Write the COMPLETE content of every planned file.",
    'Reply with ONLY strict JSON: {"files": {"<path>": "<full file content>", ...}}.',
    `${NATIVE_ENTRYPOINT} is required. Escape file contents as valid JSON strings. No markdown fences, no commentary.`,
  ].join("\n");
}

function critiquePrompt(pitch: string, files: ReadonlyMap<string, string>): string {
  return [
    `Idea pitch: ${pitch}`,
    "Built files (JSON map of path -> content):",
    serializeFiles(files),
    "",
    `Review the app against the idea. Fail it only for real problems: broken/missing ${NATIVE_ENTRYPOINT}, JS errors,`,
    "external URLs/CDN usage, or the core idea not actually implemented. Pass a reasonable working version — do not nitpick.",
    'Reply with ONLY JSON: {"pass": true|false, "issues": ["<specific fixable issue>", ...]}',
  ].join("\n");
}

function revisePrompt(pitch: string, spec: string | null, files: ReadonlyMap<string, string>, issues: string[]): string {
  return [
    `Idea pitch: ${pitch}`,
    ...(spec === null ? [] : [`Spec: ${spec}`]),
    "Current files (JSON map of path -> content):",
    serializeFiles(files),
    "",
    "Fix these issues:",
    ...issues.map((issue, index) => `${index + 1}. ${issue}`),
    "",
    'Reply with ONLY strict JSON: {"files": {"<path>": "<full new file content>", ...}} containing ONLY the files you change or add.',
    "Each changed file must be complete. No markdown fences, no commentary.",
  ].join("\n");
}

// --- reply parsing (pure; unit-tested) ------------------------------------

export interface NativePlan {
  summary: string;
  spec: string;
  manifest: Array<{ path: string; purpose: string }>;
}

// A bad plan never fails the build — fall back to a one-file plan from the pitch.
export function parsePlanReply(reply: string, pitch: string): NativePlan {
  const fallback: NativePlan = {
    summary: `A self-contained web app built from the room's pitch: ${truncate(pitch, 160)}.`,
    spec: `Implement the pitch as a single-page self-contained app: ${pitch}`,
    manifest: [{ path: NATIVE_ENTRYPOINT, purpose: "the whole app (markup, styles, script inline)" }],
  };
  const obj = extractJsonObject(reply);
  if (obj === null) {
    return fallback;
  }
  const summary = typeof obj.summary === "string" && obj.summary.trim().length > 0 ? obj.summary.trim() : fallback.summary;
  const spec = typeof obj.spec === "string" && obj.spec.trim().length > 0 ? obj.spec.trim() : fallback.spec;
  const manifest: Array<{ path: string; purpose: string }> = [];
  if (Array.isArray(obj.files)) {
    for (const entry of obj.files) {
      if (!isRecord(entry) || typeof entry.path !== "string") {
        continue;
      }
      const safe = sanitizeRelativePath(entry.path);
      if (safe === null) {
        continue;
      }
      manifest.push({ path: safe, purpose: typeof entry.purpose === "string" ? entry.purpose : "" });
    }
  }
  if (!manifest.some((f) => f.path === NATIVE_ENTRYPOINT)) {
    manifest.unshift({ path: NATIVE_ENTRYPOINT, purpose: "entrypoint" });
  }
  return { summary, spec, manifest: manifest.slice(0, 8) };
}

// Strict-JSON files payload {"files": {path: content}}; tolerates a bare
// top-level {path: content} map when every value is a string.
export function parseFilesReply(reply: string): Map<string, string> | null {
  const obj = extractJsonObject(reply);
  if (obj === null) {
    return null;
  }
  const values = Object.values(obj);
  const source = isRecord(obj.files)
    ? obj.files
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

export interface CritiqueVerdict {
  pass: boolean;
  issues: string[];
}

// An unparseable critique never wedges the loop — it counts as a pass.
export function parseCritiqueReply(reply: string): CritiqueVerdict {
  const obj = extractJsonObject(reply);
  if (obj === null || typeof obj.pass !== "boolean") {
    return { pass: true, issues: [] };
  }
  const issues = Array.isArray(obj.issues)
    ? obj.issues.filter((issue): issue is string => typeof issue === "string" && issue.trim().length > 0).slice(0, 8)
    : [];
  if (!obj.pass && issues.length === 0) {
    return { pass: false, issues: ["Critique failed the app without specifics; improve fidelity to the idea and overall polish."] };
  }
  return { pass: obj.pass, issues };
}

// Tolerant JSON-object extraction: bare JSON, then fenced ```json blocks, then
// the outermost {...} slice embedded in prose.
export function extractJsonObject(text: string): Record<string, unknown> | null {
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

// --- file plumbing --------------------------------------------------------

// Model-proposed paths must stay inside outDir: relative, no "..", no drive
// letters, forward slashes only. Returns the normalized path or null.
export function sanitizeRelativePath(raw: string): string | null {
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

// Merge sanitized incoming files into the project; returns only what changed.
function mergeSanitized(project: Map<string, string>, incoming: ReadonlyMap<string, string>): Map<string, string> {
  const changed = new Map<string, string>();
  for (const [rawPath, content] of incoming) {
    const safe = sanitizeRelativePath(rawPath);
    if (safe === null || project.get(safe) === content) {
      continue;
    }
    project.set(safe, content);
    changed.set(safe, content);
  }
  return changed;
}

async function writeProject(outDir: string, files: ReadonlyMap<string, string>): Promise<void> {
  for (const [path, content] of files) {
    await Bun.write(join(outDir, path), content);
  }
}

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

function serializeFiles(files: ReadonlyMap<string, string>): string {
  const record: Record<string, string> = {};
  for (const [path, content] of files) {
    record[path] =
      content.length > MAX_PROMPT_FILE_CHARS ? `${content.slice(0, MAX_PROMPT_FILE_CHARS)}\n/* …truncated… */` : content;
  }
  return JSON.stringify(record, null, 1);
}

// --- default model: Cerebras with claude-CLI failover ---------------------

export interface FailoverModelOptions {
  /** Injected for tests; null = unavailable, undefined = build the real one. */
  cerebras?: ModelCall | null;
  claude?: ModelCall | null;
  /** Cumulative Cerebras failures before permanently failing over. Default 2. */
  maxCerebrasFailures?: number;
}

// Cerebras-first with a sticky failover: once Cerebras has failed
// `maxCerebrasFailures` times (across calls, retries included), every
// subsequent call goes to the claude CLI. Aborts always propagate.
export function createFailoverModel(options: FailoverModelOptions = {}): ModelCall {
  const cerebras = options.cerebras !== undefined ? options.cerebras : createCerebrasModel();
  const claudeCli = options.claude !== undefined ? options.claude : createClaudeCliModel();
  const budget = options.maxCerebrasFailures ?? 2;
  let cerebrasFailures = 0;
  return async (call) => {
    while (cerebras !== null && cerebrasFailures < budget) {
      call.signal.throwIfAborted();
      try {
        return await cerebras(call);
      } catch (error) {
        if (call.signal.aborted) {
          throw error;
        }
        cerebrasFailures += 1;
      }
    }
    if (claudeCli === null) {
      throw new Error("native backend has no usable model: Cerebras unavailable/failed and no claude CLI found");
    }
    call.signal.throwIfAborted();
    return claudeCli(call);
  };
}

export interface CerebrasModelOptions {
  apiKey?: string;
  model?: string;
  /** Full transport override (tests). Replaces the default retrying fetch entirely. */
  fetchImpl?: typeof fetch;
  /** Tuning/injection for the default 429/5xx backoff transport (see cerebras-retry.ts). */
  retry?: CerebrasBackoffOptions;
  timeoutMs?: number;
  maxCompletionTokens?: number;
}

// OpenAI-compatible chat completions against Cerebras. Tries response_format
// json_object first; some models reject it, so a non-429 4xx retries once
// without it (a 429 is a quota signal, not a parameter rejection — the backoff
// transport already retried it, so re-sending would just burn more quota).
// Default transport is fetchWithCerebrasBackoff: 429/5xx get exponential
// backoff + jitter (honoring Retry-After) and the shared concurrency throttle.
export function createCerebrasModel(options: CerebrasModelOptions = {}): ModelCall | null {
  const apiKey = options.apiKey ?? process.env.CEREBRAS_API_KEY;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    return null;
  }
  // Default matches the repo-wide Cerebras default (see providers/llm/cue-cerebras.ts).
  const model = options.model ?? process.env.CEREBRAS_MODEL ?? "gemma-4-31b";
  const fetchImpl = options.fetchImpl ?? createCerebrasRetryFetch(options.retry);
  const timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const maxCompletionTokens = options.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS;
  return async ({ system, user, signal }) => {
    const attempt = async (withJsonFormat: boolean): Promise<Response> =>
      fetchImpl(CEREBRAS_CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_completion_tokens: maxCompletionTokens,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
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

export interface ClaudeCliModelOptions {
  cliPath?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

// Resolve the claude CLI: explicit path (or VIBERSYN_CLAUDE_CLI) must exist;
// otherwise prefer the repo shim, then whatever is on PATH.
export function resolveClaudeCli(options: { cliPath?: string; env?: Record<string, string | undefined> } = {}): string | null {
  const env = options.env ?? process.env;
  const explicit = options.cliPath ?? env.VIBERSYN_CLAUDE_CLI;
  if (explicit !== undefined && explicit.length > 0) {
    return existsSync(explicit) ? explicit : null;
  }
  const shim = fileURLToPath(new URL("../../../.context/claude-shim/claude", import.meta.url));
  if (existsSync(shim)) {
    return shim;
  }
  return Bun.which("claude");
}

// Print-mode claude CLI call; the subprocess is killed on abort or timeout —
// SIGTERM first, escalating to SIGKILL if it lingers, so the whole thing stays
// inside the ~2s emergency-stop budget.
export function createClaudeCliModel(options: ClaudeCliModelOptions = {}): ModelCall | null {
  const cli = resolveClaudeCli(options);
  if (cli === null) {
    return null;
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  return async ({ system, user, signal }) => {
    signal.throwIfAborted();
    const proc = Bun.spawn(
      [cli, "-p", `${system}\n\n${user}`, "--output-format", "json", "--dangerously-skip-permissions"],
      { stdout: "pipe", stderr: "ignore", stdin: "ignore" },
    );
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (): void => {
      proc.kill();
      killTimer ??= setTimeout(() => proc.kill(9), KILL_ESCALATION_MS);
    };
    signal.addEventListener("abort", kill, { once: true });
    const timer = setTimeout(kill, timeoutMs);
    try {
      const out = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      signal.throwIfAborted();
      if (exitCode !== 0) {
        throw new Error(`claude CLI exited with code ${exitCode}`);
      }
      const reply = unwrapClaudeEnvelope(out);
      if (reply === null) {
        throw new Error("claude CLI gave no usable output");
      }
      return reply;
    } finally {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal.removeEventListener("abort", kill);
    }
  };
}

// `claude -p --output-format json` wraps the reply in an envelope with a
// `result` string (and `is_error` when the CLI itself failed); fall back to
// raw stdout for older/odd shims. Throws on an error envelope so a CLI failure
// is never mistaken for a model reply (e.g. silently "passing" a critique).
function unwrapClaudeEnvelope(out: string): string | null {
  const trimmed = out.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(trimmed);
  } catch {
    return trimmed; // raw text reply from an older/odd shim
  }
  if (isRecord(envelope) && typeof envelope.result === "string") {
    if (envelope.is_error === true) {
      throw new Error(`claude CLI reported an error: ${truncate(envelope.result, 300)}`);
    }
    return envelope.result;
  }
  return trimmed;
}

// --- small helpers --------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
