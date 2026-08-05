// Shared plumbing for the LAN-facing listeners (the 0.0.0.0 phone-import
// socket and the optional guest-hands TLS socket): the /hands/ws upgrade
// routing, the guest WebSocket handlers, and the port resolvers. Extracted
// from index.ts — which boots the runtime and binds sockets on import — so all
// of this is unit-testable with fakes.

import type { Hono } from "hono";
import type { HubConnection, RemoteHandsHub } from "./remote-hands";

// Per-connection state for a LAN listener's guest-hands WebSocket.
export interface LanSocketData {
  kind?: "hands-guest";
  hands?: HubConnection;
}

interface UpgradableServer {
  upgrade(request: Request, options: { data: LanSocketData }): boolean;
}

// The LAN fetch handler: /hands/ws upgrades to a guest socket; everything else
// goes to the LAN app. The app is LATE-BOUND (a thunk) because it is created
// only after every bind resolves — so /api/import/info and /api/hands/info
// always advertise the ports that actually bound, never the wanted ones. The
// microseconds-wide window before assignment answers 503.
export function createLanFetch(app: () => Hono | null) {
  return (request: Request, server: UpgradableServer): Response | Promise<Response> | undefined => {
    if (new URL(request.url).pathname === "/hands/ws") {
      if (server.upgrade(request, { data: { kind: "hands-guest" } })) {
        return undefined;
      }
      return new Response("Expected a WebSocket upgrade for /hands/ws", { status: 426 });
    }
    const target = app();
    if (target === null) {
      return new Response("Starting…", { status: 503 });
    }
    return target.fetch(request);
  };
}

// Guest-ingest WebSocket handlers over the shared relay hub. LAN sockets carry
// ONLY guest connections (the wall's /api/hands/room subscription lives on the
// main listener) — anything else is ignored.
export function createLanWebsocket(hub: RemoteHandsHub) {
  return {
    open(ws: { data?: LanSocketData; send: (raw: string) => void }) {
      if (ws.data?.kind === "hands-guest") {
        ws.data.hands = hub.addGuest((raw) => ws.send(raw));
      }
    },
    message(ws: { data?: LanSocketData }, message: string | Uint8Array) {
      if (ws.data?.kind === "hands-guest" && typeof message === "string") {
        ws.data.hands?.message(message);
      }
    },
    close(ws: { data?: LanSocketData }) {
      if (ws.data?.kind === "hands-guest") {
        ws.data.hands?.close();
      }
    },
  };
}

// The phone listener's port. Falls back to main+1 — NEVER to a parse default
// and never to the main port itself: a garbage VIBERSYN_PHONE_PORT must not
// make the phone listener grab the main port first and crash the room's own
// bind (the phone listener is best-effort by contract).
export function resolvePhonePort(raw: string | undefined, mainPort: number, warn: (message: string) => void = console.warn): number {
  const parsed = Number(raw);
  if (raw !== undefined && Number.isInteger(parsed) && parsed > 0 && parsed !== mainPort) {
    return parsed;
  }
  if (raw !== undefined) {
    warn(`[import] VIBERSYN_PHONE_PORT=${raw} is unusable — falling back to ${mainPort + 1}.`);
  }
  return mainPort + 1;
}

// The guest-hands TLS listener's port. Same best-effort contract: a garbage
// VIBERSYN_HANDS_TLS_PORT falls back to main+2 (skipping the phone port) and
// must never collide with a socket the room depends on.
export function resolveTlsPort(
  raw: string | undefined,
  mainPort: number,
  phonePort: number | null,
  warn: (message: string) => void = console.warn,
): number {
  const parsed = Number(raw);
  if (raw !== undefined && Number.isInteger(parsed) && parsed > 0 && parsed !== mainPort && parsed !== phonePort) {
    return parsed;
  }
  const fallback = mainPort + 2 === phonePort ? mainPort + 3 : mainPort + 2;
  if (raw !== undefined) {
    warn(`[hands] VIBERSYN_HANDS_TLS_PORT=${raw} is unusable — falling back to ${fallback}.`);
  }
  return fallback;
}
