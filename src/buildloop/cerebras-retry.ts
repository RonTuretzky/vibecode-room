/**
 * Shared Cerebras transport hardening for the build backends (eliza + native).
 *
 * Why: during a concurrent 3-idea fan-out the room saw Cerebras replies of
 * `HTTP 429 token_quota_exceeded — Tokens per minute limit exceeded` (and
 * intermittent `queue_exceeded`) kill builds outright. Both backends speak to
 * the same per-minute quota, so the fix lives here once:
 *
 *   - fetchWithCerebrasBackoff: on 429/5xx (and transient network errors),
 *     retry with exponential backoff + jitter, honoring a Retry-After header
 *     when the server sends one. At most DEFAULT_MAX_ATTEMPTS attempts and
 *     ~DEFAULT_MAX_TOTAL_DELAY_MS of cumulative waiting; when the budget runs
 *     out the last response is returned so callers surface their usual
 *     "Cerebras HTTP <status>" error. Fully AbortSignal-aware: an abort (or
 *     the caller's AbortSignal.timeout) cancels a backoff sleep instantly.
 *   - CerebrasThrottle: a module-level token bucket whose tokens are in-flight
 *     request slots, so N concurrent builds do not stampede the per-minute
 *     quota. Conservative default of DEFAULT_CEREBRAS_MAX_CONCURRENT,
 *     overridable via VIBERSYN_CEREBRAS_MAX_CONCURRENT. A slot is held only
 *     while a fetch is in flight — never across a backoff sleep.
 *
 * Everything time- or network-shaped (fetch, sleep, random) is injectable so
 * the colocated tests run with zero real network and zero real waiting.
 */

export const CEREBRAS_MAX_CONCURRENT_ENV = "VIBERSYN_CEREBRAS_MAX_CONCURRENT";
export const DEFAULT_CEREBRAS_MAX_CONCURRENT = 2;

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BASE_DELAY_MS = 1_500;
const DEFAULT_MAX_DELAY_MS = 45_000;
const DEFAULT_MAX_TOTAL_DELAY_MS = 90_000;
const RETRY_AFTER_JITTER_MS = 1_000;

// --- abort-aware sleep ------------------------------------------------------

export type AbortableSleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** setTimeout that rejects with the signal's reason the instant it aborts. */
export const abortableSleep: AbortableSleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signalReason(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signalReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

function signalReason(signal: AbortSignal): unknown {
  return (signal.reason as unknown) ?? new DOMException("This operation was aborted", "AbortError");
}

// --- concurrency throttle ---------------------------------------------------

interface ThrottleWaiter {
  grant: () => void;
}

/**
 * A token bucket sized in concurrent-request slots: acquire() takes a token
 * (waiting FIFO when none are free), the returned release() puts it back.
 * Waiting is abort-aware — an abort rejects instantly and leaves the queue.
 */
export class CerebrasThrottle {
  readonly #maxConcurrent: number;
  #active = 0;
  readonly #queue: ThrottleWaiter[] = [];

  constructor(maxConcurrent: number) {
    this.#maxConcurrent = Math.max(1, Math.floor(maxConcurrent));
  }

  get maxConcurrent(): number {
    return this.#maxConcurrent;
  }

  get active(): number {
    return this.#active;
  }

  get waiting(): number {
    return this.#queue.length;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.#active < this.#maxConcurrent) {
      this.#active += 1;
    } else {
      await new Promise<void>((resolve, reject) => {
        const waiter: ThrottleWaiter = {
          grant: () => {
            signal?.removeEventListener("abort", onAbort);
            this.#active += 1;
            resolve();
          },
        };
        const onAbort = (): void => {
          const index = this.#queue.indexOf(waiter);
          if (index >= 0) {
            this.#queue.splice(index, 1);
          }
          reject(signalReason(signal!));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        this.#queue.push(waiter);
      });
    }
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.#active -= 1;
      this.#queue.shift()?.grant();
    };
  }
}

/** VIBERSYN_CEREBRAS_MAX_CONCURRENT, defaulting to a conservative 2. */
export function resolveCerebrasMaxConcurrent(env: Record<string, string | undefined> = process.env): number {
  const raw = env[CEREBRAS_MAX_CONCURRENT_ENV];
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_CEREBRAS_MAX_CONCURRENT;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_CEREBRAS_MAX_CONCURRENT;
}

// The module-level bucket every default-configured backend shares. Sized from
// the environment once, on first use (a live room sets env at process start).
let defaultThrottle: CerebrasThrottle | undefined;

export function getDefaultCerebrasThrottle(env: Record<string, string | undefined> = process.env): CerebrasThrottle {
  defaultThrottle ??= new CerebrasThrottle(resolveCerebrasMaxConcurrent(env));
  return defaultThrottle;
}

// --- retrying fetch ---------------------------------------------------------

export interface CerebrasBackoffOptions {
  fetchImpl?: typeof fetch;
  /** Injected for tests; default is a real setTimeout that aborts instantly. */
  sleep?: AbortableSleep;
  /** Jitter source; default Math.random. */
  random?: () => number;
  /** Total attempts including the first. Default 4. */
  maxAttempts?: number;
  /** First backoff delay; doubles each retry. Default 1.5s. */
  baseDelayMs?: number;
  /** Cap for a single exponential delay (Retry-After may exceed it). Default 45s. */
  maxDelayMs?: number;
  /** Ceiling on cumulative backoff waiting. Default 90s. */
  maxTotalDelayMs?: number;
  /** Concurrency token bucket; null disables, default is the shared module-level one. */
  throttle?: CerebrasThrottle | null;
  /**
   * Per-ATTEMPT cap that starts when the request actually goes on the wire —
   * it deliberately excludes throttle-queue waiting (during a 3-idea fan-out a
   * call can sit queued behind long native-lane calls for longer than any sane
   * single-request timeout). A timed-out attempt counts as transient and is
   * retried with backoff; only the caller's own signal aborts outright.
   * Default: none (the caller's signal is the only timeout).
   */
  perAttemptTimeoutMs?: number;
}

export function isRetryableCerebrasStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/** Retry-After as milliseconds: delta-seconds or an HTTP-date; null if absent/unparseable. */
export function parseRetryAfterMs(value: string | null, now: () => number = Date.now): number | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (/^\d+$/u.test(trimmed)) {
    return Number.parseInt(trimmed, 10) * 1000;
  }
  const dateMs = Date.parse(trimmed);
  return Number.isNaN(dateMs) ? null : Math.max(0, dateMs - now());
}

/**
 * fetch with 429/5xx exponential backoff + jitter and the shared concurrency
 * throttle. Non-retryable responses (including 4xx like the response_format
 * rejection the backends probe for) pass straight through. When retries are
 * exhausted — or the next wait would blow the ~90s budget — the last retryable
 * response is returned un-consumed so the caller reports its status/body.
 * Aborts (init.signal) propagate immediately, including out of a sleep.
 */
export async function fetchWithCerebrasBackoff(
  input: string | URL | Request,
  init?: RequestInit,
  options: CerebrasBackoffOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? abortableSleep;
  const random = options.random ?? Math.random;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const maxTotalDelayMs = options.maxTotalDelayMs ?? DEFAULT_MAX_TOTAL_DELAY_MS;
  const throttle = options.throttle === undefined ? getDefaultCerebrasThrottle() : options.throttle;
  const signal = init?.signal ?? undefined;
  const perAttemptTimeoutMs = options.perAttemptTimeoutMs;

  let totalDelayMs = 0;
  // Equal jitter on the exponential curve; a server Retry-After overrides the
  // curve (plus a little jitter so synchronized builds still spread out).
  // Returns null when the wait would exceed the cumulative budget.
  const nextDelayMs = (attempt: number, retryAfterMs: number | null): number | null => {
    const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
    const delay =
      retryAfterMs !== null
        ? retryAfterMs + Math.round(random() * RETRY_AFTER_JITTER_MS)
        : Math.round(exponential / 2 + random() * (exponential / 2));
    return totalDelayMs + delay > maxTotalDelayMs ? null : delay;
  };

  for (let attempt = 1; ; attempt += 1) {
    signal?.throwIfAborted();
    const release = throttle === null ? null : await throttle.acquire(signal);
    let response: Response | null = null;
    let failure: unknown = null;
    try {
      // The per-attempt timeout arms only once the slot is held — queue time
      // never counts against the request.
      const attemptInit =
        perAttemptTimeoutMs === undefined
          ? init
          : {
              ...init,
              signal:
                signal === undefined
                  ? AbortSignal.timeout(perAttemptTimeoutMs)
                  : AbortSignal.any([signal, AbortSignal.timeout(perAttemptTimeoutMs)]),
            };
      response = await fetchImpl(input, attemptInit);
    } catch (error) {
      failure = error;
    } finally {
      release?.(); // the token is held only while the request is in flight
    }
    if (response === null) {
      // Network-level failure. The caller's own abort propagates; transient
      // socket errors — and per-attempt timeouts when configured — get the
      // same backoff treatment as a 5xx.
      const callerAborted = signal?.aborted === true;
      const hardAbort = isAbortError(failure) && (callerAborted || perAttemptTimeoutMs === undefined);
      if (attempt >= maxAttempts || callerAborted || hardAbort) {
        throw failure;
      }
      const delay = nextDelayMs(attempt, null);
      if (delay === null) {
        throw failure;
      }
      totalDelayMs += delay;
      await sleep(delay, signal);
      continue;
    }
    if (!isRetryableCerebrasStatus(response.status) || attempt >= maxAttempts) {
      return response;
    }
    const delay = nextDelayMs(attempt, parseRetryAfterMs(response.headers.get("retry-after")));
    if (delay === null) {
      return response; // budget exhausted — hand the 429/5xx back to the caller
    }
    await discardBody(response);
    totalDelayMs += delay;
    await sleep(delay, signal);
  }
}

/**
 * A drop-in `typeof fetch` wrapping fetchWithCerebrasBackoff — what the
 * backends install as their default transport when no fetchImpl is injected.
 */
export function createCerebrasRetryFetch(options: CerebrasBackoffOptions = {}): typeof fetch {
  const retryFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    fetchWithCerebrasBackoff(input, init, options);
  return retryFetch as typeof fetch;
}

// --- small helpers ----------------------------------------------------------

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

// Drop a response we are about to retry past so its body never pins a socket.
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // a body that cannot be cancelled is already settled — nothing to release
  }
}
