// SELF-VERIFY — the self-rebuild loop's eyes.
//
//   bun scripts/self-verify.ts [--path "/?wall=A&flat=1"] [--wait 9000] [--out /tmp/…png]
//
// Screenshot the LIVE room server's wall page headless. Run this AFTER
// `bun run build`: the server serves dist/ from disk, so the freshly built
// working tree — YOUR uncommitted change included — is exactly what renders
// here, against the room's real state. The vibersyn-self agent MUST look at
// the output before committing a visual change: a change that does not appear
// is not on the executed path — tests passing is not enough (two self-runs
// committed green-but-invisible changes before this existed).
//
// Non-visual changes verify differently (curl the endpoint, run the surface's
// test and show its output); this script is for anything the walls show.

import { chromium } from "playwright";

function argOf(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index !== -1 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

const pagePath = argOf("--path", "/?wall=A&flat=1");
const waitMs = Number(argOf("--wait", "9000"));
const out = argOf("--out", `/tmp/self-verify-${Date.now().toString(36)}.png`);
const base = argOf("--base", "http://127.0.0.1:8788");

const health = await fetch(`${base}/api/health`).catch(() => null);
if (health === null || !health.ok) {
  console.error(`[self-verify] room server unreachable at ${base} — is it running?`);
  process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const pageErrors: string[] = [];
page.on("pageerror", (error) => pageErrors.push(String(error).slice(0, 300)));
await page.goto(`${base}${pagePath}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(waitMs);
await page.screenshot({ path: out });
await browser.close();

if (pageErrors.length > 0) {
  console.error(`[self-verify] PAGE ERRORS (your change may be crashing the wall):`);
  for (const line of pageErrors.slice(0, 5)) {
    console.error(`  ${line}`);
  }
}
console.log(`[self-verify] rendered ${pagePath} from the built working tree (dist/)`);
console.log(`[self-verify] screenshot: ${out}`);
console.log(`[self-verify] NOW READ THE SCREENSHOT and confirm your change is actually there.`);
process.exit(pageErrors.length > 0 ? 2 : 0);
