import { type AudioOutput, type PcmClip } from "../audio/earcons";
import { ProcessRegistry, type RegistryProcess } from "../process/registry";
import { GatewayRegistryClient, type RegistrySmithersClient } from "./smithers-select";
import { type RunEventStreamClient } from "./run-event-driver";
import type { SmithersClient } from "../seam/smithers-client";
import { type AudioSink } from "./audio-device-sink";
import { createCorrelationRecord, type CorrelationRecord, type CorrelationStore } from "../seam/correlation-store";


// Earcon/ack audio output backed by the selected audio sink (ISSUE-0026). Each
// prerendered clip's Int16 PCM is viewed as bytes and routed to the sink — the
// no-op sink drops them (silent production default), a recording/device sink
// retains them. The write is best-effort: a sink failure is swallowed so it can
// never abort the in-flight stage transition (emitOutput records it as a trace).
export class BufferedAudioOutput implements AudioOutput {
  readonly #sink: AudioSink;

  constructor(sink: AudioSink) {
    this.#sink = sink;
  }

  async playPcm(clip: PcmClip): Promise<void> {
    const bytes = new Uint8Array(clip.pcm.buffer, clip.pcm.byteOffset, clip.pcm.byteLength);
    await this.#sink.write(bytes);
  }
}


// Resolve a streamRunEvents-capable client from whatever the registry was given
// (ISSUE-0021). The gateway path wraps a GatewaySmithersClient that streams; the
// in-memory default exposes an empty stream. A client without the method (should
// not happen) degrades to a no-op stream so the runtime never throws on subscribe.
export function runEventStreamClient(client: RegistrySmithersClient): RunEventStreamClient {
  if (client instanceof GatewayRegistryClient) {
    return client.client;
  }
  if ("streamRunEvents" in client && typeof (client as Partial<SmithersClient>).streamRunEvents === "function") {
    return client as RunEventStreamClient;
  }
  return {
    async *streamRunEvents() {
      // No live event source (no gateway configured) — seeded fixtures stand.
    },
  };
}


// SmithersClient facade over the live ProcessRegistry so the SeamDispatcher's
// HTTP/WS actions drive the same fleet as voice. `signal` maps to steer (the
// registry exposes no separate signal channel); run-event streaming is owned by
// RunEventDriver, so the facade's stream is empty.
export function registrySeamClient(registry: ProcessRegistry): SmithersClient {
  const corr = (): string => `corr-seam-${crypto.randomUUID()}`;
  return {
    async spawn(seed) {
      const result = await registry.spawn(seed);
      if (!result.accepted) {
        throw new Error(result.spokenAck);
      }
      return result.spawn;
    },
    steer: (upid, payload) => registry.steer(upid, payload, corr()),
    signal: (upid, payload) => registry.steer(upid, payload, corr()),
    pause: (upid) => registry.pause(upid, corr()),
    resume: (upid) => registry.resume(upid, corr()),
    halt: (upid) => registry.halt(upid, corr(), "seam"),
    async *streamRunEvents() {
      // Live streaming is RunEventDriver's job; the seam facade has no source.
    },
  };
}


// Read-only CorrelationStore view over the registry. The registry is the source
// of truth: upsert/update are accepted no-ops (the registry methods invoked by
// registrySeamClient already applied the state change); reads project registry
// records into CorrelationRecords so statusSummary reports the real fleet.
export class RegistryCorrelationView implements CorrelationStore {
  readonly #registry: ProcessRegistry;

  constructor(registry: ProcessRegistry) {
    this.#registry = registry;
  }

  async load(): Promise<CorrelationRecord[]> {
    return this.#project(this.#registry.records());
  }

  async allActive(): Promise<CorrelationRecord[]> {
    return this.#project(this.#registry.activeRecords());
  }

  async findByUPID(upid: string): Promise<CorrelationRecord | undefined> {
    return this.#project(this.#registry.records()).find((record) => record.upid === upid);
  }

  async findByRunId(runId: string): Promise<CorrelationRecord | undefined> {
    return this.#project(this.#registry.records()).find((record) => record.runId === runId);
  }

  async upsert(): Promise<void> {
    // Registry already recorded the spawn (registrySeamClient.spawn).
  }

  async update(upid: string, _patch: Partial<Omit<CorrelationRecord, "upid">>): Promise<CorrelationRecord> {
    const record = await this.findByUPID(upid);
    if (record === undefined) {
      throw new Error(`No UPID correlation exists for ${upid}.`);
    }
    return record;
  }

  #project(records: readonly RegistryProcess[]): CorrelationRecord[] {
    return records.map((record) =>
      createCorrelationRecord({
        upid: record.upid,
        runId: record.runId,
        callsign: record.callsign,
        correlationId: `corr-${record.upid}`,
        state: record.state === "dead" ? "halted" : record.state,
        nowMs: record.updatedAtMs,
      }),
    );
  }
}
