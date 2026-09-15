// HTTP surface of the credible-sensor sidecar. A phone running attestable-recorder
// in room mode talks to these four endpoints while it streams audio to /api/mic
// and cursors to /hands/ws with `?source=<id>` — see docs/credible-sensors.md.
import type { Hono } from "hono";
import type { AttestationBackend } from "./backend";
import type { AttestationRegistry, ChunkRecordInput, CloseSessionInput } from "./registry";

export interface AttestationRouteDeps {
  registry: AttestationRegistry;
  backend: AttestationBackend;
}

const MAX_BODY_BYTES = 256 * 1024;

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return null;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return null;
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isStr = (v: unknown): v is string => typeof v === "string";

export function registerAttestationRoutes(app: Hono, deps: AttestationRouteDeps): void {
  const { registry, backend } = deps;

  app.get("/api/attest/info", (context) =>
    context.json({ backend: backend.kind, description: backend.description, sources: registry.summary().length }),
  );

  app.get("/api/attest/sources", (context) => context.json(registry.summary()));

  app.post("/api/attest/challenge", async (context) => {
    try {
      const issued = await backend.challenge();
      return context.json({ challenge: issued.challenge, expires_at: issued.expiresAt });
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
  });

  app.post("/api/attest/session", async (context) => {
    const body = await readJson(context.req.raw);
    if (body === null) return context.json({ error: "body must be a JSON object" }, 400);
    const recordingId = body.recording_id;
    const challenge = body.attestation_challenge;
    if (!isStr(recordingId) || !isStr(challenge) || body.attestation_chain === undefined) {
      return context.json({ error: "recording_id, attestation_chain and attestation_challenge are required" }, 400);
    }
    const outcome = await backend.attest({ chain: body.attestation_chain, challenge, recordingId });
    if (!outcome.ok) return context.json({ error: outcome.error }, 403);
    const source = registry.createSource({
      recordingId,
      spki: outcome.spki,
      facts: outcome.facts,
      freshness: outcome.freshness,
      verified: outcome.verified,
      streams: typeof body.streams === "object" && body.streams !== null ? (body.streams as Record<string, unknown>) : null,
      label: isStr(body.label) ? body.label : null,
    });
    return context.json({ source_id: source.id, verified: source.verified, facts: source.facts, freshness: source.freshness });
  });

  app.post("/api/attest/chunk", async (context) => {
    const body = await readJson(context.req.raw);
    if (body === null) return context.json({ ok: false, reason: "body must be a JSON object" }, 400);
    const record = body as Partial<ChunkRecordInput>;
    if (
      !isStr(record.source_id) || !isStr(record.type) || !isInt(record.index) || !isInt(record.timestamp) ||
      !isInt(record.duration_ms) || !isInt(record.size) || !isStr(record.hash) || !isStr(record.prev_hash) || !isStr(record.signature)
    ) {
      return context.json({ ok: false, reason: "malformed chunk record" }, 400);
    }
    const verdict = registry.verifyChunk(record as ChunkRecordInput);
    if (!verdict.ok) return context.json(verdict, 400);
    if (verdict.pending) return context.json(verdict, 202);
    return context.json(verdict);
  });

  app.post("/api/attest/session/:id/close", async (context) => {
    const body = await readJson(context.req.raw);
    if (body === null) return context.json({ ok: false, reason: "body must be a JSON object" }, 400);
    const input = body as Partial<CloseSessionInput>;
    if (!isInt(input.started_at) || !isInt(input.ended_at) || !Array.isArray(input.chunks) || !isStr(input.session_signature)) {
      return context.json({ ok: false, reason: "started_at, ended_at, chunks and session_signature are required" }, 400);
    }
    const result = registry.closeSession(context.req.param("id"), {
      started_at: input.started_at,
      ended_at: input.ended_at,
      context: Array.isArray(input.context) ? (input.context as Array<Record<string, unknown>>) : [],
      chunks: input.chunks as CloseSessionInput["chunks"],
      session_signature: input.session_signature,
    });
    return context.json(result, result.ok ? 200 : 400);
  });
}
