import { describe, expect, test } from "bun:test";
import { createCerebrasChatModel } from "./backends/eliza";
import { createCerebrasModel } from "./backends/native";
import {
  CEREBRAS_MAX_CONCURRENT_ENV,
  CerebrasThrottle,
  DEFAULT_CEREBRAS_MAX_CONCURRENT,
  abortableSleep,
  createCerebrasRetryFetch,
  fetchWithCerebrasBackoff,
  isRetryableCerebrasStatus,
  parseRetryAfterMs,
  resolveCerebrasMaxConcurrent,
  type AbortableSleep,
} from "./cerebras-retry";

// All tests: zero real network, zero real backoff waiting (sleep is injected
// everywhere a delay would otherwise be real).

const okChatPayload = JSON.stringify({ choices: [{ message: { content: "hello" } }] });

function recordingSleep(): { sleeps: number[]; sleep: AbortableSleep } {
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
}

function sequenceFetch(makeResponses: Array<() => Response>): { calls: () => number; fetchImpl: typeof fetch } {
  let calls = 0;
  const fetchImpl = (async () => {
    const make = makeResponses[Math.min(calls, makeResponses.length - 1)]!;
    calls += 1;
    return make();
  }) as unknown as typeof fetch;
  return { calls: () => calls, fetchImpl };
}

// --- resolveCerebrasMaxConcurrent -------------------------------------------

describe("resolveCerebrasMaxConcurrent", () => {
  test("defaults to a conservative 2", () => {
    expect(DEFAULT_CEREBRAS_MAX_CONCURRENT).toBe(2);
    expect(resolveCerebrasMaxConcurrent({})).toBe(2);
    expect(resolveCerebrasMaxConcurrent({ [CEREBRAS_MAX_CONCURRENT_ENV]: undefined })).toBe(2);
  });

  test("honors a valid env override", () => {
    expect(resolveCerebrasMaxConcurrent({ [CEREBRAS_MAX_CONCURRENT_ENV]: "5" })).toBe(5);
    expect(resolveCerebrasMaxConcurrent({ [CEREBRAS_MAX_CONCURRENT_ENV]: "1" })).toBe(1);
  });

  test("garbage, zero, and negatives fall back to the default", () => {
    expect(resolveCerebrasMaxConcurrent({ [CEREBRAS_MAX_CONCURRENT_ENV]: "banana" })).toBe(2);
    expect(resolveCerebrasMaxConcurrent({ [CEREBRAS_MAX_CONCURRENT_ENV]: "0" })).toBe(2);
    expect(resolveCerebrasMaxConcurrent({ [CEREBRAS_MAX_CONCURRENT_ENV]: "-3" })).toBe(2);
    expect(resolveCerebrasMaxConcurrent({ [CEREBRAS_MAX_CONCURRENT_ENV]: "  " })).toBe(2);
  });
});

// --- parseRetryAfterMs ------------------------------------------------------

describe("parseRetryAfterMs", () => {
  test("absent or unparseable → null", () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("")).toBeNull();
    expect(parseRetryAfterMs("soonish")).toBeNull();
  });

  test("delta-seconds form", () => {
    expect(parseRetryAfterMs("7")).toBe(7_000);
    expect(parseRetryAfterMs("  12  ")).toBe(12_000);
    expect(parseRetryAfterMs("0")).toBe(0);
  });

  test("HTTP-date form, clamped at zero for the past", () => {
    const now = Date.parse("2026-07-22T10:00:00Z");
    expect(parseRetryAfterMs(new Date(now + 30_000).toUTCString(), () => now)).toBe(30_000);
    expect(parseRetryAfterMs(new Date(now - 30_000).toUTCString(), () => now)).toBe(0);
  });
});

// --- abortableSleep ---------------------------------------------------------

describe("abortableSleep", () => {
  test("resolves after the delay", async () => {
    await abortableSleep(5); // just: does not hang or throw
  });

  test("rejects immediately on an already-aborted signal", async () => {
    await expect(abortableSleep(10_000, AbortSignal.abort())).rejects.toBeDefined();
  });

  test("an abort mid-sleep cancels the sleep instantly", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const sleeping = abortableSleep(30_000, controller.signal);
    setTimeout(() => controller.abort(), 5);
    await expect(sleeping).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

// --- CerebrasThrottle -------------------------------------------------------

describe("CerebrasThrottle", () => {
  test("hands out at most maxConcurrent tokens; waiters resume FIFO", async () => {
    const throttle = new CerebrasThrottle(2);
    const r1 = await throttle.acquire();
    const r2 = await throttle.acquire();
    expect(throttle.active).toBe(2);

    const order: string[] = [];
    const third = throttle.acquire().then((release) => {
      order.push("third");
      return release;
    });
    const fourth = throttle.acquire().then((release) => {
      order.push("fourth");
      return release;
    });
    expect(throttle.waiting).toBe(2);

    r1();
    const r3 = await third;
    expect(order).toEqual(["third"]);
    r2();
    const r4 = await fourth;
    expect(order).toEqual(["third", "fourth"]);
    r3();
    r4();
    expect(throttle.active).toBe(0);
    expect(throttle.waiting).toBe(0);
  });

  test("aborting a queued waiter rejects instantly and leaves the queue clean", async () => {
    const throttle = new CerebrasThrottle(1);
    const release = await throttle.acquire();
    const controller = new AbortController();
    const queued = throttle.acquire(controller.signal);
    expect(throttle.waiting).toBe(1);
    controller.abort();
    await expect(queued).rejects.toBeDefined();
    expect(throttle.waiting).toBe(0);
    release();
    // the slot is still usable afterwards
    (await throttle.acquire())();
    expect(throttle.active).toBe(0);
  });

  test("acquire on an already-aborted signal throws before taking a token", async () => {
    const throttle = new CerebrasThrottle(1);
    await expect(throttle.acquire(AbortSignal.abort())).rejects.toBeDefined();
    expect(throttle.active).toBe(0);
  });

  test("release is idempotent", async () => {
    const throttle = new CerebrasThrottle(1);
    const release = await throttle.acquire();
    release();
    release();
    expect(throttle.active).toBe(0);
    const again = await throttle.acquire();
    expect(throttle.active).toBe(1);
    again();
  });
});

// --- fetchWithCerebrasBackoff -----------------------------------------------

describe("fetchWithCerebrasBackoff", () => {
  test("a success passes straight through with no sleeping", async () => {
    const { sleeps, sleep } = recordingSleep();
    const { calls, fetchImpl } = sequenceFetch([() => new Response("fine", { status: 200 })]);
    const response = await fetchWithCerebrasBackoff("https://api.cerebras.ai/v1/chat/completions", {}, { fetchImpl, sleep, throttle: null });
    expect(response.status).toBe(200);
    expect(calls()).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test("a 429 retries with equal-jitter exponential backoff, then succeeds", async () => {
    const { sleeps, sleep } = recordingSleep();
    const { calls, fetchImpl } = sequenceFetch([
      () => new Response("token_quota_exceeded", { status: 429 }),
      () => new Response("ok", { status: 200 }),
    ]);
    const response = await fetchWithCerebrasBackoff(
      "https://x",
      {},
      { fetchImpl, sleep, throttle: null, baseDelayMs: 1_000, random: () => 0 },
    );
    expect(response.status).toBe(200);
    expect(calls()).toBe(2);
    expect(sleeps).toEqual([500]); // equal jitter floor: base/2 with random()=0
  });

  test("a 5xx retries too; a plain 4xx does not", async () => {
    const { sleeps, sleep } = recordingSleep();
    const fiveHundred = sequenceFetch([() => new Response("queue_exceeded", { status: 503 }), () => new Response("ok", { status: 200 })]);
    const okAfter503 = await fetchWithCerebrasBackoff("https://x", {}, { fetchImpl: fiveHundred.fetchImpl, sleep, throttle: null, random: () => 0 });
    expect(okAfter503.status).toBe(200);
    expect(fiveHundred.calls()).toBe(2);

    const fourHundred = sequenceFetch([() => new Response("bad request", { status: 400 })]);
    const bad = await fetchWithCerebrasBackoff("https://x", {}, { fetchImpl: fourHundred.fetchImpl, sleep, throttle: null });
    expect(bad.status).toBe(400);
    expect(fourHundred.calls()).toBe(1);
  });

  test("honors Retry-After (seconds) over the exponential curve", async () => {
    const { sleeps, sleep } = recordingSleep();
    const { calls, fetchImpl } = sequenceFetch([
      () => new Response("Tokens per minute limit exceeded", { status: 429, headers: { "retry-after": "7" } }),
      () => new Response("ok", { status: 200 }),
    ]);
    const response = await fetchWithCerebrasBackoff("https://x", {}, { fetchImpl, sleep, throttle: null, random: () => 0 });
    expect(response.status).toBe(200);
    expect(calls()).toBe(2);
    expect(sleeps).toEqual([7_000]);
  });

  test("a Retry-After beyond the total budget gives up immediately with the 429", async () => {
    const { sleeps, sleep } = recordingSleep();
    const { calls, fetchImpl } = sequenceFetch([
      () => new Response("come back tomorrow", { status: 429, headers: { "retry-after": "120" } }),
    ]);
    const response = await fetchWithCerebrasBackoff(
      "https://x",
      {},
      { fetchImpl, sleep, throttle: null, maxTotalDelayMs: 90_000, random: () => 0 },
    );
    expect(response.status).toBe(429);
    expect(calls()).toBe(1);
    expect(sleeps).toEqual([]);
    expect(await response.text()).toBe("come back tomorrow"); // body still readable for the caller's error message
  });

  test("exhausts ~4 attempts then returns the last retryable response, body intact", async () => {
    const { sleeps, sleep } = recordingSleep();
    const { calls, fetchImpl } = sequenceFetch([() => new Response("quota", { status: 429 })]);
    const response = await fetchWithCerebrasBackoff(
      "https://x",
      {},
      { fetchImpl, sleep, throttle: null, baseDelayMs: 1_000, random: () => 0 },
    );
    expect(response.status).toBe(429);
    expect(calls()).toBe(4); // default maxAttempts
    expect(sleeps).toEqual([500, 1_000, 2_000]); // doubling curve, equal-jitter floor
    expect(await response.text()).toBe("quota");
  });

  test("a transient network error is retried; an abort error is not", async () => {
    const { sleep } = recordingSleep();
    let flakyCalls = 0;
    const flaky = (async () => {
      flakyCalls += 1;
      if (flakyCalls === 1) {
        throw new TypeError("fetch failed: socket hangup");
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const response = await fetchWithCerebrasBackoff("https://x", {}, { fetchImpl: flaky, sleep, throttle: null, random: () => 0 });
    expect(response.status).toBe(200);
    expect(flakyCalls).toBe(2);

    let abortCalls = 0;
    const aborting = (async () => {
      abortCalls += 1;
      throw new DOMException("The operation was aborted", "AbortError");
    }) as unknown as typeof fetch;
    await expect(fetchWithCerebrasBackoff("https://x", {}, { fetchImpl: aborting, sleep, throttle: null })).rejects.toThrow();
    expect(abortCalls).toBe(1);
  });

  test("an abort during the backoff sleep rejects instantly (real sleep)", async () => {
    const controller = new AbortController();
    const { fetchImpl } = sequenceFetch([() => new Response("q", { status: 429, headers: { "retry-after": "30" } })]);
    const started = Date.now();
    const pending = fetchWithCerebrasBackoff("https://x", { signal: controller.signal }, { fetchImpl, throttle: null, random: () => 0 });
    setTimeout(() => controller.abort(), 5);
    await expect(pending).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("the throttle caps concurrent in-flight fetches", async () => {
    const throttle = new CerebrasThrottle(2);
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = (async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const { sleep } = recordingSleep();
    await Promise.all(
      Array.from({ length: 5 }, () => fetchWithCerebrasBackoff("https://x", {}, { fetchImpl, sleep, throttle })),
    );
    expect(peak).toBe(2);
    expect(throttle.active).toBe(0);
  });

  test("a build sleeping through backoff does not hold a throttle token", async () => {
    const throttle = new CerebrasThrottle(1);
    let releaseSleep: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseSleep = resolve;
    });
    const gatedSleep: AbortableSleep = async () => gate;
    const a = sequenceFetch([() => new Response("q", { status: 429 }), () => new Response("A", { status: 200 })]);
    const pendingA = fetchWithCerebrasBackoff("https://x", {}, { fetchImpl: a.fetchImpl, sleep: gatedSleep, throttle, random: () => 0 });
    await Bun.sleep(1); // let A take its 429 and enter the gated sleep
    expect(throttle.active).toBe(0);

    // B runs to completion while A is still backing off.
    const b = sequenceFetch([() => new Response("B", { status: 200 })]);
    const responseB = await fetchWithCerebrasBackoff("https://x", {}, { fetchImpl: b.fetchImpl, sleep: gatedSleep, throttle });
    expect(await responseB.text()).toBe("B");

    releaseSleep();
    expect(await (await pendingA).text()).toBe("A");
    expect(throttle.active).toBe(0);
  });

  test("isRetryableCerebrasStatus: 429 and the 5xx family only", () => {
    expect(isRetryableCerebrasStatus(429)).toBe(true);
    expect(isRetryableCerebrasStatus(500)).toBe(true);
    expect(isRetryableCerebrasStatus(503)).toBe(true);
    expect(isRetryableCerebrasStatus(599)).toBe(true);
    expect(isRetryableCerebrasStatus(200)).toBe(false);
    expect(isRetryableCerebrasStatus(400)).toBe(false);
    expect(isRetryableCerebrasStatus(404)).toBe(false);
    expect(isRetryableCerebrasStatus(600)).toBe(false);
  });

  test("createCerebrasRetryFetch forwards input and init untouched", async () => {
    const seen: Array<{ input: unknown; body: unknown }> = [];
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      seen.push({ input, body: init?.body });
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const retryFetch = createCerebrasRetryFetch({ fetchImpl, throttle: null });
    await retryFetch("https://api.cerebras.ai/v1/chat/completions", { method: "POST", body: "{}" });
    expect(seen).toEqual([{ input: "https://api.cerebras.ai/v1/chat/completions", body: "{}" }]);
  });
});

// --- wiring: the backends' default transport is the backoff fetch ------------

describe("backend wiring (retry options, no fetchImpl injected)", () => {
  const signal = new AbortController().signal;

  test("native createCerebrasModel rides out a 429 via the retry transport", async () => {
    const { sleeps, sleep } = recordingSleep();
    const { calls, fetchImpl } = sequenceFetch([
      () => new Response("token_quota_exceeded", { status: 429, headers: { "retry-after": "1" } }),
      () => new Response(okChatPayload, { status: 200 }),
    ]);
    const model = createCerebrasModel({ apiKey: "k", retry: { fetchImpl, sleep, throttle: null, random: () => 0 } });
    const out = await model!({ stage: "plan", system: "s", user: "u", signal });
    expect(out).toBe("hello");
    expect(calls()).toBe(2);
    expect(sleeps).toEqual([1_000]);
  });

  test("native: a final 429 surfaces as Cerebras HTTP 429 without a response_format re-send", async () => {
    const { sleep } = recordingSleep();
    const { calls, fetchImpl } = sequenceFetch([() => new Response("Tokens per minute limit exceeded", { status: 429 })]);
    const model = createCerebrasModel({ apiKey: "k", retry: { fetchImpl, sleep, throttle: null, maxAttempts: 2, random: () => 0 } });
    await expect(model!({ stage: "plan", system: "s", user: "u", signal })).rejects.toThrow(/Cerebras HTTP 429/);
    expect(calls()).toBe(2); // both backoff attempts — but NOT the doubled no-json-format pair
  });

  test("eliza createCerebrasChatModel rides out a 503 via the retry transport", async () => {
    const { sleeps, sleep } = recordingSleep();
    const { calls, fetchImpl } = sequenceFetch([
      () => new Response("queue_exceeded", { status: 503 }),
      () => new Response(JSON.stringify({ choices: [{ message: { content: "REPLY" } }] }), { status: 200 }),
    ]);
    const model = createCerebrasChatModel({ apiKey: "csk-test", retry: { fetchImpl, sleep, throttle: null, baseDelayMs: 1_000, random: () => 0 } })!;
    await expect(model({ prompt: "p", signal })).resolves.toBe("REPLY");
    expect(calls()).toBe(2);
    expect(sleeps).toEqual([500]);
  });

  test("eliza: a final 429 surfaces as Cerebras HTTP 429 without a response_format re-send", async () => {
    const { sleep } = recordingSleep();
    const { calls, fetchImpl } = sequenceFetch([() => new Response("token_quota_exceeded", { status: 429 })]);
    const model = createCerebrasChatModel({ apiKey: "csk-test", retry: { fetchImpl, sleep, throttle: null, maxAttempts: 2, random: () => 0 } })!;
    await expect(model({ prompt: "p", signal })).rejects.toThrow("Cerebras HTTP 429");
    expect(calls()).toBe(2);
  });

  test("an injected fetchImpl still bypasses the retry transport entirely (legacy test seam)", async () => {
    const { calls, fetchImpl } = sequenceFetch([() => new Response("boom", { status: 500 })]);
    const model = createCerebrasModel({ apiKey: "k", fetchImpl });
    await expect(model!({ stage: "plan", system: "s", user: "u", signal })).rejects.toThrow(/Cerebras HTTP 500/);
    expect(calls()).toBe(1); // no backoff retries on the raw injected transport
  });
});
