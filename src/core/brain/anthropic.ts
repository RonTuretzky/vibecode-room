import type { Artifact, VisualizerKind } from "../types.ts";
import { uid } from "../util.ts";
import { MockBrain } from "./mock.ts";
import type { Brain, StepRequest, StepResult, SuggestRequest, SuggestionDraft } from "./types.ts";

// Model tiers from the spec (§5.9 / P-Cost-fit):
//   - suggestion I/O loop  → fast/cheap model
//   - process orchestration → the process's own model field (Fable for planning)
const IO_MODEL = process.env.PANOPTICON_IO_MODEL ?? "claude-haiku-4-5-20251001";
const API = "https://api.anthropic.com/v1/messages";

interface Msg {
  role: "user" | "assistant";
  content: string;
}

/**
 * Pick the auth scheme by token shape. OAuth access tokens (sk-ant-oat…,
 * minted for Claude subscriptions / Claude Code) authenticate with a Bearer
 * header + the oauth beta; standard console keys (sk-ant-api…) use x-api-key.
 */
function authHeaders(apiKey: string): Record<string, string> {
  if (apiKey.startsWith("sk-ant-oat")) {
    return { authorization: `Bearer ${apiKey}`, "anthropic-beta": "oauth-2025-04-20" };
  }
  return { "x-api-key": apiKey };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(
  apiKey: string,
  model: string,
  system: string,
  messages: Msg[],
  maxTokens = 1500,
): Promise<string> {
  const maxAttempts = 3;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(API, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        ...authHeaders(apiKey),
      },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
    });
    if (res.ok) {
      const json = (await res.json()) as { content: { type: string; text?: string }[] };
      return json.content.map((b) => b.text ?? "").join("");
    }
    // Retry on rate limit / overload (subscription tokens are bursty).
    if ((res.status === 429 || res.status === 529) && attempt < maxAttempts) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
      await sleep(Math.min(waitMs, 8000));
      continue;
    }
    throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  }
}

/** Extract the first JSON object from a model response. */
function parseJson<T>(raw: string): T {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no json object in response");
  return JSON.parse(body.slice(start, end + 1)) as T;
}

const HTML_SENTINEL = "===HTML===";

/**
 * Split a "small JSON header, then raw HTML after a sentinel" response.
 * Keeping the (potentially long, token-truncatable) HTML OUT of the JSON means
 * the JSON never gets cut mid-string — only the tail of the HTML is ever lost.
 */
function parseHeaded<T>(raw: string): { meta: T; html: string } {
  const idx = raw.indexOf(HTML_SENTINEL);
  if (idx === -1) return { meta: parseJson<T>(raw), html: "" };
  return {
    meta: parseJson<T>(raw.slice(0, idx)),
    html: raw.slice(idx + HTML_SENTINEL.length).trim(),
  };
}

const SUGGEST_SYSTEM = `You are the always-on suggestion loop of Panopticon, an OS for AI-agent work.
People are talking in a room. You passively listen and occasionally propose a thing worth BUILDING.
Only fire when the conversation genuinely "rises to" a buildable idea. Otherwise output exactly: {"suggest": false}
When you fire, respond in EXACTLY this format — a single line of JSON, then the sentinel, then raw HTML:
{"suggest": true, "title": "short name", "rationale": "one sentence: why the room might want this", "visualizer": "web|code|art|book|text|data", "sourcePhrases": ["key phrase"], "questions": [{"prompt": "...", "choices": ["...","...","..."]}]}
${HTML_SENTINEL}
<a small self-contained HTML proof-of-concept, inline styles, no external assets, ideally under ~1500 chars>
Put NO html inside the JSON. Do not invent that something was already built unless asked.`;

const STEP_SYSTEM = `You are an agent process inside Panopticon working on a single goal.
You receive a steering instruction and produce a concrete update.
Respond in EXACTLY this format — a single line of JSON, then the sentinel, then the raw HTML document:
{"reply": "one short sentence to the user", "note": "<=48 char status", "done": false}
${HTML_SENTINEL}
<a complete self-contained HTML document for the visualizer (inline CSS/JS, no external assets). Leave empty to keep the current view.>
Put NO html inside the JSON.`;

export class AnthropicBrain implements Brain {
  readonly name = "anthropic";
  private fallback = new MockBrain();
  constructor(private apiKey: string) {}

  async suggest(req: SuggestRequest): Promise<SuggestionDraft | null> {
    try {
      const user = `Recent transcript:\n"""${req.transcript}"""\n\nExisting bubbles: ${
        req.existing.map((e) => e.title).join(", ") || "(none)"
      }.\n${req.modelInitiated ? "Volunteer your own idea or relevant prior art." : "Only suggest if warranted."}`;
      const raw = await call(this.apiKey, IO_MODEL, SUGGEST_SYSTEM, [{ role: "user", content: user }], 2000);
      const { meta: j, html } = parseHeaded<{
        suggest: boolean;
        title?: string;
        rationale?: string;
        visualizer?: VisualizerKind;
        sourcePhrases?: string[];
        questions?: { prompt: string; choices: string[] }[];
      }>(raw);
      if (!j.suggest || !j.title) return null;
      const kind = (j.visualizer ?? "web") as VisualizerKind;
      const demo: Artifact = { kind, title: j.title, html: html || `<h1>${j.title}</h1>` };
      return {
        title: j.title,
        rationale: j.rationale ?? "",
        visualizer: kind,
        demo,
        sourcePhrases: j.sourcePhrases ?? [],
        questions: (j.questions ?? []).map((q) => ({ id: uid("q"), prompt: q.prompt, choices: q.choices })),
      };
    } catch (err) {
      console.error("[anthropic.suggest] falling back to mock:", (err as Error).message);
      return this.fallback.suggest(req);
    }
  }

  async step(req: StepRequest): Promise<StepResult> {
    if (req.autonomous) return { note: "idle tick" };
    try {
      const history: Msg[] = req.history.map((h) => ({
        role: h.role === "agent" ? "assistant" : "user",
        content: h.text,
      }));
      const user = `Process: "${req.process.title}" (visualizer: ${req.process.visualizer}).\nInstruction: ${req.prompt}`;
      const raw = await call(
        this.apiKey,
        req.process.model,
        STEP_SYSTEM,
        [...history, { role: "user", content: user }],
        3500,
      );
      const { meta: j, html } = parseHeaded<{ reply?: string; note?: string; done?: boolean }>(raw);
      const artifact: Artifact | undefined = html
        ? { kind: req.process.visualizer, title: req.process.title, html }
        : undefined;
      return { reply: j.reply, note: j.note ?? "stepped", done: j.done, artifact };
    } catch (err) {
      console.error("[anthropic.step] falling back to mock:", (err as Error).message);
      return this.fallback.step(req);
    }
  }
}
