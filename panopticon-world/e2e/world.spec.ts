import { expect, type Page, test } from "@playwright/test";

// The e2e suite drives the real UI and asserts world state through the
// `window.__world` engine hook (see src/main.tsx). It covers every piece of
// Panopticon functionality the prototype models.

type Snap = {
  processes: { upid: string; parentId?: string; state: string; inbox: number; log: { role: string; text: string }[] }[];
  bubbles: { id: string; answers: Record<string, string> }[];
  transcript: { text: string }[];
  config: { bubblesPerMinute: number; suggestionTtlMs: number; execution: string; safety: string };
  selected: string | null;
  viewMode: string;
  graftFrom: string | null;
  paused: boolean;
};

const W = "__world";
const snap = (page: Page) => page.evaluate((w) => (window as any)[w].getSnapshot(), W) as Promise<Snap>;
const call = (page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(({ w, fn, args }) => (window as any)[w][fn](...args), { w: W, fn, args });

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept()); // QR button uses alert()
  (page as any)._errors = errors;
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__world);
  await call(page, "toggleSim"); // pause the ambient sim → deterministic state
  // close the intro legend so panels are clickable (some tests reopen it)
  const close = page.locator(".legend .snes-btn", { hasText: "Close" });
  if (await close.count()) await close.click();
});

test("boots with a live canvas, seeded processes, and no page errors", async ({ page }) => {
  await expect(page.locator("canvas")).toHaveCount(1);
  const s = await snap(page);
  expect(s.processes.length).toBeGreaterThanOrEqual(4);
  expect(s.paused).toBe(true);
  expect((page as any)._errors).toEqual([]);
});

test("legend opens from the HUD and closes", async ({ page }) => {
  await expect(page.locator(".legend")).toHaveCount(0);
  await page.locator(".hud .snes-btn", { hasText: "Legend" }).click();
  await expect(page.locator(".legend")).toBeVisible();
  await expect(page.locator(".legend-item").first()).toBeVisible();
  await page.locator(".legend .snes-btn", { hasText: "Close" }).click();
  await expect(page.locator(".legend")).toHaveCount(0);
});

test("idea bubbles render with demo + clarifying questions; answering records the choice", async ({ page }) => {
  const card = page.locator(".bubble-card").first();
  await expect(card).toBeVisible();
  await expect(card.locator(".preview")).toBeVisible(); // the shipped demo
  const chip = card.locator(".chip").first();
  await chip.click();
  await expect(chip).toHaveClass(/sel/);
  const s = await snap(page);
  const answered = s.bubbles.some((b) => Object.keys(b.answers).length > 0);
  expect(answered).toBe(true);
});

test("accept a bubble → spawns a process and auto-selects it (inspector opens)", async ({ page }) => {
  const before = (await snap(page)).processes.length;
  await page.locator(".bubble-card").first().getByRole("button", { name: /Accept/ }).click();
  await expect(page.locator(".inspector")).toBeVisible();
  const s = await snap(page);
  expect(s.processes.length).toBe(before + 1);
  expect(s.selected).not.toBeNull();
});

test("dismiss (pop) a bubble removes it from the queue", async ({ page }) => {
  const before = (await snap(page)).bubbles.length;
  expect(before).toBeGreaterThan(0);
  await page.locator(".bubble-card").first().getByRole("button", { name: /Pop/ }).click();
  await expect.poll(async () => (await snap(page)).bubbles.length).toBe(before - 1);
});

test("room dialogue feeds the ambient transcript", async ({ page }) => {
  await page.locator('.dialogue input[name="t"]').fill("we should build a latency dashboard");
  await page.locator(".dialogue").getByRole("button", { name: "Say" }).click();
  const s = await snap(page);
  expect(s.transcript.at(-1)?.text).toContain("latency dashboard");
});

test("select a process → steer it (input lands in its queue + log)", async ({ page }) => {
  const id = (await snap(page)).processes[0].upid;
  await call(page, "select", id);
  await expect(page.locator(".inspector")).toBeVisible();
  await page.locator('.inspector input[name="p"]').fill("add a dark mode");
  await page.locator(".inspector").getByRole("button", { name: "⏎" }).click();
  const p = (await snap(page)).processes.find((x) => x.upid === id)!;
  expect(p.inbox).toBeGreaterThanOrEqual(1);
  expect(p.log.some((l) => l.role === "you" && l.text.includes("dark mode"))).toBe(true);
});

test("pause / resume a process from the inspector", async ({ page }) => {
  const id = (await snap(page)).processes.find((p) => p.state === "active")!.upid;
  await call(page, "select", id);
  await page.locator(".inspector").getByRole("button", { name: /Pause/ }).click();
  expect((await snap(page)).processes.find((x) => x.upid === id)!.state).toBe("paused");
  await page.locator(".inspector").getByRole("button", { name: /Resume/ }).click();
  expect((await snap(page)).processes.find((x) => x.upid === id)!.state).toBe("active");
});

test("fork a process → child created with parent lineage", async ({ page }) => {
  const id = (await snap(page)).processes[0].upid;
  await call(page, "select", id);
  const before = (await snap(page)).processes.length;
  await page.locator(".inspector").getByRole("button", { name: /Fork/ }).click();
  const s = await snap(page);
  expect(s.processes.length).toBe(before + 1);
  expect(s.processes.some((p) => p.parentId === id)).toBe(true);
});

test("kill a process → it dies and the inspector closes", async ({ page }) => {
  const id = (await snap(page)).processes[0].upid;
  await call(page, "select", id);
  await expect(page.locator(".inspector")).toBeVisible();
  await page.locator(".inspector").getByRole("button", { name: /Kill/ }).click();
  await expect(page.locator(".inspector")).toHaveCount(0);
  const p = (await snap(page)).processes.find((x) => x.upid === id);
  expect(p === undefined || p.state === "dead").toBe(true);
});

test("toggle Village ⇄ Grove view from the HUD", async ({ page }) => {
  expect((await snap(page)).viewMode).toBe("overworld");
  await page.locator(".hud .snes-btn", { hasText: "Grove" }).click();
  expect((await snap(page)).viewMode).toBe("grove");
  await page.locator(".hud .snes-btn", { hasText: "Village" }).click();
  expect((await snap(page)).viewMode).toBe("overworld");
});

test("grove: re-graft moves a process onto another branch (and refuses cycles)", async ({ page }) => {
  await call(page, "setViewMode", "grove");
  const s0 = await snap(page);
  const child = s0.processes.find((p) => p.parentId)!; // the seeded fork
  const parent = child.parentId!;
  const newParent = s0.processes.find((p) => p.upid !== child.upid && p.upid !== parent && p.state !== "dead")!.upid;

  // graft child onto a new branch
  await call(page, "beginGraft", child.upid);
  expect((await snap(page)).graftFrom).toBe(child.upid);
  await call(page, "nodeClick", newParent);
  expect((await snap(page)).processes.find((p) => p.upid === child.upid)!.parentId).toBe(newParent);

  // a cycle (grafting the new parent onto its own descendant) is refused
  await call(page, "regraft", newParent, child.upid);
  expect((await snap(page)).processes.find((p) => p.upid === newParent)!.parentId).not.toBe(child.upid);
});

test("options knobs update session config", async ({ page }) => {
  await page.locator(".options input[type=range]").first().fill("18");
  expect((await snap(page)).config.bubblesPerMinute).toBe(18);
  await page.locator(".options .snes-btn", { hasText: "Explicit" }).click();
  expect((await snap(page)).config.execution).toBe("explicit");
  await page.locator(".options .snes-btn", { hasText: "Dangerous" }).click();
  expect((await snap(page)).config.safety).toBe("dangerous");
});

test("HUD pause toggles the ambient simulation", async ({ page }) => {
  // beforeEach already paused it
  expect((await snap(page)).paused).toBe(true);
  await page.locator(".hud .snes-btn", { hasText: "Resume" }).click();
  expect((await snap(page)).paused).toBe(false);
});
