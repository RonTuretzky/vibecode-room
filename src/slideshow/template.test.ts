import { describe, expect, test } from "bun:test";
import { escapeHtml, highlightExcerpt, renderSlideshowHtml, type Slide } from "./template";

describe("escapeHtml", () => {
  test("escapes all five HTML-significant characters", () => {
    expect(escapeHtml(`<script>alert("x & 'y'")</script>`)).toBe(
      "&lt;script&gt;alert(&quot;x &amp; &#39;y&#39;&quot;)&lt;/script&gt;",
    );
  });

  test("leaves plain text untouched", () => {
    expect(escapeHtml("plain text, no markup")).toBe("plain text, no markup");
  });
});

describe("highlightExcerpt", () => {
  test("tints known keywords without corrupting escaped markup", () => {
    const out = highlightExcerpt(`const x = document.querySelector("<div>");`);
    expect(out).toContain('<span class="tok-keyword">const</span>');
    expect(out).toContain('<span class="tok-keyword">document</span>');
    // The escaped angle brackets around "div" survive intact (as the literal
    // &lt; / &gt; entities); this is a cosmetic highlighter, not a real parser,
    // so it also tags the string-literal "<div>" as a tag — documented behavior.
    expect(out).toContain("&lt;");
    expect(out).toContain("&gt;");
    expect(out).not.toMatch(/<div(?!")/u);
  });

  test("tints real escaped tags distinctly from keywords", () => {
    const out = highlightExcerpt(`<button onclick="go()">Go</button>`);
    expect(out).toContain('<span class="tok-tag">button</span>');
  });

  test("marks whole-line comments with the comment tone", () => {
    const out = highlightExcerpt("// a comment about const\n<!-- html comment -->\n* jsdoc line");
    const lines = out.split("\n");
    expect(lines[0]).toBe('<span class="tok-comment">// a comment about const</span>');
    expect(lines[1]).toBe('<span class="tok-comment">&lt;!-- html comment --&gt;</span>');
    expect(lines[2]).toBe('<span class="tok-comment">* jsdoc line</span>');
  });

  test("never emits unescaped angle brackets from arbitrary input", () => {
    const malicious = `<img src=x onerror="alert(1)">`;
    const out = highlightExcerpt(malicious);
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;");
  });
});

describe("renderSlideshowHtml", () => {
  const slides: Slide[] = [
    {
      kicker: "Spoken in the room",
      title: "A <cool> idea & more",
      quote: "build me a thing",
      bullets: ["callsign", "backend"],
    },
    {
      kicker: "What was built",
      title: "Tagline",
      paragraphs: ["A summary paragraph."],
      bullets: ["point one", "point two"],
    },
    {
      kicker: "Key files",
      title: "Inside the build",
      code: [{ file: "index.html", excerpt: "<h1>Hi</h1>" }],
    },
  ];

  test("renders one complete self-contained HTML document", () => {
    const html = renderSlideshowHtml({ title: "My Deck", footer: "upid-3 · native · falcon", slides });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>My Deck</title>");
    expect(html).toContain('data-testid="slideshow-footer">upid-3 · native · falcon<');
    // No external network resources: no http(s) URLs, no <link>, no CDN script src.
    expect(html).not.toMatch(/https?:\/\//u);
    expect(html).not.toMatch(/<link\b/u);
    expect(html).not.toMatch(/<script\s+src=/u);
  });

  test("renders one <section data-slide> per slide, first marked active", () => {
    const html = renderSlideshowHtml({ title: "Deck", footer: "f", slides });
    const sections = html.match(/<section class="slide[^"]*" data-slide/gu) ?? [];
    expect(sections).toHaveLength(3);
    expect(html).toContain('<section class="slide active" data-slide aria-label="Slide 1 of 3">');
    expect(html).toContain('aria-label="Slide 2 of 3">');
    expect(html).toContain('aria-label="Slide 3 of 3">');
  });

  test("escapes user-influenced titles, quotes, bullets, and code excerpts", () => {
    const html = renderSlideshowHtml({ title: "Deck", footer: "f", slides });
    expect(html).toContain("A &lt;cool&gt; idea &amp; more");
    expect(html).not.toContain("<cool>");
    expect(html).toContain('&lt;/<span class="tok-tag">h1</span>&gt;');
    expect(html).not.toContain("<h1>Hi</h1>");
  });

  test("renders one nav dot per slide and a 1-based counter seed", () => {
    const html = renderSlideshowHtml({ title: "Deck", footer: "f", slides });
    const dots = html.match(/<button class="dot[^"]*" data-dot/gu) ?? [];
    expect(dots).toHaveLength(3);
    expect(html).toContain('<span class="counter" data-counter>1 / 3</span>');
  });

  test("handles zero slides without throwing", () => {
    const html = renderSlideshowHtml({ title: "Empty", footer: "f", slides: [] });
    expect(html).toContain("1 / 0");
    expect(html).not.toMatch(/<section/u);
  });
});
