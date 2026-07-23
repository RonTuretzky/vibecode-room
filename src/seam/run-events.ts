// Shared run-event normalization for the gateway stream. The live consumer is
// RunEventDriver (src/server/run-event-driver.ts), which owns the reconnect/
// afterSeq/dedup loop; the former RunEventBridge duplicate was removed.
import type { RunEvent } from "../types";
import type { GatewayEventFrame } from "./smithers-client";

export function normalizeSmithersRunEvent(
  frame: GatewayEventFrame,
  correlation: { upid: string; runId: string },
): RunEvent {
  const payload = typeof frame.payload === "object" && frame.payload !== null ? frame.payload : {};
  const seq = numberValue(payload.seq) ?? numberValue(frame.seq) ?? 0;
  const gatewayEvent = stringValue(payload.event) ?? frame.event;
  const runId = stringValue(payload.runId) ?? correlation.runId;
  return {
    upid: correlation.upid,
    runId,
    kind: classifyRunEvent(gatewayEvent, payload),
    text: summarizeForVoice(textFromPayload(gatewayEvent, payload), 15),
    seq,
  };
}

export function summarizeForVoice(text: string, limit = 15): string {
  const cleaned = text
    .replace(/https?:\/\/\S+/giu, "link")
    .replace(/\b[\w./-]+\.(?:ts|tsx|js|jsx|json|md|html|css|log)\b/giu, "file")
    .replace(/[{}\[\]`]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const words = cleaned.length === 0 ? ["Smithers", "updated"] : cleaned.split(/\s+/u);
  return words.slice(0, limit).join(" ");
}

function classifyRunEvent(event: string, payload: Record<string, unknown>): RunEvent["kind"] {
  const status = stringValue(payload.status)?.toLowerCase() ?? "";
  const haystack = `${event} ${status}`.toLowerCase();
  if (/completed|finished|cancelled|failed/u.test(haystack)) {
    return "completed";
  }
  if (/blocker|waiting-approval|approval|error|failed/u.test(haystack)) {
    return "blocker";
  }
  if (/output|task\.finished|node\.finished|complete/u.test(haystack)) {
    return "output";
  }
  return "state";
}

function textFromPayload(event: string, payload: Record<string, unknown>): string {
  for (const key of ["summary", "text", "message", "title", "status"]) {
    const value = stringValue(payload[key]);
    if (value !== undefined && value.trim().length > 0) {
      return value;
    }
  }
  return event.replace(/[\W_]+/gu, " ");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
