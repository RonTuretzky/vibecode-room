"""Arcade/joystick -> fusion-cursor bridge.

Feeds a physical stick (8BitDo Arcade Stick, Switch Pro, any pygame joystick)
into the SAME per-wall cursor websocket protocol the room's GestureLayer
already speaks (gesture-wall/gesturewall/server.py):

    client -> server (first):  {"type":"hello","wall":"A"}
    server -> client (tick):   {"type":"cursors","wall":"A","t":12.3,
                                "cursors":[{"id":900,"x":..,"y":..,
                                            "engaged":true,"conf":1.0}]}

So the joystick drives the room's dwell-select exactly like a camera cursor —
no UI changes needed. Runs standalone (this laptop, no cameras, no TCC
permission: joysticks are plain HID). Reuses ArcadeStickSource for the lever
math (velocity-integrated cursor, deadzone, engage buttons).

Usage:
    .venv/bin/python tools/arcade_fusion.py --port 8771 --walls A,B,C
    # then open the room with &fusion=ws://localhost:8771 (or merge port)

Wall windows subscribe with a wall id and drop frames whose wall doesn't
match, so re-tagging frames retargets the cursor: pressing the cycle button
(--cycle-button, default 9; edge-triggered) steps through --walls and
recenters the cursor on the new display. The cycle button is carved OUT of
the 'any button engages' set so cycling never starts a dwell.

Default port 8771 so it can run ALONGSIDE a camera fusion server on 8770;
pass --port 8770 to be the only cursor source.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

# Import the vendored gesturewall package (this file lives in tools/).
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

CURSOR_ID = 900  # distinct from camera cursor ids (small ints per person)


async def run(args: argparse.Namespace) -> int:
    from websockets.asyncio.server import serve as ws_serve
    import pygame
    from gesturewall.arcade import ArcadeStickSource

    def open_stick():
        return ArcadeStickSource(
            index=args.stick_index,
            speed=args.stick_speed,
            deadzone=args.stick_deadzone,
            engage_button=args.stick_engage,
        )

    # HOT-REPLUG TOLERANCE: Bluetooth pads (Switch Pro et al.) auto-sleep and
    # vanish from pygame mid-session, leaving a dead-but-silent handle — the
    # classic frozen cursor. So a missing stick is never fatal: start (and
    # keep running) without one, and re-acquire whenever it comes back.
    try:
        source = open_stick()
    except RuntimeError as e:
        print(f"[arcade-fusion] {e}", file=sys.stderr, flush=True)
        print("[arcade-fusion] no stick yet — serving anyway; will grab it "
              "the moment it connects (wake the controller).", flush=True)
        source = None

    clients: set = set()
    start = time.monotonic()
    stop = asyncio.Event()

    # Optional upstream camera fusion (e.g. the Kinect server on 8770): its
    # cursors are re-broadcast alongside the joystick cursor so BOTH controls
    # drive the same wall. Reconnects forever; absent upstream = joystick only.
    upstream_cursors: list[dict] = []
    upstream_stamp = 0.0

    async def follow_upstream() -> None:
        nonlocal upstream_cursors, upstream_stamp
        if not args.merge_from:
            return
        from websockets.asyncio.client import connect as ws_connect
        while not stop.is_set():
            try:
                async with ws_connect(args.merge_from) as up:
                    await up.send(json.dumps({"type": "hello", "wall": args.wall}))
                    print(f"[arcade-fusion] merging camera cursors from "
                          f"{args.merge_from}", flush=True)
                    async for raw in up:
                        try:
                            msg = json.loads(raw)
                        except Exception:  # noqa: BLE001
                            continue
                        if msg.get("type") == "cursors":
                            upstream_cursors = [
                                c for c in msg.get("cursors", [])
                                if isinstance(c, dict) and c.get("id") != CURSOR_ID
                            ]
                            upstream_stamp = time.monotonic()
            except Exception:  # noqa: BLE001 — upstream down; retry quietly
                upstream_cursors = []
                await asyncio.sleep(2.0)

    async def handler(ws) -> None:
        # Expect the hello, but tolerate silent listeners (parity with server.py).
        try:
            first = await asyncio.wait_for(ws.recv(), timeout=5.0)
            _ = json.loads(first)
        except Exception:  # noqa: BLE001 — any hello failure: just stream
            pass
        clients.add(ws)
        try:
            await ws.wait_closed()
        finally:
            clients.discard(ws)

    walls: list[str] = args.walls_list

    async def broadcast() -> None:
        nonlocal source
        period = 1.0 / args.fps
        last_xy = (0.5, 0.5)
        recheck = 0.0
        wall_idx = args.wall_index
        cycle_was_down = True  # require a fresh press (ignore held-at-start)
        last_cycle = 0.0
        while not stop.is_set():
            tick = time.monotonic()
            x, y = last_xy
            engaged = False
            if source is not None:
                try:
                    _, (x, y), engaged, _info = source.read()
                    # WALL CYCLING: one dedicated button (state read right
                    # after the pump inside source.read()) re-tags frames at
                    # the next wall in --walls. In 'any button engages' mode
                    # the source counts the cycle button too, so engage is
                    # recomputed here WITHOUT it — cycling never dwells.
                    if args.cycle_button >= 0:
                        js = source._js  # noqa: SLF001 — fresh from the pump
                        n = js.get_numbuttons()
                        cycle_down = (args.cycle_button < n and
                                      bool(js.get_button(args.cycle_button)))
                        if cycle_down and args.stick_engage < 0:
                            skip = {b for b in source._dpad_buttons  # noqa: SLF001
                                    if b is not None}
                            skip.add(args.cycle_button)
                            engaged = any(js.get_button(i) for i in range(n)
                                          if i not in skip)
                        # Edge-triggered + debounced: fire once per press.
                        if (cycle_down and not cycle_was_down
                                and tick - last_cycle >= 0.25):
                            last_cycle = tick
                            wall_idx = (wall_idx + 1) % len(walls)
                            x, y = 0.5, 0.5
                            source._cursor = (x, y)  # noqa: SLF001 — recenter
                            print(f"[arcade-fusion] cycle -> wall "
                                  f"{walls[wall_idx]} (cursor centered)",
                                  flush=True)
                        cycle_was_down = cycle_down
                    last_xy = (x, y)
                    # Cheap once-a-second liveness check: a slept pad reads as
                    # frozen-but-fine, so the count is the real signal.
                    if tick >= recheck:
                        recheck = tick + 1.0
                        if pygame.joystick.get_count() == 0:
                            raise RuntimeError("joystick disconnected")
                except Exception:  # noqa: BLE001 — device vanished mid-read
                    print("[arcade-fusion] joystick lost — waiting for it to "
                          "reconnect (wake the controller)…", flush=True)
                    try:
                        source.close()
                    except Exception:  # noqa: BLE001
                        pass
                    source = None
                    x, y = last_xy
                    engaged = False
            else:
                if tick >= recheck:
                    recheck = tick + 1.0
                    # Re-scan the bus: quit/init refreshes pygame's device
                    # list (stale handles are already dropped above).
                    try:
                        pygame.joystick.quit()
                        pygame.joystick.init()
                        if pygame.joystick.get_count() > 0:
                            source = open_stick()
                            cycle_was_down = True  # ignore a held cycle button
                            print("[arcade-fusion] joystick re-acquired: "
                                  f"'{source._name}'", flush=True)  # noqa: SLF001
                    except Exception:  # noqa: BLE001 — not back yet
                        source = None
            cursors = [{
                "id": CURSOR_ID,
                "x": round(x, 4),
                "y": round(y, 4),
                "engaged": bool(engaged),
                "conf": 1.0,
            }]
            # Fold in fresh camera cursors (stale after 0.5s — camera gone).
            if upstream_cursors and (tick - upstream_stamp) < 0.5:
                cursors.extend(upstream_cursors)
            payload = json.dumps({
                "type": "cursors",
                "wall": walls[wall_idx],
                "t": round(tick - start, 3),
                "cursors": cursors,
            }, separators=(",", ":"))
            for ws in list(clients):
                try:
                    await ws.send(payload)
                except Exception:  # noqa: BLE001 — dead client, reaped by handler
                    pass
            rest = period - (time.monotonic() - tick)
            if rest > 0:
                await asyncio.sleep(rest)

    async with ws_serve(handler, args.host or None, args.port):
        stick_name = source._name if source is not None else "(waiting for stick)"  # noqa: SLF001
        print(f"[arcade-fusion] joystick '{stick_name}' -> "
              f"ws://localhost:{args.port} wall={walls[args.wall_index]} "
              f"of [{','.join(walls)}] "
              f"(speed={args.stick_speed}/s deadzone={args.stick_deadzone})",
              flush=True)
        print("[arcade-fusion] lever moves the cursor; hold any button to "
              "engage (dwell fills while held or hovering).", flush=True)
        if args.cycle_button >= 0 and len(walls) > 1:
            print(f"[arcade-fusion] button {args.cycle_button} cycles the "
                  f"target wall ({' -> '.join(walls)} -> ...) and recenters "
                  "the cursor; it never engages.", flush=True)
        upstream_task = asyncio.create_task(follow_upstream())
        try:
            await broadcast()
        finally:
            upstream_task.cancel()
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(
        prog="arcade_fusion",
        description="Bridge a pygame joystick into the room's fusion-cursor "
                    "websocket protocol (drives dwell-select like a camera).",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--port", type=int, default=8771, help="websocket port")
    p.add_argument("--host", default="", help="bind address ('' = all)")
    p.add_argument("--wall", default=None,
                   help="starting wall id (default: first entry of --walls)")
    p.add_argument("--walls", default="A,B,C",
                   help="comma list of wall ids the cycle button steps through")
    p.add_argument("--cycle-button", type=int, dest="cycle_button", default=9,
                   help="joystick button that cycles the target wall on press "
                        "(excluded from 'any button engages'); -1 disables")
    p.add_argument("--fps", type=int, default=60, help="broadcast rate")
    p.add_argument("--stick-index", type=int, dest="stick_index", default=None,
                   help="joystick index; default auto-selects")
    p.add_argument("--stick-speed", type=float, dest="stick_speed", default=0.9,
                   help="cursor speed, wall fraction per second")
    p.add_argument("--stick-deadzone", type=float, dest="stick_deadzone",
                   default=0.4, help="analog dead zone 0..1")
    p.add_argument("--stick-engage", type=int, dest="stick_engage", default=-1,
                   help="engage button index; -1 = any button")
    p.add_argument("--merge-from", dest="merge_from", default="",
                   help="upstream camera fusion WS to merge cursors from "
                        "(e.g. ws://localhost:8770); empty = joystick only")
    args = p.parse_args(argv)
    walls = [w.strip() for w in args.walls.split(",") if w.strip()]
    if not walls:
        p.error("--walls needs at least one wall id")
    if args.wall and args.wall not in walls:
        walls.insert(0, args.wall)
    args.walls_list = walls
    args.wall_index = walls.index(args.wall) if args.wall else 0
    args.wall = walls[args.wall_index]  # upstream hello + legacy readers
    if args.cycle_button >= 0 and args.cycle_button == args.stick_engage:
        p.error("--cycle-button must differ from --stick-engage (the cycle "
                "button is excluded from engaging)")
    try:
        return asyncio.run(run(args))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
