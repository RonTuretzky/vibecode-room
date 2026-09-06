import { expect, test, type Page } from '@playwright/test';

async function visitProject(page: Page) {
  await page.getByTestId('control-dock-button').click();
  await page.getByTestId('projects-button').click();
  await page.locator('.project-row').filter({ has: page.getByText('Focus tree', { exact: true }) }).click();
  await page.getByRole('button', { name: 'Show in garden', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Tree controls for Focus tree' })).toBeVisible();
}

async function seedProjects(page: Page) {
  await page.waitForFunction(() => (window as any).__VIBERSYN__?.ready);
  await page.evaluate(() => {
    const app = (window as any).__VIBERSYN__, template = app.getSnapshot().processes[0];
    app.applySnapshot({ plantedPositions: { 'focus-fixture-0': { x: -70, z: -10 }, 'focus-fixture-1': { x: 70, z: -10 } },
      processes: [0, 1].map(index => ({ ...template,
      upid: `focus-fixture-${index}`, callsign: index ? 'Focus tree' : 'Companion',
      task: 'A focused project', source: undefined, slides: undefined, execution: undefined,
      treeRepo: { adopted: false, remoteUrl: 'https://example.invalid/focus',
        branches: [{ name: 'main', commits: 15 }, { name: 'room/detail', commits: 4 }] },
    })) });
  });
  await expect(page.getByTestId('room-scene')).toHaveAttribute('data-tree-count', '2');
}

for (const width of [1280, 390]) {
  test(`project focus clears the foreground and leaves controls usable at ${width}px`, async ({ page }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/?live=0&remote=0&env=park');
    await seedProjects(page);
    const scene = page.getByTestId('room-scene');
    await page.getByTestId('scene-fit-button').click();
    const radius = () => scene.getAttribute('data-camera-radius').then(Number);
    await expect.poll(radius, { timeout: 15000 }).toBeGreaterThan(100);
    await visitProject(page);
    await expect(page.getByTestId('idea-tray')).toBeHidden();
    await expect.poll(radius, { timeout: 15000 }).toBeLessThan(80);
    // Wait for the moving tree anchor to settle before checking the menu's
    // real rendered bounds; CSS content height can exceed a nominal layout.
    await expect.poll(async () => page.getByTestId('tree-menu').evaluate(menu => {
      const obstacles = ['.status-bar', '[data-testid="scene-controls"]'].map(selector => document.querySelector(selector)!.getBoundingClientRect());
      return Array.from(menu.querySelectorAll('[data-chip]')).filter(chip => {
        const r = chip.getBoundingClientRect();
        return r.left < 0 || r.right > innerWidth || r.top < 0 || r.bottom > innerHeight ||
          obstacles.some(o => r.left < o.right && r.right > o.left && r.top < o.bottom && r.bottom > o.top);
      }).length;
    }), { timeout: 15000 }).toBe(0);
    await page.getByTestId('scene-fit-button').click();
    await expect.poll(radius, { timeout: 15000 }).toBeGreaterThan(100);
    await visitProject(page);
    await expect.poll(radius, { timeout: 15000 }).toBeLessThan(80);
    await page.getByTestId('tree-menu-close').click();
    await expect(page.getByTestId('idea-tray')).toBeVisible();
  });
}

test('opening a project preserves the locked projector camera', async ({ page }) => {
  await page.goto('/?live=0&remote=0&flat=1&wall=a');
  await seedProjects(page);
  const scene = page.getByTestId('room-scene');
  await expect(scene).toHaveAttribute('data-camera-radius', /\d/);
  const pose = () => scene.evaluate(el => { const d = (el as HTMLElement).dataset;
    return [d.cameraX, d.cameraY, d.cameraZ, d.cameraRadius]; });
  let previous = '';
  await expect.poll(async () => {
    const next = JSON.stringify(await pose()), settled = next === previous;
    previous = next; return settled;
  }, { intervals: [1000], timeout: 15000 }).toBe(true);
  const before = await pose();
  await visitProject(page);
  await page.waitForTimeout(1500);
  expect(await pose()).toEqual(before);
  await expect(page.getByTestId('scene-fit-button')).toBeDisabled();
});
