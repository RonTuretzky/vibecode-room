import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (e) => console.log(`[PAGEERROR] ${e.message}`));

await page.goto("http://localhost:5273/", { waitUntil: "load" });
await page.waitForTimeout(4000);

const probe = await page.evaluate(() => {
  const info = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return `${sel}: MISSING`;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return `${sel}: ${Math.round(r.width)}x${Math.round(r.height)} @(${Math.round(r.x)},${Math.round(
      r.y,
    )}) z=${s.zIndex} op=${s.opacity} vis=${s.visibility} disp=${s.display} bg=${s.backgroundColor} bgImg=${s.backgroundImage.slice(0, 30)}`;
  };
  const top = (x, y) => {
    const el = document.elementFromPoint(x, y);
    return el ? `${el.tagName}.${(el.className || "").toString().slice(0, 30)}` : "null";
  };
  return [
    info("canvas"),
    info(".ui-layer"),
    info(".hud"),
    info(".options"),
    info(".dialogue"),
    info(".legend"),
    info(".legend-inner"),
    "rootVar --panel: " + getComputedStyle(document.documentElement).getPropertyValue("--panel"),
    "bodyBg: " + getComputedStyle(document.body).backgroundColor,
    "elementFromPoint(40,40): " + top(40, 40),
    "elementFromPoint(640,400): " + top(640, 400),
    "elementFromPoint(1150,300): " + top(1150, 300),
    "elementFromPoint(640,760): " + top(640, 760),
    "stylesheets: " + document.styleSheets.length,
  ];
});
console.log(probe.join("\n"));
await browser.close();
