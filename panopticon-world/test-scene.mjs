import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

let pageErrors = 0;
page.on("pageerror", (e) => {
  pageErrors++;
  console.log(`[PAGEERROR @${Date.now()}] ${e.message}`);
});
page.on("crash", () => console.log(`[PAGE CRASH @${Date.now()}]`));
page.on("console", (m) => {
  const t = m.text();
  if (/context lost|webglcontextlost|lost context|out of memory|THREE/i.test(t)) console.log(`[console.${m.type()}] ${t}`);
});

await page.goto("http://localhost:5273/", { waitUntil: "load" });

// attach WebGL context-loss listeners to the canvas
await page.waitForTimeout(800);
await page.evaluate(() => {
  window.__gl = { lost: false, restored: false, at: 0 };
  const c = document.querySelector("canvas");
  if (c) {
    c.addEventListener("webglcontextlost", () => {
      window.__gl.lost = true;
      window.__gl.at = performance.now();
    });
    c.addEventListener("webglcontextrestored", () => (window.__gl.restored = true));
  }
});

for (let t = 2; t <= 24; t += 2) {
  await page.waitForTimeout(2000);
  const s = await page.evaluate(() => {
    const c = document.querySelector("canvas");
    const gl = c && (c.getContext("webgl2") || c.getContext("webgl"));
    return {
      root: document.getElementById("root")?.childElementCount,
      glLost: window.__gl?.lost,
      glLostAt: Math.round(window.__gl?.at || 0),
      ctxLostFlag: gl ? gl.isContextLost() : "no-gl",
      hud: !!document.querySelector(".hud"),
    };
  });
  console.log(
    `t=${t}s  root=${s.root} hud=${s.hud} glLost=${s.glLost} ctxLost=${s.ctxLostFlag} lostAt=${s.glLostAt}ms errs=${pageErrors}`,
  );
  if (s.glLost) {
    await page.screenshot({ path: "/tmp/pw-after-crash.png" });
    console.log("→ screenshot saved after context loss");
    break;
  }
}
await browser.close();
