import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createLanFetch, createLanWebsocket, resolvePhonePort, resolveTlsPort, type LanSocketData } from "./lan-listener";
import { RemoteHandsHub } from "./remote-hands";

describe("resolvePhonePort", () => {
  test("an explicit usable port wins; garbage and collisions fall back to main+1 with a warning", () => {
    const warnings: string[] = [];
    const warn = (message: string) => warnings.push(message);
    expect(resolvePhonePort("9100", 8787, warn)).toBe(9100);
    expect(warnings).toHaveLength(0);
    expect(resolvePhonePort("8787", 8787, warn)).toBe(8788); // == main
    expect(resolvePhonePort("nope", 8787, warn)).toBe(8788);
    expect(resolvePhonePort("-1", 8787, warn)).toBe(8788);
    expect(warnings).toHaveLength(3);
    expect(resolvePhonePort(undefined, 8787, warn)).toBe(8788); // default, silent
    expect(warnings).toHaveLength(3);
  });
});

describe("resolveTlsPort", () => {
  test("explicit usable port wins; collisions with main or phone fall back", () => {
    const warn = () => undefined;
    expect(resolveTlsPort("9200", 8787, 8788, warn)).toBe(9200);
    expect(resolveTlsPort("8787", 8787, 8788, warn)).toBe(8789); // == main
    expect(resolveTlsPort("8788", 8787, 8788, warn)).toBe(8789); // == phone
    expect(resolveTlsPort(undefined, 8787, 8788, warn)).toBe(8789); // default main+2
  });

  test("the fallback skips the phone port when the phone listener sits on main+2", () => {
    const warn = () => undefined;
    expect(resolveTlsPort(undefined, 8787, 8789, warn)).toBe(8790);
    expect(resolveTlsPort("junk", 8787, 8789, warn)).toBe(8790);
  });
});

describe("createLanFetch", () => {
  const upgrading = { upgrade: () => true };
  const notUpgrading = { upgrade: () => false };

  test("/hands/ws upgrades to a guest socket (undefined = Bun owns the response)", () => {
    const fetch = createLanFetch(() => null);
    expect(fetch(new Request("http://lan:8788/hands/ws"), upgrading)).toBeUndefined();
  });

  test("/hands/ws without a websocket handshake is a 426", async () => {
    const fetch = createLanFetch(() => null);
    const response = (await fetch(new Request("http://lan:8788/hands/ws"), notUpgrading)) as Response;
    expect(response.status).toBe(426);
  });

  test("other paths hit the late-bound app; 503 before the boot sequence assigns it", async () => {
    let app: Hono | null = null;
    const fetch = createLanFetch(() => app);
    const starting = (await fetch(new Request("http://lan:8788/hands"), notUpgrading)) as Response;
    expect(starting.status).toBe(503);

    app = new Hono();
    app.get("/hands", (context) => context.text("guest page"));
    const served = (await fetch(new Request("http://lan:8788/hands"), notUpgrading)) as Response;
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("guest page");
  });
});

describe("createLanWebsocket", () => {
  test("guest sockets register with the hub, relay messages, and clean up on close", () => {
    const hub = new RemoteHandsHub({ now: () => 1 });
    const roomSent: string[] = [];
    hub.addRoom((raw) => roomSent.push(raw)).message(JSON.stringify({ type: "hello", wall: "A" }));

    const handlers = createLanWebsocket(hub);
    const sent: string[] = [];
    const ws: { data?: LanSocketData; send: (raw: string) => void } = {
      data: { kind: "hands-guest" },
      send: (raw) => sent.push(raw),
    };
    handlers.open(ws);
    expect(hub.guestCount()).toBe(1);
    expect(JSON.parse(sent[0]).type).toBe("welcome");

    handlers.message(ws, JSON.stringify({ type: "cursors", cursors: [{ id: 0, x: 0.5, y: 0.5, engaged: true }] }));
    expect(roomSent.some((raw) => JSON.parse(raw).type === "cursors")).toBe(true);
    handlers.message(ws, new Uint8Array([1, 2, 3])); // binary is ignored

    handlers.close(ws);
    expect(hub.guestCount()).toBe(0);
  });

  test("sockets without the guest kind are ignored entirely", () => {
    const hub = new RemoteHandsHub();
    const handlers = createLanWebsocket(hub);
    const ws: { data?: LanSocketData; send: (raw: string) => void } = { data: {}, send: () => undefined };
    handlers.open(ws);
    handlers.message(ws, "{}");
    handlers.close(ws);
    expect(hub.guestCount()).toBe(0);
  });
});
