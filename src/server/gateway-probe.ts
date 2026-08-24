/**
 * IS THE CONFIGURED SMITHERS GATEWAY ACTUALLY THERE?
 *
 * The room's degradation notice is selection-based: every leg reports what was
 * CONFIGURED, never what is alive. That is right for asr/tts/sink/decider —
 * their backends are chosen at boot and cannot vanish — but it is wrong for the
 * gateway, which is a separate process on a port. Setting
 * VIBERSYN_SMITHERS_GATEWAY_URL flipped the leg from "memory" to "gateway" and
 * the room never asked again, so a gateway that was never started, died, or
 * lives on another machine reads as perfectly healthy while every spawn fails.
 *
 * That is exactly the shape found live: one operator's room pointed at a dead
 * :7331 with /api/health reporting nothing wrong at all.
 *
 * So the I/O lives HERE, at the health-endpoint layer, and its RESULT is passed
 * into buildDegradationNotice as data. The notice function stays pure and keeps
 * every leg's reasoning in one place.
 *
 * Two things are checked in the one round-trip, because the second is free once
 * the first has parsed the payload:
 *   • reachability — did anything answer,
 *   • protocol — the gateway advertises {"protocol": N}, and the room's client
 *     never reads it. An unsupported protocol becomes a boot-time notice here
 *     instead of a mid-build failure nobody can trace.
 */

// The protocol version this room's client speaks. The gateway advertises its
// own on /health; a mismatch is reported rather than assumed compatible.
export const SUPPORTED_GATEWAY_PROTOCOL = 1;

// Health hits are cheap and frequent (dashboards, the wall, curl). Probing the
// gateway on every one would turn a status page into a load generator, so the
// verdict is cached briefly — long enough to coalesce a burst, short enough
// that a gateway dying mid-session shows up within seconds.
export const GATEWAY_PROBE_CACHE_MS = 10_000;
// A health endpoint must never hang on a dead port. Short, and deliberately
// shorter than any reasonable client timeout.
export const GATEWAY_PROBE_TIMEOUT_MS = 1_500;

export interface GatewayLiveness {
  // null = never measured (probe disabled, or no gateway configured). The
  // notice must not claim health it has not established, in EITHER direction.
  reachable: boolean | null;
  // The protocol the gateway advertised, or null when unreachable/unparsable.
  protocol: number | null;
  // Verbatim failure text for the operator ("connection refused"), or null.
  error: string | null;
}

export const GATEWAY_UNKNOWN: GatewayLiveness = { reachable: null, protocol: null, error: null };

type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

/**
 * One bounded round-trip to the gateway's /health. Never throws — a health
 * endpoint that can fail because its own probe failed is worse than no probe.
 */
export async function probeGateway(
  url: string,
  options: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<GatewayLiveness> {
  const fetchImpl = (options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)) as FetchLike;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? GATEWAY_PROBE_TIMEOUT_MS);
  (timer as { unref?: () => void }).unref?.();
  try {
    const response = await fetchImpl(`${url.replace(/\/+$/u, "")}/health`, { signal: controller.signal });
    if (!response.ok) {
      return { reachable: false, protocol: null, error: "gateway answered but not with health" };
    }
    const body = (await response.json()) as { protocol?: unknown } | null;
    const protocol = typeof body?.protocol === "number" ? body.protocol : null;
    return { reachable: true, protocol, error: null };
  } catch (error) {
    // Abort (timeout) and connection-refused both land here; keep the cause.
    const message = error instanceof Error ? error.message : String(error);
    return { reachable: false, protocol: null, error: message.slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A probe with a short memory. `url` null (no gateway configured) resolves to
 * UNKNOWN without any I/O — the in-memory client is its own separate leg and
 * already reports itself.
 */
export class GatewayProbe {
  readonly #url: string | null;
  readonly #now: () => number;
  readonly #probe: (url: string) => Promise<GatewayLiveness>;
  readonly #cacheMs: number;
  #cached: { atMs: number; value: GatewayLiveness } | null = null;
  // Coalesce a burst of health hits onto ONE in-flight round-trip.
  #inFlight: Promise<GatewayLiveness> | null = null;

  constructor(options: {
    url: string | null;
    now?: () => number;
    probe?: (url: string) => Promise<GatewayLiveness>;
    cacheMs?: number;
  }) {
    this.#url = options.url;
    this.#now = options.now ?? Date.now;
    this.#probe = options.probe ?? ((url) => probeGateway(url));
    this.#cacheMs = options.cacheMs ?? GATEWAY_PROBE_CACHE_MS;
  }

  /** The last verdict without touching the network — for synchronous callers. */
  peek(): GatewayLiveness {
    return this.#cached?.value ?? GATEWAY_UNKNOWN;
  }

  async liveness(): Promise<GatewayLiveness> {
    if (this.#url === null) {
      return GATEWAY_UNKNOWN;
    }
    const nowMs = this.#now();
    const cached = this.#cached;
    if (cached !== null && nowMs - cached.atMs < this.#cacheMs) {
      return cached.value;
    }
    if (this.#inFlight !== null) {
      return this.#inFlight;
    }
    const url = this.#url;
    this.#inFlight = this.#probe(url)
      .then((value) => {
        this.#cached = { atMs: this.#now(), value };
        return value;
      })
      .catch(() => GATEWAY_UNKNOWN)
      .finally(() => {
        this.#inFlight = null;
      });
    return this.#inFlight;
  }
}
