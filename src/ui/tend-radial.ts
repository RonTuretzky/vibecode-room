import type { SceneDwellRect } from "./gesture/scene-source";

/**
 * TEND RADIAL — pure chip-constellation layout for the self tree's tending
 * surface (TreeMenu's isSelf body). NO PANEL: every verb / branch row / receipt
 * is its own floating glass chip, positioned by projecting arcs around the
 * tree's live anchor rect (the same SceneDwellRect the App's 1 Hz anchor chase
 * feeds the halo). This module is pure and SSR-safe (treeMenuPlacement's exact
 * style): rects in, {left,top} out, no DOM, no time.
 *
 * The arcs (design constraint, verbatim): verbs on one arc — graft near the
 * base, stop-growing beside the growing card, trunk verbs (the here-card) at
 * the trunk, prune/focus among the limbs — and branches as leaf-chips on the
 * other arc, paginated four at a time. The ✕ and receipts take fixed slots.
 *
 * Anchor caveat (RoomScene:3418-3423): the self tree's limb sub-targets are
 * the FOREST payload's PRs, not the /api/self/branches rails — a rail without
 * an open PR has NO per-limb rect. So every chip slot derives geometrically
 * from the ONE guaranteed anchor, the whole-tree scene:proc rect: base = rect
 * bottom, trunk = rect mid-height, limbs/leaves = the upper region.
 */

// Viewport margin — the treeMenuPlacement idiom (TreeMenu VIEWPORT_MARGIN).
export const TEND_CHIP_MARGIN = 16;
// Edge-to-edge separation between stacked chips: 2 × HITBOX_INFLATE_PX
// (targets.ts:29 — 24px/side dwell inflation), so neighboring chips' inflated
// hitboxes never overlap and the elementFromPoint occlusion check
// (GestureLayer collectDomTargets) never sees one chip covering another's
// center. Columns compress below this only when the viewport truly cannot
// hold them (floor TEND_CHIP_MIN_SEPARATION).
export const TEND_CHIP_SEPARATION = 48;
export const TEND_CHIP_MIN_SEPARATION = 16;
// Gap between a chip column and the anchor rect's edge.
const ANCHOR_GAP = 24;
// Arc bulge: chips at a column's vertical extremes pull toward the tree by up
// to this many px, so a column reads as an arc hugging the crown/base instead
// of a flat rail. X-only — vertical separation is never traded away.
const ARC_CURVE = 56;
// Rest layout (null anchor — keyboard/SSR): columns hug the right edge.
const REST_COLUMN_GAP = 24;

export type TendChipId =
  | "identity"
  | "close"
  | "graft"
  | "growing"
  | "settled"
  | "halt-note"
  | "here"
  | "focus"
  | "branches-head"
  | "reading"
  | "empty"
  | "branch-0"
  | "branch-1"
  | "branch-2"
  | "branch-3"
  | "pager"
  | "note"
  | "error"
  | "qr";

export interface TendChipSize {
  width: number;
  height: number;
}

export interface TendChipPlacement {
  left: number;
  top: number;
}

// NOMINAL chip footprints (desk / gesture-XL). The rendered chips take these
// widths inline (single source of truth) and their CSS min-heights sit at or
// under the nominal heights, so the pure layout's separation budget holds on
// the real wall. Heights carry headroom for the taller transient states
// (armed sub-lines, halt receipts) — the 48px separation absorbs the rest.
export const DESK_SIZES: Record<TendChipId, TendChipSize> = {
  identity: { width: 250, height: 108 },
  close: { width: 64, height: 52 },
  graft: { width: 280, height: 96 },
  growing: { width: 300, height: 172 },
  settled: { width: 300, height: 96 },
  "halt-note": { width: 280, height: 60 },
  here: { width: 330, height: 196 },
  focus: { width: 350, height: 430 },
  "branches-head": { width: 220, height: 44 },
  reading: { width: 260, height: 56 },
  empty: { width: 280, height: 64 },
  "branch-0": { width: 310, height: 88 },
  "branch-1": { width: 310, height: 88 },
  "branch-2": { width: 310, height: 88 },
  "branch-3": { width: 310, height: 88 },
  pager: { width: 310, height: 76 },
  note: { width: 320, height: 56 },
  error: { width: 320, height: 56 },
  qr: { width: 220, height: 230 },
};

const GESTURE_SIZES: Record<TendChipId, TendChipSize> = {
  identity: { width: 300, height: 132 },
  close: { width: 120, height: 104 },
  graft: { width: 390, height: 190 },
  growing: { width: 400, height: 232 },
  settled: { width: 400, height: 120 },
  "halt-note": { width: 340, height: 72 },
  here: { width: 430, height: 252 },
  focus: { width: 470, height: 570 },
  "branches-head": { width: 280, height: 52 },
  reading: { width: 320, height: 64 },
  empty: { width: 340, height: 76 },
  "branch-0": { width: 420, height: 126 },
  "branch-1": { width: 420, height: 126 },
  "branch-2": { width: 420, height: 126 },
  "branch-3": { width: 420, height: 126 },
  pager: { width: 420, height: 130 },
  note: { width: 380, height: 64 },
  error: { width: 380, height: 64 },
  qr: { width: 260, height: 270 },
};

export function tendChipSize(id: TendChipId, gesture: boolean): TendChipSize {
  return (gesture ? GESTURE_SIZES : DESK_SIZES)[id];
}

// ── arc membership ──────────────────────────────────────────────────────────
// VERB ARC (left of the tree), top → bottom: the identity plate crowns it,
// the trunk verbs sit mid-height, whatever is growing sits beside its ✂, and
// graft roots the arc at the tree's base.
const VERB_ARC: readonly TendChipId[] = ["identity", "here", "growing", "settled", "halt-note", "graft"];
// LEAF ARC (right of the tree), top → bottom: ✕ crowns it; the focus view
// (prune among the limbs) or the paginated leaf-chips fill the crown; the
// pager hangs below the last leaf.
const LEAF_ARC: readonly TendChipId[] = [
  "close",
  "focus",
  "branches-head",
  "reading",
  "empty",
  "branch-0",
  "branch-1",
  "branch-2",
  "branch-3",
  "pager",
];
// FIXED SLOTS below the tree: the honest receipts (and the take-home QR).
const ROOT_SLOTS: readonly TendChipId[] = ["note", "error", "qr"];

// Canonical order for the rest column + the deterministic nudge pass.
const CANONICAL: readonly TendChipId[] = [...VERB_ARC.slice(0, 1), "close", ...VERB_ARC.slice(1), ...LEAF_ARC.slice(1), ...ROOT_SLOTS];

export interface TendChipLayoutSpec {
  gesture: boolean;
  present: readonly TendChipId[];
}

interface MutableRect {
  id: TendChipId;
  left: number;
  top: number;
  width: number;
  height: number;
}

const clamp = (value: number, lo: number, hi: number): number => Math.min(Math.max(value, lo), Math.max(lo, hi));

// Stack a column of chips vertically with the shared separation, compressing
// (never below the floor) when the viewport cannot hold the full budget, and
// clamping the whole run inside the vertical margins.
function stackColumn(
  ids: readonly TendChipId[],
  sizes: Record<TendChipId, TendChipSize>,
  viewportH: number,
  align: "top" | "bottom",
  anchorEdgeY: number,
): { tops: number[]; sep: number; top: number; total: number } {
  const heights = ids.map((id) => sizes[id].height);
  const sum = heights.reduce((a, b) => a + b, 0);
  const avail = viewportH - 2 * TEND_CHIP_MARGIN;
  let sep = TEND_CHIP_SEPARATION;
  if (ids.length > 1 && sum + sep * (ids.length - 1) > avail) {
    sep = Math.max(TEND_CHIP_MIN_SEPARATION, (avail - sum) / (ids.length - 1));
  }
  const total = sum + sep * Math.max(0, ids.length - 1);
  let top = align === "top" ? anchorEdgeY : anchorEdgeY - total;
  top = clamp(top, TEND_CHIP_MARGIN, viewportH - TEND_CHIP_MARGIN - total);
  const tops: number[] = [];
  let y = top;
  for (const h of heights) {
    tops.push(y);
    y += h + sep;
  }
  return { tops, sep, top, total };
}

// The arc bulge for a chip whose vertical center sits at fraction t (0..1) of
// its column: 0 at the middle (furthest from the tree), ARC_CURVE at the
// extremes (hugging crown and base). Pure cosine—deterministic, no wobble.
function arcInset(t: number): number {
  return Math.round(ARC_CURVE * (1 - Math.sin(Math.PI * clamp(t, 0, 1))));
}

function rectsOverlap(a: MutableRect, b: MutableRect, pad: number): boolean {
  return (
    a.left - pad < b.left + b.width &&
    b.left - pad < a.left + a.width &&
    a.top - pad < b.top + b.height &&
    b.top - pad < a.top + a.height
  );
}

// Deterministic overlap-nudge with FROZEN priority: chips are resolved in
// canonical order, each against the already-settled set only — a settled chip
// never moves again, so the pass cannot cycle and always terminates. The
// yielding chip slides along one axis to the nearest position clear of EVERY
// settled chip (cascading past each blocker in turn), choosing the smallest
// total displacement among the escapes that stay on-screen. The column stacks
// already guarantee separation within an arc; this resolves the cross-column
// brushes (receipts under a low-slung tree, a long leaf arc reaching the
// trunk row). If every escape is clamped away, partial overlap beats an
// off-screen chip (treeMenuPlacement's own last resort).
function nudge(rects: MutableRect[], viewport: { width: number; height: number }, pad: number): void {
  const maxLeft = (w: number): number => viewport.width - TEND_CHIP_MARGIN - w;
  const maxTop = (h: number): number => viewport.height - TEND_CHIP_MARGIN - h;
  for (let j = 1; j < rects.length; j += 1) {
    const b = rects[j]!;
    const frozen = rects.slice(0, j);
    if (!frozen.some((a) => rectsOverlap(a, b, pad))) {
      continue;
    }
    // One escape per direction: cascade past every settled blocker (bounded
    // by the settled count), then keep the cheapest on-screen landing.
    const escape = (axis: "top" | "left", step: (a: MutableRect, probe: MutableRect) => number): { cost: number; value: number } | null => {
      const probe: MutableRect = { ...b };
      for (let hops = 0; hops <= frozen.length; hops += 1) {
        const blocker = frozen.find((a) => rectsOverlap(a, probe, pad));
        if (blocker === undefined) {
          const fits =
            axis === "top"
              ? probe.top >= TEND_CHIP_MARGIN && probe.top <= maxTop(probe.height)
              : probe.left >= TEND_CHIP_MARGIN && probe.left <= maxLeft(probe.width);
          return fits ? { cost: Math.abs(axis === "top" ? probe.top - b.top : probe.left - b.left), value: axis === "top" ? probe.top : probe.left } : null;
        }
        probe[axis] = step(blocker, probe);
      }
      return null;
    };
    const candidates: Array<{ cost: number; apply: () => void } | null> = [
      (() => {
        const hit = escape("top", (a) => a.top + a.height + pad);
        return hit === null ? null : { cost: hit.cost, apply: () => (b.top = hit.value) };
      })(),
      (() => {
        const hit = escape("top", (a, probe) => a.top - pad - probe.height);
        return hit === null ? null : { cost: hit.cost, apply: () => (b.top = hit.value) };
      })(),
      (() => {
        const hit = escape("left", (a) => a.left + a.width + pad);
        return hit === null ? null : { cost: hit.cost, apply: () => (b.left = hit.value) };
      })(),
      (() => {
        const hit = escape("left", (a, probe) => a.left - pad - probe.width);
        return hit === null ? null : { cost: hit.cost, apply: () => (b.left = hit.value) };
      })(),
    ];
    const viable = candidates.filter((move): move is { cost: number; apply: () => void } => move !== null).sort((x, y) => x.cost - y.cost);
    if (viable.length > 0) {
      viable[0]!.apply();
    }
  }
}

// Null anchor (keyboard select / SSR / degenerate projection): a rest layout
// of columns hugging the RIGHT viewport edge, filling top→bottom in canonical
// order and wrapping leftward — every chip on-screen, nothing anchored.
function restLayout(
  present: readonly TendChipId[],
  sizes: Record<TendChipId, TendChipSize>,
  viewport: { width: number; height: number },
): Record<string, TendChipPlacement> {
  const ordered = CANONICAL.filter((id) => present.includes(id));
  const out: Record<string, TendChipPlacement> = {};
  let columnRight = viewport.width - TEND_CHIP_MARGIN;
  let y = TEND_CHIP_MARGIN;
  let columnMaxW = 0;
  for (const id of ordered) {
    const { width, height } = sizes[id];
    if (y > TEND_CHIP_MARGIN && y + height > viewport.height - TEND_CHIP_MARGIN) {
      columnRight -= columnMaxW + REST_COLUMN_GAP;
      columnMaxW = 0;
      y = TEND_CHIP_MARGIN;
    }
    out[id] = {
      left: clamp(columnRight - width, TEND_CHIP_MARGIN, viewport.width - TEND_CHIP_MARGIN - width),
      top: clamp(y, TEND_CHIP_MARGIN, viewport.height - TEND_CHIP_MARGIN - height),
    };
    columnMaxW = Math.max(columnMaxW, width);
    y += height + TEND_CHIP_SEPARATION;
  }
  return out;
}

// ── the layout ──────────────────────────────────────────────────────────────
// One projected anchor rect in, one {left,top} per present chip out. The verb
// arc bottom-aligns to the tree's base (graft roots it); the leaf arc
// top-aligns to the crown (✕ crowns it); receipts rest under the trunk.

// Pull an anchor inside the viewport so both arcs have room. Widest verb chip
// + widest leaf chip + gaps define the minimum breathing room on each side;
// the anchor's box is otherwise preserved (a tree partly on-screen keeps its
// true position). Pure — no DOM, no time.
export function normalizeAnchor(
  anchor: SceneDwellRect,
  viewport: { width: number; height: number },
  sizes: Record<string, TendChipSize>,
): SceneDwellRect {
  const widest = (ids: readonly string[]): number =>
    ids.reduce((max, id) => (sizes[id] !== undefined ? Math.max(max, sizes[id]!.width) : max), 0);
  const leftRoom = widest(VERB_ARC) + ANCHOR_GAP + TEND_CHIP_MARGIN;
  const rightRoom = widest(LEAF_ARC) + ANCHOR_GAP + TEND_CHIP_MARGIN;
  // The band the anchor's LEFT edge may occupy so both columns fit. When the
  // viewport is too narrow for both, center the anchor and let the per-chip
  // clamps share what is left (chips overlap the tree before they leave frame).
  const lo = leftRoom;
  const hi = viewport.width - rightRoom - anchor.width;
  const left = hi < lo ? Math.round((viewport.width - anchor.width) / 2) : clamp(anchor.left, lo, hi);
  const top = clamp(anchor.top, TEND_CHIP_MARGIN, Math.max(TEND_CHIP_MARGIN, viewport.height - TEND_CHIP_MARGIN - anchor.height));
  return { ...anchor, left, top };
}

export function tendChipLayout(
  anchor: SceneDwellRect | null,
  viewport: { width: number; height: number },
  spec: TendChipLayoutSpec,
): Record<string, TendChipPlacement> {
  const sizes = spec.gesture ? GESTURE_SIZES : DESK_SIZES;
  const present = spec.present;
  if (anchor === null) {
    return restLayout(present, sizes, viewport);
  }
  // ANCHOR NORMALIZATION. The flat rig NEVER reframes (RoomScene gates focus
  // off under corner/flat lock — the two projections tile one continuous
  // picture, so moving one wall's camera would tear it), and a wall's own
  // vantage can leave the tree far off-frame: measured live at left=2474 on a
  // 1920 wall. Per-chip clamping then piles BOTH arcs against the same edge —
  // the verb column, the leaf column and the receipts all crushed into the
  // right margin, several clipped away. So the arcs hang off an anchor pulled
  // far enough inside the viewport that a column fits on each side. The halo
  // still rings the real tree wherever it is; only the CHIPS come home.
  anchor = normalizeAnchor(anchor, viewport, sizes);
  const rects: MutableRect[] = [];

  // VERB ARC — left of the tree, bottom-aligned to the base.
  const verbIds = VERB_ARC.filter((id) => present.includes(id));
  if (verbIds.length > 0) {
    const col = stackColumn(verbIds, sizes, viewport.height, "bottom", anchor.top + anchor.height);
    const colRight = anchor.left - ANCHOR_GAP;
    verbIds.forEach((id, index) => {
      const size = sizes[id];
      const centerT = col.total <= 0 ? 0.5 : (col.tops[index]! + size.height / 2 - col.top) / col.total;
      const left = clamp(
        colRight - size.width + arcInset(centerT),
        TEND_CHIP_MARGIN,
        viewport.width - TEND_CHIP_MARGIN - size.width,
      );
      rects.push({ id, left, top: col.tops[index]!, width: size.width, height: size.height });
    });
  }

  // LEAF ARC — right of the tree, top-aligned to the crown.
  const leafIds = LEAF_ARC.filter((id) => present.includes(id));
  if (leafIds.length > 0) {
    const col = stackColumn(leafIds, sizes, viewport.height, "top", anchor.top);
    const colLeft = anchor.left + anchor.width + ANCHOR_GAP;
    leafIds.forEach((id, index) => {
      const size = sizes[id];
      const centerT = col.total <= 0 ? 0.5 : (col.tops[index]! + size.height / 2 - col.top) / col.total;
      const left = clamp(
        colLeft - arcInset(centerT),
        TEND_CHIP_MARGIN,
        viewport.width - TEND_CHIP_MARGIN - size.width,
      );
      rects.push({ id, left, top: col.tops[index]!, width: size.width, height: size.height });
    });
  }

  // ROOT SLOTS — receipts (and QR) centered under the trunk. A wide receipt
  // under a narrow tree would straddle the leaf column's lower chips (its arc
  // bulges up to ARC_CURVE toward the trunk), so the preferred X is bounded
  // by that conservative boundary FIRST — the nudge pass then only handles
  // the residual brushes (e.g. the verb arc overflowing below a tall column).
  const rootIds = ROOT_SLOTS.filter((id) => present.includes(id));
  if (rootIds.length > 0) {
    const col = stackColumn(rootIds, sizes, viewport.height, "top", anchor.top + anchor.height + ANCHOR_GAP);
    const centerX = anchor.left + anchor.width / 2;
    const leafBoundary = anchor.left + anchor.width + ANCHOR_GAP - ARC_CURVE - TEND_CHIP_MIN_SEPARATION;
    rootIds.forEach((id, index) => {
      const size = sizes[id];
      const left = clamp(
        Math.min(centerX - size.width / 2, leafBoundary - size.width),
        TEND_CHIP_MARGIN,
        viewport.width - TEND_CHIP_MARGIN - size.width,
      );
      rects.push({ id, left, top: col.tops[index]!, width: size.width, height: size.height });
    });
  }

  // Deterministic cross-arc nudge (12px pad keeps visual daylight; the arcs'
  // own stacks already carry the full dwell separation).
  nudge(rects, viewport, 12);

  const out: Record<string, TendChipPlacement> = {};
  for (const rect of rects) {
    out[rect.id] = { left: Math.round(rect.left), top: Math.round(rect.top) };
  }
  return out;
}
