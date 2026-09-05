import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { chromium } from "playwright";

export interface LocalBrowserStep {
  action:
    | "click"
    | "fill"
    | "wait"
    | "reload"
    | "expectText"
    | "expectChecked"
    | "expectStyle";
  selector?: string;
  text?: string;
  checked?: boolean;
  property?: string;
  ms?: number;
}

/** A fresh browser context for generated apps, never the user's browser session. */
export async function checkLocalPreview(
  dir: string,
  signal: AbortSignal,
  steps: LocalBrowserStep[] = [],
): Promise<string> {
  if (steps.length > 12) throw new Error("Use at most 12 browser steps.");
  const root = await realpath(
    existsSync(resolve(dir, "dist/index.html")) ? resolve(dir, "dist") : dir,
  );
  if (!existsSync(resolve(root, "index.html")))
    throw new Error("No preview entrypoint. Build the project first.");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      try {
        const name = decodeURIComponent(new URL(request.url).pathname);
        if (name.split("/").some((part) => part.startsWith(".")))
          return new Response("Private path", { status: 403 });
        const file = await realpath(
          resolve(root, `.${name === "/" ? "/index.html" : name}`),
        );
        if (!file.startsWith(root + sep))
          return new Response("Outside preview", { status: 403 });
        return new Response(Bun.file(file));
      } catch {
        return new Response("Not found", { status: 404 });
      }
    },
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const stop = () => {
    void browser?.close().catch(() => {});
  };
  try {
    signal.throwIfAborted();
    browser = await chromium.launch({ headless: true, timeout: 15_000 });
    signal.addEventListener("abort", stop, { once: true });
    signal.throwIfAborted();
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
    });
    page.setDefaultTimeout(4000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}/`, {
      waitUntil: "load",
      timeout: 15_000,
    });
    for (const step of steps) {
      signal.throwIfAborted();
      const target = page.locator(step.selector || "body");
      if (step.action === "click") await target.click();
      else if (step.action === "fill") await target.fill(step.text ?? "");
      else if (step.action === "wait")
        await page.waitForTimeout(Math.min(3000, Math.max(0, step.ms ?? 100)));
      else if (step.action === "reload")
        await page.reload({ waitUntil: "load", timeout: 15_000 });
      else if (step.action === "expectText") {
        const text = await target.innerText();
        if (!text.includes(step.text ?? ""))
          throw new Error(
            `Expected ${step.selector} to contain ${JSON.stringify(step.text)}; got ${JSON.stringify(text.slice(0, 500))}`,
          );
      } else if (step.action === "expectChecked") {
        if ((await target.isChecked()) !== step.checked)
          throw new Error(`Unexpected checked state for ${step.selector}`);
      } else if (step.action === "expectStyle") {
        const actual = await target.evaluate(
          (element, property) =>
            getComputedStyle(element).getPropertyValue(property),
          step.property ?? "background-color",
        );
        if (actual.replace(/\s/g, "") !== (step.text ?? "").replace(/\s/g, ""))
          throw new Error(
            `Expected ${step.selector} ${step.property} to be ${step.text}; got ${actual}`,
          );
      } else throw new Error("Unsupported browser step");
    }
    await page.waitForTimeout(100);
    if (errors.length)
      throw new Error(
        `Browser JavaScript errors: ${errors.join("; ").slice(0, 3000)}`,
      );
    return JSON.stringify(
      await page.evaluate(() => ({
        title: document.title,
        text: document.body.innerText.slice(0, 6000),
        background: getComputedStyle(document.body).backgroundColor,
        color: getComputedStyle(document.body).color,
        controls: [
          ...document.querySelectorAll("button,input,select,textarea,a"),
        ]
          .slice(0, 60)
          .map((element) => ({
            tag: element.tagName,
            id: element.id,
            text: element.textContent?.slice(0, 100),
            label: element.getAttribute("aria-label"),
            type: element.getAttribute("type"),
            disabled: (element as HTMLInputElement).disabled,
            checked: (element as HTMLInputElement).checked,
          })),
      })),
    );
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new Error(
      `Local browser check: ${error instanceof Error ? error.message : String(error)}. If Chromium is missing, run bunx playwright install chromium.`,
    );
  } finally {
    signal.removeEventListener("abort", stop);
    await browser?.close().catch(() => {});
    server.stop(true);
  }
}
