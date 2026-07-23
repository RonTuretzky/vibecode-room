// Backend selection for the multi-backend build loop. Mirrors the provider
// seam/registry idiom (src/providers/*/registry.ts): the enabled set is resolved
// once from the environment (VIBERSYN_BUILD_BACKENDS csv, default
// "smithers,native" — eliza is opt-in), can be toggled at runtime via
// POST /api/backends, and availability is probed through each backend's own
// available() with a hard timeout so a wedged backend can never stall the
// snapshot. snapshot() is the fragment the wall UI consumes as the top-level
// `backends` field.

import type { BuildBackend, BuildBackendId } from "./types";

export const DEFAULT_BUILD_BACKENDS_CSV = "smithers,native";
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

// The top-level snapshot fragment: one entry per REGISTERED backend, whether
// enabled or not, so the wall can render the toggle for every backend it could
// switch on.
export interface BackendSnapshot {
  id: BuildBackendId;
  label: string;
  enabled: boolean;
  available: boolean;
  reason?: string;
}

export interface BackendAvailability {
  ok: boolean;
  reason?: string;
}

// Parse the csv into a normalized id set. Empty/missing csv falls back to the
// default so an unset environment still builds with smithers+native.
export function parseEnabledBackends(csv: string | undefined): Set<string> {
  const source = csv === undefined || csv.trim().length === 0 ? DEFAULT_BUILD_BACKENDS_CSV : csv;
  return new Set(
    source
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
}

export interface BackendSelectorOptions {
  // The registered backends, constructed in composition. Order is display order.
  backends: BuildBackend[];
  env?: Record<string, string | undefined>;
  probeTimeoutMs?: number;
}

export class BackendSelector {
  readonly #backends = new Map<BuildBackendId, BuildBackend>();
  readonly #order: BuildBackendId[] = [];
  readonly #enabled = new Set<BuildBackendId>();
  readonly #availability = new Map<BuildBackendId, BackendAvailability>();
  readonly #probeTimeoutMs: number;

  constructor(options: BackendSelectorOptions) {
    this.#probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    for (const backend of options.backends) {
      if (!this.#backends.has(backend.id)) {
        this.#backends.set(backend.id, backend);
        this.#order.push(backend.id);
      }
    }
    const requested = parseEnabledBackends((options.env ?? process.env).VIBERSYN_BUILD_BACKENDS);
    for (const id of this.#order) {
      if (requested.has(id)) {
        this.#enabled.add(id);
      }
    }
  }

  backends(): BuildBackend[] {
    return this.#order.map((id) => this.#backends.get(id)!)
  }

  backend(id: BuildBackendId): BuildBackend | undefined {
    return this.#backends.get(id);
  }

  isKnown(id: string): id is BuildBackendId {
    return this.#backends.has(id as BuildBackendId);
  }

  isEnabled(id: BuildBackendId): boolean {
    return this.#enabled.has(id);
  }

  // Runtime toggle (POST /api/backends). Returns false for an unregistered id so
  // the endpoint can 400 instead of silently accepting garbage.
  setEnabled(id: string, enabled: boolean): boolean {
    if (!this.isKnown(id)) {
      return false;
    }
    if (enabled) {
      this.#enabled.add(id);
    } else {
      this.#enabled.delete(id);
    }
    return true;
  }

  enabledBackends(): BuildBackend[] {
    return this.backends().filter((backend) => this.#enabled.has(backend.id));
  }

  // Probe ONE backend's availability with a hard timeout; the result is cached
  // for snapshot() so the wall never awaits a probe.
  async probe(id: BuildBackendId): Promise<BackendAvailability> {
    const backend = this.#backends.get(id);
    if (backend === undefined) {
      return { ok: false, reason: `unknown backend ${id}` };
    }
    let availability: BackendAvailability;
    try {
      availability = await withTimeout(backend.available(), this.#probeTimeoutMs);
    } catch (error) {
      availability = { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    this.#availability.set(id, availability);
    return availability;
  }

  // Probe every registered backend concurrently (boot + before each fan-out).
  async probeAll(): Promise<void> {
    await Promise.all(this.#order.map((id) => this.probe(id)));
  }

  availability(id: BuildBackendId): BackendAvailability | undefined {
    const cached = this.#availability.get(id);
    return cached === undefined ? undefined : { ...cached };
  }

  // Snapshot fragment for the wall: every registered backend with its enabled
  // flag and last probed availability. Never probes inline — an unprobed backend
  // reads unavailable until probeAll() has run once.
  snapshot(): BackendSnapshot[] {
    return this.backends().map((backend) => {
      const availability = this.#availability.get(backend.id);
      return {
        id: backend.id,
        label: backend.label,
        enabled: this.#enabled.has(backend.id),
        available: availability?.ok ?? false,
        ...(availability?.ok !== true
          ? { reason: availability?.reason ?? (availability === undefined ? "not probed yet" : "unavailable") }
          : {}),
      };
    });
  }
}

async function withTimeout(probe: Promise<BackendAvailability>, timeoutMs: number): Promise<BackendAvailability> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      probe,
      new Promise<BackendAvailability>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, reason: `availability probe timed out after ${timeoutMs}ms` }), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
