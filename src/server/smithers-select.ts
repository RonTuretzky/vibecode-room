// Smithers client selection seam (ISSUE-0011 / GAP-004).
//
// `selectSmithersClient(env, opts)` is the single place that decides which
// SmithersClient backs the ProcessRegistry:
//
//   no gateway config            -> MemorySmithersClient (in-process default)
//   VIBERSYN_SMITHERS_GATEWAY_URL    -> GatewaySmithersClient over OfficialGatewayTransport
//   injected transport (opts)     -> GatewaySmithersClient over that transport (tests/e2e)
//
// The in-memory client stays the no-config default so `bun run start` keeps
// driving the seeded demo fleet without a real gateway. Partial gateway config
// (a token with no URL) is a misconfiguration and raises a clear error rather
// than silently falling back to the in-memory client.
//
// The registry uses the client directly (not via SeamDispatcher), so the gateway
// path must persist a correlation record on spawn — otherwise a later halt has no
// runId to cancel. GatewayRegistryClient wraps GatewaySmithersClient to do that
// upsert; everything else delegates straight through.

import {
  MemoryCorrelationStore,
  createCorrelationRecord,
  type CorrelationStore,
} from "../seam/correlation-store";
import {
  GatewaySmithersClient,
  OfficialGatewayTransport,
  type GatewayRpcTransport,
  type SmithersClient,
  type SpawnResult,
  type SpawnSeed,
} from "../seam/smithers-client";
import { MemorySmithersClient } from "../process/test-helpers";

// The slice of SmithersClient the ProcessRegistry actually drives.
export type RegistrySmithersClient = Pick<SmithersClient, "spawn" | "pause" | "resume" | "halt" | "steer">;

export const DEFAULT_GATEWAY_WORKFLOW = "vibersyn-process";

export interface SmithersGatewayEnv {
  // Presence of a non-empty URL turns on the gateway-backed client.
  VIBERSYN_SMITHERS_GATEWAY_URL?: string;
  // Optional bearer token forwarded to the gateway transport.
  VIBERSYN_SMITHERS_GATEWAY_TOKEN?: string;
  // Optional default workflow for launchRun when a spawn omits one.
  VIBERSYN_SMITHERS_GATEWAY_WORKFLOW?: string;
  [key: string]: string | undefined;
}

export interface SelectSmithersClientOptions {
  // Injected transport for tests/e2e — when present, the gateway client is used
  // regardless of env (no real OfficialGatewayTransport / WebSocket is created).
  transport?: GatewayRpcTransport;
  // Correlation store the gateway client persists spawns into (defaults to an
  // in-memory store scoped to this runtime).
  correlations?: CorrelationStore;
}

export function selectSmithersClient(
  env: SmithersGatewayEnv,
  options: SelectSmithersClientOptions = {},
): RegistrySmithersClient {
  const url = env.VIBERSYN_SMITHERS_GATEWAY_URL?.trim() ?? "";
  const token = env.VIBERSYN_SMITHERS_GATEWAY_TOKEN?.trim() ?? "";

  // An injected transport is an explicit request for the gateway path; honor it
  // without touching env (this is how the integration/e2e tests drive spawn/halt
  // through the transport with no real gateway).
  if (options.transport !== undefined) {
    return gatewayClient(options.transport, env, options.correlations);
  }

  const hasUrl = url.length > 0;
  const hasToken = token.length > 0;

  // No gateway config at all -> in-memory default (unchanged demo behavior).
  if (!hasUrl && !hasToken) {
    return new MemorySmithersClient();
  }

  // Partial config: a token with no URL is a misconfiguration. Fail loud rather
  // than silently dropping to the in-memory client and pretending it worked.
  if (!hasUrl) {
    throw new Error(
      "Partial Smithers gateway config: VIBERSYN_SMITHERS_GATEWAY_TOKEN is set but " +
        "VIBERSYN_SMITHERS_GATEWAY_URL is missing. Set VIBERSYN_SMITHERS_GATEWAY_URL to use " +
        "the gateway, or clear VIBERSYN_SMITHERS_GATEWAY_TOKEN for the in-memory default.",
    );
  }

  const transport = new OfficialGatewayTransport({
    baseUrl: url,
    token: hasToken ? token : undefined,
  });
  return gatewayClient(transport, env, options.correlations);
}

function gatewayClient(
  transport: GatewayRpcTransport,
  env: SmithersGatewayEnv,
  correlations?: CorrelationStore,
): RegistrySmithersClient {
  const store = correlations ?? new MemoryCorrelationStore();
  const defaultWorkflow = env.VIBERSYN_SMITHERS_GATEWAY_WORKFLOW?.trim() || DEFAULT_GATEWAY_WORKFLOW;
  const client = new GatewaySmithersClient({ transport, correlations: store, defaultWorkflow });
  return new GatewayRegistryClient(client, store);
}

// Adapts GatewaySmithersClient for direct registry use: spawn persists a
// correlation record (so halt/steer/pause/resume can resolve the runId), and the
// remaining methods delegate unchanged.
export class GatewayRegistryClient implements RegistrySmithersClient {
  constructor(
    readonly client: GatewaySmithersClient,
    readonly correlations: CorrelationStore,
  ) {}

  async spawn(seed: SpawnSeed): Promise<SpawnResult> {
    const result = await this.client.spawn(seed);
    await this.correlations.upsert(
      createCorrelationRecord({
        upid: result.upid,
        runId: result.runId,
        callsign: seed.callsign ?? null,
        steeringWindowId: seed.steeringWindowId ?? null,
        correlationId: seed.correlationId,
        parentId: result.parentId,
        state: "planning",
      }),
    );
    return result;
  }

  steer(upid: string, payload: unknown): Promise<unknown> {
    return this.client.steer(upid, payload);
  }

  pause(upid: string): Promise<unknown> {
    return this.client.pause(upid);
  }

  resume(upid: string): Promise<unknown> {
    return this.client.resume(upid);
  }

  halt(upid: string): Promise<unknown> {
    return this.client.halt(upid);
  }
}
