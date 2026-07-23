# Streams per-hand pinch frames to all WS clients. y is intentionally NOT
# flipped (protocol is y-down). Empty-hands frames ARE sent every tick
# (liveness contract). No positional smoothing required here (the browser
# runs a 1-Euro filter); an optional Lag CHOP (~0.05s) before mp_hands is fine.
import json, math
WS_OP, HANDS_OP = 'handserver', 'mp_hands'
CAM_OP = 'videodevin1'             # webcam TOP: aspect is derived from its real
                                   # resolution when the op exists; else ASPECT
ASPECT = 16/9                      # fallback — set to width/height if your
                                   # camera isn't 16:9 and CAM_OP can't find it
TARGET_HZ = 30
MIRROR_X = True                    # user-facing camera: behave like a mirror
PINCH_ON, PINCH_OFF = 0.30, 0.45   # hysteresis on hand-scale-normalized thumb-index ratio
# DEFENSIVE CHANNEL MAP — ordered candidates; first pattern that resolves wins.
# Edit here if your plugin build names differ (README: channel verification).
CHAN = {
    'active':  ['h{h}:hand_active', 'h{h}:active'],
    'thumb':   ['h{h}:thumb_tip'],            # landmark 4
    'index':   ['h{h}:index_finger_tip'],     # landmark 8
    'wrist':   ['h{h}:wrist'],                # landmark 0
    'midmcp':  ['h{h}:middle_finger_mcp'],    # landmark 9 (hand-scale reference)
    'leftness':['h{h}:Leftness', 'h{h}:leftness'],  # optional v0.5.x helper
}
_warned = set()
def _chan(chop, name):
    c = chop.chan(name)
    return c.eval() if c is not None else None
def _first(chop, key, h, suffix=''):
    for pat in CHAN[key]:
        v = _chan(chop, pat.format(h=h) + suffix)
        if v is not None: return v
    return None
def _pt(chop, h, key):
    x = _first(chop, key, h, ':x'); y = _first(chop, key, h, ':y')
    if x is None or y is None:
        tag = key + str(h)
        if tag not in _warned:
            _warned.add(tag); debug('[hands] missing channel group: %s (h%d) — edit CHAN in hands_stream.py' % (key, h))
        return None
    if MIRROR_X: x = 1.0 - x
    return (x, y)
def _aspect():
    cam = op(CAM_OP)
    return (cam.width / cam.height) if (cam is not None and cam.height) else ASPECT
def _dist(a, b, aspect):
    return math.hypot((a[0]-b[0]) * aspect, a[1]-b[1])
def _latch(hand_id, ratio):
    states = me.fetch('pinchStates', {}, storeDefault=True)
    was = states.get(hand_id, False)
    now = (ratio < PINCH_ON) if not was else (ratio < PINCH_OFF)
    states[hand_id] = now
    return now
def onFrameEnd(frame):
    every = max(1, int(round(me.time.rate / TARGET_HZ)))
    if int(frame) % every: return
    ws, hands = op(WS_OP), op(HANDS_OP)
    if ws is None or hands is None: return
    conns = list(getattr(ws, 'webSocketConnections', []) or [])
    if not conns:
        try: conns = list(op(WS_OP + '_callbacks').module.clients)
        except Exception: conns = []
    if not conns: return
    aspect = _aspect()
    out = []
    for h in (1, 2):
        active = _first(hands, 'active', h)
        if active is None:
            # Missing channel (name drift), NOT hand-not-present: warn once so
            # the stream never fails silently — README's channel-verification
            # contract promises a debug() line for every missing group.
            tag = 'active' + str(h)
            if tag not in _warned:
                _warned.add(tag); debug('[hands] missing channel group: active (h%d) — edit CHAN in hands_stream.py' % h)
            continue
        if not active: continue
        thumb, index = _pt(hands, h, 'thumb'), _pt(hands, h, 'index')
        wrist, midmcp = _pt(hands, h, 'wrist'), _pt(hands, h, 'midmcp')
        if wrist is None or thumb is None or index is None: continue
        scale = _dist(wrist, midmcp, aspect) if midmcp else 0.0
        ratio = (_dist(thumb, index, aspect) / scale) if scale > 1e-6 else 999.0
        leftness = _first(hands, 'leftness', h)
        handed = None if leftness is None else ('Left' if leftness > 0.5 else 'Right')
        cx, cy = (thumb[0]+index[0])/2, (thumb[1]+index[1])/2   # thumb/index midpoint: steadier than either tip mid-pinch
        out.append({'id': h, 'hand': handed,
                    'x': round(min(max(cx,0.0),1.0), 4), 'y': round(min(max(cy,0.0),1.0), 4),
                    'pinch': round(min(ratio, 4.0), 4), 'pinching': _latch(h, ratio), 'conf': 1.0})
    # A slot that skipped this tick (hand left / channels drifted) must drop its
    # latch — a re-entering half-open hand may never cross PINCH_ON again and
    # would otherwise inherit pinching:true forever.
    states = me.fetch('pinchStates', {}, storeDefault=True)
    emitted = {o['id'] for o in out}
    for h in (1, 2):
        if h not in emitted:
            states[h] = False
    payload = json.dumps({'type':'hands','t': absTime.seconds,'aspect': round(aspect,4),'hands': out}, separators=(',',':'))
    for client in conns:
        try: ws.webSocketSendText(client, payload)
        except Exception: pass
