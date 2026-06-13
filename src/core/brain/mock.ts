import type { Artifact, VisualizerKind } from "../types.ts";
import { uid } from "../util.ts";
import type { Brain, StepRequest, StepResult, SuggestRequest, SuggestionDraft } from "./types.ts";

// Deterministic, dependency-free brain. Good enough to demonstrate the whole
// loop — ambient suggestion, demos, clarifying questions, process steering —
// with zero API keys. Used for offline/dev mode and Smithers fallback.

const BUILD_TRIGGERS = [
  "build",
  "make",
  "should we",
  "should i",
  "what if",
  "idea",
  "let's",
  "lets",
  "could we",
  "imagine",
  "wouldn't it be cool",
  "i want",
  "we need",
  "tool",
  "app",
  "site",
  "game",
  "visualize",
  "dashboard",
  "track",
];

const STOPWORDS = new Set([
  "the","a","an","to","of","and","or","for","with","that","this","it","is","we","i","you",
  "should","would","could","build","make","just","like","so","be","do","have","want","need",
  "let's","lets","what","if","maybe","really","actually","kind","sort","thing","stuff",
]);

function pickVisualizer(text: string): VisualizerKind {
  const t = text.toLowerCase();
  if (/\b(draw|art|paint|image|logo|design|color|palette)\b/.test(t)) return "art";
  if (/\b(book|essay|story|write|chapter|novel|document)\b/.test(t)) return "book";
  if (/\b(graph|chart|data|metric|track|dashboard|analytics)\b/.test(t)) return "data";
  if (/\b(site|page|web|landing|ui|interface|app)\b/.test(t)) return "web";
  if (/\b(code|function|script|api|library|refactor|bug)\b/.test(t)) return "code";
  return "web";
}

/** Pull a short concept phrase out of an utterance. */
function concept(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w));
  const keep = words.slice(0, 5).join(" ");
  return keep || "ambient idea";
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function demoFor(kind: VisualizerKind, title: string, seed: string): Artifact {
  const safe = title.replace(/[<>]/g, "");
  switch (kind) {
    case "art":
      return {
        kind,
        title: safe,
        html: artSvg(seed),
      };
    case "book":
      return {
        kind,
        title: safe,
        content: `# ${safe}\n\n*A working draft, spun up from the room.*\n\n## Premise\n${safe} — explored as a short piece. The opening establishes the core tension and a voice worth following.\n\n## Outline\n1. Hook\n2. Turn\n3. Resolution\n`,
      };
    case "data":
      return {
        kind,
        title: safe,
        html: barChart(seed),
      };
    case "code":
      return {
        kind,
        title: safe,
        content: `// ${safe} — sketch\nexport function ${seedIdent(seed)}(input) {\n  // TODO: flesh out\n  return input;\n}\n`,
      };
    case "web":
    default:
      return { kind: "web", title: safe, html: landingPage(safe) };
  }
}

function seedIdent(seed: string): string {
  const id = seed.replace(/[^a-zA-Z0-9]/g, " ").trim().split(/\s+/);
  return (id[0] || "run") + id.slice(1).map(titleCase).join("");
}

function landingPage(title: string): string {
  return `<!doctype html><meta charset=utf8><style>
  body{margin:0;font:16px/1.5 system-ui;background:#0b0f17;color:#e7ecf3;display:grid;place-items:center;height:100vh}
  .card{max-width:520px;padding:40px;text-align:center}
  h1{font-size:34px;margin:0 0 12px;background:linear-gradient(90deg,#7df,#a9f);-webkit-background-clip:text;color:transparent}
  p{color:#9fb0c3}.btn{margin-top:20px;display:inline-block;padding:10px 22px;border-radius:999px;background:#3b82f6;color:#fff;text-decoration:none}
  </style><div class=card><h1>${title}</h1><p>A rough proof-of-concept, generated live from the conversation. Accept the bubble to spawn a real process and refine it.</p><a class=btn href=#>Try it</a></div>`;
}

function artSvg(seed: string): string {
  const n = [...seed].reduce((a, c) => a + c.charCodeAt(0), 0);
  const hue = n % 360;
  const circles = Array.from({ length: 7 }, (_, i) => {
    const x = 40 + ((n * (i + 3)) % 320);
    const y = 40 + ((n * (i + 7)) % 220);
    const r = 18 + ((n * (i + 2)) % 60);
    return `<circle cx=${x} cy=${y} r=${r} fill="hsl(${(hue + i * 40) % 360} 80% 60% / .55)"/>`;
  }).join("");
  return `<!doctype html><meta charset=utf8><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" style="background:#0b0f17;width:100%;height:100%">${circles}</svg>`;
}

function barChart(seed: string): string {
  const n = [...seed].reduce((a, c) => a + c.charCodeAt(0), 1);
  const bars = Array.from({ length: 6 }, (_, i) => {
    const h = 20 + ((n * (i + 2)) % 130);
    return `<rect x=${20 + i * 60} y=${160 - h} width=40 height=${h} rx=4 fill="hsl(${200 + i * 16} 80% 60%)"/>`;
  }).join("");
  return `<!doctype html><meta charset=utf8><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 180" style="background:#0b0f17;width:100%;height:100%">${bars}</svg>`;
}

export class MockBrain implements Brain {
  readonly name = "mock";

  async suggest(req: SuggestRequest): Promise<SuggestionDraft | null> {
    const text = req.transcript.trim();
    if (!req.modelInitiated) {
      const lower = text.toLowerCase();
      const triggered = BUILD_TRIGGERS.some((t) => lower.includes(t));
      if (!triggered || text.length < 12) return null;
    }

    const c = concept(text);
    const kind = pickVisualizer(text);
    const title = req.modelInitiated ? `Prior art: ${titleCase(c)}` : titleCase(c);

    // Merge into an existing bubble if the concept overlaps (update-in-place, §5.5).
    const merge = req.existing.find((e) =>
      e.phrases.some((p) => p && (c.includes(p) || p.includes(c))),
    );

    return {
      title,
      rationale: req.modelInitiated
        ? `Someone has explored "${c}" before — here's a starting point and how it tends to go.`
        : `The room keeps circling "${c}". Here's a quick take to react to.`,
      visualizer: kind,
      demo: demoFor(kind, title, c),
      sourcePhrases: [c],
      mergeWith: merge?.id,
      questions: [
        {
          id: uid("q"),
          prompt: `What's the primary surface for "${titleCase(c)}"?`,
          choices: ["Web app", "CLI / script", "Visual / art", "Document"],
        },
        {
          id: uid("q"),
          prompt: "Who is it for?",
          choices: ["Just us, right now", "The whole team", "Public / shippable"],
        },
        {
          id: uid("q"),
          prompt: "How far should the first process go?",
          choices: ["Throwaway demo", "Working prototype", "Production-ready"],
        },
      ],
    };
  }

  async step(req: StepRequest): Promise<StepResult> {
    const { process, prompt, autonomous } = req;
    if (autonomous) {
      // Most autonomous ticks are invisible (§5.3 — ~90% no output).
      return { note: `idle tick (${process.state})` };
    }
    const kind = process.visualizer;
    const artifact = demoFor(kind, process.title, prompt || process.title);
    return {
      reply: `Applied: "${prompt}". Updated the ${kind} view.`,
      artifact,
      note: `steered: ${prompt.slice(0, 48)}`,
    };
  }
}
