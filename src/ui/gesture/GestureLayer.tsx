import { useEffect, useRef, useState } from "react";
import type { Zone } from "./core";
import { idToHue } from "./core";
import { GestureTargets, HITBOX_INFLATE_PX, inflateRect, type TargetDescriptor } from "./targets";
import { MultiDwell } from "./multi";
import { getSceneDwellSource } from "./scene-source";
import { RemoteKeyHolds, visibleCursorDots } from "./remote";
import { GestureWallClient, type GestureCursor, type GestureWallStatus } from "./wall-client";

// Dwell/interaction tuning — matches the standalone wall client
// (gesture-wall/web/wall.js): 0.8s dwell, 0.4s cooldown, 15% sticky
// hysteresis, 0.4s post-fire zone lock, 0.5s stale-cursor eviction.
const DWELL_SECONDS = 0.8;
const COOLDOWN_SECONDS = 0.4;
const HYSTERESIS = 0.15;
const LOCK_SECONDS = 0.4;
// A CAMERA cursor not seen for this long is dropped (the hand left). The local
// mouse-test cursor is sticky (holding still is how you dwell) so it is exempt.
const STALE_SECONDS = 0.5;
// A raycast-acquired scene node stays a live dwell zone this long after the
// last cursor hit, so the sticky hysteresis has a rect to hold on to.
const SCENE_LINGER_SECONDS = 0.6;
// A completed dwell flashes an expanding ring at the target for this long.
const FIRE_FLASH_SECONDS = 0.45;

// EVERY actionable HUD control is a dwell target, generically: all enabled
// buttons plus anything opting in with data-dwell (non-button clickables like
// the fleet panels). No per-control registry to maintain — new UI is dwellable
// the moment it renders a <button>.
const DWELL_DOM_SELECTOR = "button:not(:disabled), [data-dwell]";

interface CursorState {
  x: number;
  y: number;
  engaged: boolean;
  lastSeen: number; // seconds
  isMouse: boolean;
}

// CURSOR DOTS (live-room request): a persistent colored dot per tracked person
// — like the standalone wall client (gesture-wall/web/wall.js) — so people SEE
// where they are pointing between targets. HIDDEN by default (live-room
// request); localStorage "1" opts back in. Dwell rings render regardless.
export const CURSOR_DOTS_STORAGE_KEY = "vibersyn.cursor-dots";

// Pure: parse the persisted preference. Hidden is THE default (live-room
// request: the dots read as clutter) — only an explicit "1" opts back in,
// and only via localStorage; the on-wall toggle button is gone.
export function cursorDotsFromStored(stored: string | null): boolean {
  return stored === "1";
}

function readCursorDotsPref(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return cursorDotsFromStored(window.localStorage.getItem(CURSOR_DOTS_STORAGE_KEY));
  } catch {
    return false; // storage unavailable (kiosk/private mode) — default hidden
  }
}

// The &fusion= param as a source list: one WS URL, or several comma-separated
// (camera server + arcade joystick bridge). Pure so it is testable without a
// DOM; blanks are dropped so trailing/doubled commas can't produce a client
// that reconnect-loops against an empty URL.
export function fusionSources(fusionUrl: string): string[] {
  return fusionUrl
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface GestureLayerProps {
  // The wall id to subscribe to on the fusion server (e.g. "A").
  wall: string;
  // Fusion server WS URL (e.g. ws://localhost:8770), or a comma-separated
  // LIST of them (e.g. "ws://localhost:8770,ws://localhost:8771") when extra
  // cursor sources run beside the camera server — the arcade joystick bridge
  // being the canonical second source. All sources merge into the same dwell
  // pipeline by cursor id (sources own disjoint id blocks). Empty disables
  // the camera stream (mouse-dwell testing mode uses only the local mouse).
  fusionUrl: string;
  // Guest-hands WS URL (the projector server's /api/hands/room — speaks the
  // same fusion cursors protocol, carrying LAN guests' cursors with ids in the
  // reserved guest block). Empty disables the remote stream. Guest cursors
  // merge into the same dwell pipeline as camera cursors; their dots always
  // draw (a guest aiming from their own laptop has no other feedback).
  remoteUrl?: string;
  // When true, the mouse injects a local id=-1 cursor so the SAME
  // point→highlight→dwell mechanic can be driven without cameras
  // (?dwell=mouse — testing / accessibility fallback). Default false.
  mouseTest?: boolean;
  // Test seam: overrides the persisted cursor-dot preference (the SSR test
  // renderer has no localStorage). Default: read localStorage, ON when unset.
  initialCursorDots?: boolean;
}

// A full-viewport, pointer-events:none overlay that turns the gesture-wall
// camera cursor stream (or the mouse in ?dwell=mouse) into dwell-to-select over
// the real UI. The pointed-at target's highlight (grow/glow via
// [data-dwell-hot] / scene emissive boost) plus the radial dwell-progress ring
// rendered ON the target are the selection feedback; completing the ring
// synthesizes the activation. A per-person cursor dot — hued per cursor id
// like the standalone wall client — can be opted in via localStorage, but the
// wall defaults to dwell rings only (the dots read as clutter at room scale).
export function GestureLayer({ wall, fusionUrl, remoteUrl = "", mouseTest = false, initialCursorDots }: GestureLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const statusRef = useRef<GestureWallStatus>("closed");
  const [cursorDots] = useState<boolean>(() => initialCursorDots ?? readCursorDotsPref());
  const cursorDotsRef = useRef(cursorDots);
  cursorDotsRef.current = cursorDots;

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d") ?? null;

    const cursors = new Map<number, CursorState>();
    const multi = new MultiDwell({
      dwellSeconds: DWELL_SECONDS,
      cooldownSeconds: COOLDOWN_SECONDS,
      hysteresis: HYSTERESIS,
      lockSeconds: LOCK_SECONDS,
    });
    const targets = new GestureTargets();
    // Stable per-element ids: identity-keyed so a target keeps its zone (and any
    // in-flight dwell) across React re-renders that reuse the DOM node.
    const domIds = new WeakMap<Element, string>();
    let nextDomId = 1;
    // Scene targets recently confirmed by raycast: id -> last seen (seconds).
    const sceneSeen = new Map<string, number>();
    // Per-frame rendering indexes.
    const elementsById = new Map<string, HTMLElement>();
    const rectsById = new Map<string, { left: number; top: number; width: number; height: number }>();
    let hotElements = new Set<HTMLElement>();
    let sceneHighlights = new Set<string>();
    const fireFlashes: { x: number; y: number; r: number; hue: number; at: number }[] = [];
    let raf = 0;

    const nowSec = () => performance.now() / 1000;

    // ── mouse-test cursor (id = -1): sticky, engaged, updated on move ──────────
    const MOUSE_ID = -1;
    const onMouseMove = (e: MouseEvent) => {
      const w = window.innerWidth || 1;
      const h = window.innerHeight || 1;
      cursors.set(MOUSE_ID, { x: e.clientX / w, y: e.clientY / h, engaged: true, lastSeen: nowSec(), isMouse: true });
    };
    if (mouseTest) {
      window.addEventListener("mousemove", onMouseMove, { passive: true });
    }

    // ── camera cursor stream ──────────────────────────────────────────────────
    const mergeCursors = (incoming: GestureCursor[]) => {
      const t = nowSec();
      for (const c of incoming) {
        cursors.set(c.id, { x: c.x, y: c.y, engaged: c.engaged, lastSeen: t, isMouse: false });
      }
    };
    const clients: GestureWallClient[] = fusionSources(fusionUrl).map(
      (url, i) =>
        new GestureWallClient({
          url,
          wall,
          // Only the FIRST source (the camera fusion server) drives the status
          // badge; extra sources (e.g. the arcade joystick bridge on :8771)
          // merge cursors silently so an unplugged stick never reads as the
          // wall being offline.
          onStatus:
            i === 0
              ? (s) => {
                  statusRef.current = s;
                }
              : undefined,
          onCursors: mergeCursors,
        }),
    );
    for (const client of clients) {
      client.start();
    }

    // ── guest cursor stream (LAN guests via the projector server) ─────────────
    // Same wire protocol, same merge: guests differ only by their reserved id
    // block, which the dot renderer uses to always show them. Guests' WASD
    // buttons arrive as keys frames and replay through the SAME window key
    // events the desk keyboard produces (RoomScene's fly-through binds
    // window-wide) — merged across guests, auto-released on silence.
    const keyHolds = new RemoteKeyHolds();
    let remoteClient: GestureWallClient | null = null;
    if (remoteUrl.trim().length > 0) {
      remoteClient = new GestureWallClient({
        url: remoteUrl,
        wall,
        onCursors: mergeCursors,
        onKeys: (keysFrame) => keyHolds.update(keysFrame.guest, keysFrame.held, nowSec()),
      });
      remoteClient.start();
    }

    const domIdFor = (el: Element): string => {
      let id = domIds.get(el);
      if (id === undefined) {
        const hint = el.getAttribute("data-testid") ?? el.getAttribute("data-dwell") ?? el.tagName.toLowerCase();
        id = `dom:${hint}#${nextDomId}`;
        nextDomId += 1;
        domIds.set(el, id);
      }
      return id;
    };

    // Collect every visible HUD control. An element whose center is covered by
    // something else (a modal overlay, the slideshow, …) is NOT dwellable —
    // exactly like it is not clickable — via an elementFromPoint occlusion
    // check (this overlay canvas is pointer-events:none, so it never occludes).
    const collectDomTargets = (vpW: number, vpH: number): TargetDescriptor[] => {
      const out: TargetDescriptor[] = [];
      document.querySelectorAll(DWELL_DOM_SELECTOR).forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) {
          return;
        }
        // Occlusion check on the UNinflated center: a covered control stays dead.
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const top = document.elementFromPoint(cx, cy);
        if (top === null || (top !== el && !el.contains(top))) {
          return;
        }
        const id = domIdFor(el);
        elementsById.set(id, el as HTMLElement);
        // The dwell hitbox exceeds the visual button by HITBOX_INFLATE_PX per
        // side (viewport-clamped) so pointing jitter around a control still
        // lands; scene raycast rects (appended later) stay exact.
        out.push({ ...inflateRect(r, HITBOX_INFLATE_PX, vpW, vpH), id, activate: () => (el as HTMLElement).click() });
      });
      // Smallest first: a button inside a dwellable panel wins over the panel,
      // and where two neighbors' inflated hitboxes overlap, the smaller control
      // wins acquisition (zone order is resolution order in DwellSelector).
      out.sort((a, b) => a.width * a.height - b.width * b.height);
      return out;
    };

    // ── the interaction + render loop ─────────────────────────────────────────
    const frame = () => {
      const t = nowSec();
      const vpW = window.innerWidth || 1;
      const vpH = window.innerHeight || 1;

      // The mouse cursor stays alive at its last position (holding still = dwell).
      const mouse = cursors.get(MOUSE_ID);
      if (mouse !== undefined) {
        mouse.lastSeen = t;
      }
      // Drop stale camera cursors.
      for (const [id, c] of [...cursors]) {
        if (!c.isMouse && t - c.lastSeen > STALE_SECONDS) {
          cursors.delete(id);
        }
      }

      elementsById.clear();
      rectsById.clear();
      // IDLE GUARD: the layer now mounts on EVERY wall by default (guest
      // hands), so with no cursor present the expensive per-frame work — the
      // querySelectorAll + elementFromPoint occlusion sweep and the scene
      // raycasts — must cost nothing. Remote WASD (below) still runs: guests
      // can walk the camera without pointing.
      const descriptors = cursors.size > 0 ? collectDomTargets(vpW, vpH) : [];

      // Scene nodes: raycast each engaged cursor into the 3D room; a hit node
      // becomes (or stays) a dwell target whose zone rect is the node's live
      // projected bounding box.
      const scene = cursors.size > 0 ? getSceneDwellSource() : null;
      if (scene !== null) {
        for (const c of cursors.values()) {
          if (!c.engaged) {
            continue;
          }
          const id = scene.pick(c.x * vpW, c.y * vpH);
          if (id !== null) {
            sceneSeen.set(id, t);
          }
        }
        for (const [id, seen] of [...sceneSeen]) {
          const rect = t - seen > SCENE_LINGER_SECONDS ? null : scene.rectFor(id);
          if (rect === null || rect.width <= 0 || rect.height <= 0) {
            sceneSeen.delete(id);
            continue;
          }
          descriptors.push({ id, left: rect.left, top: rect.top, width: rect.width, height: rect.height, activate: () => scene.activate(id) });
        }
      } else {
        sceneSeen.clear();
      }

      const zones: Zone[] = targets.sync(descriptors, vpW, vpH);
      for (const zone of zones) {
        rectsById.set(zone.id, { left: zone.x * vpW, top: zone.y * vpH, width: zone.w * vpW, height: zone.h * vpH });
      }

      // Remote WASD: apply this frame's press/release diff as synthetic window
      // key events (exactly what the desk keyboard would emit — RoomScene's
      // handler takes it from there; stale guests release automatically).
      const keyDiff = keyHolds.diff(t);
      for (const key of keyDiff.down) {
        window.dispatchEvent(new KeyboardEvent("keydown", { key }));
      }
      for (const key of keyDiff.up) {
        window.dispatchEvent(new KeyboardEvent("keyup", { key }));
      }

      const feed = [...cursors.entries()].map(([id, c]) => ({ id, x: c.x, y: c.y, engaged: c.engaged }));
      const result = multi.update(zones, feed, t);

      for (const fire of result.fired) {
        targets.activate(fire.zoneId);
        const rect = rectsById.get(fire.zoneId);
        if (rect !== undefined) {
          fireFlashes.push({
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            r: ringRadius(rect),
            hue: idToHue(fire.cursorId),
            at: t,
          });
        }
      }

      // ── highlight application: the target IS the feedback ────────────────
      const nextHot = new Set<HTMLElement>();
      const nextScene = new Set<string>();
      for (const a of result.active) {
        const el = elementsById.get(a.zoneId);
        if (el !== undefined) {
          nextHot.add(el);
        } else if (a.zoneId.startsWith("scene:")) {
          nextScene.add(a.zoneId);
        }
      }
      for (const el of hotElements) {
        if (!nextHot.has(el)) {
          el.removeAttribute("data-dwell-hot");
        }
      }
      for (const el of nextHot) {
        el.setAttribute("data-dwell-hot", "1");
      }
      hotElements = nextHot;
      // Resolve the scene source here independently of the idle guard above —
      // a highlight lit by the LAST cursor before eviction must still clear.
      if (nextScene.size > 0 || sceneHighlights.size > 0) {
        getSceneDwellSource()?.setHighlights(nextScene);
      }
      sceneHighlights = nextScene;

      draw(ctx, canvas, result.active, rectsById, fireFlashes, t, vpW, vpH, cursors, cursorDotsRef.current);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      if (mouseTest) {
        window.removeEventListener("mousemove", onMouseMove);
      }
      for (const el of hotElements) {
        el.removeAttribute("data-dwell-hot");
      }
      getSceneDwellSource()?.setHighlights(new Set());
      for (const client of clients) {
        client.stop();
      }
      remoteClient?.stop();
      // Never leave a remote guest's key held down past the layer's lifetime.
      for (const key of keyHolds.releaseAll()) {
        window.dispatchEvent(new KeyboardEvent("keyup", { key }));
      }
    };
  }, [wall, fusionUrl, remoteUrl, mouseTest]);

  return (
    <>
      <canvas
        ref={canvasRef}
        className="gesture-overlay"
        data-testid="gesture-overlay"
        // The wall this layer subscribes as (fusion hello AND the guest-hands
        // relay hello) — observable so tests can pin the per-window wall
        // routing that keeps one guest from double-firing both walls.
        data-wall={wall}
        aria-hidden="true"
      />
    </>
  );
}

function ringRadius(rect: { width: number; height: number }): number {
  return Math.max(15, Math.min(34, Math.min(rect.width, rect.height) * 0.45));
}

// Draw the dwell-progress ring ON each dwelled target (arc = dwell progress,
// hued per cursor) plus short expanding flashes where a dwell just completed.
// With showCursorDots on (the default), every tracked cursor also gets a
// persistent glowing dot hued by its id (idToHue) — wall.js parity — drawn
// LAST so the dot stays visible over rings and targets.
function draw(
  ctx: CanvasRenderingContext2D | null,
  canvas: HTMLCanvasElement | null,
  active: readonly { zoneId: string; cursorId: number; progress: number }[],
  rects: Map<string, { left: number; top: number; width: number; height: number }>,
  flashes: { x: number; y: number; r: number; hue: number; at: number }[],
  t: number,
  vpW: number,
  vpH: number,
  cursors: ReadonlyMap<number, CursorState>,
  showCursorDots: boolean,
): void {
  if (ctx === null || canvas === null) {
    return;
  }
  const dpr = window.devicePixelRatio || 1;
  const pxW = Math.round(vpW * dpr);
  const pxH = Math.round(vpH * dpr);
  if (canvas.width !== pxW || canvas.height !== pxH) {
    canvas.width = pxW;
    canvas.height = pxH;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, vpW, vpH);

  for (const a of active) {
    const rect = rects.get(a.zoneId);
    if (rect === undefined) {
      continue;
    }
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const r = ringRadius(rect);
    const hue = idToHue(a.cursorId);

    // Soft glow outline around the whole target (scene nodes have no CSS).
    ctx.lineWidth = 2;
    ctx.strokeStyle = `hsla(${hue}, 90%, 65%, 0.35)`;
    ctx.beginPath();
    ctx.roundRect(rect.left - 3, rect.top - 3, rect.width + 6, rect.height + 6, 10);
    ctx.stroke();

    // Dwell ring: faint track + filling progress arc.
    ctx.lineWidth = 4;
    ctx.strokeStyle = `hsla(${hue}, 90%, 60%, 0.28)`;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    if (a.progress > 0) {
      ctx.strokeStyle = `hsla(${hue}, 95%, 62%, 0.95)`;
      ctx.beginPath();
      ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + a.progress * Math.PI * 2);
      ctx.stroke();
    }
  }

  for (let i = flashes.length - 1; i >= 0; i -= 1) {
    const flash = flashes[i];
    const age = (t - flash.at) / FIRE_FLASH_SECONDS;
    if (age >= 1) {
      flashes.splice(i, 1);
      continue;
    }
    ctx.lineWidth = 3;
    ctx.strokeStyle = `hsla(${flash.hue}, 95%, 70%, ${0.8 * (1 - age)})`;
    ctx.beginPath();
    ctx.arc(flash.x, flash.y, flash.r + age * 26, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Guest cursors (the negative reserved id block) ALWAYS draw — a guest
  // aiming from their own laptop has no arm→wall mapping, the dot IS their
  // feedback. In-room cursors keep honoring the opt-in preference. The
  // filtering lives in visibleCursorDots (unit-tested) — do not re-gate here.
  for (const [id, cursor] of visibleCursorDots(cursors, showCursorDots)) {
    const x = cursor.x * vpW;
    const y = cursor.y * vpH;
    const hue = idToHue(id);
    // A disengaged (open-hand) cursor stays visible but dims, so roaming
    // people can find themselves on the wall before committing to point.
    const alpha = cursor.engaged ? 0.95 : 0.55;
    const glow = ctx.createRadialGradient(x, y, 2, x, y, 26);
    glow.addColorStop(0, `hsla(${hue}, 95%, 65%, ${0.55 * alpha})`);
    glow.addColorStop(1, `hsla(${hue}, 95%, 65%, 0)`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, 26, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `hsla(${hue}, 95%, 62%, ${alpha})`;
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `hsla(${hue}, 40%, 97%, ${alpha})`;
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
}
