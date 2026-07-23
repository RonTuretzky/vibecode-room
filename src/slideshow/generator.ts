// Pitch-deck generator: at kickoff, turn a spoken idea + its framework concept
// mocks into a SELF-CONTAINED interactive pitch at <outDir>/slideshow/index.html
// — four projector-friendly slides that END BY ASKING HOW TO CONTINUE:
//   1. the idea, verbatim as heard (big type);
//   2. the concept: what we'd build (the pitch summary from the kickoff mocks);
//   3. the mocks: a switchable gallery of the framework concept mocks (iframes);
//   4. "How should we continue?" — three large decision buttons wired to the
//      room's API: Build it for real (POST /api/process/:upid/execute), Steer it
//      (spoken correction, typed fallback -> POST /api/process/:upid/steer), and
//      Park it for later (POST /api/idea/:id/dismiss).
//
// Copy generation makes ONE Cerebras call (OpenAI-compatible chat/completions,
// CEREBRAS_API_KEY, gemma-4-31b) bounded by a hard time budget, and merges the
// result field-by-field over a DETERMINISTIC no-network fallback built purely
// from the inputs — so deck generation NEVER fails a kickoff for model reasons:
// no key, network down, timeout, garbage output all degrade to the template
// text. The model is injectable so tests run with fakes and zero network. The
// only aborts that propagate are the caller's own AbortSignal (emergency stop)
// — honored between phases and passed into fetch.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  renderSlideshowHtml,
  type Slide,
  type SlideDecision,
  type SlideMock,
} from "./template";

// Mirrors BuildBackendId in src/buildloop/types.ts BY CONVENTION — that module
// is owned by the buildloop track and this track must stand alone (no
// cross-track imports). The unions are structurally identical, so a
// BuildBackendId is directly assignable here.
export type SlideshowBackendId = "smithers" | "eliza" | "native";

// Wall-facing lane labels; match the buildloop's registered backend labels.
const BACKEND_LABELS: Record<SlideshowBackendId, string> = {
  smithers: "Smithers",
  eliza: "ElizaOS",
  native: "Native",
};

// Where the deck lives inside a build directory, and the public URL convention
// the wall consumes: previewUrl + "slideshow/".
export const SLIDESHOW_DIRNAME = "slideshow";
export const SLIDESHOW_ENTRYPOINT = "slideshow/index.html";

// Stable slideshowUrl convention for snapshot builds[] entries:
// previewUrl + "slideshow/" (exactly one slash, trailing slash kept so the
// static server can resolve the directory to its index.html).
export function slideshowUrl(previewUrl: string | null): string | null {
  if (previewUrl === null || previewUrl.trim().length === 0) {
    return null;
  }
  return `${previewUrl.trim().replace(/\/+$/u, "")}/${SLIDESHOW_DIRNAME}/`;
}

// One concept-mock lane for the gallery slide — per-backend previewUrl straight
// from process.builds[] (the kickoff contract). previewUrl null renders a
// "not ready yet" panel instead of an iframe.
export interface PitchMock {
  backend: SlideshowBackendId;
  previewUrl: string | null;
}

export interface GenerateSlideshowInput {
  upid: string;
  // Idea-ledger id powering "Park it for later" (POST /api/idea/:id/dismiss).
  // The orchestrator's slideshow hook always passes it; when absent the upid is
  // used so the button still POSTs somewhere 404-free.
  ideaId?: string | null;
  prompt: string; // the spoken idea, shown VERBATIM on slide 1
  callsign: string | null;
  backend: SlideshowBackendId; // the lane this deck is written into
  outDir: string; // ABSOLUTE build dir; deck written to <outDir>/slideshow/
  summary: string; // pitch summary from the kickoff mocks
  // All concept-mock lanes for the gallery slide. Omitted/empty -> the deck
  // shows this lane's own mock via the relative URL "../" (the deck lives at
  // previewUrl + "slideshow/", so "../" is always this lane's live mock).
  mocks?: readonly PitchMock[];
  // Optional compact digest of a cloned source repo (repo-import kickoffs, see
  // src/server/repo-clone.ts). Present only for imported projects; when set it
  // enriches the DETERMINISTIC fallback so a no-model deck grounds itself in the
  // imported codebase. Absent for spoken-idea kickoffs — the fallback still reads
  // well without it.
  repoDigest?: string | null;
  // Build-forking decision questions ({id, prompt, answers}) from the planning
  // routine (src/detect/plan-questions.ts). When present they render as
  // swipe-to-answer cards in the deck; each choice POSTs to `answerEndpoint`.
  // Absent = no question cards (the fixed decision slide still renders).
  questions?: readonly { id: string; prompt: string; answers: string[] }[];
  // Room endpoint a chosen answer POSTs to, e.g. /api/process/<upid>/answer.
  // Absent = the deck records the choice locally only (published/offline copy).
  answerEndpoint?: string;
}

// The copy the model (or the deterministic fallback) supplies. Slide 1 (the
// verbatim idea), slide 3 (the real mocks), and slide 4 (the fixed decision
// buttons) are NEVER model-authored.
export interface SlideshowCopy {
  tagline: string; // slide-2 headline: what we'd build, <=~10 words
  concept: string[]; // slide-2 bullets pitching the full build
}

export interface SlideshowCopyRequest {
  prompt: string;
  summary: string;
  backend: SlideshowBackendId;
  callsign: string | null;
  mocks: readonly string[]; // gallery lane backend ids, for grounding
}

// Injectable copy model. Return null (or reject, or hang past the budget) to
// fall back to deterministic copy; partial objects merge field-by-field.
export type SlideshowCopyModel = (
  request: SlideshowCopyRequest,
  signal: AbortSignal,
) => Promise<Partial<SlideshowCopy> | null>;

export interface GenerateSlideshowOptions {
  model?: SlideshowCopyModel; // default: one Cerebras chat/completions call
  signal?: AbortSignal; // the kickoff's abort signal (emergency stop)
  timeoutMs?: number; // model budget; the fallback path is instant
}

export interface SlideshowArtifact {
  dir: string; // <outDir>/slideshow
  indexPath: string; // <outDir>/slideshow/index.html
  slideCount: number;
  usedModel: boolean; // false whenever the deterministic fallback authored the copy
}

const DEFAULT_TIMEOUT_MS = 8_000;
const COPY_LINE_MAX = 220;
const COPY_LINES_MAX = 6;
// Headline clamp: the slide-2 tagline renders at big type (max-width ~22ch, so
// it wraps) — this bounds it so a runaway model tagline never overflows.
const TAGLINE_MAX = 100;

// Retry budget for the production model's HTTP call. Bounded by BOTH the attempt
// count AND the overall time budget (the combined abort signal): whichever trips
// first ends the retries and hands over to the deterministic fallback.
const COPY_MAX_ATTEMPTS = 3;
const COPY_RETRY_BASE_MS = 250;
const COPY_RETRY_MAX_MS = 2_000;

// --- Public entrypoint ------------------------------------------------------

// Generate the pitch deck. Model failures never propagate; the only throws are
// caller aborts and filesystem errors on the build dir itself (callers should
// still wrap this — the deck is garnish, never a reason to fail a kickoff).
export async function generateSlideshow(
  input: GenerateSlideshowInput,
  options: GenerateSlideshowOptions = {},
): Promise<SlideshowArtifact> {
  const signal = options.signal;
  signal?.throwIfAborted();

  // 1. Copy: one bounded model call merged over the deterministic fallback.
  const fallback = fallbackCopy(input);
  const model = options.model ?? cerebrasCopyModel;
  const request: SlideshowCopyRequest = {
    prompt: input.prompt,
    summary: input.summary,
    backend: input.backend,
    callsign: input.callsign,
    mocks: pitchMocks(input).map((mock) => mock.id),
  };
  const raw = await callModelWithBudget(model, request, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal);
  signal?.throwIfAborted();
  const merged = mergeCopy(raw, fallback);
  // Final clamp guard: bounds every field regardless of source (model OR
  // fallback), so no line can overflow the slide and no field is ever empty.
  const copy = clampCopy(merged.copy, fallback);
  const usedModel = merged.usedModel;

  // 2. Render + write. The template escapes everything; we hand it raw text.
  const slides = buildSlides(input, copy);
  const html = renderSlideshowHtml({
    title: `${ideaTitle(input.prompt)} — pitch`,
    footer: footerLine(input),
    slides,
    questions: input.questions,
    answerEndpoint: input.answerEndpoint,
  });
  const dir = join(input.outDir, SLIDESHOW_DIRNAME);
  await mkdir(dir, { recursive: true });
  const indexPath = join(dir, "index.html");
  await writeFile(indexPath, html, "utf8");
  return { dir, indexPath, slideCount: slides.length, usedModel };
}

// --- Deterministic fallback copy (no network, pure function of the inputs) ---

export function fallbackCopy(input: GenerateSlideshowInput): SlideshowCopy {
  const callsign = normalizeCallsign(input.callsign);
  const steerLine =
    callsign === null
      ? 'Say "steer it ..." out loud (or use the Steer it button) to reshape it before committing.'
      : `Say "steer ${callsign} ..." out loud (or use the Steer it button) to reshape it before committing.`;
  // Enrichment lines pulled from whatever the inputs actually carry, capped so
  // the four load-bearing narrative lines below are always present too.
  const context: string[] = [];
  const digestLine = repoDigestHeadline(input.repoDigest);
  if (digestLine !== null) {
    // Clamp the enrichment bullet at the source: fallbackCopy is a public export
    // that callers may consume WITHOUT the final clampCopy pass, so an imported
    // repo with a huge README block must not yield a slide-overflowing line here.
    context.push(clampText(`Grounded in the imported repo — ${digestLine}.`, COPY_LINE_MAX));
  }
  const concept = [
    ...context,
    `Concept first: ${frameworkPhrase(input)} sketched the idea as a clickable mock, not a promise.`,
    steerLine,
    "Commission it and the full build spins up — the wall shows it happen live.",
    "Parked ideas keep their seed in the tray; nothing said in the room is lost.",
  ].slice(0, COPY_LINES_MAX);
  return {
    tagline: ideaTitle(input.prompt),
    concept,
  };
}

// The frameworks that sketched this idea, as a readable subject phrase, drawn
// from the mock lanes (or this lane's own backend when none are supplied) so a
// no-model deck names the concrete backends instead of a generic "each framework".
function frameworkPhrase(input: GenerateSlideshowInput): string {
  const labels = pitchMocks(input).map((mock) => mock.label);
  const unique = [...new Set(labels)];
  if (unique.length <= 1) {
    const only = unique[0] ?? BACKEND_LABELS[input.backend] ?? input.backend;
    return `the ${only} framework`;
  }
  return `${listPhrase(unique)} each`;
}

// "a", "a and b", "a, b and c" — an Oxford-free readable join for slide copy.
function listPhrase(items: readonly string[]): string {
  if (items.length <= 1) {
    return items[0] ?? "";
  }
  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// A single concise line distilled from a repo digest (see src/server/repo-clone.ts:
// "Top-level files: …", "package.json: name — description", "README excerpt: …").
// Prefers the package.json line; else the first block. Null when there is nothing.
function repoDigestHeadline(digest: string | null | undefined): string | null {
  if (digest === null || digest === undefined) {
    return null;
  }
  const trimmed = digest.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const blocks = trimmed.split(/\n{2,}/u).map((block) => block.trim());
  const pkg = blocks.find((block) => /^package\.json:/iu.test(block));
  const source = pkg ?? blocks[0] ?? trimmed;
  const oneLine = source
    .replace(/^package\.json:\s*/iu, "")
    .replace(/^top-level files:\s*/iu, "top-level: ")
    .replace(/^readme excerpt:\s*/iu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return oneLine.length === 0 ? null : oneLine;
}

// Merge raw model output over the fallback, field by field: a field is taken
// from the model only when it survives sanitization (right type, non-empty,
// trimmed, capped), so partially-garbage output still contributes what it can.
export function mergeCopy(raw: unknown, fallback: SlideshowCopy): { copy: SlideshowCopy; usedModel: boolean } {
  if (!isRecord(raw)) {
    return { copy: fallback, usedModel: false };
  }
  const copy: SlideshowCopy = { ...fallback };
  let usedModel = false;
  const tagline = cleanLine(raw.tagline, TAGLINE_MAX);
  if (tagline !== null) {
    copy.tagline = tagline;
    usedModel = true;
  }
  for (const key of ["concept"] as const) {
    const lines = cleanLines(raw[key]);
    if (lines !== null) {
      copy[key] = lines;
      usedModel = true;
    }
  }
  return { copy, usedModel };
}

// Final length/clamp guard applied to the merged copy: bounds every field and
// GUARANTEES non-empty output. If a field somehow collapses to empty (a garbled
// fallback, a pathological clamp), the matching fallback field is used — so the
// template never receives an empty tagline or an empty concept list.
export function clampCopy(copy: SlideshowCopy, fallback: SlideshowCopy): SlideshowCopy {
  const tagline = clampText(copy.tagline, TAGLINE_MAX);
  const concept = (copy.concept ?? [])
    .map((line) => clampText(line, COPY_LINE_MAX))
    .filter((line) => line.length > 0)
    .slice(0, COPY_LINES_MAX);
  const fallbackConcept = fallback.concept
    .map((line) => clampText(line, COPY_LINE_MAX))
    .filter((line) => line.length > 0)
    .slice(0, COPY_LINES_MAX);
  return {
    tagline: tagline.length > 0 ? tagline : clampText(fallback.tagline, TAGLINE_MAX) || "Untitled idea",
    concept: concept.length > 0 ? concept : fallbackConcept.length > 0 ? fallbackConcept : ["The concept, sketched — commission it or steer it."],
  };
}

// Trim, collapse whitespace, and hard-cap a single line. When truncated it breaks
// on the last word boundary (when one is near the cut) and appends an ellipsis, so
// a clamped line reads as a clean phrase rather than a mid-word chop.
function clampText(value: string, maxLength: number): string {
  const collapsed = value.trim().replace(/\s+/gu, " ");
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  const hardCut = collapsed.slice(0, Math.max(1, maxLength - 1));
  const lastSpace = hardCut.lastIndexOf(" ");
  const body = lastSpace > maxLength * 0.6 ? hardCut.slice(0, lastSpace) : hardCut;
  return `${body.replace(/[\s.,;:!?—-]+$/u, "")}…`;
}

// Extract a JSON object from model text that may be wrapped in prose or markdown
// code fences. Tolerant in layers: (1) strip fences and parse the whole thing;
// (2) parse the outermost { ... } span; (3) scan a brace-balanced object from the
// first "{" (survives trailing prose that contains stray braces). Null on anything
// unparseable or when the JSON is not an object (e.g. a bare array).
export function parseModelCopy(content: string): Record<string, unknown> | null {
  if (typeof content !== "string") {
    return null;
  }
  const stripped = stripCodeFences(content).trim();
  const direct = tryParseRecord(stripped);
  if (direct !== null) {
    return direct;
  }
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return null;
  }
  const span = tryParseRecord(stripped.slice(start, end + 1));
  if (span !== null) {
    return span;
  }
  const balanced = extractBalancedObject(stripped, start);
  return balanced === null ? null : tryParseRecord(balanced);
}

// Remove markdown code fences (```json … ```, ``` … ```) without touching the
// JSON inside. Leaves fence-free text untouched.
function stripCodeFences(content: string): string {
  return content.replace(/```[a-zA-Z]*\n?/gu, "").replace(/```/gu, "");
}

function tryParseRecord(text: string): Record<string, unknown> | null {
  if (text.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// From the "{" at startIndex, return the substring through its brace-balanced
// close, respecting string literals and escapes so braces inside strings don't
// throw off the depth count. Null when the object never closes.
function extractBalancedObject(text: string, startIndex: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIndex; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(startIndex, i + 1);
      }
    }
  }
  return null;
}

function cleanLine(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().replace(/\s+/gu, " ");
  return trimmed.length === 0 ? null : trimmed.slice(0, maxLength);
}

function cleanLines(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const lines = value
    .map((line) => cleanLine(line, COPY_LINE_MAX))
    .filter((line): line is string => line !== null)
    .slice(0, COPY_LINES_MAX);
  return lines.length === 0 ? null : lines;
}

// --- Slides -----------------------------------------------------------------

// The gallery lanes. Explicit mocks (per-backend previewUrl from
// process.builds[]) pass through; omitted/empty falls back to this lane's own
// mock via the relative URL "../" — always live, needs zero configuration.
export function pitchMocks(input: GenerateSlideshowInput): SlideMock[] {
  const lanes: readonly PitchMock[] =
    input.mocks !== undefined && input.mocks.length > 0
      ? input.mocks
      : [{ backend: input.backend, previewUrl: "../" }];
  return lanes.map((lane) => {
    const src = lane.previewUrl === null || lane.previewUrl.trim().length === 0 ? null : lane.previewUrl.trim();
    return {
      id: lane.backend,
      label: BACKEND_LABELS[lane.backend] ?? lane.backend,
      src,
      caption: `${lane.backend} · framework concept mock`,
    };
  });
}

// The three fixed how-to-continue decisions, endpoints encoded per the kickoff
// contract. upid/ideaId are URI-encoded into the paths (and the template
// HTML-escapes the attributes on top).
export function decisionButtons(
  upid: string,
  ideaId: string,
  callsign: string | null,
): SlideDecision[] {
  const processPath = `/api/process/${encodeURIComponent(upid)}`;
  const steerSpoken = callsign === null ? '"steer it ..."' : `"steer ${callsign} ..."`;
  return [
    {
      id: "execute",
      label: "Build it for real",
      detail: "Commission the full build now — then watch it go up on the wall.",
      endpoint: `${processPath}/execute`,
      confirmation: "Commissioned — watch the wall.",
      terminal: true,
    },
    {
      id: "steer",
      label: "Steer it",
      detail: `Say ${steerSpoken} out loud — or type a correction here.`,
      endpoint: `${processPath}/steer`,
      confirmation: "Correction sent — the concept will shift on the wall.",
      prompt: {
        hint: "Say the correction out loud — or type it and send:",
        field: "text",
        placeholder: "e.g. make it neon, lean into the leaderboard",
        submitLabel: "Send correction",
      },
    },
    {
      id: "dismiss",
      label: "Park it for later",
      detail: "Keep the idea as a seed in the tray — nothing is lost.",
      endpoint: `/api/idea/${encodeURIComponent(ideaId)}/dismiss`,
      confirmation: "Parked — the idea stays in the tray for later.",
      terminal: true,
    },
  ];
}

export function buildSlides(input: GenerateSlideshowInput, copy: SlideshowCopy): Slide[] {
  const callsign = normalizeCallsign(input.callsign);
  const spoken = input.prompt.trim();
  const mocks = pitchMocks(input);
  const ideaId = input.ideaId ?? null;
  return [
    {
      kicker: "Heard in the room",
      title: "The idea, verbatim",
      hero: true,
      quote: spoken.length > 0 ? spoken : "(no transcript captured)",
      bullets: [
        callsign === null ? `Process ${input.upid}` : `Callsign “${callsign}” — process ${input.upid}`,
      ],
    },
    {
      kicker: "The concept",
      title: copy.tagline,
      paragraphs: [
        input.summary.trim().length > 0
          ? input.summary.trim()
          : "The kickoff produced no pitch summary — the mocks on the next slide speak for themselves.",
      ],
      bullets: copy.concept,
    },
    {
      kicker: "The mocks",
      title: mocks.length === 1 ? "One concept mock, live" : `${mocks.length} concept mocks, live`,
      mocks,
    },
    {
      kicker: "Your call",
      title: "How should we continue?",
      decisions: decisionButtons(input.upid, ideaId === null || ideaId.trim().length === 0 ? input.upid : ideaId.trim(), callsign),
    },
  ];
}

// First clause of the spoken idea, capped at 10 words, capitalized — the same
// move the prototype scaffold uses for page titles.
export function ideaTitle(prompt: string): string {
  const trimmed = prompt.trim();
  if (trimmed.length === 0) {
    return "Untitled idea";
  }
  const firstClause = trimmed.split(/[.!?\n]/u)[0]?.trim() ?? trimmed;
  const words = firstClause.split(/\s+/u).slice(0, 10).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function footerLine(input: GenerateSlideshowInput): string {
  const callsign = normalizeCallsign(input.callsign);
  const parts = [input.upid, input.backend];
  if (callsign !== null) {
    parts.push(callsign);
  }
  return parts.join(" · ");
}

function normalizeCallsign(callsign: string | null): string | null {
  if (callsign === null) {
    return null;
  }
  const trimmed = callsign.trim();
  return trimmed.length === 0 ? null : trimmed;
}

// --- Model plumbing ---------------------------------------------------------

// Run the copy model under a hard budget. NEVER rejects: timeout, caller
// abort, model rejection, and hung models (even ones that ignore the signal)
// all resolve to null so the deterministic fallback takes over. The caller
// re-checks its own signal right after, so emergency stops still propagate.
async function callModelWithBudget(
  model: SlideshowCopyModel,
  request: SlideshowCopyRequest,
  timeoutMs: number,
  outer: AbortSignal | undefined,
): Promise<Partial<SlideshowCopy> | null> {
  const budget = AbortSignal.timeout(timeoutMs);
  const combined = outer === undefined ? budget : AbortSignal.any([outer, budget]);
  return await new Promise((resolvePromise) => {
    let settled = false;
    const finish = (value: Partial<SlideshowCopy> | null): void => {
      if (!settled) {
        settled = true;
        resolvePromise(value);
      }
    };
    combined.addEventListener("abort", () => finish(null), { once: true });
    if (combined.aborted) {
      finish(null);
      return;
    }
    model(request, combined).then(finish, () => finish(null));
  });
}

export const CEREBRAS_CHAT_URL = "https://api.cerebras.ai/v1/chat/completions";
// Default matches the rest of the codebase (see src/providers/llm/cue-cerebras.ts):
// gemma-4-31b, overridable via CEREBRAS_MODEL.
export const CEREBRAS_SLIDESHOW_MODEL = "gemma-4-31b";

const COPY_SYSTEM_PROMPT =
  "You write projector slide copy for a live demo room that pitches spoken ideas back as clickable " +
  "concept mocks. This is a PITCH for what the full build would be — not a report. Terse, vivid, " +
  "concrete; every line must fit on a big-type slide. Respond with ONLY a JSON object (no markdown " +
  "fences, no prose) matching exactly: " +
  '{"tagline": string (<=10 word headline for what we would build), ' +
  '"concept": string[] (2-4 bullets pitching the full build)}.';

// Default production model: ONE logical Cerebras chat/completions call, with a
// BOUNDED retry (exponential backoff, honoring Retry-After) on transient
// failures — 429, 5xx, and network errors. Null on any terminal miss (no key,
// non-retryable HTTP error, exhausted retries, unparseable output). Aborts
// (budget elapsed or emergency stop) reject and are converted to null upstream.
export const cerebrasCopyModel: SlideshowCopyModel = async (request, signal) => {
  const apiKey = process.env.CEREBRAS_API_KEY;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    return null;
  }
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: process.env.CEREBRAS_MODEL ?? CEREBRAS_SLIDESHOW_MODEL,
      temperature: 0,
      max_completion_tokens: 500,
      messages: [
        { role: "system", content: COPY_SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            ideaSpokenInRoom: request.prompt,
            pitchSummary: request.summary,
            backend: request.backend,
            callsign: request.callsign,
            conceptMockLanes: request.mocks,
          }),
        },
      ],
    }),
  };
  const response = await fetchWithRetry(fetch, CEREBRAS_CHAT_URL, init, signal);
  if (response === null || !response.ok) {
    return null;
  }
  const payload = await response.json().catch(() => null);
  const content = payload === null ? null : chatContent(payload);
  return content === null ? null : (parseModelCopy(content) as Partial<SlideshowCopy> | null);
};

export interface RetryFetchOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  // Injectable so tests exercise the backoff sequence with zero real waiting.
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

// Retryable HTTP statuses: rate limits (429) and transient server errors (5xx).
// Other 4xx (bad key, malformed request) are terminal — retrying can't help.
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

// Fetch with bounded exponential backoff. Retries on 429/5xx and transient
// network errors up to maxAttempts, sleeping between tries (honoring Retry-After
// when the server sends it). AbortSignal-aware: an abort stops the retries at
// once — mid-sleep it wakes early, and the next iteration re-throws the abort so
// the budget wrapper converts it to null (the deterministic fallback). Returns
// the first ok Response, or null when a terminal status is hit or attempts run out.
export async function fetchWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  options: RetryFetchOptions = {},
): Promise<Response | null> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? COPY_MAX_ATTEMPTS);
  const baseDelayMs = options.baseDelayMs ?? COPY_RETRY_BASE_MS;
  const maxDelayMs = options.maxDelayMs ?? COPY_RETRY_MAX_MS;
  const sleep = options.sleep ?? abortableDelay;
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, signal });
    } catch (error) {
      // A caller abort must propagate (emergency stop / budget). A transient
      // network error retries until the attempt budget is spent.
      if (signal.aborted) {
        throw error;
      }
      if (attempt + 1 >= maxAttempts) {
        return null;
      }
      await sleep(backoffMs(attempt, baseDelayMs, maxDelayMs), signal);
      continue;
    }
    if (response.ok) {
      return response;
    }
    if (isRetryableStatus(response.status) && attempt + 1 < maxAttempts) {
      const retryAfter = parseRetryAfterMs(response.headers.get("retry-after"));
      const delay = retryAfter === null ? backoffMs(attempt, baseDelayMs, maxDelayMs) : Math.min(retryAfter, maxDelayMs);
      await sleep(delay, signal);
      continue;
    }
    return null;
  }
}

// Full-jitter exponential backoff: min(max, base * 2^attempt), then a random
// point in [half, full] to keep concurrent decks off the endpoint in lockstep.
function backoffMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const capped = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.round(capped / 2 + Math.random() * (capped / 2));
}

// Retry-After as milliseconds. Supports the numeric "seconds" form (the common
// Cerebras/OpenAI case); HTTP-date form and garbage yield null (fall to backoff).
function parseRetryAfterMs(header: string | null): number | null {
  if (header === null) {
    return null;
  }
  const seconds = Number(header.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : null;
}

// A sleep that resolves early (does NOT reject) when the signal aborts, so the
// retry loop's next throwIfAborted is the single, predictable abort exit point.
async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

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
