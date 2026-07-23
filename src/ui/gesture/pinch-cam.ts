// Pure pinch → camera-intent interpreter for the TouchDesigner hands stream.
// ONE latched hand = grab-the-world orbit with a flick on release (fed to the
// rig's EXISTING inertia path); TWO latched hands = ratio-preserving zoom
// (radius *= d_prev/d_curr — spreading zooms IN, release stops dead) plus a
// gentle damped midpoint pan. Pure logic — no DOM, no sockets, no three.js —
// so the whole state machine is unit-testable with scripted HandsFrame feeds.
// All timestamps are SECONDS on the CALLER's clock (never frame.t).

import { Point2DFilter } from "./core";
import type { HandsFrame } from "./hands-client";

// Pinch detection (browser-authoritative on the continuous ratio; the TD
// `pinching` bool is transport-level FALLBACK only, used when the ratio is absent).
export const PINCH_ON = 0.3; // ratio below = down-vote to engage
export const PINCH_OFF = 0.45; // latched hand releases only above — wide gap = never flaps
export const CONFIRM_FRAMES = 2; // consecutive down-votes to engage (~66 ms @30 Hz — kills flicker)
export const RELEASE_FRAMES = 1; // release is immediate — visionOS discrete pinch-up parity
export const CONF_MIN = 0.5; // below this a hand cannot START a pinch (but keeps one it owns)
export const HAND_STALE_SECONDS = 0.25; // latched hand unseen this long = CANCEL (release WITHOUT flick)
// Rotate
export const YAW_PER_UNIT = 6.0; // rad per full camera-frame of horizontal travel (~2π: one frame-width ≈ one orbit)
export const HEIGHT_PER_UNIT = 22; // world units per full-frame vertical travel (mouse parity: 0.045/px * ~500 px)
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
  lastSeen: number; // seconds, caller's clock
  latched: boolean;
  downStreak: number; // consecutive down-votes while unlatched
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
          lastSeen: t,
          latched: false,
          downStreak: 0,
        };
        this.#tracks.set(hand.id, track);
      } else if (Math.hypot(hand.x - track.rawX, hand.y - track.rawY) > ROTATE_MAX_STEP) {
        // Teleport/slot-swap, detected on the RAW delta: reset the filter so
        // the smoothed position SNAPS instead of chasing the jump across many
        // frames. The snap trips the smoothed-step guards below exactly once
        // (discard + re-anchor/re-seed) — a one-frame pause, never a swing.
        track.filter = new Point2DFilter(30, FILTER_MINCUTOFF, FILTER_BETA, FILTER_DCUTOFF);
      }
      track.rawX = hand.x;
      track.rawY = hand.y;
      [track.sx, track.sy] = track.filter.call(hand.x, hand.y, t);
      // Down-vote: the continuous ratio is authoritative (hysteresis lives HERE);
      // TD's latched bool only when the ratio is absent.
      const vote = hand.pinch !== null ? hand.pinch < (track.latched ? PINCH_OFF : PINCH_ON) : hand.pinching === true;
      if (track.latched) {
        if (!vote) {
          // RELEASE_FRAMES = 1: a single up-vote releases immediately.
          track.latched = false;
          track.downStreak = 0;
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
          this.#yawVel = 0;
          this.#heightVel = 0;
        } else if (live) {
          const track = latched[0][1];
          const dxN = track.sx - this.#anchor.x;
          const dyN = track.sy - this.#anchor.y;
          if (Math.hypot(dxN, dyN) > ROTATE_MAX_STEP) {
            // Teleport/slot-swap (filter reset at ingest snapped the smoothed
            // position): discard the step, re-anchor, leave the EMA untouched
            // — worst case is a one-frame pause, never a jump.
            this.#anchor.x = track.sx;
            this.#anchor.y = track.sy;
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
          // smoothed position so the first rotate frame has zero delta.
          const [id, track] = latched[0];
          this.#mode = "rotate";
          this.#anchor = { handId: id, x: track.sx, y: track.sy };
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

  // Aspect-corrected inter-hand distance: x is a fraction of the camera frame
  // WIDTH, y of its HEIGHT — scale x by w/h so the ratio is physically uniform.
  #dist(a: HandTrack, b: HandTrack): number {
    return Math.hypot((a.sx - b.sx) * this.#aspect, a.sy - b.sy);
  }
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}
