import { chromium } from "playwright";

// Headed = real GPU path (matches the user's machine, unlike headless SwiftShader).
const browser = await chromium.launch({ headless: false });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

page.on("pageerror", (e) => console.log(`[PAGEERROR] ${e.message}`));
page.on("crash", () => console.log(`[PAGE CRASH]`));
page.on("console", (m) => {
  const t = m.text();
  if (/context|lost|memory|THREE|webgl|error/i.test(t)) console.log(`[console.${m.type()}] ${t.slice(0, 160)}`);
});

await page.goto("http://localhost:5273/", { waitUntil: "load" });
await page.waitForTimeout(800);
await page.evaluate(() => {
  window.__gl = { lost: false, at: 0 };
  const c = document.querySelector("canvas");
  c?.addEventListener("webglcontextlost", () => {
    window.__gl.lost = true;
    window.__gl.at = Math.round(performance.now());
  });
});

let lost = false;
for (let t = 2; t <= 30; t += 2) {
  await page.waitForTimeout(2000);
  const s = await page.evaluate(() => {
    const c = document.querySelector("canvas");
    const gl = c && (c.getContext("webgl2") || c.getContext("webgl"));
    return { root: document.getElementById("root")?.childElementCount, glLost: window.__gl?.lost, lostAt: window.__gl?.at, ctx: gl ? gl.isContextLost() : "no-gl" };
  });
  console.log(`t=${t}s root=${s.root} glLost=${s.glLost} ctxLost=${s.ctx} lostAt=${s.lostAt}ms`);
  if (s.glLost || s.ctx === true) {
    lost = true;
    await page.screenshot({ path: "/tmp/pw-headed-crash.png" });
    console.log("→ CONTEXT LOST — screenshot saved");
    break;
  }
}
if (!lost) {
  await page.screenshot({ path: "/tmp/pw-headed-ok.png" });
  console.log("→ no context loss in 30s; screenshot saved");
}
await browser.close();
