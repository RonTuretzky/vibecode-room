// THE LOOP'S HANDS. self-verify.ts is the loop's eyes (screenshots) — but a
// screenshot cannot tell a reachable control from a decorative one: three
// self-runs "fixed the scroll" with overflow-y CSS that no wall input can
// drive, and every one gated green because the list LOOKED right. This probe
// answers the question screenshots can't: can the wall's dwell cursor actually
// REACH every one of these targets?
//
// A target is REACHABLE when its center sits inside the viewport AND
// document.elementsFromPoint(center) resolves to it (or a node inside it) —
// i.e. it is not scrolled out of an overflow box, clipped, occluded by other
// chrome, or rendered off-wall. That is exactly the contract the dwell
// selector needs (it targets by projected rects and confirms by hit-test).
//
// Usage (against the LIVE server, like self-verify):
//   bun scripts/self-exercise.ts --selector '[data-testid="tree-menu-version"]'
//       [--select <callsignOrUpid>]   open that tree's menu first (window hook)
//       [--open-deck <callsignOrUpid>] open that process's DECK window first
//                                     (probes the decision bar:
//                                     --selector '[data-testid="deck-decision"] button' --min 3)
//       [--path "/?wall=A&flat=1"]    wall URL (default desk wall A)
//       [--min 1]                     fail if fewer than N targets exist
//   Exit 0 = every matched target reachable; exit 1 = any unreachable/missing,
//   with a per-target report and a screenshot for the run's summary.
import { chromium } from "playwright";

function argOf(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1]! : fallback;
}

const selector = argOf("--select" + "or", "");
if (selector.length === 0) {
  console.error("[self-exercise] --selector is required (a CSS selector for the dwell targets to check)");
  process.exit(2);
}
const pagePath = argOf("--path", "/?wall=A&flat=1");
const base = argOf("--base", "http://127.0.0.1:8788");
const selectTarget = argOf("--select", "");
const minTargets = Number(argOf("--min", "1"));
const shot = argOf("--out", "/tmp/self-exercise.png");

const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(`${base}${pagePath}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => (window as { __VIBERSYN__?: { ready?: boolean } }).__VIBERSYN__?.ready === true, undefined, { timeout: 15_000 }).catch(() => undefined);
await page.waitForTimeout(4_000);

if (selectTarget.length > 0) {
  await page.evaluate((id) => (window as unknown as { __VIBERSYN__?: { select?: (id: string) => void } }).__VIBERSYN__?.select?.(id), selectTarget);
  await page.waitForTimeout(1_500);
}

const openDeckTarget = argOf("--open-deck", "");
if (openDeckTarget.length > 0) {
  await page.evaluate(
    (id) => (window as unknown as { __VIBERSYN__?: { openDeck?: (id: string) => void } }).__VIBERSYN__?.openDeck?.(id),
    openDeckTarget,
  );
  await page.waitForTimeout(1_500);
}

const report = await page.evaluate((sel) => {
  const rows: Array<{ index: number; text: string; reachable: boolean; why: string }> = [];
  const nodes = Array.from(document.querySelectorAll(sel));
  nodes.forEach((node, index) => {
    const rect = node.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const text = ((node as HTMLElement).innerText ?? "").slice(0, 60).replace(/\s+/gu, " ");
    if (rect.width < 2 || rect.height < 2) {
      rows.push({ index, text, reachable: false, why: `zero-size rect ${Math.round(rect.width)}x${Math.round(rect.height)}` });
      return;
    }
    if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) {
      rows.push({ index, text, reachable: false, why: `center off-viewport at ${Math.round(cx)},${Math.round(cy)}` });
      return;
    }
    const stack = document.elementsFromPoint(cx, cy);
    const hit = stack.some((el) => el === node || node.contains(el) || el.contains(node));
    rows.push({
      index,
      text,
      reachable: hit,
      why: hit ? "ok" : `hit-test at ${Math.round(cx)},${Math.round(cy)} lands on <${(stack[0]?.tagName ?? "nothing").toLowerCase()}> — clipped, scrolled out, or occluded`,
    });
  });
  return rows;
}, selector);

await page.screenshot({ path: shot });
await browser.close();

const unreachable = report.filter((row) => !row.reachable);
for (const row of report) {
  console.log(`[self-exercise] ${row.reachable ? "REACHABLE " : "UNREACHABLE"} #${row.index} "${row.text}" — ${row.why}`);
}
console.log(`[self-exercise] ${report.length} matched, ${unreachable.length} unreachable — screenshot: ${shot}`);
if (report.length < minTargets) {
  console.error(`[self-exercise] FAIL: expected at least ${minTargets} target(s), found ${report.length} — the surface never rendered.`);
  process.exit(1);
}
if (unreachable.length > 0) {
  console.error("[self-exercise] FAIL: a target the dwell cursor cannot reach is not shipped. CSS scrolling is not reachability on this wall — paginate instead.");
  process.exit(1);
}
console.log("[self-exercise] PASS: every target is dwell-reachable.");
