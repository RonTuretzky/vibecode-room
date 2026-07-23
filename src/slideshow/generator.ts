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
  const { copy, usedModel } = mergeCopy(raw, fallback);

  // 2. Render + write. The template escapes everything; we hand it raw text.
  const slides = buildSlides(input, copy);
  const html = renderSlideshowHtml({
    title: `${ideaTitle(input.prompt)} — pitch`,
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
      ? 'Say "steer it ..." out loud (or use the Steer it button) to reshape it before committing.'
      : `Say "steer ${callsign} ..." out loud (or use the Steer it button) to reshape it before committing.`;
  return {
    tagline: ideaTitle(input.prompt),
    concept: [
      "Concept first: each framework sketched the idea as a clickable mock, not a promise.",
      steerLine,
      "Commission it and the full build spins up — the wall shows it happen live.",
      "Parked ideas keep their seed in the tray; nothing said in the room is lost.",
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
  for (const key of ["concept"] as const) {
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
