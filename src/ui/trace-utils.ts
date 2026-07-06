/**
 * Shared trace helpers — color/category mapping and meta summarization.
 *
 * The trace stream is color-coded by category (OBS / PASS / FIRE / ACT / HALT)
 * per DESIGN.md §"Trace rail". The category drives a CSS class; the human-facing
 * tag is derived from the structured verb-noun event name.
 */

export type TraceCategory = "obs" | "pass" | "fire" | "act" | "halt" | "out" | "neutral";

export function traceCategory(eventName: string): TraceCategory {
  if (eventName.includes("halt") || eventName.includes("abort") || eventName.includes("emergency")) {
    return "halt";
  }
  if (eventName.includes("pass")) {
    return "pass";
  }
  if (eventName.startsWith("observe")) {
    return "obs";
  }
  if (eventName.startsWith("output") || eventName.startsWith("ack") || eventName.startsWith("earcon")) {
    return "out";
  }
  if (eventName.startsWith("suggestion") || eventName.includes("queued") || eventName.includes("fire")) {
    return "fire";
  }
  if (eventName.startsWith("route") || eventName.startsWith("process") || eventName.startsWith("command")) {
    return "act";
  }
  return "neutral";
}

const CATEGORY_TAG: Record<TraceCategory, string> = {
  obs: "OBS",
  pass: "PASS",
  fire: "FIRE",
  act: "ACT",
  halt: "HALT",
  out: "OUT",
  neutral: "LOG",
};

export function traceTag(eventName: string): string {
  return CATEGORY_TAG[traceCategory(eventName)];
}

export function traceClass(eventName: string): string {
  return `tc-${traceCategory(eventName)}`;
}

export function summarizeMeta(meta: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(meta)) {
    parts.push(`${key}=${formatValue(value)}`);
  }
  const joined = parts.join("  ");
  return joined.length > 140 ? `${joined.slice(0, 137)}…` : joined;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null || value === undefined) {
    return "—";
  }
  return JSON.stringify(value);
}
