// JOURNEY C — "walk up to a tree and touch it".
//
// The garden is ONE canvas. There is no DOM node for a tree, a limb tip or an
// issue fruit, and the module that knows where they are
// (src/ui/gesture/scene-source.ts getSceneDwellSource — the real raycaster and
// the real projected rects) is a module-scope singleton that is never exposed
// on window.__VIBERSYN__. So a test cannot ask "where is Atlas".
//
// What a test CAN do is what a person does: point at the picture and press.
// This spec sweeps the projected surface on a grid, presses each point, and
// records what opened. That produces the two numbers the operator actually
// cares about — how much of the wall is a live target, and whether the targets
// that are supposed to be distinct (tree vs limb vs fruit) can be told apart by
// pointing at them.
//
// SCOPE, STATED HONESTLY: with no seam, this spec cannot address a NAMED
// target. K3 (issue fruit loses to the whole-tree hit volume), K4 (self tree
// has no companions) and K5 (labels clip at the wall edge) stay BLOCKED — see
// the last test in this file, which is skipped with that reason rather than
// faked.

import { expect, reportCoverage, test } from "./live-room";
import type { GardenPress as GardenPressResult } from "./journey";
import { percentile, pressGarden, sampleFrameDeltas, sweepGardenClicks } from "./journey";

const WALL = "/?wall=A&flat=1&remote=0";

/** Pressing a tree must open its menu this fast — pure setState in App.tsx. */
const MENU_BUDGET_MS = 300;

test("pointing at the garden opens the thing that was pointed at", async ({ room, wall }) => {
  // A grid sweep is ~40 real presses against a software-rendered 1920x1080
  // garden; that does not fit the suite's default 3-minute budget.
  test.setTimeout(300_000);
  await reportCoverage(room, "garden-picking");
  await wall.open(WALL);
  const page = wall.page;

  // GUARD: a blank canvas would make every "nothing opened" reading a lie about
  // the app instead of a fact about the renderer.
  const gl = await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="room-scene"] canvas') as HTMLCanvasElement | null;
    if (canvas === null) {
      return { present: false, renderer: "none", width: 0, height: 0 };
    }
    const context = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext | null;
    const debug = context?.getExtension("WEBGL_debug_renderer_info") ?? null;
    return {
      present: true,
      renderer: context === null ? "no-gl" : String(debug === null ? context.getParameter(context.RENDERER) : context.getParameter(debug.UNMASKED_RENDERER_WEBGL)),
      width: canvas.width,
      height: canvas.height,
    };
  });
  console.log(`[garden-picking] canvas=${gl.present} ${gl.width}x${gl.height} renderer=${gl.renderer}`);
  test.skip(!gl.present || gl.renderer === "no-gl", "no WebGL canvas in this browser — the garden cannot be pointed at");

  const trees = Number(await page.locator('[data-testid="room-scene"]').getAttribute("data-tree-count"));
  expect(trees, "there are trees in the garden to point at").toBeGreaterThan(0);

  const targets = {
    "tree-menu": '[data-testid="tree-menu"]',
    "branch-popup": '[data-testid="branch-popup"]',
    "issue-popup": '[data-testid="issue-popup"]',
    "idea-card": '[data-testid="idea-action-card"]',
  };
  const sweep = await sweepGardenClicks(page, { cols: 8, rows: 5, targets });
  const hits = sweep.filter((point) => point.opened.length > 0);
  const byTarget = new Map<string, number>();
  for (const point of hits) {
    for (const name of point.opened) {
      byTarget.set(name, (byTarget.get(name) ?? 0) + 1);
    }
  }
  const viewport = page.viewportSize() ?? { width: 1920, height: 1080 };
  console.log(
    `[garden-picking] ${hits.length}/${sweep.length} presses over the ${viewport.width}x${viewport.height} wall open anything ` +
      `(${Math.round((hits.length / sweep.length) * 1000) / 10}% of the picture is a live target for ${trees} tree(s)): ` +
      `${[...byTarget.entries()].map(([name, count]) => `${name}=${count}`).join(", ") || "nothing"}`,
  );
  console.log(
    `[garden-picking] live points: ${hits.map((point) => `${point.x},${point.y}→${point.opened.join("+")}@${point.openedMs}ms`).join(" | ") || "none"}`,
  );

  expect(
    hits.length,
    `${trees} tree(s) are rendered but ${sweep.length} presses spread over the whole projected wall opened nothing. ` +
      "Picking a tree is the entry point to every per-process action in the room (TreeMenu is the only place Record, " +
      "Remove, lanes, versions and Live-app live since the fleet rail was removed).",
  ).toBeGreaterThan(0);

  // THE SAME PLACE TWICE. A projector wall is pointed at, not clicked: if the
  // hit volume for a tree drifts, the room feels broken in exactly the way the
  // operator described. Press the point that just worked, five times in a row.
  const point = hits[0]!;
  const repeats: GardenPressResult[] = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    repeats.push(await pressGarden(page, point, targets));
  }
  const reproduced = repeats.filter((press) => press.opened.length > 0).length;
  console.log(`[garden-picking] the same point (${point.x},${point.y}) re-pressed: ${reproduced}/5 opened something`);

  // …and it should be FAST: the menu is pure local state (App.tsx setSelected).
  //
  // MEASURED BUT NOT GATED, and here is the honest reason. This browser paints
  // the garden on SwiftShader (a software GPU): 6-9fps at 1920x1080, which puts
  // a floor under every click-to-paint number AND under the polling that
  // measures it (each probe is a CDP round trip behind the same starved main
  // thread). Even frame-normalized the reading swings 11-13 frames between an
  // idle machine and a contended one, so a millisecond gate here would fire on
  // the renderer, not on the room. The number is printed in the wall's own
  // frames so a run on real projector hardware has something to compare to.
  const frameP50 = percentile((await sampleFrameDeltas(page, 2_000)).slice(2), 50);
  const openedMs = [...hits, ...repeats].filter((press) => press.openedMs >= 0).map((press) => press.openedMs);
  console.log(
    `[garden-picking] press → menu on screen: p50=${percentile(openedMs, 50)}ms max=${percentile(openedMs, 100)}ms ` +
      `= ${frameP50 === 0 ? "?" : Math.round(percentile(openedMs, 50) / frameP50)} frames of this wall ` +
      `(frame p50 ${frameP50}ms on ${gl.renderer.slice(0, 40)}; the projector target is ${MENU_BUDGET_MS}ms) — REPORTED, NOT ASSERTED`,
  );

  expect(
    reproduced,
    `pressing the exact spot that just opened a tree menu opens it again (measured ${reproduced}/5). ` +
      "A drifting hit volume means the operator has to hunt for a tree that is visibly right there.",
  ).toBeGreaterThanOrEqual(4);
});

// BLOCKED, NOT PASSING. Seeds K3/K4/K5 (issue fruit unreachable, the self tree
// missing its companions, labels clipping at the wall edge) are all statements
// about NAMED scene objects. Every one of them is a one-line assertion the
// moment src/ui/App.tsx publishes the singleton it already builds:
//
//   window.__VIBERSYN__.scene = { pick(x, y), rectFor(id), targets() }
//     — ids already standardized in src/ui/gesture/scene-source.ts:
//       scene:proc:<callsign> · scene:branch:<callsign>:<branch> · scene:issue:<callsign>:<n>
//
// Until that exists the harness would have to guess pixel coordinates and call
// the guess an assertion, so it does not run.
test.skip("issue fruit, limb tips and label rects are addressable by name", async () => {
  // Intentionally empty: see the comment above. This test is a placeholder for
  // the seam, so the gap is visible in the suite's own output.
});
