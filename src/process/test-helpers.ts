import type { SmithersClient, SpawnResult, StreamRunEventsOptions } from "../seam/smithers-client";

export class MemorySmithersClient implements SmithersClient {
  readonly calls: Array<{ name: string; upid?: string; payload?: unknown }> = [];

  async spawn(seed: { upid: string; workflow: string; runId?: string; parentId?: string | null }): Promise<SpawnResult> {
    this.calls.push({ name: "spawn", upid: seed.upid });
    return {
      upid: seed.upid,
      runId: seed.runId ?? `run-${seed.upid}`,
      workflow: seed.workflow,
      parentId: seed.parentId ?? null,
    };
  }

  async steer(upid: string, payload: unknown): Promise<unknown> {
    this.calls.push({ name: "steer", upid, payload });
    return { ok: true };
  }

  signal(upid: string, payload: unknown): Promise<unknown> {
    return this.steer(upid, payload);
  }

  async pause(upid: string): Promise<unknown> {
    this.calls.push({ name: "pause", upid });
    return { ok: true };
  }

  async resume(upid: string): Promise<unknown> {
    this.calls.push({ name: "resume", upid });
    return { ok: true };
  }

  async halt(upid: string): Promise<unknown> {
    this.calls.push({ name: "halt", upid });
    return { ok: true };
  }

  async *streamRunEvents(_upid: string, _options?: StreamRunEventsOptions): AsyncIterable<never> {}
}
