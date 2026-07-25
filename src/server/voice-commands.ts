// Server-side voice control (desk mode): the wake router that replaces the
// gesture wall as a primary control surface. Pure functions — the composition
// runs them over every FINAL transcript observation BEFORE idea-detection
// ingest, so a spoken command is never mistaken for room-idea material.
//
// The matcher is deliberately FUZZY: "Vibersyn" is an invented word, so ASR
// finals arrive as "viber sin", "vibersin", "vibe or sin", "viper sin", … For
// every window of 1–3 consecutive tokens, join without spaces and match when
// the edit distance to the canonical wake word is within budget OR the phonetic
// keys are equal. Guardrails, so ordinary room talk can never execute commands:
//   - the window must start within the first WAKE_MAX_START tokens of the
//     utterance (a wake word ADDRESSES the room; a mid-sentence mention like
//     "we should theme the vibersyn tray" is material, not a command);
//   - the joined window's first letter must match the wake word's ("fiber
//     sync" must not wake a room named vibersyn);
//   - the edit budget is 2 only when the window is at least as long as a
//     long (>= 8 char) wake word — shorter windows get 1 ("vibes in" is 2
//     edits from vibersyn but plainly not the name);
//   - a wake word shorter than 5 characters disables fuzziness entirely
//     (exact token match only), since every guard above loses meaning at
//     that length.

export const DEFAULT_WAKE_WORD = "vibersyn";

export type VoiceCommandKind =
  | "capture-on"
  | "capture-off"
  | "build"
  | "dismiss"
  | "auto-on"
  | "auto-off"
  | "research-on"
  | "research-off"
  | "research"
  | "emergency";

export interface VoiceCommand {
  kind: VoiceCommandKind;
}

export interface WakePhraseMatch {
  // The raw token window that matched the wake word (e.g. "vibe or sin").
  matched: string;
  // Normalized text AFTER the wake window — what parseVoiceCommand consumes.
  afterWake: string;
}

// Canonical wake word from the environment. Overridable (VIBERSYN_WAKE_WORD)
// so a room can pick a name its ASR hears more reliably; default "vibersyn".
export function wakeWordFromEnv(env: Record<string, string | undefined> = process.env): string {
  const raw = env.VIBERSYN_WAKE_WORD?.trim();
  return raw !== undefined && raw.length > 0 ? raw : DEFAULT_WAKE_WORD;
}

// A wake phrase must appear at (or very near) the START of the utterance —
// this many leading tokens of filler ("hey", "ok", "so") are tolerated.
const WAKE_MAX_START = 2;

// Fuzzy wake-phrase matcher. Scans the first WAKE_MAX_START+1 start positions;
// at the earliest start with any match, picks the BEST window (lowest edit
// distance, phonetic-equal counts as 0; ties prefer the shorter window) so a
// partially-heard name never leaves its own fragments in afterWake. Returns
// null when the utterance is not addressed to the room.
export function matchWakePhrase(text: string, wakeWord: string = DEFAULT_WAKE_WORD): WakePhraseMatch | null {
  const canonical = wakeWord.toLowerCase().replace(/[^a-z0-9]+/gu, "");
  if (canonical.length === 0) {
    return null;
  }
  const fuzzy = canonical.length >= 5;
  const canonicalKey = phoneticKey(canonical);
  const tokens = tokenize(text);
  for (let start = 0; start <= WAKE_MAX_START && start < tokens.length; start += 1) {
    let best: { size: number; distance: number } | null = null;
    for (let size = 1; size <= 3 && start + size <= tokens.length; size += 1) {
      const joined = tokens.slice(start, start + size).join("");
      if (joined === canonical) {
        best = { size, distance: 0 };
        break;
      }
      if (!fuzzy) {
        continue;
      }
      if (canonicalKey.length > 0 && phoneticKey(joined) === canonicalKey) {
        best = { size, distance: 0 };
        break;
      }
      // Edit path: anchored on the first letter, budget scaled to how much of
      // the name was actually heard.
      if (joined.length < 5 || joined[0] !== canonical[0]) {
        continue;
      }
      const maxEdits = canonical.length >= 8 && joined.length >= canonical.length ? 2 : 1;
      const distance = levenshtein(joined, canonical);
      if (distance <= maxEdits && (best === null || distance < best.distance)) {
        best = { size, distance };
      }
    }
    if (best !== null) {
      const window = tokens.slice(start, start + best.size);
      return { matched: window.join(" "), afterWake: tokens.slice(start + best.size).join(" ") };
    }
  }
  return null;
}

// The exact command table (contract-fixed). Keys are the normalized token text
// AFTER the wake phrase; the bare wake word ("") starts capture.
const COMMAND_TABLE: ReadonlyArray<readonly [VoiceCommandKind, ReadonlySet<string>]> = [
  ["capture-on", new Set(["", "capture", "start capturing", "listen"])],
  ["capture-off", new Set(["stop capturing", "capture off", "stand down"])],
  ["build", new Set(["build it", "build that", "build this", "accept", "ship it", "yes"])],
  ["dismiss", new Set(["dismiss", "skip", "no", "next"])],
  ["auto-on", new Set(["auto build on"])],
  ["auto-off", new Set(["auto build off"])],
  ["research-on", new Set(["research on", "research mode", "start researching"])],
  ["research-off", new Set(["research off", "stop researching"])],
  // Accept the strongest proposed research quest (or surface one to accept).
  ["research", new Set(["research it", "research that", "research this", "fact check", "fact check it", "fact check that", "look it up"])],
  ["emergency", new Set(["emergency", "stop everything", "kill everything", "shut down"])],
];

// Parse the text after a matched wake phrase into a command. Null for anything
// not in the table — the caller still traces it, but executes nothing.
export function parseVoiceCommand(afterWake: string): VoiceCommand | null {
  const normalized = tokenize(afterWake).join(" ");
  for (const [kind, phrases] of COMMAND_TABLE) {
    if (phrases.has(normalized)) {
      return { kind };
    }
  }
  return null;
}

// Human-readable label for the snapshot's voice indicator (`snapshot.voice.lastCommand`).
const COMMAND_LABELS: Record<VoiceCommandKind, string> = {
  "capture-on": "capture on",
  "capture-off": "capture off",
  build: "build",
  dismiss: "dismiss",
  "auto-on": "auto-build on",
  "auto-off": "auto-build off",
  "research-on": "research on",
  "research-off": "research off",
  research: "research",
  emergency: "emergency stop",
};

export function voiceCommandLabel(command: VoiceCommand): string {
  return COMMAND_LABELS[command.kind];
}

// Phonetic key: a crude sound-alike fold so "vibe or sin" keys the same as
// "vibersyn". Steps (contract-fixed): lowercase; ph→f; c/q→k; z→s; y→i
// (then treated as a vowel); drop non-leading vowels; collapse repeats.
// "vibersyn" → "vbrsn".
export function phoneticKey(word: string): string {
  const substituted = word
    .toLowerCase()
    .replace(/[^a-z]+/gu, "")
    .replaceAll("ph", "f")
    .replace(/[cq]/gu, "k")
    .replace(/z/gu, "s")
    .replace(/y/gu, "i");
  let key = "";
  for (let index = 0; index < substituted.length; index += 1) {
    const char = substituted[index]!;
    if (index > 0 && "aeiou".includes(char)) {
      continue; // drop non-leading vowels
    }
    if (key.length > 0 && key[key.length - 1] === char) {
      continue; // collapse repeats
    }
    key += char;
  }
  return key;
}

// Lowercase alphanumeric tokens; punctuation/apostrophes become separators.
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 0);
}

// Classic two-row Levenshtein — inputs are short (joined 1–3 token windows).
function levenshtein(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min(previous[j]! + 1, current[j - 1]! + 1, substitution));
    }
    previous = current;
  }
  return previous[b.length]!;
}
