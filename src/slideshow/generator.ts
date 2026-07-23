// Slideshow generator: after a build backend finishes, turn the build into a
// SELF-CONTAINED clickable HTML slideshow at <outDir>/slideshow/index.html —
// six projector-friendly slides: the spoken idea verbatim, what was built, how
// it works, key files (highlighted excerpts read from disk), how to demo it,
// and next steps.
//
// Copy generation makes ONE Cerebras call (OpenAI-compatible chat/completions,
// CEREBRAS_API_KEY, gemma-4-31b) bounded by a hard time budget, and merges the
// result field-by-field over a DETERMINISTIC no-network fallback built purely
// from the inputs — so slideshow generation NEVER fails a build for model
// reasons: no key, network down, timeout, garbage output all degrade to the
// template text. The model is injectable so tests run with fakes and zero
// network. The only aborts that propagate are the caller's own AbortSignal
// (emergency stop) — honored between phases and passed into fetch.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { renderSlideshowHtml, type Slide, type SlideCode } from "./template";

// Mirrors BuildBackendId in src/buildloop/types.ts BY CONVENTION — that module
// is owned by the buildloop track and this track must stand alone (no
// cross-track imports). The unions are structurally identical, so a
// BuildBackendId is directly assignable here.
export type SlideshowBackendId = "smithers" | "eliza" | "native";

// Where the slideshow lives inside a build directory, and the public URL
// convention the wall consumes: previewUrl + "slideshow/".
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

export interface GenerateSlideshowInput {
  upid: string;
  prompt: string; // the spoken idea, shown VERBATIM on slide 1
  callsign: string | null;
  backend: SlideshowBackendId;
  outDir: string; // ABSOLUTE build dir; slideshow written to <outDir>/slideshow/
  summary: string; // one-paragraph build summary from the backend
  // Key files to excerpt, relative to outDir. Omitted/empty -> the generator
  // scans outDir itself (index.html first), so wiring stays a one-liner.
  files?: readonly string[];
}

// The copy the model (or the deterministic fallback) supplies. Slide 1 (the
// verbatim idea) and slide 4 (real file excerpts) are NEVER model-authored.
export interface SlideshowCopy {
  tagline: string; // slide-2 headline, <=~10 words
  whatWasBuilt: string[];
  howItWorks: string[];
  demoSteps: string[];
  nextSteps: string[];
}

export interface SlideshowCopyRequest {
  prompt: string;
  summary: string;
  backend: SlideshowBackendId;
  callsign: string | null;
  files: readonly string[]; // excerpt file names, for grounding
}

// Injectable copy model. Return null (or reject, or hang past the budget) to
// fall back to deterministic copy; partial objects merge field-by-field.
export type SlideshowCopyModel = (
  request: SlideshowCopyRequest,
  signal: AbortSignal,
) => Promise<Partial<SlideshowCopy> | null>;

export interface GenerateSlideshowOptions {
  model?: SlideshowCopyModel; // default: one Cerebras chat/completions call
  signal?: AbortSignal; // the build's abort signal (emergency stop)
  timeoutMs?: number; // model budget; the fallback path is instant
  maxFiles?: number; // excerpt count cap for the key-files slide
}

export interface SlideshowArtifact {
  dir: string; // <outDir>/slideshow
  indexPath: string; // <outDir>/slideshow/index.html
  slideCount: number;
  usedModel: boolean; // false whenever the deterministic fallback authored the copy
}

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_FILES = 4;
const EXCERPT_MAX_LINES = 14;
const EXCERPT_MAX_COLS = 96;
const EXCERPT_MAX_BYTES = 200_000;
const EXCERPT_EXTENSIONS = /\.(?:html|css|js|mjs|ts|tsx|jsx|json|md|svg)$/u;
const COPY_LINE_MAX = 220;
const COPY_LINES_MAX = 6;

// --- Public entrypoint ------------------------------------------------------

// Generate the slideshow. Model failures never propagate; the only throws are
// caller aborts and filesystem errors on the build dir itself (callers should
// still wrap this — the slideshow is garnish, never a reason to fail a build).
export async function generateSlideshow(
  input: GenerateSlideshowInput,
  options: GenerateSlideshowOptions = {},
): Promise<SlideshowArtifact> {
  const signal = options.signal;
  signal?.throwIfAborted();

  // 1. Deterministic ground truth: real excerpts read from the build dir.
  const excerpts = await collectExcerpts(input.outDir, input.files, options.maxFiles ?? DEFAULT_MAX_FILES);
  signal?.throwIfAborted();

  // 2. Copy: one bounded model call merged over the deterministic fallback.
  const fallback = fallbackCopy(input);
  const model = options.model ?? cerebrasCopyModel;
  const request: SlideshowCopyRequest = {
    prompt: input.prompt,
    summary: input.summary,
    backend: input.backend,
    callsign: input.callsign,
    files: excerpts.map((entry) => entry.file),
  };
  const raw = await callModelWithBudget(model, request, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal);
  signal?.throwIfAborted();
  const { copy, usedModel } = mergeCopy(raw, fallback);

  // 3. Render + write. The template escapes everything; we hand it raw text.
  const slides = buildSlides(input, copy, excerpts);
  const html = renderSlideshowHtml({
    title: `${ideaTitle(input.prompt)} — build slides`,
    footer: footerLine(input),
    slides,
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
      ? 'Say "steer it ..." out loud to apply a spoken correction live.'
      : `Say "steer ${callsign} ..." out loud to apply a spoken correction live.`;
  return {
    tagline: ideaTitle(input.prompt),
    whatWasBuilt: [
      "A working, self-contained web app — index.html is the entrypoint.",
      `Assembled end-to-end by the ${input.backend} build backend.`,
      "Served live by the room; the preview link always shows the current files.",
    ],
    howItWorks: [
      `The room heard the idea and handed it to the ${input.backend} build backend.`,
      "The backend wrote a complete app into this build directory — plain HTML/CSS/JS, no build step.",
      "A static server serves the directory as the preview, so file edits appear on refresh.",
      "Spoken steering rewrites the same directory in place while the process keeps running.",
    ],
    demoSteps: [
      "Open the preview link on this process card — it is the real, working app.",
      "Interact with it: click around and exercise the actual behavior, not a mock.",
      steerLine,
      "Use pause / halt on the process card if you need to stop the build loop.",
    ],
    nextSteps: [
      "Steer it a few times to sharpen the behavior while the room watches.",
      "Promote it: copy the build directory into a real repo and keep iterating with an agent.",
      "Compare backends — the same idea may have sibling builds; keep the best one.",
      "Say the next idea out loud; the room is listening.",
    ],
  };
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
  const tagline = cleanLine(raw.tagline, 120);
  if (tagline !== null) {
    copy.tagline = tagline;
    usedModel = true;
  }
  for (const key of ["whatWasBuilt", "howItWorks", "demoSteps", "nextSteps"] as const) {
    const lines = cleanLines(raw[key]);
    if (lines !== null) {
      copy[key] = lines;
      usedModel = true;
    }
  }
  return { copy, usedModel };
}

// Extract a JSON object from model text that may be wrapped in prose or code
// fences: parse the outermost { ... } span. Null on anything unparseable.
export function parseModelCopy(content: string): Record<string, unknown> | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(content.slice(start, end + 1));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
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

export function buildSlides(
  input: GenerateSlideshowInput,
  copy: SlideshowCopy,
  excerpts: readonly SlideCode[],
): Slide[] {
  const callsign = normalizeCallsign(input.callsign);
  const spoken = input.prompt.trim();
  return [
    {
      kicker: "Spoken in the room",
      title: ideaTitle(input.prompt),
      quote: spoken.length > 0 ? spoken : "(no transcript captured)",
      bullets: [
        callsign === null ? `Process ${input.upid}` : `Callsign “${callsign}” — process ${input.upid}`,
        `Built by the ${input.backend} backend`,
      ],
    },
    {
      kicker: "What was built",
      title: copy.tagline,
      paragraphs: [
        input.summary.trim().length > 0
          ? input.summary.trim()
          : "The build finished without a summary — open the preview to see it.",
      ],
      bullets: copy.whatWasBuilt,
    },
    {
      kicker: "How it works",
      title: "From spoken idea to running app",
      bullets: copy.howItWorks,
    },
    {
      kicker: "Key files",
      title: "Inside the build",
      paragraphs:
        excerpts.length === 0
          ? ["No source files captured — open the preview and view-source to explore the build."]
          : undefined,
      code: excerpts,
    },
    {
      kicker: "Demo it",
      title: "Try it right now",
      bullets: copy.demoSteps,
    },
    {
      kicker: "Next steps",
      title: "Where this goes",
      bullets: copy.nextSteps,
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

// --- Key-file excerpts (deterministic, read from the build dir) --------------

async function collectExcerpts(
  outDir: string,
  files: readonly string[] | undefined,
  maxFiles: number,
): Promise<SlideCode[]> {
  const candidates =
    files !== undefined && files.length > 0 ? [...files] : await scanCandidateFiles(outDir);
  const excerpts: SlideCode[] = [];
  for (const relative of candidates) {
    if (excerpts.length >= maxFiles) {
      break;
    }
    const excerpt = await readFileExcerpt(outDir, relative);
    if (excerpt !== null) {
      excerpts.push({ file: relative, excerpt });
    }
  }
  return excerpts;
}

// Read a short excerpt of one build file. Null (skip, never throw) on missing
// files, path escapes, binary-looking content, or oversized files.
async function readFileExcerpt(outDir: string, relative: string): Promise<string | null> {
  const root = resolve(outDir);
  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}/`)) {
    return null; // refuses to excerpt outside the build dir
  }
  let text: string;
  try {
    text = await readFile(target, "utf8");
  } catch {
    return null;
  }
  if (text.length === 0 || text.length > EXCERPT_MAX_BYTES || text.includes("\u0000")) {
    return null;
  }
  const lines = text.split("\n");
  const shown = lines
    .slice(0, EXCERPT_MAX_LINES)
    .map((line) => (line.length > EXCERPT_MAX_COLS ? `${line.slice(0, EXCERPT_MAX_COLS)}…` : line));
  const excerpt = shown.join("\n").trimEnd();
  if (excerpt.length === 0) {
    return null;
  }
  return lines.length > EXCERPT_MAX_LINES ? `${excerpt}\n…` : excerpt;
}

// When the caller names no files, scan the build dir (depth <= 2, deterministic
// order): index.html first, then other pages, then scripts, styles, the rest.
async function scanCandidateFiles(outDir: string): Promise<string[]> {
  const skip = new Set([SLIDESHOW_DIRNAME, "node_modules"]);
  const found: Array<{ rel: string; depth: number }> = [];
  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 2) {
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) {
          await walk(join(dir, entry.name), `${prefix}${entry.name}/`, depth + 1);
        }
      } else if (entry.isFile() && EXCERPT_EXTENSIONS.test(entry.name)) {
        found.push({ rel: `${prefix}${entry.name}`, depth });
      }
    }
  };
  await walk(outDir, "", 0);
  found.sort(
    (a, b) => excerptRank(a.rel) - excerptRank(b.rel) || a.depth - b.depth || a.rel.localeCompare(b.rel),
  );
  return found.map((entry) => entry.rel);
}

function excerptRank(relative: string): number {
  if (relative === "index.html") {
    return 0;
  }
  if (relative.endsWith(".html")) {
    return 1;
  }
  if (/\.(?:js|mjs|ts|tsx|jsx)$/u.test(relative)) {
    return 2;
  }
  if (relative.endsWith(".css")) {
    return 3;
  }
  return 4;
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
  "You write projector slide copy for a live demo room where spoken ideas become working web apps. " +
  "Terse, vivid, concrete — every line must fit on a big-type slide. Respond with ONLY a JSON object " +
  "(no markdown fences, no prose) matching exactly: " +
  '{"tagline": string (<=10 word headline for what was built), ' +
  '"whatWasBuilt": string[] (2-4 bullets), "howItWorks": string[] (3-5 bullets on how the app works), ' +
  '"demoSteps": string[] (3-5 imperative steps to demo it), "nextSteps": string[] (2-4 bullets)}.';

// Default production model: ONE Cerebras chat/completions call. Null on any
// miss (no key, HTTP error, unparseable output); errors reject and are
// converted to null by callModelWithBudget.
export const cerebrasCopyModel: SlideshowCopyModel = async (request, signal) => {
  const apiKey = process.env.CEREBRAS_API_KEY;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    return null;
  }
  const response = await fetch(CEREBRAS_CHAT_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: process.env.CEREBRAS_MODEL ?? CEREBRAS_SLIDESHOW_MODEL,
      temperature: 0,
      max_completion_tokens: 700,
      messages: [
        { role: "system", content: COPY_SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            ideaSpokenInRoom: request.prompt,
            buildSummary: request.summary,
            backend: request.backend,
            callsign: request.callsign,
            files: request.files,
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
  const content = chatContent(payload);
  return content === null ? null : (parseModelCopy(content) as Partial<SlideshowCopy> | null);
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
