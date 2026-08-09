// Pure pinch → camera-intent interpreter for the TouchDesigner hands stream.
// ONE latched hand = grab-the-world orbit with a flick on release (fed to the
// rig's EXISTING inertia path) PLUS a depth dolly: the palm's apparent size is
// the monocular depth proxy (hand toward the camera = palm grows = move
// forward), telescoping by the same per-frame ratio math as the two-hand
// spread. TWO latched hands = ratio-preserving zoom (radius *= d_prev/d_curr —
// spreading zooms IN, release stops dead) plus a gentle damped midpoint pan.
// Pure logic — no DOM, no sockets, no three.js — so the whole state machine is
// unit-testable with scripted HandsFrame feeds.
// All timestamps are SECONDS on the CALLER's clock (never frame.t).

import { OneEuroFilter, Point2DFilter } from "./core";
import type { HandsFrame, PinchHand } from "./hands-client";

// Pinch detection (browser-authoritative on the continuous ratio; the TD
// `pinching` bool is transport-level FALLBACK only, used when the ratio is absent).
export const PINCH_ON = 0.3; // ratio below = down-vote to engage
export const PINCH_OFF = 0.45; // latched hand releases only above — wide gap = never flaps
export const CONFIRM_FRAMES = 2; // consecutive down-votes to engage (~66 ms @30 Hz — kills flicker)
export const RELEASE_FRAMES = 3; // release debounced: a 1-frame tracking dip mid-drag must not drop the orbit (Ultraleap-style state persistence)
export const CONF_MIN = 0.5; // below this a hand cannot START a pinch (but keeps one it owns)
export const HAND_STALE_SECONDS = 0.25; // latched hand unseen this long = CANCEL (release WITHOUT flick)
// Rotate
export const YAW_PER_UNIT = 3.5; // rad per full camera-frame of horizontal travel (~200°: high enough to orbit in one sweep, low enough that hand wobble stays sub-degree)
export const HEIGHT_PER_UNIT = 12; // world units per full-frame vertical travel — under half the height envelope per gesture, so aiming a band is possible
export const ROTATE_MAX_STEP = 0.12; // max normalized move per frame; larger = teleport/slot-swap → discard + re-anchor
// Flick (feeds the rig's EXISTING inertia path — a hand release coasts like a mouse flick)
export const FLICK_EMA = 0.75; // matches the mouse drag's velocity EMA (RoomScene.tsx:1385)
export const FLICK_MAX_AGE_SECONDS = 0.15; // no flick if the last real motion sample is older (loss-of-tracking never launches the camera)
export const FLICK_MIN_YAW = 0.05; // rad/s; below = release emits zero yaw velocity
export const FLICK_MIN_HEIGHT = 0.2; // units/s; below = release emits zero height velocity
export const FLICK_MAX_YAW = 4.0; // cap (rad/s)
export const FLICK_MAX_HEIGHT = 30; // cap (units/s)
// Two-hand zoom / pan
export const ZOOM_MIN_DIST = 0.02; // hands overlapping → ratio untrustworthy, skip zoom that frame
export const DOLLY_DEADBAND = 0.015; // |d/d_seed - 1| must exceed this once before zoom engages (kills micro-zoom while holding)
export const DOLLY_MAX_STEP = 1.25; // per-frame scale clamp to [1/1.25, 1.25] (teleport/filter-reset defense)
export const PAN_GAIN = 0.6; // midpoint pan, fraction of mouse-pan feel (gentler so zoom doesn't drift)
// One-hand depth dolly (palm size = monocular depth proxy; needs the bridge's
// `lm` skeleton — hands_mediapipe.py sends it, the TD stream may not: no
// skeleton simply means no dolly, rotate is unaffected).
export const DEPTH_DEADBAND = 0.08; // |span/span_seed - 1| must exceed this once — palm pitch wobbles size more than two-hand spread wobbles distance
export const DEPTH_MIN_SPAN = 0.015; // palm smaller than this (too far from the camera) = size ratio untrustworthy, skip
export const DEPTH_JUMP_RATIO = 1.5; // one-frame raw span jump beyond this factor = tracking glitch → reset the size filter (position-teleport analogue)
// Input smoothing (we own it — TD is a new source; a Lag CHOP upstream is optional belt+braces).
export const FILTER_MINCUTOFF = 1.0; // raise BETA if fast sweeps lag; lower it if jittery
export const FILTER_BETA = 0.15;
export const FILTER_DCUTOFF = 1.0;

// What the pinch layer asks of the camera rig. All deltas are per-frame and
// incremental; pan dx/dy are normalized viewport units, y-down.
export type CameraIntent =
  | { kind: "grab" }
  | { kind: "release"; yawVel: number; heightVel: number }
  | { kind: "orbit"; dYaw: number; dHeight: number }
  | { kind: "zoom"; scale: number }
  | { kind: "pan"; dx: number; dy: number };

interface HandTrack {
  filter: Point2DFilter;
  sx: number; // smoothed position (normalized, y-down)
  sy: number;
  rawX: number; // last RAW sample — teleport detection must see the unfiltered
  rawY: number; // jump (the 1-Euro filter dilutes a one-frame jump ~5x, so a
  // smoothed-delta check alone lets slot-swaps whip the camera via the chase)
  sizeFilter: OneEuroFilter; // palm-span smoothing (the depth proxy is noisier than position)
  sSize: number | null; // smoothed palm span; null until the bridge sends a skeleton
  rawSize: number | null; // last RAW span — the size-jump guard must see the unfiltered value
  lastSeen: number; // seconds, caller's clock
  latched: boolean;
  downStreak: number; // consecutive down-votes while unlatched
  upStreak: number; // consecutive up-votes while latched (release debounce)
}

// Palm span from the 21-point skeleton: wrist→middle-MCP, guarded against palm
// pitch foreshortening by the knuckle span (the same formula hands-page.ts uses
// to normalize its pinch ratio), aspect-corrected like the inter-hand distance.
// Apparent span ∝ 1/distance-from-camera — the monocular depth signal.
export function palmSpan(lm: PinchHand["lm"], aspect: number): number | null {
  if (lm === undefined || lm.length !== 21) {
    return null;
  }
  const d = (a: number, b: number) => Math.hypot((lm[a][0] - lm[b][0]) * aspect, lm[a][1] - lm[b][1]);
  const span = Math.max(d(0, 9), 0.9 * d(5, 17));
  return Number.isFinite(span) && span > 0 ? span : null;
}

export class PinchCam {
  readonly #tracks = new Map<number, HandTrack>();
  #mode: "idle" | "rotate" | "zoom" = "idle";
  // Rotate: incremental deltas against the last frame's smoothed position.
  #anchor = { handId: 0, x: 0, y: 0 };
  #yawVel = 0; // flick EMAs (rad/s, units/s)
  #heightVel = 0;
  #lastMotionAt = -Infinity;
  // Zoom: seedDist anchors the deadband; prevDist/prevMid are per-frame baselines.
  #zoom = { seedDist: 0, prevDist: 0, prevMidX: 0, prevMidY: 0, engaged: false };
  // One-hand depth dolly: seedSize anchors the deadband (null = unseeded — the
  // anchor hand has not yet shown a usable palm span); prevSize is the
  // per-frame ratio baseline. Reset on every rotate (re-)anchor.
  #depth: { seedSize: number | null; prevSize: number; engaged: boolean } = { seedSize: null, prevSize: 0, engaged: false };
  #aspect = 16 / 9; // last seen frame aspect — inter-hand distance is aspect-corrected
  #lastT: number | null = null;

  update(frame: HandsFrame, t: number): CameraIntent[] {
    if (Number.isFinite(frame.aspect) && frame.aspect > 0) {
      this.#aspect = frame.aspect;
    }
    // Latched hands whose pinch ended NOT by a clean up-vote (stale/teleported
    // slot) — their release must carry ZERO velocity (pointercancel semantics).
    const cancelled = new Set<number>();
    // 1. INGEST — smooth positions, vote the ratio hysteresis, advance latches.
    for (const hand of frame.hands) {
      let track = this.#tracks.get(hand.id);
      if (track !== undefined && t - track.lastSeen > HAND_STALE_SECONDS) {
        // Slot reappeared after staleness: a reused filter would emit a swing
        // and a stale latch would resurrect a dead pinch — start over.
        if (track.latched) {
          cancelled.add(hand.id);
        }
        this.#tracks.delete(hand.id);
        track = undefined;
      }
      if (track === undefined) {
        track = {
          filter: new Point2DFilter(30, FILTER_MINCUTOFF, FILTER_BETA, FILTER_DCUTOFF),
          sx: hand.x,
          sy: hand.y,
          rawX: hand.x,
          rawY: hand.y,
          sizeFilter: new OneEuroFilter(30, FILTER_MINCUTOFF, FILTER_BETA, FILTER_DCUTOFF),
          sSize: null,
          rawSize: null,
          lastSeen: t,
          latched: false,
          downStreak: 0,
          upStreak: 0,
        };
        this.#tracks.set(hand.id, track);
      } else if (Math.hypot(hand.x - track.rawX, hand.y - track.rawY) > ROTATE_MAX_STEP) {
        // Teleport/slot-swap, detected on the RAW delta: reset the filter so
        // the smoothed position SNAPS instead of chasing the jump across many
        // frames. The snap trips the smoothed-step guards below exactly once
        // (discard + re-anchor/re-seed) — a one-frame pause, never a swing.
        track.filter = new Point2DFilter(30, FILTER_MINCUTOFF, FILTER_BETA, FILTER_DCUTOFF);
        track.sizeFilter = new OneEuroFilter(30, FILTER_MINCUTOFF, FILTER_BETA, FILTER_DCUTOFF);
      }
      track.rawX = hand.x;
      track.rawY = hand.y;
      [track.sx, track.sy] = track.filter.call(hand.x, hand.y, t);
      // Palm span (depth proxy): smoothed like position; a one-frame size jump
      // beyond DEPTH_JUMP_RATIO is a tracking glitch — snap the filter so the
      // per-frame dolly clamp absorbs it once instead of chasing it.
      const span = palmSpan(hand.lm, this.#aspect);
      if (span !== null) {
        if (track.rawSize !== null && (span > track.rawSize * DEPTH_JUMP_RATIO || span < track.rawSize / DEPTH_JUMP_RATIO)) {
          track.sizeFilter = new OneEuroFilter(30, FILTER_MINCUTOFF, FILTER_BETA, FILTER_DCUTOFF);
        }
        track.rawSize = span;
        track.sSize = track.sizeFilter.call(span, t);
      }
      // Down-vote: the continuous ratio is authoritative (hysteresis lives HERE);
      // TD's latched bool only when the ratio is absent.
      const vote = hand.pinch !== null ? hand.pinch < (track.latched ? PINCH_OFF : PINCH_ON) : hand.pinching === true;
      if (track.latched) {
        if (!vote) {
          track.upStreak += 1;
          if (track.upStreak >= RELEASE_FRAMES) {
            track.latched = false;
            track.downStreak = 0;
            track.upStreak = 0;
          }
        } else {
          track.upStreak = 0;
        }
      } else if (vote && hand.conf >= CONF_MIN) {
        track.downStreak += 1;
        if (track.downStreak >= CONFIRM_FRAMES) {
          track.latched = true;
        }
      } else {
        track.downStreak = 0;
      }
      track.lastSeen = t;
    }
    const intents = this.#step(t, cancelled, true);
    // 5. dt baseline for the flick EMA — only real frames advance it.
    this.#lastT = t;
    return intents;
  }

  // Steps 2–4 with no new samples: lets the layer evict stale hands and force
  // releases when the socket stalls or closes. live=false — with no fresh
  // samples, emitting orbit/zoom or feeding the flick EMA would fabricate
  // motion (the layer's 250 ms watchdog would dilute every drag's flick).
  idleTick(t: number): CameraIntent[] {
    return this.#step(t, new Set(), false);
  }

  #step(t: number, cancelled: Set<number>, live: boolean): CameraIntent[] {
    // 2. EVICT — a latched hand unseen too long is a CANCEL, never a flick.
    for (const [id, track] of [...this.#tracks]) {
      if (t - track.lastSeen > HAND_STALE_SECONDS) {
        this.#tracks.delete(id);
        if (track.latched) {
          cancelled.add(id);
        }
      }
    }
    // 3. Latched slots, most-recently-seen first, defensively capped at 2
    //    (numHands=2 upstream makes 3+ unreachable).
    const latched = [...this.#tracks.entries()]
      .filter(([, track]) => track.latched)
      .sort((a, b) => b[1].lastSeen - a[1].lastSeen)
      .slice(0, 2);
    const intents: CameraIntent[] = [];
    // 4. TRANSITIONS / EMISSIONS — every re-seed reads CURRENT smoothed
    //    positions, so a mode change can never produce a jump.
    switch (this.#mode) {
      case "idle": {
        if (latched.length === 1) {
          const [id, track] = latched[0];
          this.#mode = "rotate";
          this.#anchor = { handId: id, x: track.sx, y: track.sy };
          this.#seedDepth(track);
          this.#yawVel = 0;
          this.#heightVel = 0;
          intents.push({ kind: "grab" });
        } else if (latched.length === 2) {
          this.#mode = "zoom";
          this.#seedZoom(latched[0][1], latched[1][1]);
          intents.push({ kind: "grab" });
        }
        break;
      }
      case "rotate": {
        if (latched.length === 0) {
          intents.push(this.#releaseIntent(t, cancelled.has(this.#anchor.handId)));
          this.#mode = "idle";
        } else if (latched.length === 2) {
          // Second hand latched: still grabbed, no intent. Dolly has no inertia
          // in the reference, so the flick EMAs die here.
          this.#mode = "zoom";
          this.#seedZoom(latched[0][1], latched[1][1]);
          this.#yawVel = 0;
          this.#heightVel = 0;
        } else if (latched[0][0] !== this.#anchor.handId) {
          // The rotating hand dropped but another latched hand survives:
          // hand off silently — re-anchor, zero the EMAs, stay grabbed.
          const [id, track] = latched[0];
          this.#anchor = { handId: id, x: track.sx, y: track.sy };
          this.#seedDepth(track);
          this.#yawVel = 0;
          this.#heightVel = 0;
        } else if (live) {
          const track = latched[0][1];
          const dxN = track.sx - this.#anchor.x;
          const dyN = track.sy - this.#anchor.y;
          if (Math.hypot(dxN, dyN) > ROTATE_MAX_STEP) {
            // Teleport/slot-swap (filter reset at ingest snapped the smoothed
            // position): discard the step, re-anchor, leave the EMA untouched
            // — worst case is a one-frame pause, never a jump. Depth re-seeds
            // for the same reason: the snapped span must not read as a dolly.
            this.#anchor.x = track.sx;
            this.#anchor.y = track.sy;
            this.#seedDepth(track);
          } else {
            // Signs mirror the mouse drag exactly (RoomScene.tsx:1380-1383,
            // y-down input): hand right = yaw negative, hand down = height up.
            const dYaw = -dxN * YAW_PER_UNIT;
            const dHeight = dyN * HEIGHT_PER_UNIT;
            intents.push({ kind: "orbit", dYaw, dHeight });
            // Flick EMA: only frames arriving at a plausible cadence feed it.
            // Post-stall bursts (queued WS frames delivered back-to-back, often
            // with IDENTICAL clamped performance.now() stamps) carry a full
            // frame of motion over a near-zero dt — flooring dt would inflate
            // the velocity up to 8x and saturate the flick; a stall-length gap
            // deflates it. Both are skipped; the orbit delta still applies.
            const rawDt = this.#lastT === null ? 1 / 30 : t - this.#lastT;
            if (rawDt >= 1 / 120 && rawDt <= FLICK_MAX_AGE_SECONDS) {
              this.#yawVel = this.#yawVel * FLICK_EMA + (dYaw / rawDt) * (1 - FLICK_EMA);
              this.#heightVel = this.#heightVel * FLICK_EMA + (dHeight / rawDt) * (1 - FLICK_EMA);
              if (dYaw !== 0 || dHeight !== 0) {
                this.#lastMotionAt = t;
              }
            }
            this.#anchor.x = track.sx;
            this.#anchor.y = track.sy;
            // DEPTH DOLLY: palm toward the camera = span grows = scale < 1 =
            // move forward (the per-frame ratios telescope exactly like the
            // two-hand spread). Deadband against the SEED span so holding a
            // pinch still doesn't breathe the camera; the [1/DOLLY_MAX_STEP,
            // DOLLY_MAX_STEP] clamp is the teleport/filter-reset defense. No
            // dolly inertia on release — parity with the two-hand zoom.
            const span = track.sSize;
            if (span !== null && span >= DEPTH_MIN_SPAN) {
              if (this.#depth.seedSize === null) {
                // First usable span mid-grab (skeleton arrived late): baseline
                // here — never dolly against a span from before the grab.
                this.#depth.seedSize = span;
                this.#depth.prevSize = span;
              } else {
                if (!this.#depth.engaged && Math.abs(span / this.#depth.seedSize - 1) > DEPTH_DEADBAND) {
                  this.#depth.engaged = true;
                }
                if (this.#depth.engaged && this.#depth.prevSize > 0) {
                  const scale = clamp(this.#depth.prevSize / span, 1 / DOLLY_MAX_STEP, DOLLY_MAX_STEP);
                  if (scale !== 1) {
                    intents.push({ kind: "zoom", scale });
                  }
                }
                this.#depth.prevSize = span;
              }
            }
          }
        }
        break;
      }
      case "zoom": {
        if (latched.length === 2) {
          if (!live) {
            break;
          }
          const a = latched[0][1];
          const b = latched[1][1];
          const dCurr = this.#dist(a, b);
          const midX = (a.sx + b.sx) / 2;
          const midY = (a.sy + b.sy) / 2;
          if (Math.hypot(midX - this.#zoom.prevMidX, midY - this.#zoom.prevMidY) > ROTATE_MAX_STEP) {
            // A hand teleported (filter reset snapped it): swallow the frame
            // and re-baseline — same one-frame-pause contract as rotate. The
            // dolly clamp alone would still let the unclamped pan jerk through.
            this.#zoom.prevDist = dCurr;
            this.#zoom.prevMidX = midX;
            this.#zoom.prevMidY = midY;
            break;
          }
          if (this.#zoom.prevDist > ZOOM_MIN_DIST && dCurr > ZOOM_MIN_DIST) {
            if (!this.#zoom.engaged && Math.abs(dCurr / this.#zoom.seedDist - 1) > DOLLY_DEADBAND) {
              this.#zoom.engaged = true;
            }
            if (this.#zoom.engaged) {
              // Spread → dCurr grows → scale < 1 → radius shrinks → zoom IN.
              // Per-frame ratios telescope to d_initial/d_final — the exact
              // OrbitControls dolly ratio.
              intents.push({
                kind: "zoom",
                scale: clamp(this.#zoom.prevDist / dCurr, 1 / DOLLY_MAX_STEP, DOLLY_MAX_STEP),
              });
            }
          }
          const dx = (midX - this.#zoom.prevMidX) * PAN_GAIN;
          const dy = (midY - this.#zoom.prevMidY) * PAN_GAIN;
          if (dx !== 0 || dy !== 0) {
            intents.push({ kind: "pan", dx, dy });
          }
          this.#zoom.prevDist = dCurr;
          this.#zoom.prevMidX = midX;
          this.#zoom.prevMidY = midY;
        } else if (latched.length === 1) {
          // Seamless 2→1: the survivor keeps the grab; anchor at its CURRENT
          // smoothed position so the first rotate frame has zero delta (and
          // depth re-seeds so the survivor's span baseline is fresh).
          const [id, track] = latched[0];
          this.#mode = "rotate";
          this.#anchor = { handId: id, x: track.sx, y: track.sy };
          this.#seedDepth(track);
          this.#yawVel = 0;
          this.#heightVel = 0;
        } else {
          // Zoom stops DEAD on release — no dolly inertia (reference parity).
          intents.push({ kind: "release", yawVel: 0, heightVel: 0 });
          this.#mode = "idle";
        }
        break;
      }
    }
    return intents;
  }

  #releaseIntent(t: number, cancel: boolean): CameraIntent {
    if (cancel) {
      // Pointercancel semantics: a lost hand never launches the camera.
      return { kind: "release", yawVel: 0, heightVel: 0 };
    }
    const flick = t - this.#lastMotionAt <= FLICK_MAX_AGE_SECONDS;
    const yawVel = flick && Math.abs(this.#yawVel) >= FLICK_MIN_YAW ? clamp(this.#yawVel, -FLICK_MAX_YAW, FLICK_MAX_YAW) : 0;
    const heightVel =
      flick && Math.abs(this.#heightVel) >= FLICK_MIN_HEIGHT ? clamp(this.#heightVel, -FLICK_MAX_HEIGHT, FLICK_MAX_HEIGHT) : 0;
    return { kind: "release", yawVel, heightVel };
  }

  #seedZoom(a: HandTrack, b: HandTrack): void {
    const d = this.#dist(a, b);
    this.#zoom = { seedDist: d, prevDist: d, prevMidX: (a.sx + b.sx) / 2, prevMidY: (a.sy + b.sy) / 2, engaged: false };
  }

  // (Re-)baseline the depth dolly on the anchor hand's CURRENT smoothed span.
  // Null span (no skeleton yet) leaves it unseeded — the rotate loop seeds on
  // the first usable frame instead.
  #seedDepth(track: HandTrack): void {
    const span = track.sSize !== null && track.sSize >= DEPTH_MIN_SPAN ? track.sSize : null;
    this.#depth = { seedSize: span, prevSize: span ?? 0, engaged: false };
  }

  // Aspect-corrected inter-hand distance: x is a fraction of the camera frame
  // WIDTH, y of its HEIGHT — scale x by w/h so the ratio is physically uniform.
  #dist(a: HandTrack, b: HandTrack): number {
    return Math.hypot((a.sx - b.sx) * this.#aspect, a.sy - b.sy);
  }
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}
