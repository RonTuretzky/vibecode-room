// Additions-framed build prompt for phone GitHub imports. A QR-imported repo is
// shallow-cloned to builds/<upid>/repo/ and digested (repo-clone.ts). Instead of
// planning a NEW app from scratch, we frame the fleet build as ADDING the
// smallest coherent enhancement that fits the existing stack — or, for an
// empty/near-empty repo, SCAFFOLDING the first real slice. inferAdditionMode is
// the pure gate between those two framings.
//
// The prompt returned here is what registry.startBuild() feeds the fleet backend
// (itself an agent with a model + shell that reads the checkout). The OPTIONAL
// Cerebras calls in this module only seed a concrete first addition and the
// deck's decision questions (buildImportPlanQuestions — imports have no judge
// assessment to derive cards from); EVERY model call has a deterministic
// no-network fallback: no key / HTTP error / timeout / abort → the
// deterministic prompt/question set, which tells the agent to infer the
// addition from the repo itself.

import { MAX_PLAN_QUESTIONS, questionsFromAssessment, type PlanQuestion } from "../detect";

export type AdditionMode = "additions" | "scaffold";

export interface ImportPlanInput {
  context: string | null; // the phone submitter's steer, or null
  digest: string | null; // repoDigest() output (repo-clone.ts), or null when unavailable
  repoPath: string; // absolute path to the checkout (builds/<upid>/repo)
}

// The model seam: propose ONE concrete first addition/slice grounded in the
// digest + context, or null to defer entirely to the fleet agent. Injectable so
// the merge is unit-testable without a network.
export type AdditionPlanner = (
  request: { context: string | null; digest: string | null; mode: AdditionMode },
  signal: AbortSignal,
) => Promise<string | null>;

export interface BuildImportPlanOptions {
  planner?: AdditionPlanner; // default: cerebrasAdditionPlanner (no key → null)
  signal?: AbortSignal; // upstream abort (emergency stop / halt)
  timeoutMs?: number; // model budget; the fallback path is instant
}

const DEFAULT_TIMEOUT_MS = 6_000;
const MAX_SUGGESTION_CHARS = 200;

// --- Public entrypoint ------------------------------------------------------

// Build the fleet build prompt for an imported repo. Async only because it may
// consult a model for a concrete first-addition hint; it NEVER throws and NEVER
// requires the network — with no planner/key it resolves to the deterministic
// prompt. The wiring (composition.runGitHubImportRoutine) feeds the returned
// string straight into registry.startBuild().
export async function buildImportPlanPrompt(input: ImportPlanInput, options: BuildImportPlanOptions = {}): Promise<string> {
  const mode = inferAdditionMode(input.digest, input.context);
  const planner = options.planner ?? cerebrasAdditionPlanner;
  const suggestion = await callWithBudget(
    (signal) => planner({ context: input.context, digest: input.digest, mode }, signal).then(cleanSuggestion),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    options.signal,
  );
  return renderImportPlanPrompt(input, mode, suggestion);
}

// --- Mode inference (pure) --------------------------------------------------

// Decide whether the build should ADD to an existing project or SCAFFOLD a first
// slice. Repo-substance-driven: a null/near-empty digest (no stack, no
// dependencies, no source layout) → "scaffold"; a digest showing a real stack,
// dependencies, entrypoint, or a source tree → "additions". The digest is the
// only evidence, so this is fully deterministic and testable with literals. A
// borderline repo (one weak signal) plus an explicit steer from the room tips to
// "additions"; with no signals and no steer we scaffold.
export function inferAdditionMode(digest: string | null, context: string | null): AdditionMode {
  if (digest === null || digest.trim().length === 0) {
    return "scaffold";
  }
  let substance = 0;
  if (/^Stack: *\S/mu.test(digest)) substance += 2;
  if (/^Dependencies: *\S/mu.test(digest)) substance += 2;
  if (/^package\.json: *\S/mu.test(digest)) substance += 1;
  if (/^Entrypoint: *\S/mu.test(digest)) substance += 1;
  if (/^Languages: *\S/mu.test(digest)) substance += 1;
  if (/(?:^|[\s,])(?:src|lib|app|apps|packages|cmd|pkg|internal|source|components)\//mu.test(digest)) {
    substance += 1;
  }
  const filesLine = /^Top-level files: (.+)$/mu.exec(digest);
  if (filesLine !== null && filesLine[1]!.split(",").length >= 8) {
    substance += 1;
  }
  if (substance >= 2) return "additions";
  if (substance === 1 && context !== null && context.trim().length > 0) return "additions";
  return "scaffold";
}

// --- Deterministic prompt (pure) --------------------------------------------

// Render the build prompt from the mode, the digest, the user's context, and an
// OPTIONAL model suggestion. Pure and total — this is the no-network fallback,
// so it must always produce a usable prompt.
export function renderImportPlanPrompt(input: ImportPlanInput, mode: AdditionMode, suggestion: string | null = null): string {
  const context = input.context !== null && input.context.trim().length > 0 ? input.context.trim() : null;
  const digestBlock =
    input.digest !== null && input.digest.trim().length > 0
      ? `What the repository looks like (auto-generated digest):\n${input.digest.trim()}`
      : "No digest of the repository was available.";
  const lines: string[] = [];

  if (mode === "additions") {
    lines.push(
      "You are ADDING to an existing software project, not building a new app from scratch.",
      `The repository is already cloned at ${input.repoPath}. Read the real files there — they are the source of truth; the digest below is only a summary.`,
      "",
      digestBlock,
      "",
    );
    if (context !== null) {
      lines.push(
        `What the person who imported it asked for:\n${context}`,
        "",
        "Propose and build the SMALLEST coherent addition or enhancement that delivers that request while fitting the existing stack, conventions, and file layout. Do NOT rewrite or re-scaffold what is already there — extend it.",
      );
    } else {
      lines.push(
        "No specific request was given, so infer the single most valuable addition the repository is currently missing (a natural next feature, a rough edge to smooth, or an obvious enhancement) and build THAT — the smallest coherent slice that fits the existing stack, conventions, and file layout. Do NOT rewrite what is already there — extend it.",
      );
    }
    if (suggestion !== null) {
      lines.push("", `A suggested starting point (verify it against the actual code first): ${suggestion}`);
    }
    lines.push(
      "",
      "Match the project's existing language, framework, and style; reuse its components and utilities. Keep the addition self-contained and demoable.",
    );
  } else {
    lines.push(
      "You are starting an essentially empty (or near-empty) repository — there is little or nothing to build on yet.",
      `The repository is cloned at ${input.repoPath}; read whatever is there (README, config, repo name) for intent.`,
      "",
      digestBlock,
      "",
    );
    if (context !== null) {
      lines.push(
        `What the person who imported it asked for:\n${context}`,
        "",
        "Scaffold the smallest coherent first slice that delivers that request. Honor any stack hinted by the repo's name, README, or existing config; otherwise pick a lightweight, sensible default.",
      );
    } else {
      lines.push(
        "No specific request was given, so infer from the repository's name, README, or config what it is meant to become, and scaffold the smallest coherent first slice of THAT.",
      );
    }
    if (suggestion !== null) {
      lines.push("", `A suggested first slice (verify against the repo first): ${suggestion}`);
    }
    lines.push("", "Keep it minimal, runnable, and demoable — a foundation to extend, not a finished product.");
  }
  return lines.join("\n");
}

// --- Deck questions for imports ---------------------------------------------

// The question-model seam: draft the deck's decision questions for an imported
// repo, or null to defer to the deterministic set. Returns the RAW model output
// (ideally a strict-JSON string) — buildImportPlanQuestions owns the tolerant
// parse, so a drifting model can never break the deck. Injectable so the
// normalize/fallback merge is unit-testable without a network.
export type ImportQuestionPlanner = (
  request: { context: string | null; digest: string | null; mode: AdditionMode },
  signal: AbortSignal,
) => Promise<unknown>;

export interface BuildImportPlanQuestionsOptions {
  planner?: ImportQuestionPlanner; // default: cerebrasQuestionPlanner (no key → null)
  signal?: AbortSignal; // upstream abort (emergency stop / halt)
  timeoutMs?: number; // model budget; the fallback path is instant
}

// Deck questions for an imported repo. Spoken-idea kickoffs get their
// swipe-to-answer cards from the judge's mcqs/answers; an import has NO
// assessment, so this is its equivalent seam: one bounded model call drafting
// 2-3 decision questions, and — on ANY miss (no key, HTTP error, timeout,
// abort, unparseable output) — the deterministic mode-aware set. Like
// buildImportPlanPrompt it NEVER throws and NEVER requires the network; unlike
// the suggestion it also NEVER returns empty, so an imported project's deck
// always has an interactive part.
export async function buildImportPlanQuestions(
  input: ImportPlanInput,
  options: BuildImportPlanQuestionsOptions = {},
): Promise<PlanQuestion[]> {
  const mode = inferAdditionMode(input.digest, input.context);
  const planner = options.planner ?? cerebrasQuestionPlanner;
  const raw = await callWithBudget(
    (signal) => planner({ context: input.context, digest: input.digest, mode }, signal),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    options.signal,
  );
  const drafted = questionsFromModelOutput(raw);
  return drafted.length > 0 ? drafted : deterministicImportQuestions(mode, input.context);
}

// The no-network question set: mode-aware and steer-aware so the deck reads
// like it looked at THIS import (the mode already encodes what the digest
// showed), not a generic form. Encoded via the same "/"-joined parallel-arrays
// convention + questionsFromAssessment, so ids and clamps match the judge path
// exactly. Pure and total — never empty, even fully offline.
export function deterministicImportQuestions(mode: AdditionMode, context: string | null): PlanQuestion[] {
  const steered = context !== null && context.trim().length > 0;
  const pairs: Array<[string, string]> =
    mode === "additions"
      ? [
          ["How bold should the first addition be?", "Small safe polish / Solid new feature / Ambitious swing"],
          ["What should it prioritize?", "User-facing shine / New capability / Speed and cleanup"],
          steered
            ? ["How closely should we follow the request?", "To the letter / Take creative liberties"]
            : ["Where should we aim it?", "Round out an existing feature / Open a new area"],
        ]
      : [
          ["What should the first slice prove?", "A visible demo / Working core logic / An end-to-end skeleton"],
          ["How opinionated should the stack be?", "Minimal and dependency-light / Batteries included"],
          steered
            ? ["How closely should we follow the request?", "To the letter / Take creative liberties"]
            : ["What should guide the scaffold?", "The repo name and README / A sensible default app"],
        ];
  return questionsFromAssessment({ questions: pairs.map((pair) => pair[0]), answers: pairs.map((pair) => pair[1]) });
}

// Normalize whatever the model produced into deck-ready questions. Tolerant by
// construction: accepts a raw array, a { questions: [...] } wrapper, or a JSON
// string (markdown fences / surrounding prose stripped); per entry it accepts
// the prompt/question and answers/options/choices key spellings. Everything
// funnels through questionsFromAssessment (plan-questions.ts) so imports share
// the EXACT deck clamping conventions — counts, lengths, dedup, stable ids —
// with spoken-idea kickoffs. A question left with fewer than 2 options is
// dropped: a one-option "decision" is not a decision, and the deterministic
// fallback covers an empty result.
function questionsFromModelOutput(raw: unknown): PlanQuestion[] {
  const prompts: string[] = [];
  const answers: string[] = [];
  for (const entry of questionEntries(raw)) {
    if (prompts.length >= MAX_PLAN_QUESTIONS) {
      break;
    }
    if (!isRecord(entry)) {
      continue;
    }
    const prompt = firstString(entry, ["prompt", "question", "q"]);
    const options = firstStringArray(entry, ["answers", "options", "choices"]);
    if (prompt === null || options.length < 2) {
      continue;
    }
    // Re-encode into the "/"-joined per-question option bundle the deck
    // normalizer decodes.
    prompts.push(prompt);
    answers.push(options.join(" / "));
  }
  return questionsFromAssessment({ questions: prompts, answers }).filter((question) => question.answers.length >= 2);
}

function questionEntries(raw: unknown): unknown[] {
  const value = typeof raw === "string" ? parseLooseJson(raw) : raw;
  if (Array.isArray(value)) {
    return value;
  }
  if (isRecord(value) && Array.isArray(value.questions)) {
    return value.questions;
  }
  return [];
}

// Find the JSON payload inside a chatty completion: strip markdown fences, then
// try the outermost [...] span, then the outermost {...}. Null when nothing
// parses — the caller treats that as a model miss.
function parseLooseJson(text: string): unknown {
  const stripped = text.replace(/```[a-z]*\n?/giu, "").trim();
  for (const [open, close] of [
    ["[", "]"],
    ["{", "}"],
  ] as const) {
    const start = stripped.indexOf(open);
    const end = stripped.lastIndexOf(close);
    if (start === -1 || end <= start) {
      continue;
    }
    try {
      return JSON.parse(stripped.slice(start, end + 1));
    } catch {
      // Fall through to the next span shape.
    }
  }
  return null;
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

function firstStringArray(record: Record<string, unknown>, keys: readonly string[]): string[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      const strings = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
      if (strings.length > 0) {
        return strings.map((entry) => entry.trim());
      }
    }
  }
  return [];
}

// --- Model budget wrapper ---------------------------------------------------

// Race a model call against a timeout and an upstream abort; any rejection,
// timeout, or abort resolves to null so the deterministic path takes over. A
// call that ignores its signal and never resolves still loses to the timeout.
// Shared by both model seams (first-addition suggestion + deck questions).
async function callWithBudget<T>(
  call: (signal: AbortSignal) => Promise<T | null>,
  timeoutMs: number,
  outer: AbortSignal | undefined,
): Promise<T | null> {
  if (outer?.aborted === true) {
    return null;
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  outer?.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
  });
  try {
    return await Promise.race([call(controller.signal).catch(() => null), timeout]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
    outer?.removeEventListener("abort", onAbort);
  }
}

function cleanSuggestion(value: string | null): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().replace(/\s+/gu, " ");
  return trimmed.length === 0 ? null : trimmed.slice(0, MAX_SUGGESTION_CHARS);
}

// --- Default model (one bounded Cerebras call) ------------------------------

export const CEREBRAS_CHAT_URL = "https://api.cerebras.ai/v1/chat/completions";
// Matches the rest of the codebase (src/providers/llm/cue-cerebras.ts): default
// gemma-4-31b, overridable via CEREBRAS_MODEL.
export const CEREBRAS_IMPORT_PLAN_MODEL = "gemma-4-31b";

const PLANNER_SYSTEM_PROMPT =
  "You help a live demo room decide what to build on top of an imported GitHub repository. Given a digest of " +
  "the repo and (optionally) what the room asked for, name ONE concrete, small addition (mode=additions) or a " +
  "first slice to scaffold (mode=scaffold) that fits the existing stack and conventions. Reply with a SINGLE " +
  "imperative sentence (<= 24 words) describing WHAT to build — no preamble, no markdown, no lists.";

// Default production planner: ONE Cerebras chat/completions call. Null on any
// miss (no key, HTTP error, unparseable output). Errors reject and are converted
// to null by callPlannerWithBudget.
export const cerebrasAdditionPlanner: AdditionPlanner = async (request, signal) => {
  const apiKey = process.env.CEREBRAS_API_KEY;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    return null;
  }
  const response = await fetch(CEREBRAS_CHAT_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: process.env.CEREBRAS_MODEL ?? CEREBRAS_IMPORT_PLAN_MODEL,
      temperature: 0,
      max_completion_tokens: 120,
      messages: [
        { role: "system", content: PLANNER_SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            mode: request.mode,
            roomAskedFor: request.context,
            repositoryDigest: request.digest,
          }),
        },
      ],
    }),
    signal,
  });
  if (!response.ok) {
    return null;
  }
  const payload: unknown = await response.json();
  return chatContent(payload);
};

const QUESTION_SYSTEM_PROMPT =
  "You help a live demo room set up a swipeable decision deck for a freshly imported GitHub repository. Given a " +
  "digest of the repo, (optionally) what the room asked for, and the build mode (additions = extend the existing " +
  "project; scaffold = start its first slice), write 2-3 decision questions the room should swipe on before the " +
  "build starts, each with 2-4 SHORT option labels (max ~5 words each). Reply with STRICT JSON only — " +
  '[{"prompt":"...","answers":["...","..."]}] — no markdown, no prose.';

// Default production question model: ONE Cerebras chat/completions call, same
// endpoint/model conventions as cerebrasAdditionPlanner. Resolves to the raw
// content string (questionsFromModelOutput owns decoding); null on any miss.
// Errors reject and are converted to null by callWithBudget.
export const cerebrasQuestionPlanner: ImportQuestionPlanner = async (request, signal) => {
  const apiKey = process.env.CEREBRAS_API_KEY;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    return null;
  }
  const response = await fetch(CEREBRAS_CHAT_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: process.env.CEREBRAS_MODEL ?? CEREBRAS_IMPORT_PLAN_MODEL,
      temperature: 0,
      max_completion_tokens: 300,
      messages: [
        { role: "system", content: QUESTION_SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            mode: request.mode,
            roomAskedFor: request.context,
            repositoryDigest: request.digest,
          }),
        },
      ],
    }),
    signal,
  });
  if (!response.ok) {
    return null;
  }
  const payload: unknown = await response.json();
  return chatContent(payload);
};

function chatContent(payload: unknown): string | null {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    return null;
  }
  const first: unknown = payload.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) {
    return null;
  }
  return typeof first.message.content === "string" ? first.message.content : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
