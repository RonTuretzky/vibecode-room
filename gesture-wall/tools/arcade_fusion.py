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
    .venv/bin/python tools/arcade_fusion.py --port 8771 --wall A
    # then open the room with &fusion=ws://localhost:8771 (or merge port)

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
    from gesturewall.arcade import ArcadeStickSource

    try:
        source = ArcadeStickSource(
            index=args.stick_index,
            speed=args.stick_speed,
            deadzone=args.stick_deadzone,
            engage_button=args.stick_engage,
        )
    except RuntimeError as e:
        print(f"[arcade-fusion] {e}", file=sys.stderr, flush=True)
        return 2

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

    async def broadcast() -> None:
        period = 1.0 / args.fps
        while not stop.is_set():
            tick = time.monotonic()
            _, (x, y), engaged, _info = source.read()
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
                "wall": args.wall,
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
        print(f"[arcade-fusion] joystick '{source._name}' -> "  # noqa: SLF001
              f"ws://localhost:{args.port} wall={args.wall} "
              f"(speed={args.stick_speed}/s deadzone={args.stick_deadzone})",
              flush=True)
        print("[arcade-fusion] lever moves the cursor; hold any button to "
              "engage (dwell fills while held or hovering).", flush=True)
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
    p.add_argument("--wall", default="A", help="wall id tagged on frames")
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
    try:
        return asyncio.run(run(args))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
