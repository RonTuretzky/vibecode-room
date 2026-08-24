import { describe, expect, test } from "bun:test";
import {
  TEND_CHIP_MARGIN,
  TEND_CHIP_MIN_SEPARATION,
  TEND_CHIP_SEPARATION,
  tendChipLayout,
  tendChipSize,
  type TendChipId,
  normalizeAnchor,
  DESK_SIZES,
  type TendChipSize,
} from "./tend-radial";

// TEND RADIAL — the pure chip-constellation layout (no panel, no container:
// every tend verb / branch row / receipt is its own floating glass chip on
// arcs around the tree's projected anchor rect). These tests pin the three
// dwell-critical guarantees at 1920×1080 for BOTH size families:
//   1. every chip fully on-screen (an off-screen chip is dropped as a dwell
//      target by the occlusion check — the ✕-off-screen live-room P0 class);
//   2. no two chips overlap (elementFromPoint kills a covered chip's center),
//      with arc-internal separation ≥ the 2×24px hitbox-inflation budget
//      wherever the viewport can afford it;
//   3. a null anchor (keyboard select / SSR / degenerate projection) still
//      lays every chip on-screen at the right-edge rest column.

const VIEWPORT = { width: 1920, height: 1080 };
// The busiest LIST view: identity + ✕ + graft + growing + trunk verbs +
// branch heading + four leaf-chips + pager + both receipts (the 20+ branch
// fixture always paginates to exactly four leaf-chips — that is the point).
const LIST_PRESENT: TendChipId[] = [
  "identity",
  "close",
  "graft",
  "growing",
  "here",
  "branches-head",
  "branch-0",
  "branch-1",
  "branch-2",
  "branch-3",
  "pager",
  "note",
  "error",
];
// The FOCUS view (prune among the limbs): the leaf-chips stand down.
const FOCUS_PRESENT: TendChipId[] = ["identity", "close", "graft", "here", "focus", "error"];
// The busiest realistic ADOPTED fleet tree (salem-class import): three lane
// chips share the leaf slots with one branch card (TreeMenu pages branches
// into the remainder), the brief/live/grow verbs stack above the record chip,
// remove roots the arc, a receipt + replant rest under the trunk.
const FLEET_ADOPTED_PRESENT: TendChipId[] = [
  "identity",
  "close",
  "graft",
  "remove",
  "lane-0",
  "lane-1",
  "lane-2",
  "settled",
  "brief",
  "live",
  "grow",
  "branches-head",
  "branch-0",
  "pager",
  "note",
  "replant",
];
// A concept/mock tree: lanes + deck + the fleet verbs, QR after a publish.
const FLEET_CONCEPT_PRESENT: TendChipId[] = [
  "identity",
  "close",
  "graft",
  "remove",
  "lane-0",
  "lane-1",
  "lane-2",
  "deck",
  "replant",
  "qr",
];

const ANCHOR = { left: 800, top: 240, width: 320, height: 620 }; // a framed tree, mid-frame

function rectOf(id: TendChipId, layout: Record<string, { left: number; top: number }>, gesture: boolean) {
  const size = tendChipSize(id, gesture);
  const pos = layout[id];
  expect(pos).toBeDefined();
  return { id, left: pos!.left, top: pos!.top, width: size.width, height: size.height };
}

type Rect = ReturnType<typeof rectOf>;

function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}

describe("tend-radial: the chip constellation layout", () => {
  for (const gesture of [false, true]) {
    const family = gesture ? "gesture-XL" : "desk";

    test(`${family}: every chip lands fully on-screen at 1920×1080 (anchored + focus views)`, () => {
      for (const present of [LIST_PRESENT, FOCUS_PRESENT, FLEET_ADOPTED_PRESENT, FLEET_CONCEPT_PRESENT]) {
        const layout = tendChipLayout(ANCHOR, VIEWPORT, { gesture, present });
        for (const id of present) {
          const rect = rectOf(id, layout, gesture);
          expect(rect.left).toBeGreaterThanOrEqual(TEND_CHIP_MARGIN);
          expect(rect.top).toBeGreaterThanOrEqual(TEND_CHIP_MARGIN);
          expect(rect.left + rect.width).toBeLessThanOrEqual(VIEWPORT.width - TEND_CHIP_MARGIN);
          expect(rect.top + rect.height).toBeLessThanOrEqual(VIEWPORT.height - TEND_CHIP_MARGIN);
        }
      }
    });

    test(`${family}: no two chips overlap — a covered center is a dead dwell target`, () => {
      for (const present of [LIST_PRESENT, FOCUS_PRESENT, FLEET_ADOPTED_PRESENT, FLEET_CONCEPT_PRESENT]) {
        const layout = tendChipLayout(ANCHOR, VIEWPORT, { gesture, present });
        const rects = present.map((id) => rectOf(id, layout, gesture));
        for (let i = 0; i < rects.length; i += 1) {
          for (let j = i + 1; j < rects.length; j += 1) {
            expect(overlaps(rects[i]!, rects[j]!)).toBe(false);
          }
        }
      }
    });

    test(`${family}: arc-internal vertical separation honors the dwell-inflation budget (floor ${TEND_CHIP_MIN_SEPARATION}px)`, () => {
      const layout = tendChipLayout(ANCHOR, VIEWPORT, { gesture, present: LIST_PRESENT });
      // The leaf arc's stacked run (heading → four leaf-chips → pager).
      const leafRun: TendChipId[] = ["branches-head", "branch-0", "branch-1", "branch-2", "branch-3", "pager"];
      const rects = leafRun.map((id) => rectOf(id, layout, gesture));
      for (let i = 1; i < rects.length; i += 1) {
        const gap = rects[i]!.top - (rects[i - 1]!.top + rects[i - 1]!.height);
        expect(gap).toBeGreaterThanOrEqual(TEND_CHIP_MIN_SEPARATION);
        // Where 1080p can hold the full budget the gap IS the 2×24px budget.
        expect(gap).toBeLessThanOrEqual(TEND_CHIP_SEPARATION + 1);
      }
    });

    test(`${family}: the arcs sit AROUND the tree — verbs left of the anchor, leaves right, garden between`, () => {
      const layout = tendChipLayout(ANCHOR, VIEWPORT, { gesture, present: LIST_PRESENT });
      const anchorCenter = ANCHOR.left + ANCHOR.width / 2;
      for (const id of ["identity", "here", "growing", "graft"] as TendChipId[]) {
        const rect = rectOf(id, layout, gesture);
        expect(rect.left + rect.width / 2).toBeLessThan(anchorCenter);
      }
      for (const id of ["close", "branches-head", "branch-0", "branch-3", "pager"] as TendChipId[]) {
        const rect = rectOf(id, layout, gesture);
        expect(rect.left + rect.width / 2).toBeGreaterThan(anchorCenter);
      }
      // Graft roots the verb arc at the BASE; identity crowns it; the ✕ crowns
      // the leaf arc above the first leaf-chip.
      expect(rectOf("graft", layout, gesture).top).toBeGreaterThan(rectOf("here", layout, gesture).top);
      expect(rectOf("identity", layout, gesture).top).toBeLessThan(rectOf("here", layout, gesture).top);
      expect(rectOf("close", layout, gesture).top).toBeLessThan(rectOf("branch-0", layout, gesture).top);
    });

    test(`${family}: null anchor (keyboard/SSR) → the rest column, every chip on-screen and clear`, () => {
      const layout = tendChipLayout(null, VIEWPORT, { gesture, present: LIST_PRESENT });
      const rects = LIST_PRESENT.map((id) => rectOf(id, layout, gesture));
      for (const rect of rects) {
        expect(rect.left).toBeGreaterThanOrEqual(TEND_CHIP_MARGIN);
        expect(rect.top).toBeGreaterThanOrEqual(TEND_CHIP_MARGIN);
        expect(rect.left + rect.width).toBeLessThanOrEqual(VIEWPORT.width - TEND_CHIP_MARGIN);
        expect(rect.top + rect.height).toBeLessThanOrEqual(VIEWPORT.height - TEND_CHIP_MARGIN);
      }
      for (let i = 0; i < rects.length; i += 1) {
        for (let j = i + 1; j < rects.length; j += 1) {
          expect(overlaps(rects[i]!, rects[j]!)).toBe(false);
        }
      }
    });
  }

  test("off-screen anchors (chased mid-camera-move) still clamp every chip inside the margins", () => {
    for (const anchor of [
      { left: 2200, top: 300, width: 200, height: 400 }, // off right
      { left: -900, top: 300, width: 200, height: 400 }, // off left
      { left: 700, top: -500, width: 300, height: 400 }, // off the top
      { left: 700, top: 1400, width: 300, height: 400 }, // off the bottom
    ]) {
      const layout = tendChipLayout(anchor, VIEWPORT, { gesture: true, present: LIST_PRESENT });
      for (const id of LIST_PRESENT) {
        const rect = rectOf(id, layout, true);
        expect(rect.left).toBeGreaterThanOrEqual(TEND_CHIP_MARGIN);
        expect(rect.left + rect.width).toBeLessThanOrEqual(VIEWPORT.width - TEND_CHIP_MARGIN);
        expect(rect.top).toBeGreaterThanOrEqual(TEND_CHIP_MARGIN);
      }
    }
  });

  test("gesture-XL interactive chips meet the ~96px stationary-target floor", () => {
    // Chips that carry dwell buttons must render at wall-target scale; the
    // pure size table is the single source of truth the layout budgets from.
    for (const id of ["close", "graft", "growing", "here", "focus", "branch-0", "pager"] as TendChipId[]) {
      expect(tendChipSize(id, true).height).toBeGreaterThanOrEqual(96);
    }
  });
});

// THE FLAT RIG NEVER REFRAMES. RoomScene gates camera focus off under
// corner/flat lock (the two projections tile one continuous picture), so the
// tree can sit far off-frame — measured live at left=2474 on a 1920 wall. The
// arcs must still land ON the wall, spread around a pulled-in anchor, instead
// of piling every column against one margin.
describe("normalizeAnchor keeps both arcs on the wall", () => {
  const viewport = { width: 1920, height: 1080 };
  const sizes = { ...DESK_SIZES } as Record<string, TendChipSize>;
  const anchorAt = (left: number) => ({ id: "scene:proc:mirror", left, top: 127, width: 625, height: 888 });

  test("a far off-frame tree comes home with room on both sides", () => {
    const normalized = normalizeAnchor(anchorAt(2474), viewport, sizes);
    expect(normalized.left).toBeGreaterThanOrEqual(TEND_CHIP_MARGIN);
    expect(normalized.left + normalized.width).toBeLessThanOrEqual(viewport.width - TEND_CHIP_MARGIN);
    // Room for a verb chip to its left and a leaf chip to its right.
    expect(normalized.left).toBeGreaterThan(200);
    expect(viewport.width - (normalized.left + normalized.width)).toBeGreaterThan(200);
  });

  test("an on-screen tree keeps its true position (the halo and chips agree)", () => {
    const anchor = anchorAt(700);
    expect(normalizeAnchor(anchor, viewport, sizes).left).toBe(700);
  });

  test("off-frame LEFT is pulled in too, symmetrically", () => {
    const normalized = normalizeAnchor(anchorAt(-800), viewport, sizes);
    expect(normalized.left).toBeGreaterThanOrEqual(TEND_CHIP_MARGIN);
  });

  test("the whole layout lands inside the wall for an off-frame tree", () => {
    const placements = tendChipLayout(anchorAt(2474), viewport, {
      gesture: false,
      present: ["graft", "here", "branches-head", "close"],
    });
    for (const [id, placement] of Object.entries(placements)) {
      expect(placement.left, `${id} left`).toBeGreaterThanOrEqual(0);
      expect(placement.left, `${id} right edge`).toBeLessThanOrEqual(viewport.width);
      expect(placement.top, `${id} top`).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("root slots: transient receipts never move the persistent chips", () => {
  // The '⚘ replant…' chip is a real dwell BUTTON (and the QR a stable
  // take-home surface): a receipt mounting above it used to re-stack the
  // shared root column and slide it out from under a mid-dwell cursor — the
  // exact moving-target class the pager/prune-scope comments forbid. The
  // two-part root stack pins them regardless of receipts.
  const BASE: TendChipId[] = ["identity", "close", "graft", "remove", "replant", "qr"];
  for (const gesture of [false, true]) {
    const family = gesture ? "gesture-XL" : "desk";
    test(`${family}: replant and qr hold still while note/error come and go`, () => {
      const bare = tendChipLayout(ANCHOR, VIEWPORT, { gesture, present: BASE });
      const withReceipts = tendChipLayout(ANCHOR, VIEWPORT, { gesture, present: [...BASE, "note", "error"] });
      expect(withReceipts.replant).toEqual(bare.replant!);
      expect(withReceipts.qr).toEqual(bare.qr!);
    });
  }
});
