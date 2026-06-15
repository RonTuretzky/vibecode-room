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

const SECRET_KEY_PATH = /(?:api[_-]?key|authorization|bearer|credential|password|secret|token)/iu;
const UUID_VALUE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const UNKNOWN_SECRET_CHARS = "A-Za-z0-9._~+/=-";
const MIN_ALPHA_ONLY_OPAQUE_TOKEN_LENGTH = 32;
const UNKNOWN_SECRET_CANDIDATE = new RegExp(
  `(?<![${UNKNOWN_SECRET_CHARS}])(?=[${UNKNOWN_SECRET_CHARS}]{24,})(?=[${UNKNOWN_SECRET_CHARS}]*[A-Za-z])[${UNKNOWN_SECRET_CHARS}]+(?![${UNKNOWN_SECRET_CHARS}])`,
  "gu",
);
const ALPHA_ONLY_OPAQUE_TOKEN = new RegExp(`^[A-Za-z]{${MIN_ALPHA_ONLY_OPAQUE_TOKEN_LENGTH},}$`, "u");

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
      const keyResult = redactObjectKey(key);
      const result = redactSecretValues(entry, [...path, key]);
      count += keyResult.count + result.count;
      redacted[uniqueRedactedKey(redacted, keyResult.value)] = result.value;
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

  const unknownMatches = findUnknownSecretTokens(text);
  if (unknownMatches > 0) {
    findings.push({ pattern: "unknown-high-entropy-token", count: unknownMatches });
  }

  return findings;
}

export async function scanSecretLikeFiles(rootDir: string): Promise<SecretScanResult> {
  const findings: SecretScanFinding[] = [];
  const glob = new Bun.Glob("**/*");

  for await (const path of glob.scan({ cwd: rootDir, absolute: true, onlyFiles: true })) {
    const text = await Bun.file(path).text();
    for (const finding of scanSecretLikeText(text)) {
      findings.push({ path, ...finding });
    }
  }

  return { passed: findings.length === 0, findings };
}

function redactString(value: string, path: readonly string[]): SecretRedactionResult {
  if (isKnownRedactionMarker(value)) {
    return { value, count: 0 };
  }

  if (path.some((segment) => SECRET_KEY_PATH.test(segment)) && value.length >= 8) {
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

  UNKNOWN_SECRET_CANDIDATE.lastIndex = 0;
  redacted = redacted.replace(UNKNOWN_SECRET_CANDIDATE, (match) => {
    if (!isUnknownSecretToken(match)) {
      return match;
    }
    count += 1;
    return REDACTED_SECRET;
  });

  return { value: redacted, count };
}

function redactObjectKey(key: string): { value: string; count: number } {
  const result = redactString(key, []);
  if (typeof result.value !== "string") {
    return { value: REDACTED_SECRET, count: result.count + 1 };
  }
  return { value: result.value, count: result.count };
}

function uniqueRedactedKey(target: Record<string, unknown>, key: string): string {
  if (!Object.hasOwn(target, key)) {
    return key;
  }

  let index = 2;
  while (Object.hasOwn(target, `${key}#${index}`)) {
    index += 1;
  }
  return `${key}#${index}`;
}

function findUnknownSecretTokens(text: string): number {
  let count = 0;
  UNKNOWN_SECRET_CANDIDATE.lastIndex = 0;
  for (const match of text.matchAll(UNKNOWN_SECRET_CANDIDATE)) {
    if (isUnknownSecretToken(match[0]) && !isUnquotedCamelCaseIdentifier(match[0], text, match.index ?? -1)) {
      count += 1;
    }
  }
  return count;
}

function isUnknownSecretToken(value: string): boolean {
  if (UUID_VALUE.test(value)) {
    return false;
  }

  if (/^(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{24,}$/u.test(value)) {
    return true;
  }

  if (ALPHA_ONLY_OPAQUE_TOKEN.test(value)) {
    return true;
  }

  if (isPaddedOpaqueToken(value)) {
    return true;
  }

  if (isSlashOnlyOpaqueToken(value)) {
    return true;
  }

  if (isProviderPrefixedOpaqueToken(value)) {
    return true;
  }

  if (isProviderPrefixedNumericToken(value)) {
    return true;
  }

  if (/[+~]/u.test(value)) {
    return true;
  }

  if (/=/u.test(value) && !/^[A-Za-z][A-Za-z0-9_-]{1,96}=/u.test(value)) {
    return true;
  }

  const segments = value.split(/[._~+/=-]+/u).filter(Boolean);
  const hasSecretPrefix = /(?:^|[._~+/=-])(?:key|live|prod|secret|test|token)[._~+/=-]/iu.test(value);
  const hasLongSegment = segments.some((segment) => /^[A-Za-z0-9]{16,}$/u.test(segment));
  const hasLongMixedSegment = segments.some((segment) =>
    /^(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{16,}$/u.test(segment),
  );
  return hasLongMixedSegment || (hasSecretPrefix && hasLongSegment);
}

function isPaddedOpaqueToken(value: string): boolean {
  if (!/={1,2}$/u.test(value)) {
    return false;
  }

  const unpadded = value.replace(/=+$/u, "");
  return unpadded.length >= 24 && /^[A-Za-z0-9._~+/-]+$/u.test(unpadded) && /[A-Za-z]/u.test(unpadded);
}

function isSlashOnlyOpaqueToken(value: string): boolean {
  if (!value.includes("/") || /[._-]/u.test(value) || value.startsWith("/") || value.includes("//")) {
    return false;
  }

  const segments = value.split("/");
  return value.length >= 32 && segments.length >= 2 && segments.every((segment) => /^[A-Za-z0-9]{12,}$/u.test(segment));
}

function isProviderPrefixedOpaqueToken(value: string): boolean {
  const match = /^(?:[A-Za-z]{2,12})[._-]([A-Za-z0-9]{24,})$/u.exec(value);
  return match !== null && /[A-Za-z]/u.test(match[1]);
}

function isProviderPrefixedNumericToken(value: string): boolean {
  return /^(?:[A-Za-z]{2,12})[._-](?:[0-9]{8,}[._-]){1,}[0-9]{8,}$/u.test(value);
}

function isKnownRedactionMarker(value: string): boolean {
  return value === REDACTED_SECRET || /^\[redacted\]$/iu.test(value);
}

function isUnquotedCamelCaseIdentifier(value: string, source: string, index: number): boolean {
  if (!ALPHA_ONLY_OPAQUE_TOKEN.test(value) || !/[a-z][A-Z]/u.test(value) || index < 0) {
    return false;
  }

  const previous = source[index - 1];
  const next = source[index + value.length];
  return !((previous === "\"" && next === "\"") || (previous === "'" && next === "'"));
}
