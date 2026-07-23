import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  buildSlides,
  fallbackCopy,
  generateSlideshow,
  ideaTitle,
  mergeCopy,
  parseModelCopy,
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

// --- fallbackCopy --------------------------------------------------------------

describe("fallbackCopy", () => {
  const base: GenerateSlideshowInput = {
    upid: "upid-3",
    prompt: "a tip calculator",
    callsign: null,
    backend: "native",
    outDir: "/tmp/whatever",
    summary: "built it",
  };

  test("produces every required field, non-empty", () => {
    const copy = fallbackCopy(base);
    expect(copy.tagline.length).toBeGreaterThan(0);
    expect(copy.whatWasBuilt.length).toBeGreaterThan(0);
    expect(copy.howItWorks.length).toBeGreaterThan(0);
    expect(copy.demoSteps.length).toBeGreaterThan(0);
    expect(copy.nextSteps.length).toBeGreaterThan(0);
  });

  test("mentions the backend id in howItWorks", () => {
    const copy = fallbackCopy({ ...base, backend: "smithers" });
    expect(copy.howItWorks.some((line) => line.includes("smithers"))).toBe(true);
  });

  test("demo steps reference generic steering when there is no callsign", () => {
    const copy = fallbackCopy({ ...base, callsign: null });
    expect(copy.demoSteps.some((line) => line.toLowerCase().includes('say "steer it'))).toBe(true);
  });

  test("demo steps use the callsign when present", () => {
    const copy = fallbackCopy({ ...base, callsign: "falcon" });
    expect(copy.demoSteps.some((line) => line.includes("steer falcon"))).toBe(true);
  });

  test("blank callsign is treated the same as no callsign", () => {
    const copy = fallbackCopy({ ...base, callsign: "   " });
    expect(copy.demoSteps.some((line) => line.toLowerCase().includes('say "steer it'))).toBe(true);
  });
});

// --- mergeCopy -----------------------------------------------------------------

describe("mergeCopy", () => {
  const fallback: SlideshowCopy = {
    tagline: "fallback tagline",
    whatWasBuilt: ["fallback built"],
    howItWorks: ["fallback works"],
    demoSteps: ["fallback demo"],
    nextSteps: ["fallback next"],
  };

  test("non-object raw returns the fallback verbatim and usedModel false", () => {
    expect(mergeCopy(null, fallback)).toEqual({ copy: fallback, usedModel: false });
    expect(mergeCopy("garbage", fallback)).toEqual({ copy: fallback, usedModel: false });
    expect(mergeCopy([1, 2, 3], fallback)).toEqual({ copy: fallback, usedModel: false });
  });

  test("a fully valid object overrides every field and flips usedModel", () => {
    const raw = {
      tagline: "model tagline",
      whatWasBuilt: ["a", "b"],
      howItWorks: ["c"],
      demoSteps: ["d", "e"],
      nextSteps: ["f"],
    };
    const { copy, usedModel } = mergeCopy(raw, fallback);
    expect(usedModel).toBe(true);
    expect(copy).toEqual({
      tagline: "model tagline",
      whatWasBuilt: ["a", "b"],
      howItWorks: ["c"],
      demoSteps: ["d", "e"],
      nextSteps: ["f"],
    });
  });

  test("partial output merges field-by-field over the fallback", () => {
    const { copy, usedModel } = mergeCopy({ tagline: "only tagline" }, fallback);
    expect(usedModel).toBe(true);
    expect(copy.tagline).toBe("only tagline");
    expect(copy.whatWasBuilt).toEqual(fallback.whatWasBuilt);
  });

  test("empty-string tagline and empty arrays are rejected as garbage", () => {
    const { copy, usedModel } = mergeCopy({ tagline: "   ", whatWasBuilt: [] }, fallback);
    expect(usedModel).toBe(false);
    expect(copy).toEqual(fallback);
  });

  test("wrong-typed fields are ignored while valid sibling fields still apply", () => {
    const { copy, usedModel } = mergeCopy({ tagline: 42, whatWasBuilt: ["ok"] }, fallback);
    expect(usedModel).toBe(true);
    expect(copy.tagline).toBe(fallback.tagline);
    expect(copy.whatWasBuilt).toEqual(["ok"]);
  });

  test("caps line count and trims/collapses whitespace per line", () => {
    const many = Array.from({ length: 20 }, (_, i) => `  line   ${i}  `);
    const { copy } = mergeCopy({ nextSteps: many }, fallback);
    expect(copy.nextSteps.length).toBeLessThanOrEqual(6);
    expect(copy.nextSteps[0]).toBe("line 0");
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

  test("returns null for unparseable content", () => {
    expect(parseModelCopy("not json at all")).toBeNull();
    expect(parseModelCopy("")).toBeNull();
  });

  test("returns null for a JSON array (not a record)", () => {
    expect(parseModelCopy("[1,2,3]")).toBeNull();
  });
});

// --- buildSlides -----------------------------------------------------------------

describe("buildSlides", () => {
  const input: GenerateSlideshowInput = {
    upid: "upid-3",
    prompt: "  build me a tip calculator  ",
    callsign: "falcon",
    backend: "native",
    outDir: "/tmp/x",
    summary: "A working tip calculator.",
  };
  const copy: SlideshowCopy = {
    tagline: "Tip calculator",
    whatWasBuilt: ["built one"],
    howItWorks: ["works somehow"],
    demoSteps: ["click it"],
    nextSteps: ["ship it"],
  };

  test("produces exactly 6 slides in the specified order", () => {
    const slides = buildSlides(input, copy, []);
    expect(slides).toHaveLength(6);
    expect(slides.map((s) => s.kicker)).toEqual([
      "Spoken in the room",
      "What was built",
      "How it works",
      "Key files",
      "Demo it",
      "Next steps",
    ]);
  });

  test("slide 1 shows the verbatim spoken idea as a quote plus callsign+upid", () => {
    const [first] = buildSlides(input, copy, []);
    expect(first!.quote).toBe("build me a tip calculator");
    expect(first!.bullets).toContain("Callsign “falcon” — process upid-3");
  });

  test("slide 1 omits callsign wording when callsign is null", () => {
    const [first] = buildSlides({ ...input, callsign: null }, copy, []);
    expect(first!.bullets).toContain("Process upid-3");
  });

  test("slide 4 carries the real file excerpts, not model copy", () => {
    const excerpts = [{ file: "index.html", excerpt: "<h1>hi</h1>" }];
    const slides = buildSlides(input, copy, excerpts);
    expect(slides[3]!.code).toEqual(excerpts);
  });

  test("slide 4 explains missing excerpts instead of being empty", () => {
    const slides = buildSlides(input, copy, []);
    expect(slides[3]!.paragraphs?.[0]).toMatch(/no source files captured/iu);
  });

  test("slide 1 falls back to a placeholder when the prompt is blank", () => {
    const [first] = buildSlides({ ...input, prompt: "   " }, copy, []);
    expect(first!.quote).toBe("(no transcript captured)");
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
    prompt: "build a pomodoro timer that yells at me",
    callsign: "otter",
    backend: "native",
    outDir,
    summary: "A pomodoro timer with a yelling mascot.",
  });

  test("writes a self-contained index.html at <outDir>/slideshow/index.html", async () => {
    dir = await mkdtemp(join(tmpdir(), "slideshow-test-"));
    await writeFile(join(dir, "index.html"), "<!doctype html><html><body>hi</body></html>", "utf8");

    const noNetworkModel: SlideshowCopyModel = async () => null;
    const artifact = await generateSlideshow(baseInput(dir), { model: noNetworkModel });

    expect(artifact.indexPath).toBe(join(dir, SLIDESHOW_ENTRYPOINT));
    expect(artifact.slideCount).toBe(6);
    expect(artifact.usedModel).toBe(false);

    const html = await readFile(artifact.indexPath, "utf8");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toMatch(/https?:\/\//u);
    expect(html).toContain("build a pomodoro timer that yells at me");
  });

  test("merges a working fake model's copy into the rendered slides", async () => {
    dir = await mkdtemp(join(tmpdir(), "slideshow-test-"));
    await writeFile(join(dir, "index.html"), "<h1>Pomodoro</h1>", "utf8");

    const fakeModel: SlideshowCopyModel = async () => ({
      tagline: "The yelling pomodoro timer",
      whatWasBuilt: ["A countdown that shouts at you"],
    });
    const artifact = await generateSlideshow(baseInput(dir), { model: fakeModel });
    expect(artifact.usedModel).toBe(true);
    const html = await readFile(artifact.indexPath, "utf8");
    expect(html).toContain("The yelling pomodoro timer");
    expect(html).toContain("A countdown that shouts at you");
  });

  test("a rejecting model still produces a slideshow via the deterministic fallback", async () => {
    dir = await mkdtemp(join(tmpdir(), "slideshow-test-"));
    await writeFile(join(dir, "index.html"), "<h1>Pomodoro</h1>", "utf8");

    const throwingModel: SlideshowCopyModel = async () => {
      throw new Error("network is down");
    };
    const artifact = await generateSlideshow(baseInput(dir), { model: throwingModel });
    expect(artifact.usedModel).toBe(false);
    const html = await readFile(artifact.indexPath, "utf8");
    expect(html).toContain("otter");
  });

  test("a hanging model is bounded by timeoutMs and falls back", async () => {
    dir = await mkdtemp(join(tmpdir(), "slideshow-test-"));
    await writeFile(join(dir, "index.html"), "<h1>Pomodoro</h1>", "utf8");

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

  test("scans the build dir for candidate files when none are named, index.html first", async () => {
    dir = await mkdtemp(join(tmpdir(), "slideshow-test-"));
    await writeFile(join(dir, "index.html"), "<h1>Pomodoro</h1>", "utf8");
    await writeFile(join(dir, "app.js"), "const x = 1;", "utf8");
    await mkdir(join(dir, "styles"), { recursive: true });
    await writeFile(join(dir, "styles", "main.css"), "body { color: red; }", "utf8");

    const artifact = await generateSlideshow(baseInput(dir), { model: async () => null });
    const html = await readFile(artifact.indexPath, "utf8");
    expect(html).toContain("index.html");
    // index.html should appear before app.js in the excerpt list.
    expect(html.indexOf("index.html")).toBeLessThan(html.indexOf("app.js"));
  });

  test("a rerun never excerpts its own previously-written slideshow/ output", async () => {
    dir = await mkdtemp(join(tmpdir(), "slideshow-test-"));
    await writeFile(join(dir, "index.html"), "<h1>Pomodoro</h1>", "utf8");

    await generateSlideshow(baseInput(dir), { model: async () => null });
    // Regenerating (e.g. after a steer) must not pick slideshow/index.html back
    // up as a "key file" candidate — scanCandidateFiles skips SLIDESHOW_DIRNAME.
    const artifact = await generateSlideshow(baseInput(dir), { model: async () => null, maxFiles: 8 });
    const html = await readFile(artifact.indexPath, "utf8");
    expect(html).not.toContain("slideshow/index.html");
    expect(html).not.toContain('<figcaption>slideshow');
  });

  test("respects an explicit files list relative to outDir", async () => {
    dir = await mkdtemp(join(tmpdir(), "slideshow-test-"));
    await writeFile(join(dir, "index.html"), "<h1>Pomodoro</h1>", "utf8");
    await writeFile(join(dir, "notes.md"), "# design notes\nsome notes here", "utf8");

    const input: GenerateSlideshowInput = { ...baseInput(dir), files: ["notes.md"] };
    const artifact = await generateSlideshow(input, { model: async () => null });
    const html = await readFile(artifact.indexPath, "utf8");
    expect(html).toContain("notes.md");
    expect(html).not.toContain("index.html<");
  });

  test("a missing named file is skipped rather than throwing", async () => {
    dir = await mkdtemp(join(tmpdir(), "slideshow-test-"));
    await writeFile(join(dir, "index.html"), "<h1>Pomodoro</h1>", "utf8");
    const input: GenerateSlideshowInput = { ...baseInput(dir), files: ["does-not-exist.txt"] };
    const artifact = await generateSlideshow(input, { model: async () => null });
    expect(artifact.slideCount).toBe(6);
    const html = await readFile(artifact.indexPath, "utf8");
    expect(html).toMatch(/no source files captured/iu);
  });

  test("path traversal in an explicit files entry is refused, not thrown", async () => {
    dir = await mkdtemp(join(tmpdir(), "slideshow-test-"));
    await writeFile(join(dir, "index.html"), "<h1>Pomodoro</h1>", "utf8");
    const outsideFile = join(dir, "..", `outside-${Date.now()}.txt`);
    await writeFile(outsideFile, "secret stuff", "utf8");
    try {
      const input: GenerateSlideshowInput = { ...baseInput(dir), files: ["../" + outsideFile.split("/").pop()] };
      const artifact = await generateSlideshow(input, { model: async () => null });
      const html = await readFile(artifact.indexPath, "utf8");
      expect(html).not.toContain("secret stuff");
      expect(artifact.slideCount).toBe(6);
    } finally {
      await rm(outsideFile, { force: true });
    }
  });

  test("a binary-looking file (NUL byte) is skipped", async () => {
    dir = await mkdtemp(join(tmpdir(), "slideshow-test-"));
    await writeFile(join(dir, "index.html"), "<h1>Pomodoro</h1>", "utf8");
    await writeFile(join(dir, "blob.svg"), Buffer.from([0x00, 0x01, 0x02, 0xff]));
    const input: GenerateSlideshowInput = { ...baseInput(dir), files: ["blob.svg"] };
    const artifact = await generateSlideshow(input, { model: async () => null });
    const html = await readFile(artifact.indexPath, "utf8");
    expect(html).not.toContain("blob.svg");
  });

  test("caps the excerpt count at maxFiles", async () => {
    dir = await mkdtemp(join(tmpdir(), "slideshow-test-"));
    for (let i = 0; i < 5; i += 1) {
      await writeFile(join(dir, `page-${i}.html`), `<p>page ${i}</p>`, "utf8");
    }
    const artifact = await generateSlideshow(baseInput(dir), { model: async () => null, maxFiles: 2 });
    const html = await readFile(artifact.indexPath, "utf8");
    const figureCount = (html.match(/<figure class="code">/gu) ?? []).length;
    expect(figureCount).toBe(2);
    expect(artifact.slideCount).toBe(6);
  });

  test("runs fast with a fake model (well under the 10s budget)", async () => {
    dir = await mkdtemp(join(tmpdir(), "slideshow-test-"));
    await writeFile(join(dir, "index.html"), "<h1>Pomodoro</h1>", "utf8");
    const start = Date.now();
    await generateSlideshow(baseInput(dir), { model: async () => ({ tagline: "fast" }) });
    expect(Date.now() - start).toBeLessThan(2_000);
  });
});
