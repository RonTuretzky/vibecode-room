import { expect, test, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';

// Opt-in hardware test: the regular suite intentionally uses lightweight
// software-renderer fallbacks. This test must load the actual park assets.
test.use({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: process.env.VIBERSYN_PARK_DPR === '2' ? 2 : 1,
  contextOptions: { reducedMotion: process.env.VIBERSYN_PARK_MOTION === '1' ? 'no-preference' : 'reduce' },
  video: process.env.VIBERSYN_PARK_MOTION === '1' ? 'on' : 'off',
  launchOptions: { args: process.platform === 'darwin' ? ['--use-angle=metal'] : [] } });
test.skip(process.env.VIBERSYN_PARK_GPU !== '1', 'Set VIBERSYN_PARK_GPU=1 on a machine with hardware WebGL.');

async function cameraSettled(page: Page) {
  let previous = '';
  await expect.poll(async () => {
    const pose = await page.getByTestId('room-scene').evaluate(el => {
      const d = (el as HTMLElement).dataset; return [d.cameraX, d.cameraY, d.cameraZ, d.cameraRadius].join(',');
    });
    const settled = pose === previous; previous = pose; return settled;
  }, { intervals: [1000], timeout: 15000 }).toBe(true);
}

test('the full park renders every preset, material and environment return without GPU errors', async ({ page }, info) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' || /shader.*error|failed to load|context lost/i.test(message.text())) errors.push(message.text());
  });
  await page.goto('/?live=0&env=park');
  const scene = page.getByTestId('room-scene'), view = page.getByTestId('park-view-button');
  await expect(scene).toHaveAttribute('data-park-ready', 'true', { timeout: 90000 });
  expect(await scene.getAttribute('data-renderer')).not.toMatch(/swiftshader|llvmpipe|softpipe|software/i);
  expect(Number(await scene.getAttribute('data-triangles'))).toBeGreaterThan(100000);
  const stats: Record<string, unknown> = { renderer: await scene.getAttribute('data-renderer'),
    reducedMotion: await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches) };
  for (const [label, file] of [['The Pond', 'pond'], ['Park overlook', 'overlook'], ['Wollman Rink', 'wollman'], ['Project lawn', 'lawn']]) {
    await view.click(); await expect(scene).toHaveAttribute('data-park-view', label!);
    await cameraSettled(page);
    await page.getByTestId('scene-zen-button').click();
    // Capture diagnostics before screenshot readback, which can itself stall
    // the frame loop and inflate a short average at high pixel densities.
    stats[file!] = await scene.evaluate(el => {
      const d = (el as HTMLElement).dataset;
      return { triangles: d.averageTriangles, draws: d.averageDrawCalls, frameMs: d.frameMs, p95Ms: d.frameP95Ms, ratio: d.pixelRatio };
    });
    await page.screenshot({ path: info.outputPath(`${file}.png`) });
    await page.keyboard.press('Escape');
  }
  // Respect a preference change while the room is already running; a reload
  // must not be required to stop or restore decorative motion.
  const originallyReduced = stats.reducedMotion as boolean;
  const canvas = await scene.locator('canvas').elementHandle();
  await page.emulateMedia({ reducedMotion: originallyReduced ? 'no-preference' : 'reduce' });
  await expect(scene).toHaveAttribute('data-reduced-motion', String(!originallyReduced));
  await cameraSettled(page);
  expect(await canvas!.evaluate(el => el.isConnected)).toBe(true);
  await page.emulateMedia({ reducedMotion: originallyReduced ? 'reduce' : 'no-preference' });
  await expect(scene).toHaveAttribute('data-reduced-motion', String(originallyReduced));
  await page.getByTestId('scene-mode-button').click();
  await expect(view).toHaveCount(0);
  await page.getByTestId('scene-mode-button').click();
  await expect(scene).toHaveAttribute('data-park-ready', 'true');
  await page.getByTestId('control-dock-button').click();
  await page.getByTestId('central-park-button').click();
  await expect(view).toHaveCount(0);
  await page.getByTestId('central-park-button').click();
  await expect(scene).toHaveAttribute('data-park-ready', 'true');
  await page.getByTestId('control-dock-button').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('scene-fit-button').click(); await cameraSettled(page);
  await page.screenshot({ path: info.outputPath('portrait-controls.png') });
  await page.getByTestId('scene-zen-button').click();
  await page.screenshot({ path: info.outputPath('portrait-zen.png') });
  const samples = info.outputPath('render-samples.json');
  writeFileSync(samples, JSON.stringify(stats, null, 2));
  await info.attach('render-samples', { path: samples, contentType: 'application/json' });
  expect(errors).toEqual([]);
});
