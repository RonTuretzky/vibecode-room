// Demo GIF capture harness — Playwright frames → ffmpeg palette GIFs.
//
//   bun scripts/capture-demo-gifs.ts [beat…]        (default: all beats)
//
// Frames are pulled from a HEADLESS wall window at 1920×1080 against the LIVE
// server (read-only walks — no decision/commission/dismiss presses), written
// to a temp dir at ~8 fps, then encoded with the two-pass palette pipeline so
// the garden's gradients don't band. Output: artifacts/demo-gifs/<beat>.gif
// (gitignored, survives server restarts — /tmp does not).
//
// Beats marked TODO(rehearsal) are finalized during the dress rehearsal once
// the holo panel / branch popups are live; the harness runs the ones it can.

import { chromium, type Page } from "playwright";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const BASE = process.env.VIBERSYN_BASE ?? "http://localhost:8788";
const OUT_DIR = join(import.meta.dir, "..", "artifacts", "demo-gifs");
const FPS = 8;

interface Beat {
  name: string;
  // Drives the page; call frame() whenever the visual state is worth a frame
  // (the walker owns pacing — hold a state by calling frame() repeatedly).
  walk: (page: Page, frame: () => Promise<void>) => Promise<void>;
}

async function hold(frame: () => Promise<void>, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await frame();
  }
}

const BEATS: Beat[] = [
  {
    // Beat 1: the garden breathing — establishing shot for the deck.
    name: "garden",
    walk: async (page, frame) => {
      await page.goto(`${BASE}/?wall=A&flat=1`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(6000);
      await hold(frame, FPS * 4);
    },
  },
  {
    // Beat 2: dwell a tree → the menu blooms beside it.
    name: "tree-menu",
    walk: async (page, frame) => {
      await page.goto(`${BASE}/?wall=A&flat=1&gesture=1`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(6000);
      await hold(frame, FPS);
      // Find any garden tree by probing likely slots; stop at the first menu.
      for (const [x, y] of [[1780, 480], [960, 500], [1400, 520], [600, 520], [1780, 640]]) {
        await page.mouse.click(x, y);
        await page.waitForTimeout(700);
        if ((await page.locator('[data-testid="tree-menu"]').count()) > 0) {
          break;
        }
      }
      await hold(frame, FPS * 3);
      const close = page.locator('[data-testid="tree-menu-close"]');
      if ((await close.count()) > 0) {
        await close.click();
      }
      await hold(frame, FPS);
    },
  },
  // TODO(rehearsal): "import" — QR submit → tree sprouts (needs a disposable
  // import; captured live during the dress rehearsal, not on every run).
  // TODO(rehearsal): "holo-panel" — Live app ▸ → panel bloom (needs /salem sid).
  // TODO(rehearsal): "branch-pr" — grow branch → record steer → Open PR ▸.
  // TODO(rehearsal): "issue-fruit" — dwell fruit → take issue → branch grows.
];

async function captureBeat(beat: Beat): Promise<void> {
  const frameDir = join("/tmp", `demo-frames-${beat.name}`);
  rmSync(frameDir, { recursive: true, force: true });
  mkdirSync(frameDir, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  let n = 0;
  const frame = async () => {
    await page.screenshot({ path: join(frameDir, `f${String(n).padStart(4, "0")}.png`) });
    n += 1;
    await page.waitForTimeout(Math.round(1000 / FPS));
  };
  try {
    await beat.walk(page, frame);
  } finally {
    await browser.close();
  }
  if (n === 0) {
    console.warn(`[gif] ${beat.name}: no frames captured — skipped`);
    return;
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const out = join(OUT_DIR, `${beat.name}.gif`);
  const palette = join(frameDir, "palette.png");
  // Two-pass palette encode: 960px wide (readable, shareable size), lanczos.
  const scale = "scale=960:-1:flags=lanczos";
  const gen = spawnSync("ffmpeg", ["-y", "-framerate", String(FPS), "-i", join(frameDir, "f%04d.png"), "-vf", `${scale},palettegen`, palette], { stdio: "pipe" });
  if (gen.status !== 0) {
    console.error(`[gif] ${beat.name}: palettegen failed:\n${gen.stderr}`);
    return;
  }
  const enc = spawnSync(
    "ffmpeg",
    ["-y", "-framerate", String(FPS), "-i", join(frameDir, "f%04d.png"), "-i", palette, "-lavfi", `${scale}[x];[x][1:v]paletteuse=dither=bayer`, out],
    { stdio: "pipe" },
  );
  if (enc.status !== 0) {
    console.error(`[gif] ${beat.name}: encode failed:\n${enc.stderr}`);
    return;
  }
  rmSync(frameDir, { recursive: true, force: true });
  console.log(`[gif] wrote ${out} (${n} frames)`);
}

const wanted = process.argv.slice(2);
for (const beat of BEATS) {
  if (wanted.length > 0 && !wanted.includes(beat.name)) {
    continue;
  }
  await captureBeat(beat);
}
