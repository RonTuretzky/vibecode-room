// ─────────────────────────────────────────────────────────────────────────────
// Mock engine — a self-contained simulation that makes the overworld ALIVE with
// zero backend. It mirrors the real Panopticon loop: scripted room chatter feeds
// an always-on suggestion engine (bubbles), accepted bubbles spawn processes
// (buildings), and processes run a session loop that occasionally emits output.
//
// Ported from the real mock brain (src/core/brain/mock.ts) so the artifacts and
// clarifying questions match what the actual system produces.
// ─────────────────────────────────────────────────────────────────────────────

import { useSyncExternalStore } from "react";
import { VIS_TO_BUILDING } from "./itemMapping.ts";
import type {
  Artifact,
  ClarifyingQuestion,
  ModelId,
  ProcessState,
  VisualizerKind,
  WorldBubble,
  WorldConfig,
  WorldProcess,
  WorldState,
} from "./types.ts";

// ── tiny id helpers ──────────────────────────────────────────────────────────
let counter = 0;
const uid = (p: string) => `${p}_${(counter++).toString(36)}_${Math.floor(Math.random() * 1e4).toString(36)}`;
const token = () => Math.random().toString(36).slice(2, 10);
const now = () => Date.now();
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];

// ── board layout: a spiral of tiles around the central Idea Spring ───────────
export const TILE = 3.6;
const SLOTS: [number, number][] = (() => {
  const out: [number, number][] = [];
  for (let r = 1; r <= 4; r++) {
    for (let x = -r; x <= r; x++)
      for (let z = -r; z <= r; z++)
        if (Math.max(Math.abs(x), Math.abs(z)) === r) out.push([x, z]);
  }
  return out;
})();
export const gridToWorld = (g: [number, number]): [number, number] => [g[0] * TILE, g[1] * TILE];

// ── visualizer detection + concept extraction (ported from mock brain) ───────
const BUILD_TRIGGERS = [
  "build", "make", "should we", "should i", "what if", "idea", "let's", "lets",
  "could we", "imagine", "i want", "we need", "tool", "app", "site", "game",
  "visualize", "dashboard", "track", "generator",
];
const STOPWORDS = new Set([
  "the", "a", "an", "to", "of", "and", "or", "for", "with", "that", "this", "it", "is",
  "we", "i", "you", "should", "would", "could", "build", "make", "just", "like", "so",
  "be", "do", "have", "want", "need", "lets", "what", "if", "maybe", "really", "actually",
  "kind", "sort", "thing", "stuff", "our", "all", "them", "each",
]);

function pickVisualizer(text: string): VisualizerKind {
  const t = text.toLowerCase();
  if (/\b(draw|art|paint|image|logo|design|color|palette|mural)\b/.test(t)) return "art";
  if (/\b(book|essay|story|write|chapter|novel|document|spec|notes)\b/.test(t)) return "book";
  if (/\b(graph|chart|data|metric|track|dashboard|analytics|stats)\b/.test(t)) return "data";
  if (/\b(code|function|script|api|library|refactor|bug|compiler)\b/.test(t)) return "code";
  if (/\b(site|page|web|landing|ui|interface|app)\b/.test(t)) return "web";
  return "web";
}
function concept(text: string): string {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w && !STOPWORDS.has(w));
  return words.slice(0, 4).join(" ") || "ambient idea";
}
const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

// ── demo artifact generators (ported, trimmed) ───────────────────────────────
function landingPage(title: string): string {
  return `<!doctype html><meta charset=utf8><style>body{margin:0;font:13px/1.5 system-ui;background:#0b0f17;color:#e7ecf3;display:grid;place-items:center;height:100vh}.c{padding:14px;text-align:center}h1{font-size:18px;margin:0 0 6px;background:linear-gradient(90deg,#7df,#a9f);-webkit-background-clip:text;color:transparent}p{color:#9fb0c3;font-size:11px;margin:0}.b{margin-top:10px;display:inline-block;padding:5px 14px;border-radius:999px;background:#3b82f6;color:#fff;font-size:11px}</style><div class=c><h1>${title}</h1><p>Live POC from the room.</p><span class=b>Try it</span></div>`;
}
function artSvg(seed: string): string {
  const n = [...seed].reduce((a, c) => a + c.charCodeAt(0), 7);
  const hue = n % 360;
  const circles = Array.from({ length: 7 }, (_, i) => {
    const x = 40 + ((n * (i + 3)) % 320);
    const y = 30 + ((n * (i + 7)) % 180);
    const r = 14 + ((n * (i + 2)) % 46);
    return `<circle cx=${x} cy=${y} r=${r} fill="hsl(${(hue + i * 40) % 360} 80% 62% / .6)"/>`;
  }).join("");
  return `<!doctype html><meta charset=utf8><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 240" style="background:#0b0f17;width:100%;height:100%">${circles}</svg>`;
}
function barChart(seed: string): string {
  const n = [...seed].reduce((a, c) => a + c.charCodeAt(0), 1);
  const bars = Array.from({ length: 6 }, (_, i) => {
    const h = 18 + ((n * (i + 2)) % 120);
    return `<rect x=${22 + i * 60} y=${150 - h} width=40 height=${h} rx=4 fill="hsl(${200 + i * 16} 80% 62%)"/>`;
  }).join("");
  return `<!doctype html><meta charset=utf8><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 160" style="background:#0b0f17;width:100%;height:100%">${bars}</svg>`;
}
function codeBlock(title: string, seed: string): string {
  const id = (seed.replace(/[^a-z0-9]/gi, " ").trim().split(/\s+/)[0] || "run") + "Fn";
  return `// ${title} — sketch\nexport function ${id}(input) {\n  // TODO: flesh out\n  return input;\n}\n`;
}
function prose(title: string): string {
  return `# ${title}\n\nA working draft, spun up from the room.\n\n## Premise\n${title} — explored as a short piece.\n\n## Outline\n1. Hook\n2. Turn\n3. Resolution`;
}
function demoFor(kind: VisualizerKind, title: string, seed: string): Artifact {
  switch (kind) {
    case "art": return { kind, title, html: artSvg(seed) };
    case "data": return { kind, title, html: barChart(seed) };
    case "code": return { kind, title, content: codeBlock(title, seed) };
    case "book":
    case "text": return { kind, title, content: prose(title) };
    default: return { kind: "web", title, html: landingPage(title) };
  }
}

function questionsFor(c: string): ClarifyingQuestion[] {
  return [
    { id: uid("q"), prompt: `What's the primary surface for "${titleCase(c)}"?`, choices: ["Web app", "CLI / script", "Visual / art", "Document"] },
    { id: uid("q"), prompt: "Who is it for?", choices: ["Just us", "The team", "Public"] },
    { id: uid("q"), prompt: "How far should v1 go?", choices: ["Throwaway", "Prototype", "Production"] },
  ];
}

const AGENTS = ["smithers", "eliza", "nanoclaw", "mock"];
function modelFor(kind: VisualizerKind): ModelId {
  if (kind === "code" || kind === "web" || kind === "data") return Math.random() < 0.7 ? "claude-fable-5" : "claude-sonnet-4-6";
  return Math.random() < 0.6 ? "claude-sonnet-4-6" : "claude-haiku-4-5-20251001";
}

// ── scripted room conversation (the always-on ambient channel) ───────────────
const SCRIPT = [
  "morning — what are we building today",
  "I keep losing track of all the agent processes we have running, we should build a dashboard to track them",
  "yeah and what if it visualized each one differently depending on what it is",
  "honestly we could also make a little tool to turn the whiteboard photos into a spec document",
  "ooh and an art generator that matches the vibe of the room",
  "we need a compiler playground to test that refactor idea",
  "could we chart the compute spend per process over the week",
  "imagine a landing page for the whole panopticon thing",
  "let's write the onboarding essay while we're at it",
  "what if the factory could fork itself when the queue gets deep",
];

// ── the store ────────────────────────────────────────────────────────────────
type Listener = () => void;

class Engine {
  private s: WorldState;
  private snapshot: WorldState;
  private listeners = new Set<Listener>();
  private lastBubbleAt = 0;
  private lastScriptAt = 0;
  private scriptIdx = 0;
  private bubblesSinceModel = 0;
  private startedAt = now();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.s = {
      processes: [],
      bubbles: [],
      transcript: [],
      config: { bubblesPerMinute: 6, suggestionTtlMs: 22_000, execution: "optimistic", safety: "safe" },
      selected: null,
      dayPhase: 0.15,
      paused: false,
      viewMode: "overworld",
      graftFrom: null,
    };
    this.snapshot = { ...this.s };
    this.seed();
  }

  // ── store plumbing ──
  subscribe = (l: Listener) => {
    this.listeners.add(l);
    this.ensureRunning();
    return () => {
      this.listeners.delete(l);
    };
  };
  getSnapshot = () => this.snapshot;
  private commit() {
    this.snapshot = { ...this.s };
    for (const l of this.listeners) l();
  }
  private ensureRunning() {
    if (!this.timer) this.timer = setInterval(() => this.tick(), 450);
  }

  // ── seed an interesting starting state ──
  private seed() {
    this.spawnProcess("Agent-Tracker Dashboard", "data", "active", undefined, true);
    this.spawnProcess("Whiteboard → Spec", "book", "active", undefined, true);
    const f = this.spawnProcess("Refactor Compiler", "code", "active", undefined, true);
    this.spawnProcess("Vibe Art Generator", "art", "paused", undefined, true);
    // a fork of the compiler, to show lineage roads
    this.fork(f.upid, true);
    // a couple of bubbles already drifting
    this.emitBubble(SCRIPT[1], false);
    this.emitBubble(SCRIPT[4], false);
    for (const line of SCRIPT.slice(0, 3)) this.s.transcript.push({ text: line, source: "seed", ts: now() });
  }

  // ── main simulation tick ──
  private tick() {
    if (this.s.paused) {
      this.s.dayPhase = (this.s.dayPhase + 0.0015) % 1; // sky keeps drifting even when paused
      this.commit();
      return;
    }
    const t = now();
    this.s.dayPhase = (this.s.dayPhase + 0.0016) % 1;

    // 1) ambient room chatter every ~4.5s
    if (t - this.lastScriptAt > 4500) {
      this.lastScriptAt = t;
      const line = SCRIPT[this.scriptIdx % SCRIPT.length];
      this.scriptIdx++;
      this.pushTranscript(line, "room", false);
    }

    // 2) suggestion engine: rate-gated bubble fire
    const minInterval = 60_000 / Math.max(0.5, this.s.config.bubblesPerMinute);
    if (t - this.lastBubbleAt > minInterval) {
      const recent = this.s.transcript.slice(-3).map((l) => l.text).join(" ");
      const modelInitiated = this.bubblesSinceModel >= 4;
      if (recent && (modelInitiated || BUILD_TRIGGERS.some((b) => recent.toLowerCase().includes(b)))) {
        this.emitBubble(recent, modelInitiated);
      }
    }

    // 3) expire bubbles past their TTL
    this.s.bubbles = this.s.bubbles.filter((b) => t - b.createdAt < b.ttlMs);

    // 4) process session loops
    for (const p of this.s.processes) {
      if (p.state === "planning" && t - p.bornAt > 2600) p.state = "active";
      if (p.state === "dead" && p.endedAt && t - p.endedAt > 9000) p.state = "dead"; // keep ruin
      if (p.state !== "active") continue;
      if (p.inbox > 0) {
        p.inbox--;
        this.processOutput(p, `steered → updated the ${p.visualizer} view`);
      } else if (Math.random() < 0.12) {
        // ~90% of autonomous ticks are invisible (§5.3)
        this.processOutput(p, autonomousNote(p));
      }
    }
    // sweep long-dead ruins
    this.s.processes = this.s.processes.filter((p) => !(p.state === "dead" && p.endedAt && t - p.endedAt > 14000));

    this.commit();
  }

  private processOutput(p: WorldProcess, text: string) {
    p.lastArtifact = demoFor(p.visualizer, p.title, p.title + p.log.length);
    p.emitPulse++;
    p.lastEmitAt = now();
    p.log.push({ role: "agent", text, ts: now() });
    if (p.log.length > 24) p.log.shift();
  }

  // ── suggestion creation (with merge-in-place) ──
  private emitBubble(sourceText: string, modelInitiated: boolean) {
    const c = concept(sourceText);
    const kind = pickVisualizer(sourceText);
    const title = modelInitiated ? `Prior art: ${titleCase(c)}` : titleCase(c);

    // merge into an existing active bubble whose concept overlaps (§5.5)
    const merge = this.s.bubbles.find((b) => {
      const bc = b.title.toLowerCase();
      return c.split(" ").some((w) => w.length > 3 && bc.includes(w));
    });
    if (merge && !modelInitiated) {
      merge.createdAt = now(); // refresh TTL — a visible "merge" pulse
      merge.rationale = `The room keeps circling "${c}". Merged with earlier idea.`;
      this.lastBubbleAt = now();
      this.bubblesSinceModel++;
      this.commit();
      return;
    }

    const bubble: WorldBubble = {
      id: uid("sug"),
      title,
      rationale: modelInitiated
        ? `Someone explored "${c}" before — here's a starting point.`
        : `The room keeps circling "${c}". Here's a quick take.`,
      visualizer: kind,
      demo: demoFor(kind, title, c),
      questions: questionsFor(c),
      createdAt: now(),
      ttlMs: this.s.config.suggestionTtlMs,
      modelInitiated,
      answers: {},
      seed: Math.random() * 1000,
      angle: Math.random() * Math.PI * 2,
    };
    this.s.bubbles.unshift(bubble);
    if (this.s.bubbles.length > 6) this.s.bubbles.pop();
    this.lastBubbleAt = now();
    this.bubblesSinceModel = modelInitiated ? 0 : this.bubblesSinceModel + 1;
    this.commit();
  }

  // ── process spawning ──
  private nextSlot(prefer?: [number, number]): [number, number] {
    const occupied = new Set(this.s.processes.map((p) => `${p.grid[0]},${p.grid[1]}`));
    if (prefer) {
      const neighbors: [number, number][] = [
        [prefer[0] + 1, prefer[1]], [prefer[0] - 1, prefer[1]],
        [prefer[0], prefer[1] + 1], [prefer[0], prefer[1] - 1],
      ];
      for (const n of neighbors) if (!occupied.has(`${n[0]},${n[1]}`) && SLOTS.some((s) => s[0] === n[0] && s[1] === n[1])) return n;
    }
    for (const s of SLOTS) if (!occupied.has(`${s[0]},${s[1]}`)) return s;
    return SLOTS[this.s.processes.length % SLOTS.length];
  }

  private spawnProcess(
    title: string,
    visualizer: VisualizerKind,
    state: ProcessState,
    parentId?: string,
    silent = false,
  ): WorldProcess {
    const parent = parentId ? this.s.processes.find((p) => p.upid === parentId) : undefined;
    const grid = this.nextSlot(parent?.grid);
    const p: WorldProcess = {
      upid: uid("proc"),
      parentId,
      title,
      owner: "room",
      createdAt: now(),
      state,
      visualizer,
      model: modelFor(visualizer),
      agent: pick(AGENTS),
      mode: { execution: this.s.config.execution, safety: this.s.config.safety },
      qrToken: token(),
      dependsOn: parentId ? [parentId] : [],
      grid,
      inbox: 0,
      log: [{ role: "agent", text: `spawned · ${VIS_TO_BUILDING[visualizer]} raised`, ts: now() }],
      emitPulse: 0,
      lastEmitAt: now(),
      bornAt: now(),
    };
    this.s.processes.push(p);
    if (!silent) this.commit();
    return p;
  }

  // ── public actions (the real Process-Manager surface) ──
  pushTranscript(text: string, source = "pro", commit = true) {
    if (!text.trim()) return;
    this.s.transcript.push({ text: text.trim(), source, ts: now() });
    if (this.s.transcript.length > 40) this.s.transcript.shift();
    if (commit) this.commit();
  }

  acceptBubble(id: string) {
    const b = this.s.bubbles.find((x) => x.id === id);
    if (!b) return;
    this.s.bubbles = this.s.bubbles.filter((x) => x.id !== id);
    const p = this.spawnProcess(b.title.replace(/^Prior art: /, ""), b.visualizer, "planning");
    this.s.selected = p.upid;
    this.commit();
  }
  dismissBubble(id: string) {
    this.s.bubbles = this.s.bubbles.filter((x) => x.id !== id);
    this.commit();
  }
  answer(bubbleId: string, qId: string, choice: string) {
    const b = this.s.bubbles.find((x) => x.id === bubbleId);
    if (!b) return;
    b.answers = { ...b.answers, [qId]: choice };
    this.commit();
  }

  select(id: string | null) {
    this.s.selected = id && this.s.processes.some((p) => p.upid === id && p.state !== "dead") ? id : null;
    this.commit();
  }
  prompt(id: string, text: string) {
    const p = this.s.processes.find((x) => x.upid === id);
    if (!p || p.state === "dead") return;
    p.log.push({ role: "you", text, ts: now() });
    p.inbox++;
    if (p.state === "planning") p.state = "active";
    this.commit();
  }
  pause(id: string) {
    const p = this.s.processes.find((x) => x.upid === id);
    if (p && p.state !== "dead") p.state = p.state === "paused" ? "active" : "paused";
    this.commit();
  }
  fork(id: string, silent = false) {
    const parent = this.s.processes.find((x) => x.upid === id);
    if (!parent) return;
    const child = this.spawnProcess(`${parent.title} (fork)`, parent.visualizer, "planning", parent.upid, true);
    if (!silent) {
      this.s.selected = child.upid;
      this.commit();
    }
  }
  kill(id: string) {
    const p = this.s.processes.find((x) => x.upid === id);
    if (!p) return;
    p.state = "dead";
    p.endedAt = now();
    p.inbox = 0;
    if (this.s.selected === id) this.s.selected = null;
    this.commit();
  }
  setConfig(patch: Partial<WorldConfig>) {
    this.s.config = { ...this.s.config, ...patch };
    this.commit();
  }
  toggleSim() {
    this.s.paused = !this.s.paused;
    this.commit();
  }
  setViewMode(m: WorldState["viewMode"]) {
    this.s.viewMode = m;
    this.s.graftFrom = null;
    this.commit();
  }

  // ── Grove: "move ideas to different branches" = re-graft (re-parent) ──
  beginGraft(id: string) {
    this.s.graftFrom = id;
    this.commit();
  }
  cancelGraft() {
    this.s.graftFrom = null;
    this.commit();
  }
  /** Click a node: in graft mode it re-parents the held node; otherwise selects. */
  nodeClick(id: string) {
    const g = this.s.graftFrom;
    if (g && g !== id) {
      this.regraft(g, id);
      return;
    }
    if (g === id) {
      this.s.graftFrom = null; // clicked self → cancel
      this.commit();
      return;
    }
    this.select(id);
  }
  private isDescendant(node: string, maybeAncestor: string): boolean {
    let cur: string | undefined = node;
    const byId = new Map(this.s.processes.map((p) => [p.upid, p]));
    while (cur) {
      if (cur === maybeAncestor) return true;
      cur = byId.get(cur)?.parentId;
    }
    return false;
  }
  regraft(childId: string, newParentId: string) {
    const child = this.s.processes.find((p) => p.upid === childId);
    const parent = this.s.processes.find((p) => p.upid === newParentId);
    this.s.graftFrom = null;
    if (!child || !parent || child.state === "dead" || parent.state === "dead") return this.commit();
    // never create a cycle: new parent can't be a descendant of the child
    if (this.isDescendant(newParentId, childId)) return this.commit();
    child.parentId = newParentId;
    child.dependsOn = [newParentId];
    child.bornAt = now(); // the branch re-grows from its new fork point
    this.s.selected = childId;
    this.commit();
  }

  elapsedDays() {
    return Math.floor((now() - this.startedAt) / 60_000) + 1;
  }
}

function autonomousNote(p: WorldProcess): string {
  const notes = [
    "ran tests · green",
    "pre-hook: resource check ok",
    "post-hook: logged + cleaned",
    "fetched context",
    "compiled draft",
    "idle tick",
  ];
  return `${pick(notes)} (${p.visualizer})`;
}

export const engine = new Engine();

export function useWorld(): WorldState {
  return useSyncExternalStore(engine.subscribe, engine.getSnapshot);
}
