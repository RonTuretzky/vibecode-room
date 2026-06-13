import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto("http://localhost:5273/", { waitUntil: "load" });
await page.waitForTimeout(3000);

const styles = await page.evaluate(() => {
  const canvas = document.querySelector("canvas");
  const container = canvas?.parentElement;
  const grab = (el, name) => {
    if (!el) return `${name}: null`;
    const s = getComputedStyle(el);
    return `${name} <${el.tagName}.${(el.className || "").toString().slice(0, 20)}>: pos=${s.position} z=${s.zIndex} transform=${s.transform} mixBlend=${s.mixBlendMode} isolation=${s.isolation} opacity=${s.opacity}`;
  };
  return [grab(canvas, "canvas"), grab(container, "container"), grab(container?.parentElement, "container.parent"), grab(document.querySelector(".ui-layer"), "ui-layer")].join("\n");
});
console.log("=== STYLES ===\n" + styles);

// Hide the canvas container → does the UI appear?
await page.evaluate(() => {
  const c = document.querySelector("canvas")?.parentElement;
  if (c) c.style.display = "none";
});
await page.waitForTimeout(400);
await page.screenshot({ path: "/tmp/no-canvas.png" });
console.log("saved /tmp/no-canvas.png");
await browser.close();
