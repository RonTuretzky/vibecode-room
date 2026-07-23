import { describe, expect, test } from "bun:test";
import type { HandsFrame, PinchHand } from "./hands-client";
import {
  CONFIRM_FRAMES,
  DOLLY_MAX_STEP,
  FLICK_MAX_YAW,
  HAND_STALE_SECONDS,
  HEIGHT_PER_UNIT,
  PAN_GAIN,
  PinchCam,
  ROTATE_MAX_STEP,
  YAW_PER_UNIT,
  type CameraIntent,
} from "./pinch-cam";

const DT = 1 / 30;
// Ratio values comfortably past both hysteresis thresholds.
const PINCHED = 0.2;
const OPEN = 0.9;

function hand(
  id: number,
  x: number,
  y: number,
  pinch: number | null = PINCHED,
  extra: { pinching?: boolean | null; conf?: number } = {},
): PinchHand {
  return { id, hand: null, x, y, pinch, pinching: extra.pinching ?? null, conf: extra.conf ?? 1 };
}

// aspect defaults to 1 so scripted separations equal the corrected distance;
// the aspect-correction test passes 16/9 explicitly.
function frame(hands: PinchHand[], aspect = 1): HandsFrame {
  return { t: 0, aspect, hands };
}

// Scripted linear motion: position of a coordinate moving a→b over [t0,t1].
function sweep(t: number, t0: number, t1: number, a: number, b: number): number {
  const s = Math.max(0, Math.min(1, (t - t0) / (t1 - t0)));
  return a + (b - a) * s;
}

interface Emitted {
  t: number;
  intent: CameraIntent;
}

// Step the interpreter with a scripted frame feed from t0..t1, collecting
// (t, intent) pairs. Sequential run() calls on one cam continue its state.
function run(cam: PinchCam, feed: (t: number) => HandsFrame, t0: number, t1: number, dt = DT): Emitted[] {
  const out: Emitted[] = [];
  for (let t = t0; t <= t1 + 1e-9; t += dt) {
    for (const intent of cam.update(feed(t), t)) {
      out.push({ t, intent });
    }
  }
  return out;
}

function ofKind<K extends CameraIntent["kind"]>(emitted: Emitted[], kind: K): Extract<CameraIntent, { kind: K }>[] {
  return emitted.map((e) => e.intent).filter((i): i is Extract<CameraIntent, { kind: K }> => i.kind === kind);
}

describe("PinchCam — engagement gating", () => {
  test("open hands drifting produce zero intents", () => {
    const cam = new PinchCam();
    const out = run(cam, (t) => frame([hand(1, sweep(t, 0, 2, 0.2, 0.7), 0.5, OPEN)]), 0, 2);
    expect(out).toHaveLength(0);
  });

  test("single-frame pinch flicker (< CONFIRM_FRAMES) never grabs", () => {
    const cam = new PinchCam();
    const out = run(cam, (t) => frame([hand(1, 0.4, 0.5, Math.abs(t - 0.5) < DT / 2 ? PINCHED : OPEN)]), 0, 1);
    expect(out).toHaveLength(0);
  });

  test("grab lands on the CONFIRM_FRAMES-th consecutive down-vote", () => {
    const cam = new PinchCam();
    const out = run(cam, () => frame([hand(1, 0.4, 0.5)]), 0, 0.2);
    expect(ofKind(out, "grab")).toHaveLength(1);
    expect(out[0].intent.kind).toBe("grab");
    expect(out[0].t).toBeCloseTo((CONFIRM_FRAMES - 1) * DT, 5);
  });
});

describe("PinchCam — ratio hysteresis", () => {
  test("after engage, ratio oscillating 0.28↔0.44 stays engaged", () => {
    const cam = new PinchCam();
    const feed = (t: number) => {
      const i = Math.round(t / DT);
      return frame([hand(1, 0.4, 0.5, i < CONFIRM_FRAMES ? 0.28 : i % 2 === 0 ? 0.28 : 0.44)]);
    };
    const out = run(cam, feed, 0, 1.5);
    expect(ofKind(out, "grab")).toHaveLength(1);
    expect(ofKind(out, "release")).toHaveLength(0);
  });

  test("ratio oscillating 0.32↔0.50 never engages", () => {
    const cam = new PinchCam();
    const feed = (t: number) => frame([hand(1, 0.4, 0.5, Math.round(t / DT) % 2 === 0 ? 0.32 : 0.5)]);
    expect(run(cam, feed, 0, 1.5)).toHaveLength(0);
  });

  test("a single up-vote past PINCH_OFF releases immediately", () => {
    const cam = new PinchCam();
    const out = run(cam, (t) => frame([hand(1, 0.4, 0.5, t < 0.5 ? PINCHED : 0.46)]), 0, 1);
    const releases = out.filter((e) => e.intent.kind === "release");
    expect(releases).toHaveLength(1);
    expect(releases[0].t).toBeGreaterThan(0.5 - DT);
    expect(releases[0].t).toBeLessThan(0.5 + 2 * DT);
  });
});

describe("PinchCam — fallback and confidence gates", () => {
  test("pinch:null falls back to the TD pinching bool", () => {
    const cam = new PinchCam();
    const out = run(cam, (t) => frame([hand(1, 0.4, 0.5, null, { pinching: t < 0.5 })]), 0, 1);
    expect(ofKind(out, "grab")).toHaveLength(1);
    expect(ofKind(out, "release")).toHaveLength(1);
  });

  test("conf below CONF_MIN cannot START a pinch", () => {
    const cam = new PinchCam();
    const out = run(cam, () => frame([hand(1, 0.4, 0.5, PINCHED, { conf: 0.3 })]), 0, 1);
    expect(out).toHaveLength(0);
  });

  test("low conf keeps a pinch it already owns", () => {
    const cam = new PinchCam();
    // Engage at full confidence; confidence then collapses while the ratio
    // stays pinched — the latch must hold until the ratio's own up-vote.
    const feed = (t: number) => frame([hand(1, 0.4, 0.5, t < 1 ? PINCHED : OPEN, { conf: t < 0.2 ? 1 : 0.2 })]);
    const out = run(cam, feed, 0, 1.3);
    expect(ofKind(out, "grab")).toHaveLength(1);
    const releases = out.filter((e) => e.intent.kind === "release");
    expect(releases).toHaveLength(1);
    expect(releases[0].t).toBeGreaterThan(0.95);
  });
});

describe("PinchCam — rotate", () => {
  test("pinch-hold-drag: grab then orbit totals ≈ drag with mouse-parity signs", () => {
    const cam = new PinchCam();
    // +0.1 right, +0.05 down over 1s, then hold so the filter settles.
    const feed = (t: number) => frame([hand(1, sweep(t, 0.2, 1.2, 0.3, 0.4), sweep(t, 0.2, 1.2, 0.6, 0.65))]);
    const out = run(cam, feed, 0, 2);
    expect(out[0].intent.kind).toBe("grab");
    expect(ofKind(out, "release")).toHaveLength(0);
    const orbits = ofKind(out, "orbit");
    expect(orbits.length).toBeGreaterThan(10);
    const sumYaw = orbits.reduce((s, o) => s + o.dYaw, 0);
    const sumHeight = orbits.reduce((s, o) => s + o.dHeight, 0);
    // Hand right → yaw NEGATIVE (grab-the-world), magnitude ≈ 0.1*YAW_PER_UNIT.
    expect(sumYaw).toBeLessThan(-0.09 * YAW_PER_UNIT);
    expect(sumYaw).toBeGreaterThan(-0.11 * YAW_PER_UNIT);
    // Hand DOWN (y-down input) → height POSITIVE, ≈ 0.05*HEIGHT_PER_UNIT.
    expect(sumHeight).toBeGreaterThan(0.045 * HEIGHT_PER_UNIT);
    expect(sumHeight).toBeLessThan(0.055 * HEIGHT_PER_UNIT);
  });
});

describe("PinchCam — flick", () => {
  test("release at speed flicks with the sweep velocity, correct sign", () => {
    const cam = new PinchCam();
    const VX = 0.3; // normalized units/s
    const feed = (t: number) => frame([hand(1, sweep(t, 0.2, 0.7, 0.2, 0.2 + VX * 0.5), 0.5, t <= 0.7 ? PINCHED : OPEN)]);
    const out = run(cam, feed, 0, 1);
    const releases = ofKind(out, "release");
    expect(releases).toHaveLength(1);
    // Scripted velocity −VX*YAW_PER_UNIT; EMA + filter lag within [0.5x, 1.5x].
    expect(releases[0].yawVel).toBeLessThan(-0.5 * VX * YAW_PER_UNIT);
    expect(releases[0].yawVel).toBeGreaterThan(-1.5 * VX * YAW_PER_UNIT);
    expect(releases[0].heightVel).toBe(0); // no vertical motion → under FLICK_MIN_HEIGHT → exact zero
  });

  test("flick velocity is clamped at ±FLICK_MAX_YAW", () => {
    const cam = new PinchCam();
    const feed = (t: number) => frame([hand(1, sweep(t, 0.2, 0.6, 0.1, 0.9), 0.5, t <= 0.6 ? PINCHED : OPEN)]);
    const out = run(cam, feed, 0, 0.8);
    const releases = ofKind(out, "release");
    expect(releases).toHaveLength(1);
    // Raw sweep is 2 units/s → 12 rad/s, far past the cap: clamped exactly.
    expect(releases[0].yawVel).toBe(-FLICK_MAX_YAW);
  });

  test("release after holding still emits zero velocity", () => {
    const cam = new PinchCam();
    // Sweep, then a 1s rest before release: the filter's motion tail dies and
    // the flick EMA decays under FLICK_MIN_YAW → the release is a dead stop.
    const feed = (t: number) => frame([hand(1, sweep(t, 0.2, 0.7, 0.2, 0.4), 0.5, t <= 1.7 ? PINCHED : OPEN)]);
    const out = run(cam, feed, 0, 2);
    const releases = ofKind(out, "release");
    expect(releases).toHaveLength(1);
    expect(releases[0]).toEqual({ kind: "release", yawVel: 0, heightVel: 0 });
  });

  test("post-stall burst frames (queued WS delivery, one clamped timestamp) never inflate the flick", () => {
    const cam = new PinchCam();
    const VX = 0.3; // normalized units/s, true velocity −VX*YAW_PER_UNIT rad/s
    const xAt = (t: number) => 0.2 + VX * Math.max(0, t - 0.2);
    run(cam, (t) => frame([hand(1, xAt(t), 0.5)]), 0, 0.7);
    // 100 ms main-thread stall: three queued frames + the pinch-up all arrive
    // back-to-back with ONE clamped performance.now() reading, each carrying a
    // full frame of real motion. Flooring dt would inflate every sample ~8x
    // and saturate the flick at the cap; those samples must be skipped.
    const tBurst = 0.8;
    const intents: CameraIntent[] = [];
    for (const tTrue of [0.733, 0.766, 0.8]) {
      intents.push(...cam.update(frame([hand(1, xAt(tTrue), 0.5)]), tBurst));
    }
    intents.push(...cam.update(frame([hand(1, xAt(0.8), 0.5, OPEN)]), tBurst));
    const releases = intents.filter((i): i is Extract<CameraIntent, { kind: "release" }> => i.kind === "release");
    expect(releases).toHaveLength(1);
    // The flick reflects the honest pre-stall velocity, never the cap.
    expect(releases[0].yawVel).toBeLessThan(-0.5 * VX * YAW_PER_UNIT);
    expect(releases[0].yawVel).toBeGreaterThan(-1.5 * VX * YAW_PER_UNIT);
  });

  test("stale mid-pinch eviction cancels with EXACTLY zero velocity", () => {
    const cam = new PinchCam();
    // Sweeping at speed when tracking drops: never a flick (pointercancel).
    const feed = (t: number) => (t <= 0.5 ? frame([hand(1, sweep(t, 0.1, 0.5, 0.2, 0.5), 0.5)]) : frame([]));
    const out = run(cam, feed, 0, 1.2);
    const releases = out.filter((e) => e.intent.kind === "release");
    expect(releases).toHaveLength(1);
    expect(releases[0].intent).toEqual({ kind: "release", yawVel: 0, heightVel: 0 });
    // The cancel lands one staleness window after the hand vanished.
    expect(releases[0].t).toBeGreaterThan(0.5 + HAND_STALE_SECONDS - 1e-9);
    expect(releases[0].t).toBeLessThan(0.5 + HAND_STALE_SECONDS + 3 * DT);
  });
});

describe("PinchCam — teleport guard", () => {
  test("a slot-swap-sized jump (raw 0.25) is swallowed whole: no orbit, no chase, no phantom flick", () => {
    const cam = new PinchCam();
    // Engage and settle at x=0.3.
    const settled = run(cam, () => frame([hand(1, 0.3, 0.5)]), 0, 0.5);
    expect(ofKind(settled, "grab")).toHaveLength(1);
    // Raw jump of 0.25 — a typical inter-hand distance, the exact slot-swap
    // case the guard exists for. The RAW-delta check resets the filter, so the
    // smoothed position SNAPS and the step guard discards it once: total
    // emitted orbit must be ZERO — silence, not a multi-frame whip.
    const after = run(cam, () => frame([hand(1, 0.55, 0.5)]), 0.5 + DT, 1.0);
    expect(ofKind(after, "release")).toHaveLength(0);
    const swallowed = ofKind(after, "orbit").reduce((s, o) => s + Math.abs(o.dYaw) + Math.abs(o.dHeight), 0);
    expect(swallowed).toBe(0);
    // Release right after: motion the user never made must never flick.
    const rel = run(cam, () => frame([hand(1, 0.55, 0.5, OPEN)]), 1.0 + DT, 1.0 + DT);
    expect(ofKind(rel, "release")).toEqual([{ kind: "release", yawVel: 0, heightVel: 0 }]);
  });

  test("after a swallowed teleport, a normal drag tracks again (re-anchored, not stuck)", () => {
    const cam = new PinchCam();
    run(cam, () => frame([hand(1, 0.3, 0.5)]), 0, 0.5);
    run(cam, () => frame([hand(1, 0.55, 0.5)]), 0.5 + DT, 0.7);
    const drag = run(cam, (t) => frame([hand(1, 0.55 + sweep(t, 0.7 + DT, 1.0, 0, 0.05), 0.5)]), 0.7 + DT, 1.5);
    const sumYaw = ofKind(drag, "orbit").reduce((s, o) => s + o.dYaw, 0);
    expect(sumYaw).toBeLessThan(-0.035 * YAW_PER_UNIT);
    expect(sumYaw).toBeGreaterThan(-0.075 * YAW_PER_UNIT);
  });
});

describe("PinchCam — two-hand zoom", () => {
  test("spreading hands zooms IN: scales telescope to d0/d1 ≈ 0.5", () => {
    const cam = new PinchCam();
    // Separation 0.2 → 0.4 about a fixed midpoint, then hold to settle.
    const feed = (t: number) =>
      frame([hand(1, sweep(t, 0.3, 1.3, 0.4, 0.3), 0.5), hand(2, sweep(t, 0.3, 1.3, 0.6, 0.7), 0.5)]);
    const out = run(cam, feed, 0, 2);
    expect(ofKind(out, "grab")).toHaveLength(1); // ONE grab for the pair
    expect(ofKind(out, "release")).toHaveLength(0);
    const zooms = ofKind(out, "zoom");
    expect(zooms.length).toBeGreaterThan(10);
    const product = zooms.reduce((p, z) => p * z.scale, 1);
    expect(product).toBeGreaterThan(0.45); // ≈ 0.2/0.4, deadband + filter tolerance
    expect(product).toBeLessThan(0.56);
  });

  test("closing hands zooms OUT: product ≈ 2", () => {
    const cam = new PinchCam();
    const feed = (t: number) =>
      frame([hand(1, sweep(t, 0.3, 1.3, 0.3, 0.4), 0.5), hand(2, sweep(t, 0.3, 1.3, 0.7, 0.6), 0.5)]);
    const product = ofKind(run(cam, feed, 0, 2), "zoom").reduce((p, z) => p * z.scale, 1);
    expect(product).toBeGreaterThan(1.7);
    expect(product).toBeLessThan(2.2);
  });

  test("static separation: deadband holds, no zoom", () => {
    const cam = new PinchCam();
    const out = run(cam, () => frame([hand(1, 0.4, 0.5), hand(2, 0.6, 0.5)]), 0, 1);
    expect(ofKind(out, "zoom")).toHaveLength(0);
  });

  test("a teleporting hand in zoom mode is swallowed and re-baselined — no dolly jerk, no pan jump", () => {
    const cam = new PinchCam();
    // Engage and break the deadband with a small spread first.
    run(
      cam,
      (t) => frame([hand(1, sweep(t, 0.2, 0.5, 0.4, 0.38), 0.5), hand(2, sweep(t, 0.2, 0.5, 0.6, 0.62), 0.5)]),
      0,
      0.8,
    );
    // Hand 2 teleports inward: raw separation collapses 0.24 → 0.08 and the
    // midpoint snaps 0.16 at once — the frame is swallowed and re-baselined
    // (one-frame pause), so neither a dolly step nor a pan jerk leaks through.
    const jump = run(cam, () => frame([hand(1, 0.38, 0.5), hand(2, 0.3, 0.5)]), 0.8 + DT, 1.2);
    const dollyMag = ofKind(jump, "zoom").reduce((s, z) => s + Math.abs(Math.log(z.scale)), 0);
    expect(dollyMag).toBeLessThan(0.02); // pre-fix leak: one log(DOLLY_MAX_STEP) ≈ 0.22 step
    const panMag = ofKind(jump, "pan").reduce((s, p) => s + Math.abs(p.dx) + Math.abs(p.dy), 0);
    expect(panMag).toBeLessThan(0.01); // pre-fix leak: ≈ 0.16 * PAN_GAIN
    // Zooming resumes against the NEW baseline: closing 0.08 → 0.06 zooms OUT.
    const resumed = run(
      cam,
      (t) =>
        frame([
          hand(1, 0.38 - sweep(t, 1.2 + DT, 1.5, 0, 0.01), 0.5),
          hand(2, 0.3 + sweep(t, 1.2 + DT, 1.5, 0, 0.01), 0.5),
        ]),
      1.2 + DT,
      1.8,
    );
    const scales = ofKind(resumed, "zoom").map((z) => z.scale);
    for (const s of scales) {
      expect(s).toBeLessThanOrEqual(DOLLY_MAX_STEP);
    }
    expect(scales.reduce((p, s) => p * s, 1)).toBeGreaterThan(1.15); // net zoom OUT ≈ 0.08/0.06
  });

  test("overlapping hands (below ZOOM_MIN_DIST) never zoom", () => {
    const cam = new PinchCam();
    const feed = (t: number) => {
      const wobble = 0.004 * Math.sin(t * 20);
      return frame([hand(1, 0.495 - wobble / 2, 0.5), hand(2, 0.505 + wobble / 2, 0.5)]);
    };
    expect(ofKind(run(cam, feed, 0, 0.8), "zoom")).toHaveLength(0);
  });

  test("midpoint drift pans with PAN_GAIN; constant separation never zooms", () => {
    const cam = new PinchCam();
    const feed = (t: number) => {
      const dx = sweep(t, 0.3, 1.3, 0, 0.1);
      const dy = sweep(t, 0.3, 1.3, 0, 0.05);
      return frame([hand(1, 0.3 + dx, 0.45 + dy), hand(2, 0.5 + dx, 0.45 + dy)]);
    };
    const out = run(cam, feed, 0, 2);
    const pans = ofKind(out, "pan");
    const sumX = pans.reduce((s, p) => s + p.dx, 0);
    const sumY = pans.reduce((s, p) => s + p.dy, 0);
    expect(sumX).toBeGreaterThan(0.09 * PAN_GAIN);
    expect(sumX).toBeLessThan(0.11 * PAN_GAIN);
    expect(sumY).toBeGreaterThan(0.04 * PAN_GAIN);
    expect(sumY).toBeLessThan(0.06 * PAN_GAIN);
    expect(ofKind(out, "zoom")).toHaveLength(0);
  });

  test("inter-hand distance is aspect-corrected (horizontal→vertical at 16:9 ≈ aspect)", () => {
    const cam = new PinchCam();
    const A = 16 / 9;
    // Rotate a constant 0.2 separation from horizontal to vertical about a
    // fixed midpoint: corrected distance goes 0.2*A → 0.2, so the telescoped
    // product ≈ A. Without aspect correction it would be ≈ 1.
    const feed = (t: number) => {
      const s = Math.max(0, Math.min(1, (t - 0.3) / 1));
      return frame([hand(1, 0.4 + 0.1 * s, 0.5 - 0.1 * s), hand(2, 0.6 - 0.1 * s, 0.5 + 0.1 * s)], A);
    };
    const product = ofKind(run(cam, feed, 0, 2), "zoom").reduce((p, z) => p * z.scale, 1);
    expect(product).toBeGreaterThan(A * 0.9);
    expect(product).toBeLessThan(A * 1.1);
  });
});

describe("PinchCam — transitions", () => {
  test("1→2 seeds the zoom baseline at second-confirm: no zoom jump", () => {
    const cam = new PinchCam();
    // Hand 1 rotates a little, then rests before hand 2 arrives.
    const phase1 = run(cam, (t) => frame([hand(1, sweep(t, 0.1, 0.3, 0.3, 0.35), 0.5)]), 0, 0.55 - DT);
    expect(ofKind(phase1, "grab")).toHaveLength(1);
    // Hand 2 appears OPEN far away, then pinches; both hold still after.
    const feed2 = (t: number) => frame([hand(1, 0.35, 0.5), hand(2, 0.75, 0.5, t < 0.7 ? OPEN : PINCHED)]);
    const out = run(cam, feed2, 0.55, 1.2);
    expect(ofKind(out, "grab")).toHaveLength(0); // same grab throughout — no re-grab
    expect(ofKind(out, "release")).toHaveLength(0);
    expect(ofKind(out, "zoom")).toHaveLength(0); // baseline seeded at CURRENT positions → static hold = no jump
    // A real spread afterwards DOES zoom — the pair is live.
    const spread = run(
      cam,
      (t) => frame([hand(1, sweep(t, 1.25, 1.55, 0.35, 0.3), 0.5), hand(2, sweep(t, 1.25, 1.55, 0.75, 0.8), 0.5)]),
      1.2 + DT,
      1.9,
    );
    expect(ofKind(spread, "zoom").length).toBeGreaterThan(0);
  });

  test("2→1: the survivor keeps the grab seamlessly (no release, no orbit jump)", () => {
    const cam = new PinchCam();
    run(cam, () => frame([hand(1, 0.35, 0.5), hand(2, 0.65, 0.5)]), 0, 0.5 - DT);
    // Hand 2 releases; hand 1 stays pinched and still.
    const mid = run(cam, () => frame([hand(1, 0.35, 0.5), hand(2, 0.65, 0.5, OPEN)]), 0.5, 0.8);
    expect(ofKind(mid, "release")).toHaveLength(0);
    expect(ofKind(mid, "grab")).toHaveLength(0);
    for (const o of ofKind(mid, "orbit")) {
      expect(Math.abs(o.dYaw)).toBeLessThan(0.01); // anchored at the survivor's CURRENT pos → no jump
      expect(Math.abs(o.dHeight)).toBeLessThan(0.05);
    }
    // The survivor now drags: orbit tracks it (hand 2 gone entirely).
    const drag = run(cam, (t) => frame([hand(1, sweep(t, 0.85, 1.15, 0.35, 0.41), 0.5)]), 0.8 + DT, 1.6);
    const sumYaw = ofKind(drag, "orbit").reduce((s, o) => s + o.dYaw, 0);
    expect(sumYaw).toBeLessThan(-0.05 * YAW_PER_UNIT);
    expect(sumYaw).toBeGreaterThan(-0.07 * YAW_PER_UNIT);
  });

  test("both hands dropping emits exactly one dead-stop release", () => {
    const cam = new PinchCam();
    run(cam, () => frame([hand(1, 0.4, 0.5), hand(2, 0.6, 0.5)]), 0, 0.4 - DT);
    const out = run(cam, () => frame([hand(1, 0.4, 0.5, OPEN), hand(2, 0.6, 0.5, OPEN)]), 0.4, 0.8);
    const releases = ofKind(out, "release");
    expect(releases).toHaveLength(1);
    expect(releases[0]).toEqual({ kind: "release", yawVel: 0, heightVel: 0 }); // zoom stops DEAD — no dolly inertia
    expect(ofKind(out, "grab")).toHaveLength(0);
  });
});

describe("PinchCam — idleTick", () => {
  test("stream silence releases a held grab via idleTick", () => {
    const cam = new PinchCam();
    const held = run(cam, () => frame([hand(1, 0.4, 0.5)]), 0, 0.2);
    expect(ofKind(held, "grab")).toHaveLength(1);
    // Before the staleness window: still grabbed, and — no samples — SILENT
    // (an idle tick fabricating orbit intents would fake motion).
    expect(cam.idleTick(0.2 + HAND_STALE_SECONDS / 2)).toEqual([]);
    // Past it: the latched hand is evicted → zero-velocity cancel.
    const late = cam.idleTick(0.2 + HAND_STALE_SECONDS + 0.05);
    expect(late).toEqual([{ kind: "release", yawVel: 0, heightVel: 0 }]);
    // Idle stays silent.
    expect(cam.idleTick(1)).toEqual([]);
  });

  test("watchdog ticks interleaved into a live drag are silent and leave the flick untouched", () => {
    // The layer's 250 ms watchdog calls idleTick between WS frames during
    // every drag — it must not emit and must not dilute the flick EMA.
    const flickOf = (withIdleTicks: boolean): number => {
      const cam = new PinchCam();
      const feed = (t: number) => frame([hand(1, sweep(t, 0.2, 0.7, 0.2, 0.35), 0.5, t <= 0.7 ? PINCHED : OPEN)]);
      const out: Emitted[] = [];
      for (let t = 0; t <= 1 + 1e-9; t += DT) {
        for (const intent of cam.update(feed(t), t)) {
          out.push({ t, intent });
        }
        if (withIdleTicks) {
          expect(cam.idleTick(t + DT / 2)).toEqual([]);
        }
      }
      const releases = ofKind(out, "release");
      expect(releases).toHaveLength(1);
      return releases[0].yawVel;
    };
    const baseline = flickOf(false);
    expect(baseline).toBeLessThan(0); // sanity: the sweep produces a real flick
    expect(flickOf(true)).toBe(baseline);
  });
});
