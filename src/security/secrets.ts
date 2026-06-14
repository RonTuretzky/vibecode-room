export const REDACTED_SECRET = "«redacted»";

export interface SecretRedactionResult {
  value: unknown;
  count: number;
}

export interface SecretScanFinding {
  path: string;
  pattern: string;
  count: number;
}

export interface SecretScanResult {
  passed: boolean;
  findings: SecretScanFinding[];
}

interface SecretPattern {
  name: string;
  pattern: RegExp;
}

const SECRET_PATTERNS: SecretPattern[] = [
  { name: "authorization-header", pattern: /\bAuthorization\s*:\s*(?:Bearer|Basic|Token)?\s*[A-Za-z0-9._~+/=-]{16,}\b/giu },
  { name: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/giu },
  { name: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/gu },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu },
  { name: "deepgram-key", pattern: /\b(?:dg|deepgram)[_-][A-Za-z0-9_-]{16,}\b/giu },
  { name: "elevenlabs-key", pattern: /\b(?:xi|elevenlabs|el)[_-][A-Za-z0-9_-]{16,}\b/giu },
  {
    name: "generic-key-assignment",
    pattern: /\b(?:api[_-]?key|secret|token|credential|password)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{16,}["']?/giu,
  },
];

const SECRETISH_PATH = /(?:authorization|api[_-]?key|secret|token|credential|password|bearer)/iu;
const HIGH_ENTROPY_VALUE = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9._~+/=-]{24,}$/u;

export function redactSecretValues(value: unknown, path: readonly string[] = []): SecretRedactionResult {
  if (typeof value === "string") {
    return redactString(value, path);
  }

  if (Array.isArray(value)) {
    let count = 0;
    const redacted = value.map((entry, index) => {
      const result = redactSecretValues(entry, [...path, String(index)]);
      count += result.count;
      return result.value;
    });
    return { value: redacted, count };
  }

  if (value !== null && typeof value === "object") {
    let count = 0;
    const redacted: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const result = redactSecretValues(entry, [...path, key]);
      count += result.count;
      redacted[key] = result.value;
    }
    return { value: redacted, count };
  }

  return { value, count: 0 };
}

export function hasSecretLikeString(value: string, path: readonly string[] = []): boolean {
  return redactString(value, path).count > 0;
}

export function scanSecretLikeText(text: string): Array<{ pattern: string; count: number }> {
  const findings: Array<{ pattern: string; count: number }> = [];

  for (const { name, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    const matches = text.match(pattern);
    if (matches?.length) {
      findings.push({ pattern: name, count: matches.length });
    }
  }

  return findings;
}

export async function scanSecretLikeFiles(rootDir: string): Promise<SecretScanResult> {
  const findings: SecretScanFinding[] = [];
  const glob = new Bun.Glob("**/*.{json,jsonl,log,txt,md,ts,tsx,js,mjs,cjs,html}");

  for await (const path of glob.scan({ cwd: rootDir, absolute: true, onlyFiles: true })) {
    const text = await Bun.file(path).text();
    for (const finding of scanSecretLikeText(text)) {
      findings.push({ path, ...finding });
    }
  }

  return { passed: findings.length === 0, findings };
}

function redactString(value: string, path: readonly string[]): SecretRedactionResult {
  if (SECRETISH_PATH.test(path.join(".")) && HIGH_ENTROPY_VALUE.test(value)) {
    return { value: REDACTED_SECRET, count: 1 };
  }

  let count = 0;
  let redacted = value;

  for (const { pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, () => {
      count += 1;
      return REDACTED_SECRET;
    });
  }

  return { value: redacted, count };
}
