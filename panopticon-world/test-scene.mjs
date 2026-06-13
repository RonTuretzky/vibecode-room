import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto("http://localhost:5273/", { waitUntil: "load" });

const grab = async (name) => {
  const dataUrl = await page.evaluate(() => {
    const c = document.querySelector("canvas");
    const off = document.createElement("canvas");
    off.width = 1280;
    off.height = 800;
    const ctx = off.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(c, 0, 0, 1280, 800);
    return off.toDataURL("image/png");
  });
  writeFileSync(`/tmp/${name}.png`, Buffer.from(dataUrl.split(",")[1], "base64"));
  console.log("saved", name);
};

await page.waitForTimeout(4500);
await grab("scene-village");

await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Grove"))?.click());
await page.waitForTimeout(3000);
await grab("scene-grove");

await browser.close();
