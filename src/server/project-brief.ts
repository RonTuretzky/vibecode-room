/**
 * THE PROJECT BRIEF — what the room knows about an imported project, before
 * anyone asks it to change anything.
 *
 * Clicking an imported tree used to show its build controls and nothing about
 * the project itself. You could take an issue and start work on a codebase the
 * room had never told you one fact about. The brief is the missing surface:
 * what this project is, what it is built out of, how alive it is, and how much
 * of that the room actually knows versus inferred.
 *
 * Everything here is DERIVED FROM THE CLONE (repoDigest's profile of the real
 * checkout) — no model required and none faked. The digest already leads with
 * an "appears to be" inference; the brief keeps that phrasing rather than
 * upgrading a guess into a statement.
 */

export interface ProjectBriefSource {
  repo: string; // "owner/name"
  url: string;
  // repoDigest's output for the checkout, or null when there is no checkout.
  digest: string | null;
  // Why there is no checkout, when that is the case — the brief says so
  // instead of rendering an empty card.
  cloneError: string | null;
  // What the person typed when they imported it. Their intent is part of the
  // brief: the room should show the ask it is working from.
  context: string | null;
}

export interface ProjectBrief {
  repo: string;
  url: string;
  // The digest's leading inference ("appears to be …"), when it made one.
  summary: string | null;
  // Section lines lifted from the digest — stack, layout, entrypoint.
  facts: string[];
  // The README's opening prose, trimmed to something readable on a wall.
  readme: string | null;
  // The instruction this import carried, verbatim.
  ask: string | null;
  // Set when the room could not read the project at all.
  unavailable: string | null;
  atMs: number;
}

const MAX_FACTS = 8;
const MAX_FACT_CHARS = 160;
const MAX_README_CHARS = 420;

/**
 * Pure: the digest text → a brief the wall can render.
 *
 * The digest is prose+sections built for a prompt, so this pulls it apart
 * conservatively: the "appears to be" line becomes the summary, remaining
 * non-empty lines become facts (bounded), and a README section becomes the
 * readable excerpt. Anything it cannot find is null — the card renders less
 * rather than inventing more.
 */
export function buildProjectBrief(source: ProjectBriefSource, nowMs: number): ProjectBrief {
  const ask = source.context !== null && source.context.trim().length > 0 ? source.context.trim() : null;
  if (source.digest === null) {
    return {
      repo: source.repo,
      url: source.url,
      summary: null,
      facts: [],
      readme: null,
      ask,
      unavailable:
        source.cloneError !== null
          ? `The room could not clone this repository — ${source.cloneError}`
          : "The room has no checkout of this repository to read.",
      atMs: nowMs,
    };
  }
  const lines = source.digest
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  // The digest's inference line, wherever it sits.
  const summary = lines.find((line) => /appears to be/iu.test(line)) ?? null;

  // A README section, when the digest carried one. Everything after the
  // heading up to the next heading-ish line.
  let readme: string | null = null;
  const readmeIndex = lines.findIndex((line) => /^readme\b/iu.test(line) || /^#+\s/u.test(line));
  if (readmeIndex >= 0) {
    const body: string[] = [];
    for (const line of lines.slice(readmeIndex + 1)) {
      if (/^[A-Z][A-Za-z ]{2,20}:$/u.test(line)) {
        break;
      }
      body.push(line.replace(/^#+\s*/u, ""));
      if (body.join(" ").length > MAX_README_CHARS) {
        break;
      }
    }
    const joined = body.join(" ").trim();
    readme = joined.length > 0 ? truncate(joined, MAX_README_CHARS) : null;
  }

  const facts = lines
    .filter((line) => line !== summary)
    .filter((line) => !/^#+\s/u.test(line))
    .filter((line) => line.includes(":") || /^[-•*]/u.test(line))
    .map((line) => truncate(line.replace(/^[-•*]\s*/u, ""), MAX_FACT_CHARS))
    .slice(0, MAX_FACTS);

  return { repo: source.repo, url: source.url, summary, facts, readme, ask, unavailable: null, atMs: nowMs };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}
