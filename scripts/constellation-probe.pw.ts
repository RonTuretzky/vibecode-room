// One-shot visual probe for the constellation ceiling (demo snapshot):
// asserts the dataset stamps + draw budget and saves a screenshot.
import { chromium } from "@playwright/test";

const url = process.env.PROBE_URL ?? "http://127.0.0.1:8991/?live=0&research=1&zen=1";
const out = process.env.PROBE_OUT ?? "/tmp/constellations/constellation-demo.png";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto(url);
await page.waitForFunction(() => Boolean((window as any).__VIBERSYN__?.ready), null, { timeout: 20_000 });
await page.waitForTimeout(3_500); // let the sky mount + the 1s stamps tick
const stamps = await page.evaluate(() => {
  const container = document.querySelector("[data-draw-calls]") as HTMLElement | null;
  const d = container?.dataset ?? {};
  return {
    skyConstellations: d.skyConstellations,
    skyStars: d.skyStars,
    skyDust: d.skyDust,
    skyPlanets: d.skyPlanets,
    drawCalls: d.drawCalls,
    labeledClouds: d.labeledClouds,
    cloudCount: d.cloudCount,
    wispCount: d.wispCount,
  };
});
console.log("stamps:", JSON.stringify(stamps));
await page.screenshot({ path: out });
await browser.close();
if (Number(stamps.drawCalls) > 20) {
  console.error(`DRAW BUDGET BLOWN: ${stamps.drawCalls} > 20`);
  process.exit(1);
}
if (Number(stamps.skyConstellations ?? 0) < 3) {
  console.error("expected ≥3 constellations in the demo snapshot");
  process.exit(1);
}
console.log("probe ok →", out);
