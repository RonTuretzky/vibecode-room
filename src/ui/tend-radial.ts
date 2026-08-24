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
  | "qr"
  // Fleet-tree chips (the generalized constellation — TreeMenu's non-self
  // body speaks the same chip vocabulary): concept lanes ride the leaf arc
  // like branch cards, the action verbs (brief/live/deck/grow) join the verb
  // arc above the steer chip, remove roots it, and replant rests with the
  // receipts at the roots.
  | "lane-0"
  | "lane-1"
  | "lane-2"
  | "lane-3"
  | "brief"
  | "live"
  | "deck"
  | "grow"
  | "replant"
  | "remove";

export interface TendChipSize {
  width: number;
  height: number;
}

export interface TendChipPlacement {
  left: number;
  top: number;
  // A HARD CEILING, present only when the arc could not afford this chip's
  // full nominal and squeezed it (see FLEXIBLE_CHIPS). The renderer applies it
  // as max-height, so the budget the layout reserved is the budget the chip
  // actually occupies — otherwise the chip below is painted over and its
  // centre goes dead, which is the whole failure this module exists to avoid.
  height?: number;
}

// NOMINAL chip footprints (desk / gesture-XL). The rendered chips take these
// widths inline (single source of truth) and their CSS min-heights sit at or
// under the nominal heights, so the pure layout's separation budget holds on
// the real wall. Heights carry headroom for the taller transient states
// (armed sub-lines, halt receipts) — the 48px separation absorbs the rest.
//
// A nominal that under-states what a chip DRAWS is not a rounding error: the
// arc budgets from these numbers, so the chip below gets painted over, and a
// covered chip centre is a dead dwell target (GestureLayer's elementFromPoint
// occlusion check drops it). `scripts/measure-tend-chips.tsx` renders the
// surface in a real browser and prints every chip's true rect; the RECORD
// heights below come from it, and tend-radial.test.ts re-asserts them so a CSS
// change that grows the record surface fails out loud instead of quietly
// eating the next chip.
//
// MEASURED (1920×1080, echo full): 221px desk, 314px gesture — a 128px press
// over the echo box (max-height 9rem) inside the chip padding.
export const RECORD_CHIP_HEIGHT = { desk: 232, gesture: 324 } as const;
// …and the least a record chip may be squeezed to when the arc cannot afford
// its full height (FLEXIBLE_CHIPS, below): the press itself, at wall scale,
// plus the chip's padding. Below this the button stops being a dwell target,
// which is worse than a shorter echo.
export const RECORD_CHIP_MIN_HEIGHT = { desk: 96, gesture: 172 } as const;

// CHIPS WHOSE HEIGHT IS NEGOTIABLE. A busy adopted tree at gesture scale
// spends 716 of its 1048px verb column on identity + settled + brief + live +
// deck + remove; a full-size record surface (324) does not fit after them at
// ANY honest separation. The record chips are the only ones that can give: the
// press keeps its wall-scale height and the ECHO — which is a rolling tail of
// what was just said, not a claim the operator has to read — takes the cut.
// Every other chip is text that would be sliced mid-sentence.
const FLEXIBLE_CHIPS: ReadonlySet<TendChipId> = new Set<TendChipId>(["graft", "grow"]);

function minHeightOf(id: TendChipId, gesture: boolean): number {
  return FLEXIBLE_CHIPS.has(id) ? (gesture ? RECORD_CHIP_MIN_HEIGHT.gesture : RECORD_CHIP_MIN_HEIGHT.desk) : Number.POSITIVE_INFINITY;
}

export const DESK_SIZES: Record<TendChipId, TendChipSize> = {
  // The identity plate is four stacked lines (eyebrow / title / callsign /
  // status) and a long inferred title wraps: measured 120 desk, 152 gesture.
  identity: { width: 250, height: 124 },
  close: { width: 64, height: 52 },
  // THE RECORD SURFACE, not a verb row. Budgeted as a one-line verb (96 desk /
  // 190 gesture) it drew its echo straight over the chip below and killed that
  // chip's centre. `grow` renders the IDENTICAL component; `graft` was
  // under-budgeted the same way and only looked safe because nothing follows
  // it on the self arc — until a take-home QR appeared under the trunk.
  graft: { width: 280, height: RECORD_CHIP_HEIGHT.desk },
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
  "lane-0": { width: 310, height: 68 },
  "lane-1": { width: 310, height: 68 },
  "lane-2": { width: 310, height: 68 },
  "lane-3": { width: 310, height: 68 },
  // Verb-chip nominals cover the REAL rendered minimum: 56px verb button +
  // 24px chip padding + 2px border = 82 — an under-budgeted nominal quietly
  // eats the separation the dwell hitboxes rely on.
  brief: { width: 280, height: 84 },
  live: { width: 280, height: 84 },
  deck: { width: 280, height: 84 },
  // GROW renders the SAME RecordSteerToggle the graft chip does, so it takes
  // the same VERTICAL budget; the width is its own (it sits in the wider fleet
  // column).
  grow: { width: 310, height: RECORD_CHIP_HEIGHT.desk },
  replant: { width: 280, height: 84 },
  remove: { width: 280, height: 84 },
};

const GESTURE_SIZES: Record<TendChipId, TendChipSize> = {
  identity: { width: 300, height: 156 },
  close: { width: 120, height: 104 },
  graft: { width: 390, height: RECORD_CHIP_HEIGHT.gesture },
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
  // Root-slot chips stay NARROW at gesture scale: the free band between the
  // two arcs' bulged edges is ~290px on a busy fleet tree — a wider receipt
  // has nowhere to rest and the nudge pass can only trade overlap for
  // off-screen.
  // Long verbatim refusals wrap in the narrow band — the taller nominal
  // keeps the wrapped receipt from eating the next chip's separation.
  note: { width: 280, height: 120 },
  error: { width: 280, height: 120 },
  qr: { width: 260, height: 270 },
  // Fleet chips render with trimmed 8px chip padding at gesture scale
  // (TreeMenu.css), so a 96px-floor interactive row yields a 114px chip —
  // these nominals cover that real footprint.
  "lane-0": { width: 420, height: 116 },
  "lane-1": { width: 420, height: 116 },
  "lane-2": { width: 420, height: 116 },
  "lane-3": { width: 420, height: 116 },
  brief: { width: 390, height: 116 },
  live: { width: 390, height: 116 },
  deck: { width: 390, height: 116 },
  // …and at gesture scale both record chips keep the record surface's own
  // budget (the 128px press + the capped echo + full chip padding), not the
  // trimmed verb-row one.
  grow: { width: 420, height: RECORD_CHIP_HEIGHT.gesture },
  replant: { width: 280, height: 116 },
  remove: { width: 390, height: 116 },
};

export function tendChipSize(id: TendChipId, gesture: boolean): TendChipSize {
  return (gesture ? GESTURE_SIZES : DESK_SIZES)[id];
}

// ── arc membership ──────────────────────────────────────────────────────────
// VERB ARC (left of the tree), top → bottom: the identity plate crowns it,
// the trunk verbs sit mid-height, whatever is growing sits beside its ✂, and
// graft roots the arc at the tree's base.
// Fleet-only ids interleave where their meaning sits: brief/live/deck/grow
// are action verbs above the steer/graft chip at the base, remove is the
// danger verb below everything. A present-set never mixes self-only and
// fleet-only ids, so the self constellation's slots are byte-identical to
// before.
const VERB_ARC: readonly TendChipId[] = [
  "identity",
  "here",
  "growing",
  "settled",
  "halt-note",
  "brief",
  "live",
  "deck",
  "grow",
  "graft",
  "remove",
];
// LEAF ARC (right of the tree), top → bottom: ✕ crowns it; concept lanes fill
// the crown on fleet trees; the focus view (prune among the limbs) or the
// paginated leaf-chips fill it on trees with branches; the pager hangs below
// the last leaf. Lanes and branch cards SHARE the four leaf slots (TreeMenu
// pages branches into the remainder) so the arc's vertical budget is bounded
// at gesture sizes — a 1080p wall cannot stack both families in full.
const LEAF_ARC: readonly TendChipId[] = [
  "close",
  "lane-0",
  "lane-1",
  "lane-2",
  "lane-3",
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
// FIXED SLOTS below the tree: replant and the take-home QR first (STATIONARY
// — a dwell button must never move because a transient receipt mounted above
// it), then the honest receipts, which come and go on their own budgets. The
// layout stacks the two groups independently (see the root-slot pass below).
const ROOT_PERSISTENT: readonly TendChipId[] = ["replant", "qr"];
const ROOT_TRANSIENT: readonly TendChipId[] = ["note", "error"];
const ROOT_SLOTS: readonly TendChipId[] = [...ROOT_PERSISTENT, ...ROOT_TRANSIENT];

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
//
// THE ORDER OF CONCESSIONS matters. Separation goes first: it is slack, and
// the floor is where it stops being slack. Only then does a FLEXIBLE chip give
// up height, down to its own floor. The alternative — what this module used to
// do — was to keep every nominal, overflow the column, and clamp: the run then
// runs off the bottom of the wall and the chips inside it sit exactly where a
// taller neighbour paints over them.
function stackColumn(
  ids: readonly TendChipId[],
  sizes: Record<TendChipId, TendChipSize>,
  viewportH: number,
  align: "top" | "bottom",
  anchorEdgeY: number,
  gesture: boolean,
): { tops: number[]; heights: number[]; sep: number; top: number; total: number } {
  const heights = ids.map((id) => sizes[id].height);
  const avail = viewportH - 2 * TEND_CHIP_MARGIN;
  const gaps = Math.max(0, ids.length - 1);
  const sumOf = (): number => heights.reduce((a, b) => a + b, 0);
  let sep = TEND_CHIP_SEPARATION;
  if (ids.length > 1 && sumOf() + sep * gaps > avail) {
    sep = Math.max(TEND_CHIP_MIN_SEPARATION, (avail - sumOf()) / gaps);
  }
  // Still over budget at the separation floor: take it out of the chips that
  // can afford to give, largest overshoot first, never past their floors.
  let excess = sumOf() + sep * gaps - avail;
  if (excess > 0) {
    const flexible = ids
      .map((id, index) => ({ index, give: heights[index]! - minHeightOf(id, gesture) }))
      .filter((entry) => entry.give > 0)
      .sort((a, b) => b.give - a.give);
    for (const entry of flexible) {
      if (excess <= 0) {
        break;
      }
      const take = Math.min(entry.give, excess);
      heights[entry.index] = heights[entry.index]! - take;
      excess -= take;
    }
  }
  const total = sumOf() + sep * gaps;
  let top = align === "top" ? anchorEdgeY : anchorEdgeY - total;
  top = clamp(top, TEND_CHIP_MARGIN, viewportH - TEND_CHIP_MARGIN - total);
  const tops: number[] = [];
  let y = top;
  for (const h of heights) {
    tops.push(y);
    y += h + sep;
  }
  return { tops, heights, sep, top, total };
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
    const col = stackColumn(verbIds, sizes, viewport.height, "bottom", anchor.top + anchor.height, spec.gesture);
    const colRight = anchor.left - ANCHOR_GAP;
    verbIds.forEach((id, index) => {
      const size = sizes[id];
      const height = col.heights[index]!;
      const centerT = col.total <= 0 ? 0.5 : (col.tops[index]! + height / 2 - col.top) / col.total;
      const left = clamp(
        colRight - size.width + arcInset(centerT),
        TEND_CHIP_MARGIN,
        viewport.width - TEND_CHIP_MARGIN - size.width,
      );
      rects.push({ id, left, top: col.tops[index]!, width: size.width, height });
    });
  }

  // LEAF ARC — right of the tree, top-aligned to the crown.
  const leafIds = LEAF_ARC.filter((id) => present.includes(id));
  if (leafIds.length > 0) {
    const col = stackColumn(leafIds, sizes, viewport.height, "top", anchor.top, spec.gesture);
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

  // ROOT SLOTS — replant/QR and the receipts under the trunk. A wide chip
  // under a narrow tree would straddle the leaf column's lower chips (its arc
  // bulges up to ARC_CURVE toward the trunk), so the preferred X is bounded
  // by that conservative boundary FIRST — the nudge pass then only handles
  // the residual brushes (e.g. the verb arc overflowing below a tall column).
  //
  // TWO-PART STACK: the persistent chips (replant — a dwell BUTTON — and the
  // QR) are stacked and clamped on their own, so a transient receipt mounting
  // or fading can NEVER move them (a shared column's whole-run clamp used to
  // pull the replant button up out from under a mid-dwell cursor whenever a
  // receipt landed). Receipts then append below, each clamped individually;
  // the nudge pass resolves whatever they brush.
  const centerX = anchor.left + anchor.width / 2;
  const leafBoundary = anchor.left + anchor.width + ANCHOR_GAP - ARC_CURVE - TEND_CHIP_MIN_SEPARATION;
  const rootLeft = (size: TendChipSize): number =>
    clamp(
      Math.min(centerX - size.width / 2, leafBoundary - size.width),
      TEND_CHIP_MARGIN,
      viewport.width - TEND_CHIP_MARGIN - size.width,
    );
  const persistentRoot = ROOT_PERSISTENT.filter((id) => present.includes(id));
  let rootCursor = anchor.top + anchor.height + ANCHOR_GAP;
  if (persistentRoot.length > 0) {
    const col = stackColumn(persistentRoot, sizes, viewport.height, "top", rootCursor, spec.gesture);
    persistentRoot.forEach((id, index) => {
      const size = sizes[id];
      rects.push({ id, left: rootLeft(size), top: col.tops[index]!, width: size.width, height: size.height });
    });
    const last = sizes[persistentRoot[persistentRoot.length - 1]!];
    rootCursor = col.tops[persistentRoot.length - 1]! + last.height + col.sep;
  }
  // The receipts append BELOW the persistent stack while the wall has room —
  // and stack UPWARD from the trunk when it does not. Clamping them to the
  // bottom margin instead (what this did) put every over-budget receipt on the
  // SAME line, one painted over the other and both over the verb arc's last
  // chip — the 🗑 remove button, whose centre then stopped being a dwell
  // target. Measured at gesture scale on a tree carrying a QR, a full leaf
  // page and both receipts.
  let upwardCursor = anchor.top + anchor.height + ANCHOR_GAP;
  for (const id of ROOT_TRANSIENT.filter((candidate) => present.includes(candidate))) {
    const size = sizes[id];
    const fitsBelow = rootCursor + size.height <= viewport.height - TEND_CHIP_MARGIN;
    const top = fitsBelow
      ? rootCursor
      : clamp(upwardCursor - size.height - TEND_CHIP_SEPARATION, TEND_CHIP_MARGIN, viewport.height - TEND_CHIP_MARGIN - size.height);
    rects.push({ id, left: rootLeft(size), top, width: size.width, height: size.height });
    if (fitsBelow) {
      rootCursor = top + size.height + TEND_CHIP_SEPARATION;
    } else {
      upwardCursor = top;
    }
  }

  // Deterministic cross-arc nudge (12px pad keeps visual daylight; the arcs'
  // own stacks already carry the full dwell separation).
  nudge(rects, viewport, 12);

  const out: Record<string, TendChipPlacement> = {};
  for (const rect of rects) {
    // The ceiling rides out ONLY when the column squeezed this chip below its
    // nominal — an unconditional max-height would clip every chip that renders
    // a few px taller than its budget (a wrapped receipt, a two-line title),
    // and clipping words is a different kind of lying.
    const squeezed = rect.height < sizes[rect.id].height;
    out[rect.id] = {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      ...(squeezed ? { height: Math.round(rect.height) } : {}),
    };
  }
  return out;
}
