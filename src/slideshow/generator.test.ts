import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  buildSlides,
  cerebrasCopyModel,
  clampCopy,
  decisionButtons,
  fallbackCopy,
  fetchWithRetry,
  generateSlideshow,
  ideaTitle,
  mergeCopy,
  parseModelCopy,
  pitchMocks,
  slideshowUrl,
  SLIDESHOW_ENTRYPOINT,
  type GenerateSlideshowInput,
  type SlideshowCopy,
  type SlideshowCopyModel,
} from "./generator";

// --- slideshowUrl -----------------------------------------------------------

describe("slideshowUrl", () => {
  test("appends the slideshow/ segment to a previewUrl", () => {
    expect(slideshowUrl("http://127.0.0.1:4123/")).toBe("http://127.0.0.1:4123/slideshow/");
  });

  test("normalizes a previewUrl with no trailing slash", () => {
    expect(slideshowUrl("http://127.0.0.1:4123")).toBe("http://127.0.0.1:4123/slideshow/");
  });

  test("collapses multiple trailing slashes before appending", () => {
    expect(slideshowUrl("http://127.0.0.1:4123///")).toBe("http://127.0.0.1:4123/slideshow/");
  });

  test("returns null for a null or blank previewUrl", () => {
    expect(slideshowUrl(null)).toBeNull();
    expect(slideshowUrl("   ")).toBeNull();
  });
});

// --- ideaTitle ---------------------------------------------------------------

describe("ideaTitle", () => {
  test("takes the first clause, capped at 10 words, capitalized", () => {
    expect(ideaTitle("a tip calculator that also splits the bill fairly among many friends. it also tips well.")).toBe(
      "A tip calculator that also splits the bill fairly among",
    );
  });

  test("falls back to Untitled idea for blank input", () => {
    expect(ideaTitle("   ")).toBe("Untitled idea");
  });

  test("splits on ! and ? and newlines too", () => {
    expect(ideaTitle("build a synth!\nit should be fun")).toBe("Build a synth");
    expect(ideaTitle("can we make a maze?")).toBe("Can we make a maze");
  });
});

// --- fallbackCopy (deterministic no-Cerebras pitch copy) ----------------------

describe("fallbackCopy", () => {
  const base: GenerateSlideshowInput = {
    upid: "upid-3",
    ideaId: "idea-9",
    prompt: "a tip calculator",
    callsign: null,
    backend: "native",
    outDir: "/tmp/whatever",
    summary: "a concept pitch",
  };

  test("produces every required field, non-empty", () => {
    const copy = fallbackCopy(base);
    expect(copy.tagline.length).toBeGreaterThan(0);
    expect(copy.concept.length).toBeGreaterThan(0);
  });

  test("taglines from the spoken idea, deterministically", () => {
    expect(fallbackCopy(base).tagline).toBe("A tip calculator");
  });

  test("concept bullets pitch mocks-first + commissioning, not a build report", () => {
    const copy = fallbackCopy(base);
    expect(copy.concept.some((line) => line.toLowerCase().includes("mock"))).toBe(true);
    expect(copy.concept.some((line) => line.toLowerCase().includes("commission"))).toBe(true);
  });

  test("references generic spoken steering when there is no callsign", () => {
    const copy = fallbackCopy({ ...base, callsign: null });
    expect(copy.concept.some((line) => line.toLowerCase().includes('say "steer it'))).toBe(true);
  });

  test("uses the callsign in the steer line when present", () => {
    const copy = fallbackCopy({ ...base, callsign: "falcon" });
    expect(copy.concept.some((line) => line.includes("steer falcon"))).toBe(true);
  });

  test("blank callsign is treated the same as no callsign", () => {
    const copy = fallbackCopy({ ...base, callsign: "   " });
    expect(copy.concept.some((line) => line.toLowerCase().includes('say "steer it'))).toBe(true);
  });

  test("names this lane's own framework when no mock lanes are supplied", () => {
    const copy = fallbackCopy({ ...base, backend: "native" });
    expect(copy.concept.some((line) => line.includes("the Native framework"))).toBe(true);
  });

  test("names every framework from the mock lanes, in reading order", () => {
    const copy = fallbackCopy({
      ...base,
      mocks: [
        { backend: "smithers", previewUrl: "/preview/upid-3/smithers/" },
        { backend: "eliza", previewUrl: "/preview/upid-3/eliza/" },
        { backend: "native", previewUrl: null },
      ],
    });
    expect(copy.concept.some((line) => line.includes("Smithers, ElizaOS and Native each"))).toBe(true);
  });

  test("grounds the deck in the imported repo digest when one is present", () => {
    const copy = fallbackCopy({
      ...base,
      repoDigest: "Top-level files: src/, package.json\n\npackage.json: snowsip — turns snowfall into sips",
    });
    expect(copy.concept.some((line) => line.toLowerCase().includes("imported repo"))).toBe(true);
    expect(copy.concept.some((line) => line.includes("snowsip — turns snowfall into sips"))).toBe(true);
    // Enrichment never crowds out the load-bearing narrative lines.
    expect(copy.concept.some((line) => line.toLowerCase().includes("mock"))).toBe(true);
    expect(copy.concept.some((line) => line.toLowerCase().includes("commission"))).toBe(true);
    expect(copy.concept.length).toBeLessThanOrEqual(6);
  });

  test("ignores a blank/absent repo digest without adding an empty bullet", () => {
    expect(fallbackCopy({ ...base, repoDigest: "   " }).concept).toEqual(fallbackCopy(base).concept);
    expect(fallbackCopy({ ...base, repoDigest: null }).concept).toEqual(fallbackCopy(base).concept);
  });

  test("clamps a huge repo-digest bullet at the source (fallbackCopy alone, no clampCopy)", () => {
    // A README-heavy import: the digest headline is far longer than a slide line.
    const giant = `package.json: ${"lorem ipsum ".repeat(80)}dolor`;
    const copy = fallbackCopy({ ...base, repoDigest: giant });
    const digestBullet = copy.concept.find((line) => line.toLowerCase().includes("imported repo"));
    expect(digestBullet).toBeDefined();
    expect(digestBullet!.length).toBeLessThanOrEqual(220);
    expect(digestBullet!.endsWith("…")).toBe(true);
    // Every fallback bullet stays slide-sized even without the final clamp pass.
    for (const line of copy.concept) {
      expect(line.length).toBeLessThanOrEqual(220);
    }
  });
});

// --- clampCopy (length/clamp guard) ---------------------------------------------

describe("clampCopy", () => {
  const fallback: SlideshowCopy = { tagline: "fallback tagline", concept: ["fallback concept"] };

  test("passes short, clean copy through untouched", () => {
    const copy: SlideshowCopy = { tagline: "Tip calculator", concept: ["splits fairly", "yells politely"] };
    expect(clampCopy(copy, fallback)).toEqual(copy);
  });

  test("truncates an over-long tagline on a word boundary with an ellipsis", () => {
    const long = `${"word ".repeat(60)}end`;
    const { tagline } = clampCopy({ tagline: long, concept: ["x"] }, fallback);
    expect(tagline.length).toBeLessThanOrEqual(100);
    expect(tagline.endsWith("…")).toBe(true);
    expect(tagline).not.toMatch(/\s…$/u); // no dangling space before the ellipsis
  });

  test("clamps each concept line and caps the line count at six", () => {
    const many = Array.from({ length: 12 }, (_, i) => `line ${i}`);
    const { concept } = clampCopy({ tagline: "t", concept: many }, fallback);
    expect(concept.length).toBe(6);
  });

  test("falls back per-field when a field collapses to empty", () => {
    const { tagline, concept } = clampCopy({ tagline: "   ", concept: ["  ", ""] }, fallback);
    expect(tagline).toBe("fallback tagline");
    expect(concept).toEqual(["fallback concept"]);
  });

  test("never emits an empty tagline or empty concept, even with an empty fallback", () => {
    const { tagline, concept } = clampCopy({ tagline: "", concept: [] }, { tagline: "", concept: [] });
    expect(tagline.length).toBeGreaterThan(0);
    expect(concept.length).toBeGreaterThan(0);
  });
});

// --- mergeCopy -----------------------------------------------------------------

describe("mergeCopy", () => {
  const fallback: SlideshowCopy = {
    tagline: "fallback tagline",
    concept: ["fallback concept"],
  };

  test("non-object raw returns the fallback verbatim and usedModel false", () => {
    expect(mergeCopy(null, fallback)).toEqual({ copy: fallback, usedModel: false });
    expect(mergeCopy("garbage", fallback)).toEqual({ copy: fallback, usedModel: false });
    expect(mergeCopy([1, 2, 3], fallback)).toEqual({ copy: fallback, usedModel: false });
  });

  test("a fully valid object overrides every field and flips usedModel", () => {
    const raw = { tagline: "model tagline", concept: ["a", "b"] };
    const { copy, usedModel } = mergeCopy(raw, fallback);
    expect(usedModel).toBe(true);
    expect(copy).toEqual({ tagline: "model tagline", concept: ["a", "b"] });
  });

  test("partial output merges field-by-field over the fallback", () => {
    const { copy, usedModel } = mergeCopy({ tagline: "only tagline" }, fallback);
    expect(usedModel).toBe(true);
    expect(copy.tagline).toBe("only tagline");
    expect(copy.concept).toEqual(fallback.concept);
  });

  test("empty-string tagline and empty arrays are rejected as garbage", () => {
    const { copy, usedModel } = mergeCopy({ tagline: "   ", concept: [] }, fallback);
    expect(usedModel).toBe(false);
    expect(copy).toEqual(fallback);
  });

  test("wrong-typed fields are ignored while valid sibling fields still apply", () => {
    const { copy, usedModel } = mergeCopy({ tagline: 42, concept: ["ok"] }, fallback);
    expect(usedModel).toBe(true);
    expect(copy.tagline).toBe(fallback.tagline);
    expect(copy.concept).toEqual(["ok"]);
  });

  test("caps line count and trims/collapses whitespace per line", () => {
    const many = Array.from({ length: 20 }, (_, i) => `  line   ${i}  `);
    const { copy } = mergeCopy({ concept: many }, fallback);
    expect(copy.concept.length).toBeLessThanOrEqual(6);
    expect(copy.concept[0]).toBe("line 0");
  });
});

// --- parseModelCopy --------------------------------------------------------------

describe("parseModelCopy", () => {
  test("parses bare JSON", () => {
    expect(parseModelCopy('{"tagline":"x"}')).toEqual({ tagline: "x" });
  });

  test("extracts JSON wrapped in prose", () => {
    expect(parseModelCopy('Sure, here it is:\n{"tagline":"x"}\nhope that helps')).toEqual({ tagline: "x" });
  });

  test("extracts JSON wrapped in a markdown fence", () => {
    expect(parseModelCopy('```json\n{"tagline":"x"}\n```')).toEqual({ tagline: "x" });
  });

  test("extracts JSON from a fence followed by trailing prose", () => {
    expect(parseModelCopy('Here you go:\n```json\n{"tagline":"x","concept":["a"]}\n```\nLet me know!')).toEqual({
      tagline: "x",
      concept: ["a"],
    });
  });

  test("balanced scan survives trailing prose that itself contains a brace", () => {
    // lastIndexOf('}') lands on the prose brace; the balanced scan recovers the object.
    expect(parseModelCopy('{"tagline":"x"} — use it like { placeholder }')).toEqual({ tagline: "x" });
  });

  test("keeps braces that live inside string values intact", () => {
    expect(parseModelCopy('prose {"tagline":"a {curly} headline"} more')).toEqual({ tagline: "a {curly} headline" });
  });

  test("returns null for unparseable content", () => {
    expect(parseModelCopy("not json at all")).toBeNull();
    expect(parseModelCopy("")).toBeNull();
  });

  test("returns null for a JSON array (not a record)", () => {
    expect(parseModelCopy("[1,2,3]")).toBeNull();
  });
});

// --- pitchMocks ------------------------------------------------------------------

describe("pitchMocks", () => {
  const base: GenerateSlideshowInput = {
    upid: "upid-3",
    prompt: "an idea",
    callsign: null,
    backend: "smithers",
    outDir: "/tmp/x",
    summary: "s",
  };

  test("passes explicit mock lanes through with per-backend previewUrl", () => {
    const mocks = pitchMocks({
      ...base,
      mocks: [
        { backend: "smithers", previewUrl: "/preview/upid-3/smithers/" },
        { backend: "eliza", previewUrl: "/preview/upid-3/eliza/" },
        { backend: "native", previewUrl: null },
      ],
    });
    expect(mocks.map((m) => m.id)).toEqual(["smithers", "eliza", "native"]);
    expect(mocks[0]!.src).toBe("/preview/upid-3/smithers/");
    expect(mocks[1]!.src).toBe("/preview/upid-3/eliza/");
    expect(mocks[2]!.src).toBeNull();
    expect(mocks.map((m) => m.label)).toEqual(["Smithers", "ElizaOS", "Native"]);
  });

  test("omitted mocks default to this lane's own mock via the relative ../ URL", () => {
    const mocks = pitchMocks(base);
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.id).toBe("smithers");
    expect(mocks[0]!.src).toBe("../");
  });

  test("blank previewUrl becomes a null src (placeholder panel)", () => {
    const mocks = pitchMocks({ ...base, mocks: [{ backend: "native", previewUrl: "   " }] });
    expect(mocks[0]!.src).toBeNull();
  });
});

// --- decisionButtons -------------------------------------------------------------

describe("decisionButtons", () => {
  test("encodes the three kickoff-contract endpoints in order", () => {
    const decisions = decisionButtons("upid-3", "idea-9", null);
    expect(decisions.map((d) => d.id)).toEqual(["execute", "steer", "dismiss"]);
    expect(decisions[0]!.endpoint).toBe("/api/process/upid-3/execute");
    expect(decisions[1]!.endpoint).toBe("/api/process/upid-3/steer");
    expect(decisions[2]!.endpoint).toBe("/api/idea/idea-9/dismiss");
  });

  test("URI-encodes hostile upid/ideaId path segments", () => {
    const decisions = decisionButtons("up id/../x", "idea?9", null);
    expect(decisions[0]!.endpoint).toBe("/api/process/up%20id%2F..%2Fx/execute");
    expect(decisions[2]!.endpoint).toBe("/api/idea/idea%3F9/dismiss");
  });

  test("execute shows the commissioned confirmation; execute/dismiss terminal, steer prompts", () => {
    const decisions = decisionButtons("u", "i", null);
    expect(decisions[0]!.confirmation).toBe("Commissioned — watch the wall.");
    expect(decisions[0]!.terminal).toBe(true);
    expect(decisions[2]!.terminal).toBe(true);
    expect(decisions[1]!.terminal).toBeUndefined();
    expect(decisions[1]!.prompt).toMatchObject({ field: "text" });
  });

  test("steer detail speaks the callsign when present", () => {
    expect(decisionButtons("u", "i", "falcon")[1]!.detail).toContain('"steer falcon ..."');
    expect(decisionButtons("u", "i", null)[1]!.detail).toContain('"steer it ..."');
  });
});

// --- buildSlides -----------------------------------------------------------------

describe("buildSlides", () => {
  const input: GenerateSlideshowInput = {
    upid: "upid-3",
    ideaId: "idea-9",
    prompt: "  build me a tip calculator  ",
    callsign: "falcon",
    backend: "native",
    outDir: "/tmp/x",
    summary: "A tip calculator concept, three ways.",
    mocks: [
      { backend: "smithers", previewUrl: "/preview/upid-3/smithers/" },
      { backend: "eliza", previewUrl: "/preview/upid-3/eliza/" },
      { backend: "native", previewUrl: "/preview/upid-3/native/" },
    ],
  };
  const copy: SlideshowCopy = {
    tagline: "Tip calculator",
    concept: ["splits fairly", "yells politely"],
  };

  test("produces exactly 4 pitch slides in the specified order", () => {
    const slides = buildSlides(input, copy);
    expect(slides).toHaveLength(4);
    expect(slides.map((s) => s.kicker)).toEqual(["Heard in the room", "The concept", "The mocks", "Your call"]);
  });

  test("slide 1 is the hero: the verbatim spoken idea, big type", () => {
    const [first] = buildSlides(input, copy);
    expect(first!.hero).toBe(true);
    expect(first!.quote).toBe("build me a tip calculator");
    expect(first!.bullets).toContain("Callsign “falcon” — process upid-3");
  });

  test("slide 1 omits callsign wording when callsign is null", () => {
    const [first] = buildSlides({ ...input, callsign: null }, copy);
    expect(first!.bullets).toContain("Process upid-3");
  });

  test("slide 1 falls back to a placeholder when the prompt is blank", () => {
    const [first] = buildSlides({ ...input, prompt: "   " }, copy);
    expect(first!.quote).toBe("(no transcript captured)");
  });

  test("slide 2 pitches the concept: model tagline + kickoff summary + concept bullets", () => {
    const slides = buildSlides(input, copy);
    expect(slides[1]!.title).toBe("Tip calculator");
    expect(slides[1]!.paragraphs).toEqual(["A tip calculator concept, three ways."]);
    expect(slides[1]!.bullets).toEqual(["splits fairly", "yells politely"]);
  });

  test("slide 2 explains a missing summary instead of being empty", () => {
    const slides = buildSlides({ ...input, summary: "  " }, copy);
    expect(slides[1]!.paragraphs?.[0]).toMatch(/no pitch summary/iu);
  });

  test("slide 3 carries the mock gallery with a count-aware title", () => {
    const slides = buildSlides(input, copy);
    expect(slides[2]!.title).toBe("3 concept mocks, live");
    expect(slides[2]!.mocks?.map((m) => m.id)).toEqual(["smithers", "eliza", "native"]);
  });

  test("slide 3 titles a lone self-mock in the singular", () => {
    const slides = buildSlides({ ...input, mocks: undefined }, copy);
    expect(slides[2]!.title).toBe("One concept mock, live");
    expect(slides[2]!.mocks?.[0]?.src).toBe("../");
  });

  test("slide 4 asks how to continue with the three contract decisions", () => {
    const slides = buildSlides(input, copy);
    expect(slides[3]!.title).toBe("How should we continue?");
    expect(slides[3]!.decisions?.map((d) => d.id)).toEqual(["execute", "steer", "dismiss"]);
    expect(slides[3]!.decisions?.[2]?.endpoint).toBe("/api/idea/idea-9/dismiss");
  });

  test("slide 4 falls back to the upid for dismiss when ideaId is absent or blank", () => {
    const noIdea = buildSlides({ ...input, ideaId: undefined }, copy);
    expect(noIdea[3]!.decisions?.[2]?.endpoint).toBe("/api/idea/upid-3/dismiss");
    const blankIdea = buildSlides({ ...input, ideaId: "  " }, copy);
    expect(blankIdea[3]!.decisions?.[2]?.endpoint).toBe("/api/idea/upid-3/dismiss");
  });
});

// --- generateSlideshow (end-to-end, filesystem + fake model) --------------------

describe("generateSlideshow", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  const baseInput = (outDir: string): GenerateSlideshowInput => ({
    upid: "upid-7",
    ideaId: "idea-7",
    prompt: "build a pomodoro timer that yells at me",
    callsign: "otter",
    backend: "native",
    outDir,
    summary: "A pomodoro timer with a yelling mascot.",
    mocks: [
      { backend: "smithers", previewUrl: "/preview/upid-7/smithers/" },
      { backend: "eliza", previewUrl: "/preview/upid-7/eliza/" },
      { backend: "native", previewUrl: "/preview/upid-7/native/" },
    ],
  });

  test("writes a self-contained 4-slide pitch at <outDir>/slideshow/index.html", async () => {
    dir = await mkdtemp(join(tmpdir(), "slideshow-test-"));

    const noNetworkModel: SlideshowCopyModel = async () => null;
    const artifact = await generateSlideshow(baseInput(dir), { model: noNetworkModel });

    expect(artifact.indexPath).toBe(join(dir, SLIDESHOW_ENTRYPOINT));
    expect(artifact.slideCount).toBe(4);
    expect(artifact.usedModel).toBe(false);

    const html = await readFile(artifact.indexPath, "utf8");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toMatch(/https?:\/\//u);
    expect(html).toContain("build a pomodoro timer that yells at me");
    expect(html).toContain("How should we continue?");
  });

  test("encodes the decision endpoints and the mock gallery in the written deck", async () => {
    dir = await mkdtemp(join(tmpdir(), "slideshow-test-"));
    const artifact = await generateSlideshow(baseInput(dir), { model: async () => null });
    const html = await readFile(artifact.indexPath, "utf8");
    expect(html).toContain('data-endpoint="/api/process/upid-7/execute"');
    expect(html).toContain('data-endpoint="/api/process/upid-7/steer"');
    expect(html).toContain('data-endpoint="/api/idea/idea-7/dismiss"');
    expect(html).toContain('data-dwell="decision-execute"');
    expect(html).toContain('src="/preview/upid-7/eliza/"');
    expect(html).toContain('data-mock-tab="smithers"');
  });

  test("merges a working fake model's copy into the rendered slides", async () => {
    dir = await mkdtemp(join(tmpdir(), "slideshow-test-"));

    const fakeModel: SlideshowCopyModel = async () => ({
      tagline: "The yelling pomodoro timer",
      concept: ["A countdown that shouts at you"],
    });
    const artifact = await generateSlideshow(baseInput(dir), { model: fakeModel });
    expect(artifact.usedModel).toBe(true);
    const html = await readFile(artifact.indexPath, "utf8");
    expect(html).toContain("The yelling pomodoro timer");
    expect(html).toContain("A countdown that shouts at you");
  });

  test("a rejecting model still produces a deck via the deterministic fallback", async () => {
    dir = await mkdtemp(join(tmpdir(), "slideshow-test-"));

    const throwingModel: SlideshowCopyModel = async () => {
      throw new Error("network is down");
    };
    const artifact = await generateSlideshow(baseInput(dir), { model: throwingModel });
    expect(artifact.usedModel).toBe(false);
    const html = await readFile(artifact.indexPath, "utf8");
    expect(html).toContain("otter");
    expect(html).toContain("How should we continue?");
  });

  test("a hanging model is bounded by timeoutMs and falls back", async () => {
    dir = await mkdtemp(join(tmpdir(), "slideshow-test-"));

    const hangingModel: SlideshowCopyModel = () => new Promise(() => {}); // never resolves
    const start = Date.now();
    const artifact = await generateSlideshow(baseInput(dir), { model: hangingModel, timeoutMs: 30 });
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(artifact.usedModel).toBe(false);
  });

  test("propagates an already-aborted caller signal instead of writing anything", async () => {
    dir = await mkdtemp(join(tmpdir(), "slideshow-test-"));
    const controller = new AbortController();
    controller.abort();
    await expect(
      generateSlideshow(baseInput(dir), { model: async () => null, signal: controller.signal }),
    ).rejects.toThrow();
  });

  test("omitted mocks still produce a deck with the self-lane ../ mock", async () => {
    dir = await mkdtemp(join(tmpdir(), "slideshow-test-"));
    const input = { ...baseInput(dir), mocks: undefined };
    const artifact = await generateSlideshow(input, { model: async () => null });
    expect(artifact.slideCount).toBe(4);
    const html = await readFile(artifact.indexPath, "utf8");
    expect(html).toContain('src="../"');
  });

  test("runs fast with a fake model (well under the kickoff budget)", async () => {
    dir = await mkdtemp(join(tmpdir(), "slideshow-test-"));
    const start = Date.now();
    await generateSlideshow(baseInput(dir), { model: async () => ({ tagline: "fast" }) });
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  test("clamps an overflowing model tagline before it reaches the slide", async () => {
    dir = await mkdtemp(join(tmpdir(), "slideshow-test-"));
    const runaway = `${"overflowing ".repeat(40)}tagline`;
    const artifact = await generateSlideshow(baseInput(dir), { model: async () => ({ tagline: runaway }) });
    const html = await readFile(artifact.indexPath, "utf8");
    expect(html).not.toContain(runaway);
    expect(html).toContain("…");
  });

  test("prose-wrapped model JSON still merges into the deck (tolerant extraction)", async () => {
    dir = await mkdtemp(join(tmpdir(), "slideshow-test-"));
    // A model that answers in prose around fenced JSON; parseModelCopy recovers it.
    const proseModel: SlideshowCopyModel = async () =>
      parseModelCopy('Sure!\n```json\n{"tagline":"Recovered headline","concept":["Recovered bullet"]}\n```\nEnjoy.');
    const artifact = await generateSlideshow(baseInput(dir), { model: proseModel });
    expect(artifact.usedModel).toBe(true);
    const html = await readFile(artifact.indexPath, "utf8");
    expect(html).toContain("Recovered headline");
    expect(html).toContain("Recovered bullet");
  });

  test("a partial model (tagline only) keeps the deterministic concept bullets in the deck", async () => {
    dir = await mkdtemp(join(tmpdir(), "slideshow-test-"));
    // Model supplies just the headline; the concept bullets must fall back per-field
    // so the concept slide is never left without body copy.
    const partialModel: SlideshowCopyModel = async () => ({ tagline: "Just the headline" });
    const input = baseInput(dir);
    const artifact = await generateSlideshow(input, { model: partialModel });
    expect(artifact.usedModel).toBe(true);
    const html = await readFile(artifact.indexPath, "utf8");
    expect(html).toContain("Just the headline");
    // The deterministic fallback's load-bearing bullets survive for the missing field.
    const fallbackBullet = fallbackCopy(input).concept.find((line) => line.toLowerCase().includes("commission"));
    expect(fallbackBullet).toBeDefined();
    expect(html).toContain(fallbackBullet!);
  });
});

// --- fetchWithRetry (bounded exponential backoff on 429/5xx/network) -------------

describe("fetchWithRetry", () => {
  // A fake fetch that yields a scripted sequence of responses/errors and counts calls.
  function scriptedFetch(steps: ReadonlyArray<Response | Error>): { impl: typeof fetch; calls: () => number } {
    let i = 0;
    const impl = (async () => {
      const step = steps[Math.min(i, steps.length - 1)];
      i += 1;
      if (step instanceof Error) {
        throw step;
      }
      return step;
    }) as unknown as typeof fetch;
    return { impl, calls: () => i };
  }

  const ok = (): Response => new Response('{"ok":true}', { status: 200 });
  const status = (code: number, headers?: Record<string, string>): Response =>
    new Response(null, { status: code, headers });
  const liveSignal = (): AbortSignal => new AbortController().signal;

  test("returns the first ok response with no sleep on a clean call", async () => {
    const delays: number[] = [];
    const { impl, calls } = scriptedFetch([ok()]);
    const res = await fetchWithRetry(impl, "u", {}, liveSignal(), { sleep: async (ms) => void delays.push(ms) });
    expect(res?.status).toBe(200);
    expect(calls()).toBe(1);
    expect(delays).toEqual([]);
  });

  test("retries a 429 then returns the subsequent 200", async () => {
    const delays: number[] = [];
    const { impl, calls } = scriptedFetch([status(429), ok()]);
    const res = await fetchWithRetry(impl, "u", {}, liveSignal(), { sleep: async (ms) => void delays.push(ms) });
    expect(res?.status).toBe(200);
    expect(calls()).toBe(2);
    expect(delays).toHaveLength(1);
  });

  test("retries 5xx up to maxAttempts then returns null", async () => {
    const delays: number[] = [];
    const { impl, calls } = scriptedFetch([status(503)]);
    const res = await fetchWithRetry(impl, "u", {}, liveSignal(), {
      maxAttempts: 3,
      sleep: async (ms) => void delays.push(ms),
    });
    expect(res).toBeNull();
    expect(calls()).toBe(3);
    expect(delays).toHaveLength(2); // one sleep between each of the three attempts
  });

  test("does NOT retry a non-retryable 4xx (bad key / bad request)", async () => {
    const delays: number[] = [];
    const { impl, calls } = scriptedFetch([status(400)]);
    const res = await fetchWithRetry(impl, "u", {}, liveSignal(), { sleep: async (ms) => void delays.push(ms) });
    expect(res).toBeNull();
    expect(calls()).toBe(1);
    expect(delays).toEqual([]);
  });

  test("retries a transient network error then succeeds", async () => {
    const { impl, calls } = scriptedFetch([new Error("ECONNRESET"), ok()]);
    const res = await fetchWithRetry(impl, "u", {}, liveSignal(), { sleep: async () => {} });
    expect(res?.status).toBe(200);
    expect(calls()).toBe(2);
  });

  test("gives up on a persistent network error at the attempt budget", async () => {
    const { impl, calls } = scriptedFetch([new Error("down")]);
    const res = await fetchWithRetry(impl, "u", {}, liveSignal(), { maxAttempts: 2, sleep: async () => {} });
    expect(res).toBeNull();
    expect(calls()).toBe(2);
  });

  test("honors a numeric Retry-After header (seconds -> ms), capped at maxDelayMs", async () => {
    const delays: number[] = [];
    const { impl } = scriptedFetch([status(429, { "retry-after": "1" }), ok()]);
    await fetchWithRetry(impl, "u", {}, liveSignal(), { maxDelayMs: 2_000, sleep: async (ms) => void delays.push(ms) });
    expect(delays[0]).toBe(1_000);
  });

  test("an abort during backoff stops the retries (throws, no further fetch)", async () => {
    const controller = new AbortController();
    const { impl, calls } = scriptedFetch([status(500)]);
    await expect(
      fetchWithRetry(impl, "u", {}, controller.signal, {
        maxAttempts: 5,
        // Simulate the budget elapsing mid-sleep: abort, then wake.
        sleep: async () => {
          controller.abort();
        },
      }),
    ).rejects.toThrow();
    expect(calls()).toBe(1); // aborted before a second fetch
  });

  test("an already-aborted signal throws before any fetch", async () => {
    const controller = new AbortController();
    controller.abort();
    const { impl, calls } = scriptedFetch([ok()]);
    await expect(fetchWithRetry(impl, "u", {}, controller.signal, { sleep: async () => {} })).rejects.toThrow();
    expect(calls()).toBe(0);
  });
});

// --- cerebrasCopyModel (default production model, global fetch overridden) -------

describe("cerebrasCopyModel", () => {
  const savedFetch = globalThis.fetch;
  const savedKey = process.env.CEREBRAS_API_KEY;

  afterEach(() => {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) {
      delete process.env.CEREBRAS_API_KEY;
    } else {
      process.env.CEREBRAS_API_KEY = savedKey;
    }
  });

  const request = {
    prompt: "a pomodoro timer",
    summary: "a timer",
    backend: "native" as const,
    callsign: null,
    mocks: ["native"],
  };

  test("returns null with no API key configured (no network touched)", async () => {
    delete process.env.CEREBRAS_API_KEY;
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    expect(await cerebrasCopyModel(request, new AbortController().signal)).toBeNull();
    expect(fetched).toBe(false);
  });

  test("parses a well-formed chat completion into partial copy", async () => {
    process.env.CEREBRAS_API_KEY = "test-key";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: '{"tagline":"Yell timer","concept":["shouts"]}' } }] }),
        { status: 200 },
      )) as unknown as typeof fetch;
    expect(await cerebrasCopyModel(request, new AbortController().signal)).toEqual({
      tagline: "Yell timer",
      concept: ["shouts"],
    });
  });

  test("returns null on a non-retryable HTTP error", async () => {
    process.env.CEREBRAS_API_KEY = "test-key";
    globalThis.fetch = (async () => new Response(null, { status: 401 })) as unknown as typeof fetch;
    expect(await cerebrasCopyModel(request, new AbortController().signal)).toBeNull();
  });

  test("retries a transient 429 through the real retry path, then parses the 200", async () => {
    process.env.CEREBRAS_API_KEY = "test-key";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        // First hit rate-limits; a tiny Retry-After keeps the real backoff bounded.
        return new Response(null, { status: 429, headers: { "retry-after": "0" } });
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"tagline":"After the retry","concept":["ok"]}' } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const copy = await cerebrasCopyModel(request, new AbortController().signal);
    expect(copy).toEqual({ tagline: "After the retry", concept: ["ok"] });
    expect(calls).toBe(2); // one retry, then success — the production path is wired to fetchWithRetry
  });

  test("gives up (null) after retrying persistent 5xx, without throwing", async () => {
    process.env.CEREBRAS_API_KEY = "test-key";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(null, { status: 503, headers: { "retry-after": "0" } });
    }) as unknown as typeof fetch;
    expect(await cerebrasCopyModel(request, new AbortController().signal)).toBeNull();
    expect(calls).toBeGreaterThan(1); // it retried before giving up
  });
});
