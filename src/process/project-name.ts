// Infer a human project name from a spoken idea pitch, replacing the old
// random codename callsigns ("virellium") the user couldn't connect to their
// ideas. Two outputs per pitch:
//   title  — display name for the wall card ("Annual Snowfall App")
//   handle — one speakable lowercase word for voice addressing ("snowfall");
//            it feeds CallsignAllocator.assign, so it must survive
//            normalizeCallsign (lowercase alphanumerics).
// Deterministic on purpose: naming must never delay or fail a spawn.

const STOPWORDS = new Set([
  "a", "an", "the", "this", "that", "these", "those", "it", "its", "of", "in",
  "on", "for", "to", "with", "and", "or", "but", "so", "then", "than", "as",
  "at", "by", "from", "into", "after", "before", "when", "where", "how", "what",
  "which", "who", "whose", "i", "im", "id", "we", "you", "they", "them", "my",
  "our", "your", "their", "me", "us", "he", "she", "his", "her",
  "is", "are", "was", "were", "be", "been", "being", "am", "do", "does", "did",
  "can", "could", "should", "would", "will", "wont", "cant", "dont", "not",
  "no", "yes", "there", "here", "have", "has", "had", "get", "gets", "got",
  "want", "wants", "wanted", "like", "likes", "liked", "need", "needs",
  "really", "very", "just", "basically", "sort", "kind", "know", "think",
  "make", "makes", "made", "build", "builds", "built", "create", "creates",
  "takes", "take", "says", "say", "see", "sees", "know", "knows", "let", "lets",
  "some", "something", "any", "anything", "one", "all", "much", "many", "more",
  "amount", "also", "because", "youre", "your", "cool", "awesome", "nice",
]);

// Words that describe the KIND of thing being built. One is appended to the
// title (never used as the handle — "app" is unspeakable as an address in a
// room full of apps).
const KIND_WORDS = ["app", "application", "extension", "website", "site", "dashboard", "bot", "tool", "game", "platform"] as const;

function words(pitch: string): string[] {
  return (pitch.toLowerCase().match(/[a-z0-9']+/gu) ?? []).map((w) => w.replace(/'/gu, ""));
}

function titleCase(word: string): string {
  return word.length === 0 ? word : word[0].toUpperCase() + word.slice(1);
}

export interface InferredProjectName {
  title: string;
  handle: string;
}

// ── LLM naming (Cerebras) ─────────────────────────────────────────────────────
// The deterministic inference below is the instant placeholder + offline
// fallback; this is the real namer. Called fire-and-forget AFTER a spawn (a
// name must never delay or fail a spawn) — the card renames when it resolves.
export interface LlmNamerOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const CEREBRAS_CHAT_URL = "https://api.cerebras.ai/v1/chat/completions";
const DEFAULT_NAMER_MODEL = "gemma-4-31b";
const DEFAULT_NAMER_TIMEOUT_MS = 6_000;

export async function llmProjectName(
  pitch: string,
  options: LlmNamerOptions,
): Promise<InferredProjectName | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_NAMER_TIMEOUT_MS);
  try {
    const response = await fetchImpl(CEREBRAS_CHAT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model: options.model ?? DEFAULT_NAMER_MODEL,
        temperature: 0.4,
        max_tokens: 80,
        messages: [
          {
            role: "user",
            content:
              `Name this software project from the spoken idea below. Reply with ONLY a JSON object, no prose:\n` +
              `{"title": "<catchy 2-4 word product name>", "handle": "<ONE lowercase word from the idea's domain, easy to say aloud>"}\n\n` +
              `Spoken idea: ${pitch}`,
          },
        ],
      }),
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = body.choices?.[0]?.message?.content ?? "";
    const json = raw.match(/\{[\s\S]*\}/u)?.[0];
    if (json === undefined) {
      return null;
    }
    const parsed = JSON.parse(json) as { title?: unknown; handle?: unknown };
    const title = typeof parsed.title === "string" ? parsed.title.trim().slice(0, 48) : "";
    const handleWord = typeof parsed.handle === "string" ? (parsed.handle.toLowerCase().match(/[a-z0-9]+/u)?.[0] ?? "") : "";
    if (title.length === 0) {
      return null;
    }
    // A degenerate handle falls back to the deterministic keyword so voice
    // addressing always has something speakable.
    const handle = handleWord.length >= 3 ? handleWord : inferProjectName(pitch).handle;
    return { title, handle };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function inferProjectName(pitch: string | undefined | null): InferredProjectName {
  const all = words(pitch ?? "");
  const kind = KIND_WORDS.find((k) => all.includes(k)) ?? null;

  // Content words in pitch order: no stopwords, no kind words, deduped.
  const seen = new Set<string>();
  const content = all.filter((w) => {
    if (w.length < 3 || STOPWORDS.has(w) || (KIND_WORDS as readonly string[]).includes(w) || seen.has(w)) {
      return false;
    }
    seen.add(w);
    return true;
  });

  // Prefer distinctive words: repetition marks the topic ("dating" said three
  // times IS the project), length breaks ties, and adverbs ("intellectually")
  // never name a project. Keep pitch order among the chosen so the title still
  // parses as a phrase.
  const freq = new Map<string, number>();
  for (const w of all) freq.set(w, (freq.get(w) ?? 0) + 1);
  const score = (w: string) => (freq.get(w) ?? 1) * 10 + w.length - (w.endsWith("ly") ? 25 : 0);
  const ranked = [...content].sort((a, b) => score(b) - score(a)).slice(0, 3);
  const chosen = content.filter((w) => ranked.includes(w)).slice(0, 3);

  if (chosen.length === 0) {
    return { title: kind ? `${titleCase(kind)} Idea` : "Untitled Idea", handle: "" };
  }

  const kindSuffix = kind !== null && kind !== "application" ? ` ${titleCase(kind)}` : kind === "application" ? " App" : "";
  const title = `${chosen.map(titleCase).join(" ")}${kindSuffix}`;
  // Handle: the single most distinctive chosen word (longest), speakable and
  // collision-friendlier than short generic ones.
  const handle = [...chosen].sort((a, b) => score(b) - score(a))[0] ?? "";
  return { title, handle };
}
