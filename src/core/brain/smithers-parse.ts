import type { VisualizerKind } from "../types.ts";

const VISUALIZERS = new Set<VisualizerKind>(["web", "code", "art", "book", "text", "data"]);

type SmithersOutputEnvelope = {
  output?: unknown;
  value?: unknown;
  result?: unknown;
};

export function firstJsonObject(raw: string): unknown {
  const start = raw.indexOf("{");
  if (start === -1) throw new Error("no json object on stdout");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") inString = true;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(raw.slice(start, i + 1));
    }
  }
  throw new Error("unterminated json object on stdout");
}

export function boolValue(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  // `smithers output` serialization coerces booleans to numbers (true->1, false->0).
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    return v === "true" || v === "1";
  }
  return false;
}

export function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    // Fall through to comma splitting.
  }
  return trimmed.split(",").map((p) => p.trim()).filter(Boolean);
}

export function visualizerKind(value: unknown): VisualizerKind {
  const kind = typeof value === "string" ? value : "web";
  return VISUALIZERS.has(kind as VisualizerKind) ? (kind as VisualizerKind) : "web";
}

export function parseQuestions(value: unknown): { prompt: string; choices: string[] }[] {
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? JSON.parse(value || "[]") : value;
  } catch {
    parsed = [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((q) => {
    if (!q || typeof q !== "object") return [];
    const prompt = "prompt" in q && typeof q.prompt === "string" ? q.prompt : "";
    const choices = "choices" in q ? stringArray(q.choices) : [];
    return prompt && choices.length ? [{ prompt, choices }] : [];
  });
}

export function unwrapSmithersOutput<T extends object>(value: unknown): T {
  if (!value || typeof value !== "object") {
    throw new Error("smithers output was not an object");
  }
  const envelope = value as SmithersOutputEnvelope;
  const nested = envelope.output ?? envelope.value ?? envelope.result;
  if (nested && typeof nested === "object") return nested as T;
  return value as T;
}
