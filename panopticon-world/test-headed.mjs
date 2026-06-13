import { chromium } from "playwright";

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
let errs = 0,
  crashed = false;
page.on("pageerror", (e) => (errs++, console.log(`[PAGEERROR] ${e.message}`)));
page.on("crash", () => ((crashed = true), console.log("[PAGE CRASH]")));

await page.goto("http://localhost:5273/", { waitUntil: "load" });
await page.waitForTimeout(800);
await page.evaluate(() => {
  window.__gl = false;
  document.querySelector("canvas")?.addEventListener("webglcontextlost", () => (window.__gl = true));
});

await page.waitForTimeout(5200);
await page.screenshot({ path: "/tmp/v6.png" });
const s6 = await page.evaluate(() => ({ glLost: window.__gl, root: document.getElementById("root")?.childElementCount }));
console.log("t=6s", JSON.stringify(s6), "errs=", errs, "crashed=", crashed);

await page.waitForTimeout(14000);
await page.screenshot({ path: "/tmp/v20.png" });
const s20 = await page.evaluate(() => ({ glLost: window.__gl, root: document.getElementById("root")?.childElementCount }));
console.log("t=20s", JSON.stringify(s20), "errs=", errs, "crashed=", crashed);

await browser.close();
