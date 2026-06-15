// Generates a self-contained HTML slideshow of Panopticon build progress:
// landed tickets from integration, active builds from Smithers worktrees,
// and any UI captures dropped into artifacts/smithering/ui-captures.
// Run: node artifacts/smithering/gen-progress-slideshow.mjs
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { basename, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const BASELINE = "8e67319";
const OUT = resolve(ROOT, "artifacts/smithering/progress.html");
const VERSION_OUT = resolve(ROOT, "artifacts/smithering/progress.version");
const TICKETS_FILE = resolve(ROOT, "artifacts/smithering/tickets.json");
const CAPTURES_DIR = resolve(ROOT, "artifacts/smithering/ui-captures");
const WT_DIR = resolve(ROOT, ".smithers/workflows/.smithers/wt");

function sh(cmd) {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function html(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function firstSentence(t) {
  return String(t || "")
    .replace(/\s+/g, " ")
    .split(/[.\n]/)[0]
    .slice(0, 170);
}

const raw = JSON.parse(readFileSync(TICKETS_FILE, "utf8"));
const tickets = Array.isArray(raw) ? raw : raw.tickets || [];
const ticketIds = new Set(tickets.map((t) => t.id));

const landedLog = sh(`git log --oneline ${BASELINE}..smithering/integration 2>/dev/null`);
const landedIds = new Set(tickets.map((t) => t.id).filter((id) => landedLog.includes(id)));

const worktreeIds = existsSync(WT_DIR)
  ? readdirSync(WT_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => basename(entry.name))
      .filter((id) => ticketIds.has(id))
  : [];
const buildingIds = new Set(worktreeIds.filter((id) => !landedIds.has(id)));

const AREAS = [
  ["Foundation & spine", /skeleton|shared-types|record-replay|provider-interface|canonical-spine|no-screen/],
  ["Validation probes", /^probe-|probe-suite/],
  ["Voice I/O pipeline", /audio-capture|asr|tts|earcon|output-policy/],
  ["Cue layer", /cue-|seam|routing-dispatch|intent-gate/],
  ["Magic-word steering", /callsign|collision|steering-window/],
  ["Suggestion engine", /suggestion|acceptance-spawn/],
  ["Process Manager & fleet", /process-registry|fleet-|emergency-stop/],
  ["Safety & consent", /shell-command|safety-execution|mute-controller|consent|credentials-redaction/],
  ["Observability & display board", /observability|trace|board|latency-benchmark/],
];

function areaOf(t) {
  const key = `${t.id} ${t.title || ""}`.toLowerCase();
  for (const [name, re] of AREAS) {
    if (re.test(key)) return name;
  }
  return "Other";
}

function statusOf(id) {
  if (landedIds.has(id)) return "landed";
  if (buildingIds.has(id)) return "building";
  return "not-started";
}

function statusRank(id) {
  const s = statusOf(id);
  return s === "landed" ? 0 : s === "building" ? 1 : 2;
}

function statusLabel(s) {
  return s === "landed" ? "LANDED" : s === "building" ? "BUILDING" : "NOT STARTED";
}

const byArea = new Map();
for (const ticket of tickets) {
  const area = areaOf(ticket);
  if (!byArea.has(area)) byArea.set(area, []);
  byArea.get(area).push(ticket);
}

const order = AREAS.map(([name]) => name).concat("Other");
const total = tickets.length;
const landedN = landedIds.size;
const buildingN = buildingIds.size;
const todoN = Math.max(0, total - landedN - buildingN);
const pct = total ? Math.round((landedN / total) * 100) : 0;
const now = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
const version = String(Date.now());

const captures = existsSync(CAPTURES_DIR)
  ? readdirSync(CAPTURES_DIR)
      .filter((f) => /\.(png|gif|jpe?g|webp)$/i.test(f))
      .sort((a, b) => a.localeCompare(b))
  : [];

function ticketRows(areaTickets) {
  return areaTickets
    .slice()
    .sort((a, b) => statusRank(a.id) - statusRank(b.id) || a.id.localeCompare(b.id))
    .map((ticket) => {
      const status = statusOf(ticket.id);
      return `<li class="ticket ${status}">
        <span class="status">${statusLabel(status)}</span>
        <span class="title">${html(ticket.title || ticket.id)}</span>
        <span class="id">${html(ticket.id)}</span>
        <span class="note">${html(firstSentence(ticket.instructions || ticket.summary || ticket.id))}</span>
      </li>`;
    })
    .join("");
}

function countFor(areaTickets, status) {
  return areaTickets.filter((ticket) => statusOf(ticket.id) === status).length;
}

const buildingList = tickets
  .filter((ticket) => buildingIds.has(ticket.id))
  .sort((a, b) => a.id.localeCompare(b.id))
  .map((ticket) => `<li><strong>${html(ticket.id)}</strong><span>${html(ticket.title || ticket.id)}</span></li>`)
  .join("");

const slides = [];
slides.push(`<section class="slide is-active" data-slide="summary" data-landed="${landedN}" data-building="${buildingN}" data-todo="${todoN}">
  <div class="kicker">Live build run impl-build-17</div>
  <h1>Panopticon Build Progress</h1>
  <p class="lede">Current state from <code>git log ${BASELINE}..smithering/integration</code> and live Smithers worktrees.</p>
  <div class="metrics">
    <div><span>${landedN}</span><small>Landed</small></div>
    <div><span>${buildingN}</span><small>Building</small></div>
    <div><span>${todoN}</span><small>Not started</small></div>
    <div><span>${pct}%</span><small>Integrated</small></div>
  </div>
  <div class="meter"><i style="width:${pct}%"></i></div>
  <div class="building-now">
    <h2>Building now</h2>
    <ul>${buildingList || "<li><strong>None detected</strong><span>No active matching worktree is present.</span></li>"}</ul>
  </div>
</section>`);

for (const area of order) {
  const areaTickets = byArea.get(area) || [];
  if (areaTickets.length === 0) continue;
  slides.push(`<section class="slide" data-slide="${html(area)}">
    <div class="kicker">Feature area</div>
    <h1>${html(area)}</h1>
    <div class="area-stats">
      <span class="landed">${countFor(areaTickets, "landed")} landed</span>
      <span class="building">${countFor(areaTickets, "building")} building</span>
      <span>${countFor(areaTickets, "not-started")} not started</span>
    </div>
    <ul class="tickets">${ticketRows(areaTickets)}</ul>
  </section>`);
}

if (captures.length > 0) {
  for (const file of captures) {
    const src = encodeURI(`ui-captures/${file}`).replace(/#/g, "%23");
    slides.push(`<section class="slide capture" data-slide="${html(file)}">
      <div class="kicker">UI capture</div>
      <h1>${html(file.replace(/\.[^.]+$/, ""))}</h1>
      <figure><img src="${html(src)}" alt="${html(file)}"></figure>
    </section>`);
  }
} else {
  slides.push(`<section class="slide capture-placeholder" data-slide="ui-captures">
    <div class="kicker">UI captures</div>
    <h1>Images and GIFs appear here automatically</h1>
    <div class="placeholder-grid">
      <div><span>Display board</span></div>
      <div><span>Idea bubbles</span></div>
      <div><span>Steering banner</span></div>
    </div>
    <p class="lede">Drop .png, .jpg, .webp, or .gif files into <code>artifacts/smithering/ui-captures/</code>, regenerate, and they become slides.</p>
  </section>`);
}

const dots = slides
  .map((_, i) => `<button class="dot${i === 0 ? " is-active" : ""}" type="button" data-go="${i}" aria-label="Go to slide ${i + 1}"></button>`)
  .join("");

const htmlOut = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Panopticon - Build Progress</title>
<style>
:root{--bg:#09090b;--panel:#151518;--panel2:#1d1d21;--line:#303035;--text:#f2f2f4;--muted:#a1a1aa;--landed:#40d982;--building:#f5b84b;--todo:#858593;--accent:#8b7cf6;--rose:#fb7185;--cyan:#38bdf8;color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:radial-gradient(circle at 20% 0%,rgba(139,124,246,.18),transparent 30%),var(--bg);color:var(--text);font:15px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif}
button{font:inherit}
.app{min-height:100%;display:grid;grid-template-rows:auto 1fr auto}
.top{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid var(--line);background:rgba(9,9,11,.86);backdrop-filter:blur(12px)}
.brand{font-weight:700}.stamp{color:var(--muted);font-size:12px}.spacer{flex:1}
.chip{border:1px solid var(--line);background:var(--panel);border-radius:6px;padding:4px 8px;font-size:12px;color:var(--muted)}
.chip strong{color:var(--text)}
.stage{min-height:0;display:grid;place-items:center;padding:22px}
.slide{display:none;width:min(1120px,100%);min-height:min(650px,calc(100vh - 142px));background:linear-gradient(180deg,var(--panel),#101012);border:1px solid var(--line);border-radius:8px;padding:34px;box-shadow:0 24px 70px rgba(0,0,0,.36)}
.slide.is-active{display:block}
.kicker{color:var(--cyan);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px}
h1{font-size:34px;line-height:1.08;margin:0 0 12px;letter-spacing:0}
h2{font-size:16px;margin:0 0 10px}
.lede{color:var(--muted);max-width:780px;margin:0 0 22px}
code{background:#0c0c0f;border:1px solid var(--line);border-radius:5px;padding:1px 5px;color:#d8d8df}
.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:26px 0 18px}
.metrics div{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:18px}
.metrics span{display:block;font-size:42px;font-weight:800;line-height:1}.metrics small{display:block;color:var(--muted);margin-top:6px}
.meter{height:12px;background:#2a2a31;border-radius:999px;overflow:hidden}.meter i{display:block;height:100%;background:linear-gradient(90deg,var(--accent),var(--landed))}
.building-now{margin-top:24px}.building-now ul{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:0;padding:0;list-style:none}
.building-now li{border:1px solid rgba(245,184,75,.35);background:rgba(245,184,75,.09);border-radius:8px;padding:10px 12px}
.building-now strong{display:block;color:var(--building);font-size:13px}.building-now span{display:block;color:var(--muted);font-size:12px;margin-top:2px}
.area-stats{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 18px}.area-stats span{border:1px solid var(--line);border-radius:999px;padding:5px 10px;color:var(--muted);font-size:12px}.area-stats .landed{color:var(--landed)}.area-stats .building{color:var(--building)}
.tickets{list-style:none;margin:0;padding:0;display:grid;gap:8px;max-height:470px;overflow:auto;padding-right:4px}
.ticket{display:grid;grid-template-columns:112px 1fr auto;gap:2px 12px;align-items:start;border:1px solid var(--line);background:rgba(255,255,255,.025);border-radius:8px;padding:10px 12px}
.ticket .status{font-size:11px;font-weight:800}.ticket.landed .status{color:var(--landed)}.ticket.building .status{color:var(--building)}.ticket.not-started .status{color:var(--todo)}
.ticket .title{font-weight:650}.ticket .id{color:var(--muted);font-size:12px}.ticket .note{grid-column:2/4;color:var(--muted);font-size:12px}
.capture figure{margin:18px 0 0}.capture img{display:block;width:100%;max-height:520px;object-fit:contain;border:1px solid var(--line);border-radius:8px;background:#050506}
.placeholder-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:26px 0}
.placeholder-grid div{height:210px;border:1px dashed #4b4b55;border-radius:8px;background:linear-gradient(135deg,#17171b,#111114);display:grid;place-items:center;color:var(--muted);font-weight:700}
.controls{display:flex;align-items:center;gap:10px;padding:12px 18px;border-top:1px solid var(--line);background:rgba(9,9,11,.88)}
.nav{height:34px;border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:6px;padding:0 12px;cursor:pointer}
.nav:hover{border-color:var(--accent)}
.dots{display:flex;gap:6px;align-items:center;overflow:auto;max-width:48vw;padding:3px 0}.dot{width:9px;height:9px;border:0;border-radius:999px;background:#4b4b55;cursor:pointer;flex:0 0 auto}.dot.is-active{background:var(--accent);width:24px}
.counter{color:var(--muted);font-size:12px;margin-left:auto}
@media (max-width:760px){.top{flex-wrap:wrap}.stage{padding:12px}.slide{min-height:calc(100vh - 176px);padding:22px}h1{font-size:27px}.metrics,.building-now ul,.placeholder-grid{grid-template-columns:1fr}.ticket{grid-template-columns:1fr}.ticket .note{grid-column:1}.dots{max-width:34vw}}
</style>
</head>
<body>
<div class="app" data-testid="progress-slideshow" data-version="${html(version)}">
  <header class="top">
    <div class="brand">Panopticon Progress</div>
    <div class="stamp">Generated ${html(now)}</div>
    <div class="spacer"></div>
    <div class="chip"><strong>${landedN}</strong> landed</div>
    <div class="chip"><strong>${buildingN}</strong> building</div>
    <div class="chip"><strong>${todoN}</strong> not started</div>
  </header>
  <main class="stage">
    ${slides.join("\n")}
  </main>
  <footer class="controls">
    <button class="nav" type="button" data-prev>Prev</button>
    <button class="nav" type="button" data-next>Next</button>
    <button class="nav" type="button" data-auto>Auto on</button>
    <div class="dots">${dots}</div>
    <div class="counter"><span data-current>1</span> / ${slides.length}</div>
  </footer>
</div>
<script>
const PAGE_VERSION = ${JSON.stringify(version)};
const slides = [...document.querySelectorAll(".slide")];
const dots = [...document.querySelectorAll(".dot")];
let index = 0;
let auto = true;
let timer = null;
function show(next) {
  index = (next + slides.length) % slides.length;
  slides.forEach((slide, i) => slide.classList.toggle("is-active", i === index));
  dots.forEach((dot, i) => dot.classList.toggle("is-active", i === index));
  document.querySelector("[data-current]").textContent = String(index + 1);
}
function schedule() {
  clearInterval(timer);
  timer = auto ? setInterval(() => show(index + 1), 12000) : null;
}
document.querySelector("[data-prev]").addEventListener("click", () => show(index - 1));
document.querySelector("[data-next]").addEventListener("click", () => show(index + 1));
document.querySelector("[data-auto]").addEventListener("click", (event) => {
  auto = !auto;
  event.currentTarget.textContent = auto ? "Auto on" : "Auto off";
  schedule();
});
dots.forEach((dot) => dot.addEventListener("click", () => show(Number(dot.dataset.go))));
document.addEventListener("keydown", (event) => {
  if (event.key === "ArrowRight" || event.key === "PageDown") show(index + 1);
  if (event.key === "ArrowLeft" || event.key === "PageUp") show(index - 1);
});
async function checkVersion() {
  try {
    const response = await fetch("progress.version?" + Date.now(), { cache: "no-store" });
    if (!response.ok) return;
    const nextVersion = (await response.text()).trim();
    if (nextVersion && nextVersion !== PAGE_VERSION) location.reload();
  } catch {}
}
setInterval(checkVersion, 6000);
schedule();
</script>
</body>
</html>`;

writeFileSync(OUT, htmlOut);
writeFileSync(VERSION_OUT, version);
console.log(`progress slideshow -> ${OUT} (${landedN}/${total} landed, ${buildingN} building, ${captures.length} UI captures)`);
