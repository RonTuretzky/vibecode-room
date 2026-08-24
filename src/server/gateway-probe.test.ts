// A CONFIGURED GATEWAY IS NOT A LIVE ONE.
//
// Found across two machines running the same room: one operator's gateway was
// healthy with real accumulated state, the other's port had nothing on it at
// all — and BOTH rooms' /api/health reported only tts/sink degraded, because
// the smithers leg only ever warned when no gateway URL was configured. The
// room pointed at a dead port and called itself well.
import { describe, expect, test } from "bun:test";

import {
  GATEWAY_PROBE_CACHE_MS,
  GATEWAY_UNKNOWN,
  GatewayProbe,
  SUPPORTED_GATEWAY_PROTOCOL,
  probeGateway,
  type GatewayLiveness,
} from "./gateway-probe";
import { buildDegradationNotice, type RuntimeLegSelections } from "./degradation-notice";

const GATEWAY_SELECTIONS: RuntimeLegSelections = {
  asr: "deepgram",
  tts: "elevenlabs",
  sink: "device",
  decider: "claude",
  smithers: "gateway",
  summarizer: "cerebras",
};

const smithersLeg = (notice: ReturnType<typeof buildDegradationNotice>) =>
  notice.degraded.find((leg) => leg.leg === "smithers") ?? null;

describe("probeGateway", () => {
  test("a healthy gateway reports reachable + its protocol", async () => {
    const result = await probeGateway("http://127.0.0.1:7331", {
      fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, protocol: 1, stateVersion: 4191 }) }),
    });
    expect(result).toEqual({ reachable: true, protocol: 1, error: null });
  });

  test("A DEAD PORT is reachable:false with the cause kept, never a throw", async () => {
    const result = await probeGateway("http://127.0.0.1:7331", {
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:7331");
      },
    });
    expect(result.reachable).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });

  test("a health endpoint must not hang on a dead port — the probe times out", async () => {
    const result = await probeGateway("http://127.0.0.1:7331", {
      timeoutMs: 20,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("The operation was aborted.")));
        }),
    });
    expect(result.reachable).toBe(false);
  });

  test("something answering that is NOT the gateway is not 'reachable'", async () => {
    const result = await probeGateway("http://127.0.0.1:7331", {
      fetchImpl: async () => ({ ok: false, json: async () => ({}) }),
    });
    expect(result.reachable).toBe(false);
  });

  test("a gateway with no protocol field still counts as reachable", async () => {
    const result = await probeGateway("http://x", {
      fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true }) }),
    });
    expect(result).toEqual({ reachable: true, protocol: null, error: null });
  });

  test("a trailing slash does not produce a double slash", async () => {
    let seen = "";
    await probeGateway("http://127.0.0.1:7331/", {
      fetchImpl: async (url) => {
        seen = url;
        return { ok: true, json: async () => ({ protocol: 1 }) };
      },
    });
    expect(seen).toBe("http://127.0.0.1:7331/health");
  });
});

describe("GatewayProbe caching", () => {
  test("a burst of health hits costs ONE round-trip, not one each", async () => {
    let calls = 0;
    let nowMs = 1_000;
    const probe = new GatewayProbe({
      url: "http://x",
      now: () => nowMs,
      probe: async () => {
        calls += 1;
        return { reachable: true, protocol: 1, error: null };
      },
    });
    await Promise.all([probe.liveness(), probe.liveness(), probe.liveness()]);
    await probe.liveness();
    expect(calls).toBe(1);
  });

  test("but a gateway that dies mid-session shows up once the cache lapses", async () => {
    let nowMs = 1_000;
    let alive = true;
    const probe = new GatewayProbe({
      url: "http://x",
      now: () => nowMs,
      probe: async () => ({ reachable: alive, protocol: alive ? 1 : null, error: alive ? null : "ECONNREFUSED" }),
    });
    expect((await probe.liveness()).reachable).toBe(true);
    alive = false;
    expect((await probe.liveness()).reachable).toBe(true); // still cached
    nowMs += GATEWAY_PROBE_CACHE_MS + 1;
    expect((await probe.liveness()).reachable).toBe(false);
  });

  test("no gateway configured = UNKNOWN, and no I/O at all", async () => {
    let calls = 0;
    const probe = new GatewayProbe({
      url: null,
      probe: async () => {
        calls += 1;
        return { reachable: true, protocol: 1, error: null };
      },
    });
    expect(await probe.liveness()).toEqual(GATEWAY_UNKNOWN);
    expect(calls).toBe(0);
  });

  test("peek() never blocks and never invents a verdict", async () => {
    const probe = new GatewayProbe({ url: "http://x", probe: async () => ({ reachable: true, protocol: 1, error: null }) });
    expect(probe.peek()).toEqual(GATEWAY_UNKNOWN);
    await probe.liveness();
    expect(probe.peek().reachable).toBe(true);
  });
});

describe("the smithers leg with live facts", () => {
  const live = (gateway: GatewayLiveness) =>
    buildDegradationNotice(GATEWAY_SELECTIONS, { gateway, gatewayUrl: "http://127.0.0.1:7331" });

  test("THE LIVE BUG: a configured-but-dead gateway is now degraded, and names the address", () => {
    const leg = smithersLeg(live({ reachable: false, protocol: null, error: "ECONNREFUSED" }));
    expect(leg).not.toBeNull();
    expect(leg?.mode).toBe("gateway-unreachable");
    expect(leg?.detail).toContain("127.0.0.1:7331");
    expect(leg?.detail).toContain("ECONNREFUSED");
    expect(leg?.upgrade).toContain("start the gateway");
  });

  test("a healthy gateway on the supported protocol is NOT degraded", () => {
    const notice = live({ reachable: true, protocol: SUPPORTED_GATEWAY_PROTOCOL, error: null });
    expect(smithersLeg(notice)).toBeNull();
  });

  test("a protocol mismatch is a boot-time notice, not a mid-build mystery", () => {
    const leg = smithersLeg(live({ reachable: true, protocol: 2, error: null }));
    expect(leg?.mode).toBe("gateway-protocol-2");
    expect(leg?.detail).toContain("protocol 2");
    expect(leg?.detail).toContain(`speaks ${SUPPORTED_GATEWAY_PROTOCOL}`);
  });

  test("UNMEASURED claims nothing — in either direction", () => {
    expect(smithersLeg(live(GATEWAY_UNKNOWN))).toBeNull();
    // And with no liveness argument at all, the notice is exactly as before.
    expect(smithersLeg(buildDegradationNotice(GATEWAY_SELECTIONS))).toBeNull();
  });

  test("the in-memory client keeps its own separate warning, unchanged", () => {
    const leg = smithersLeg(
      buildDegradationNotice(
        { ...GATEWAY_SELECTIONS, smithers: "memory" },
        { gateway: { reachable: false, protocol: null, error: "x" }, gatewayUrl: null },
      ),
    );
    // Memory mode is its own degradation and must not be reported as a dead
    // gateway — there is no gateway to be dead.
    expect(leg?.mode).toBe("memory");
  });

  test("a dead gateway makes allReal false", () => {
    expect(live({ reachable: false, protocol: null, error: "x" }).allReal).toBe(false);
  });
});
