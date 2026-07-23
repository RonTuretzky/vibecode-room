# Phone-as-roaming-mic (`public/mic.html`)

Audit finding §5.9: phone-as-roaming-mic was promised (PRD REQ scope) but no page
existed. `public/mic.html` closes that gap: a self-contained mobile page (inline
CSS/JS, no build step, no framework) that turns any phone on the LAN into an
extra mic for the room, streaming straight into the same pipeline the built-in
browser mic uses.

Because it lives under `public/`, Vite's default `publicDir` behavior copies it
verbatim to `dist/mic.html` on `bun run build`, and the dev server (`bun run
dev`) serves it as-is at `/mic.html` with no build step. `src/server/app.ts`'s
`serveStatic` fallback (`app.get("*", ...)`) then serves it from `dist/` in
production, exactly like `index.html`.

## Usage

1. Start the projector server so it's reachable on the LAN (`HOST=0.0.0.0 bun
   run start`, or the equivalent in `run-room.sh`).
2. On the phone, browse to `http://<server-lan-ip>:<port>/mic.html`.
3. Tap the big button to request mic permission and go live. Tap it again to
   locally mute/unmute (stops sending frames without tearing down the socket).
   A "stop session" link releases the mic and closes the connection.

The page shows a connection-status dot/line and a live level meter so you can
confirm audio is actually reaching the room from across a stage or venue.

## Protocol (mirrors `src/ui/mic.ts`)

- Captures audio via `getUserMedia` (mono, echo cancellation + noise
  suppression on).
- Encodes to 16 kHz mono little-endian Int16 (linear16) PCM using a
  `ScriptProcessor` at a 4096-sample frame size, resampling by linear
  interpolation when the `AudioContext` won't grant a native 16 kHz context.
  The encoder in `mic.html` (`floatTo16BitPCM` / `downsample`, marked with
  `@encoder-test-begin` / `@encoder-test-end` comments) is a line-for-line copy
  of the same functions in `src/ui/mic.ts`, kept in sync by hand since the page
  has no build step and can't import from `src/`.
- Streams binary PCM frames over `ws(s)://<location.host>/api/mic` — the exact
  same WebSocket endpoint and session the built-in browser mic uses
  (`src/server/index.ts`). The server does not distinguish phone vs. built-in
  mic sessions.
- On connect, the server may reply with a control frame and immediately close
  with code `1008` and reason `"muted"` if the room is currently muted (mic
  sessions are never opened while muted). The page reacts by `POST
  /api/unmute`-ing, then reconnecting with exponential backoff (1s → 10s cap).

## HTTPS / insecure-origin caveat (read before demoing)

Browsers only expose `getUserMedia` on "secure contexts": `https:` origins, or
`http://localhost` / `http://127.0.0.1`. A phone hitting the server's plain
`http://<lan-ip>:<port>/mic.html` is **not** a secure context by default, so
`navigator.mediaDevices` may simply be missing.

- **Android Chrome** has a working escape hatch for LAN demos: open
  `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, add the exact
  origin (e.g. `http://192.168.1.42:8787`) to the list, enable the flag, and
  relaunch Chrome. `mic.html` detects the blocked-mic case and shows this
  exact flag name plus the current origin inline so it can be copy-pasted on
  the phone.
- **iOS Safari has no equivalent override.** `getUserMedia` requires HTTPS (or
  localhost) unconditionally; there is no flag, no entitlement, no way around
  it for a plain-HTTP LAN origin. Do not plan a live demo around an iPhone on
  plain HTTP.
- **Primary target for the demo is Android Chrome or a desktop browser** on
  the same LAN as the server, both over plain HTTP with the flag above (or
  desktop's `localhost`, which needs no flag at all). If iOS support is ever
  required, put the server behind a TLS-terminating proxy and use the HTTPS
  origin instead — `mic.html` itself needs no changes to work over `https:`
  (it already switches to `wss:` automatically based on
  `location.protocol`).

## Testing

`mic.html` has no build step and isn't imported by anything in `src/`, so it
isn't covered by the app's `bun test` suite. The PCM encoder block is written
as dependency-free pure functions (no DOM/AudioContext) specifically so it can
be extracted and exercised headlessly, e.g. from Node:

```js
const fs = require("fs");
const html = fs.readFileSync("public/mic.html", "utf8");
const src = html.match(/@encoder-test-begin \*\/([\s\S]*?)\/\* @encoder-test-end/)[1];
const sandbox = {};
new Function("globalThis", src)(sandbox);
const { floatTo16BitPCM, downsample } = sandbox.MicEncoder;
// exercise floatTo16BitPCM/downsample directly with Float32Array fixtures
```

The rest of the page (WebSocket lifecycle, unmute-then-reconnect, UI state) was
verified manually against a running `bun run start` server plus a browser
`WebSocket`/`getUserMedia` shim, and by inspecting `src/server/index.ts`'s
`/api/mic` upgrade handler and `src/server/app.ts`'s `/api/unmute` route for
the exact close-code/response contract.
