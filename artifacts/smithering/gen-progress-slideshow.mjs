// Generates a self-contained HTML slideshow of Panopticon build progress:
// what's built vs not (per feature area, from landed tickets) + embedded UI captures.
// Run: node artifacts/smithering/gen-progress-slideshow.mjs
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const BASELINE = "8e67319"; // lean integration baseline; commits past it = landed work
const OUT = resolve(ROOT, "artifacts/smithering/progress.html");
const CAPTURES_DIR = resolve(ROOT, "artifacts/smithering/ui-captures");

function sh(cmd) { try { return execSync(cmd, { cwd: ROOT, encoding: "utf8" }).trim(); } catch { return ""; } }

const raw = JSON.parse(readFileSync(resolve(ROOT, "artifacts/smithering/tickets.json"), "utf8"));
const tickets = Array.isArray(raw) ? raw : (raw.tickets || []);

// Landed = the ticket id appears in a commit subject on integration past the baseline.
const landedLog = sh(`git log --oneline ${BASELINE}..smithering/integration 2>/dev/null`);
const landedIds = new Set(
  tickets.map((t) => t.id).filter((id) => landedLog.includes(id)),
);
// In-flight = a live worktree exists for it.
let inflight = new Set();
try {
  const wt = sh(`.smithers/node_modules/@smithers-orchestrator/jj-darwin-arm64/bin/jj workspace list 2>/dev/null`);
  inflight = new Set(tickets.map((t) => t.id).filter((id) => wt.includes(id) && !landedIds.has(id)));
} catch {}

// Feature-area grouping (keyword heuristic over id+title).
const AREAS = [
  ["Foundation & spine", /skeleton|shared-types|record-replay|provider-interface|canonical-spine|no-screen/],
  ["Validation probes (real third-party APIs)", /^probe-|probe-suite/],
  ["Voice I/O pipeline (STT → LLM → TTS)", /audio-capture|asr|tts|earcon|output-policy/],
  ["Cue layer (policies, seam, routing)", /cue-|seam|routing-dispatch|intent-gate/],
  ["Magic-word selection & steering", /callsign|collision|steering-window/],
  ["Suggestion engine (idea bubbles)", /suggestion|acceptance-spawn/],
  ["Process Manager & fleet", /process-registry|fleet-|emergency-stop/],
  ["Safety & consent", /shell-command|safety-execution|mute-controller|consent|credentials-redaction/],
  ["Observability & display board", /observability|trace|board|latency-benchmark/],
];
function areaOf(t) {
  const k = (t.id + " " + (t.title || "")).toLowerCase();
  for (const [name, re] of AREAS) if (re.test(k)) return name;
  return "Other";
}
const byArea = new Map();
for (const t of tickets) {
  const a = areaOf(t);
  if (!byArea.has(a)) byArea.set(a, []);
  byArea.get(a).push(t);
}
const order = AREAS.map(([n]) => n).concat("Other");

const statusOf = (id) => landedIds.has(id) ? "built" : inflight.has(id) ? "inflight" : "todo";
const badge = { built: "✅ built", inflight: "🔨 building", todo: "⬜ not yet" };

const total = tickets.length;
const builtN = landedIds.size;
const pct = total ? Math.round((builtN / total) * 100) : 0;
const now = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
const VERSION = String(Date.now()); // bumped every regen; the page polls this and reloads only on change

// UI captures (png/gif/jpg) embedded if present.
let captures = [];
if (existsSync(CAPTURES_DIR)) {
  captures = readdirSync(CAPTURES_DIR)
    .filter((f) => /\.(png|gif|jpe?g|webp)$/i.test(f))
    .sort();
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function areaSlide(area) {
  const ts = (byArea.get(area) || []).slice().sort((a, b) => statusRank(a.id) - statusRank(b.id));
  if (ts.length === 0) return "";
  const rows = ts.map((t) => {
    const st = statusOf(t.id);
    return `<li class="t ${st}"><span class="b">${badge[st]}</span><span class="ti">${esc(t.title || t.id)}</span>
      <span class="exp">${esc((t.instructions || "").split(/[.\n]/)[0] || t.id).slice(0, 160)}</span></li>`;
  }).join("");
  const a = ts.filter((t) => statusOf(t.id) === "built").length;
  return `<section class="slide"><h2>${esc(area)} <span class="cnt">${a}/${ts.length}</span></h2><ul class="tickets">${rows}</ul></section>`;
}
function statusRank(id) { const s = statusOf(id); return s === "built" ? 0 : s === "inflight" ? 1 : 2; }

const captureSlides = captures.length
  ? captures.map((f) => `<section class="slide cap"><h2>UI — ${esc(f.replace(/\.[^.]+$/, ""))}</h2>
      <img src="ui-captures/${esc(f)}" alt="${esc(f)}"/></section>`).join("")
  : `<section class="slide"><h2>UI captures</h2><p class="muted">The product is voice-only; the screen is an output-only display board (React/Vite).
     It isn't runnable yet — these slides will fill with live screenshots & GIFs of the board, idea-bubbles, "you are steering X" banner,
     and the living-garden process view as the frontend tickets land.</p></section>`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Panopticon — Build Progress</title>
<style>
:root{--bg:#0b0b0f;--card:#16161c;--bd:#26262e;--tx:#eaeaf0;--mut:#8a8a96;--ok:#4ade80;--wk:#fbbf24;--td:#3a3a44;--ac:#7c83ff;color-scheme:dark}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.55 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif}
.deck{max-width:1000px;margin:0 auto;padding:32px 20px 80px}
.slide{background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:26px 30px;margin:0 0 22px;scroll-margin-top:20px}
h1{font-size:30px;margin:0 0 6px}h2{font-size:20px;margin:0 0 16px;display:flex;align-items:center;gap:10px}
.cnt{font-size:13px;color:var(--mut);font-weight:500}
.sub{color:var(--mut);margin:0 0 18px}
.bar{height:14px;background:var(--td);border-radius:8px;overflow:hidden;margin:14px 0}
.bar>i{display:block;height:100%;width:${pct}%;background:linear-gradient(90deg,var(--ac),var(--ok))}
.big{font-size:46px;font-weight:700}.muted{color:var(--mut)}
.tickets{list-style:none;margin:0;padding:0}
.t{display:grid;grid-template-columns:96px 1fr;gap:4px 12px;padding:10px 0;border-bottom:1px solid var(--bd)}
.t:last-child{border-bottom:0}.t .b{font-size:12px;font-weight:600;grid-row:span 2}
.t.built .b{color:var(--ok)}.t.inflight .b{color:var(--wk)}.t.todo .b{color:var(--mut)}
.t .ti{font-weight:600}.t .exp{grid-column:2;color:var(--mut);font-size:13px}
.cap img{width:100%;border:1px solid var(--bd);border-radius:8px}
.legend{display:flex;gap:16px;color:var(--mut);font-size:13px;margin-top:8px}
a.nav{color:var(--ac);text-decoration:none;font-size:13px;margin-right:14px}
</style></head><body><div class="deck">
<section class="slide">
  <h1>Panopticon — Build Progress</h1>
  <p class="sub">Voice-only / Cue-powered OS for AI-agent work. Smithered from PROMPT.md · generated ${now}</p>
  <div class="big">${builtN}<span class="muted" style="font-size:20px"> / ${total} tickets built (${pct}%)</span></div>
  <div class="bar"><i></i></div>
  <div class="legend"><span>✅ built (landed on integration)</span><span>🔨 building now</span><span>⬜ not yet</span></div>
  <p class="muted" style="margin-top:14px">${builtN === 0
    ? "Foundation is being established (orchestration spine + shared contracts). Feature areas below fill in as tickets land in parallel waves."
    : "What is functional vs pending, by feature area, is below; UI captures appear once the display board is runnable."}</p>
</section>
${order.map(areaSlide).join("")}
${captureSlides}
</div>
<script>
const V=${JSON.stringify(VERSION)};
async function check(){try{const r=await fetch('progress.version?'+Date.now(),{cache:'no-store'});if(r.ok){const v=(await r.text()).trim();if(v&&v!==V){location.reload();}}}catch(e){}}
setInterval(check,6000);
</script>
</body></html>`;

writeFileSync(OUT, html);
writeFileSync(resolve(ROOT, "artifacts/smithering/progress.version"), VERSION);
console.log(`progress slideshow -> ${OUT} (${builtN}/${total} built, ${captures.length} UI captures)`);
