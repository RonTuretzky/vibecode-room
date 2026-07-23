// Self-contained slideshow HTML template. Pure string rendering: slides in,
// ONE complete projector-ready HTML document out — inline CSS, a small inline
// vanilla-JS deck controller, no external URLs, no web fonts, no frameworks.
// Everything user-influenced (titles, copy, code excerpts) is escaped here so
// callers never handle HTML. Palette + font stack match the house prototype
// pages (see src/server/idea-builder.ts) so wall projections feel like one app.

// One highlighted code excerpt shown on the "key files" slide.
export interface SlideCode {
  file: string; // display path, relative to the build dir
  excerpt: string; // RAW text — escaped + highlighted at render time
}

// One slide. Every field is optional except the headline pair; the template
// renders only what is present, in a fixed order: quote, paragraphs, bullets,
// code excerpts.
export interface Slide {
  kicker: string; // small eyebrow label above the headline
  title: string; // the big projector headline
  quote?: string; // rendered as a large blockquote (the verbatim spoken idea)
  paragraphs?: readonly string[];
  bullets?: readonly string[];
  code?: readonly SlideCode[];
}

export interface SlideshowTemplateOptions {
  title: string; // document <title> and deck heading
  footer: string; // persistent footer line, e.g. "upid-3 · smithers · falcon"
  slides: readonly Slide[];
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

// Words worth tinting in JS/TS/CSS-ish excerpts. Cosmetic only — this is a
// slideshow highlight, not a parser. Applied to already-escaped text.
const KEYWORD_PATTERN =
  /\b(const|let|var|function|return|if|else|for|while|import|export|from|class|new|async|await|try|catch|document|window)\b/gu;

// An escaped opening/closing tag: `&lt;` optionally followed by `/`, then a
// tag name. Runs AFTER keyword tinting; the keyword pass never emits `&lt;`,
// so the two passes cannot corrupt each other's markup.
const TAG_PATTERN = /(&lt;\/?)([a-zA-Z][\w-]*)/gu;

// Escape + line-by-line tint of a code excerpt. Whole-line comments get the
// comment tone; other lines get keyword + tag tones. Deterministic, no network.
export function highlightExcerpt(excerpt: string): string {
  return excerpt
    .split("\n")
    .map((line) => {
      const escaped = escapeHtml(line);
      const trimmed = line.trim();
      if (
        trimmed.startsWith("//") ||
        trimmed.startsWith("/*") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("<!--")
      ) {
        return `<span class="tok-comment">${escaped}</span>`;
      }
      return escaped
        .replace(KEYWORD_PATTERN, '<span class="tok-keyword">$1</span>')
        .replace(TAG_PATTERN, '$1<span class="tok-tag">$2</span>');
    })
    .join("\n");
}

function renderSlide(slide: Slide, index: number, total: number): string {
  const parts: string[] = [];
  parts.push(`      <p class="kicker">${escapeHtml(slide.kicker)}</p>`);
  parts.push(`      <h1 class="headline">${escapeHtml(slide.title)}</h1>`);
  if (slide.quote !== undefined && slide.quote.trim().length > 0) {
    parts.push(`      <blockquote class="quote">“${escapeHtml(slide.quote)}”</blockquote>`);
  }
  for (const paragraph of slide.paragraphs ?? []) {
    parts.push(`      <p class="para">${escapeHtml(paragraph)}</p>`);
  }
  const bullets = slide.bullets ?? [];
  if (bullets.length > 0) {
    const items = bullets.map((bullet) => `        <li>${escapeHtml(bullet)}</li>`).join("\n");
    parts.push(`      <ul class="points">\n${items}\n      </ul>`);
  }
  const code = slide.code ?? [];
  if (code.length > 0) {
    const figures = code
      .map(
        (entry) =>
          `        <figure class="code"><figcaption>${escapeHtml(entry.file)}</figcaption>` +
          `<pre><code>${highlightExcerpt(entry.excerpt)}</code></pre></figure>`,
      )
      .join("\n");
    parts.push(`      <div class="files">\n${figures}\n      </div>`);
  }
  const active = index === 0 ? " active" : "";
  return [
    `    <section class="slide${active}" data-slide aria-label="Slide ${index + 1} of ${total}">`,
    parts.join("\n"),
    "    </section>",
  ].join("\n");
}

// The deck controller. Fully static (no interpolation, so no injection surface):
// arrow keys / space / PageUp+Down / Home+End, click-right = next + click-left =
// prev, clickable dots, a live counter, and #N hash sync so refresh keeps place.
const DECK_SCRIPT = `(function () {
  "use strict";
  var slides = Array.prototype.slice.call(document.querySelectorAll("[data-slide]"));
  var dots = Array.prototype.slice.call(document.querySelectorAll("[data-dot]"));
  var counter = document.querySelector("[data-counter]");
  var index = 0;
  var fromHash = parseInt((location.hash || "").replace("#", ""), 10);
  if (!isNaN(fromHash) && fromHash >= 1 && fromHash <= slides.length) {
    index = fromHash - 1;
  }
  function show(next) {
    if (slides.length === 0) {
      return;
    }
    index = Math.max(0, Math.min(slides.length - 1, next));
    for (var i = 0; i < slides.length; i++) {
      slides[i].classList.toggle("active", i === index);
    }
    for (var j = 0; j < dots.length; j++) {
      dots[j].classList.toggle("active", j === index);
    }
    if (counter) {
      counter.textContent = (index + 1) + " / " + slides.length;
    }
    if (history.replaceState) {
      history.replaceState(null, "", "#" + (index + 1));
    }
  }
  document.addEventListener("keydown", function (event) {
    if (event.key === "ArrowRight" || event.key === " " || event.key === "PageDown" || event.key === "Enter") {
      event.preventDefault();
      show(index + 1);
    } else if (event.key === "ArrowLeft" || event.key === "PageUp" || event.key === "Backspace") {
      event.preventDefault();
      show(index - 1);
    } else if (event.key === "Home") {
      show(0);
    } else if (event.key === "End") {
      show(slides.length - 1);
    }
  });
  document.addEventListener("click", function (event) {
    var target = event.target;
    while (target && target !== document.body) {
      if (target.tagName === "A" || (target.hasAttribute && target.hasAttribute("data-dot"))) {
        return;
      }
      target = target.parentElement;
    }
    if (event.clientX < window.innerWidth * 0.3) {
      show(index - 1);
    } else {
      show(index + 1);
    }
  });
  for (var d = 0; d < dots.length; d++) {
    (function (i) {
      dots[i].addEventListener("click", function () {
        show(i);
      });
    })(d);
  }
  show(index);
})();`;

const DECK_STYLE = `:root {
  color-scheme: dark;
  --bg: #05070d;
  --fg: #e6f0ff;
  --accent: #5ad1ff;
  --muted: #8aa0c0;
  --line: rgba(90, 209, 255, 0.18);
  --wash: rgba(90, 209, 255, 0.06);
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  overflow: hidden;
  background: radial-gradient(circle at 50% 0%, #0b1426, var(--bg) 70%);
  color: var(--fg);
  font: 18px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  cursor: pointer;
  user-select: none;
}
.slide {
  position: fixed;
  inset: 0 0 4rem 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 4vh 7vw;
  overflow: hidden;
  opacity: 0;
  visibility: hidden;
  transform: translateY(10px);
  transition: opacity 220ms ease, transform 220ms ease, visibility 220ms;
}
.slide.active { opacity: 1; visibility: visible; transform: none; }
.kicker {
  text-transform: uppercase;
  letter-spacing: 0.22em;
  font-size: clamp(0.8rem, 1.4vw, 1.1rem);
  color: var(--accent);
  margin: 0 0 0.8rem;
}
.headline {
  font-size: clamp(2rem, 5.2vw, 4.2rem);
  line-height: 1.08;
  margin: 0 0 1.4rem;
  max-width: 22ch;
}
.quote {
  font-size: clamp(1.3rem, 2.8vw, 2.2rem);
  line-height: 1.35;
  color: var(--fg);
  border-left: 4px solid var(--accent);
  background: var(--wash);
  border-radius: 0 14px 14px 0;
  margin: 0 0 1.4rem;
  padding: 1.2rem 1.6rem;
  max-width: 42ch;
}
.para {
  font-size: clamp(1.1rem, 2.2vw, 1.7rem);
  color: var(--fg);
  margin: 0 0 1rem;
  max-width: 52ch;
}
.points {
  margin: 0.2rem 0 0;
  padding: 0;
  list-style: none;
  max-width: 56ch;
}
.points li {
  font-size: clamp(1.05rem, 2vw, 1.6rem);
  margin: 0 0 0.85rem;
  padding-left: 1.5em;
  position: relative;
}
.points li::before {
  content: "\\2192";
  position: absolute;
  left: 0;
  color: var(--accent);
}
.files {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 1rem;
  align-items: start;
  max-height: 62vh;
  overflow: hidden;
}
.code {
  margin: 0;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--wash);
  overflow: hidden;
}
.code figcaption {
  font-size: 0.85rem;
  letter-spacing: 0.08em;
  color: var(--accent);
  padding: 0.5rem 0.9rem;
  border-bottom: 1px solid var(--line);
}
.code pre {
  margin: 0;
  padding: 0.8rem 0.9rem;
  overflow: hidden;
  font: 0.95rem/1.5 ui-monospace, "SF Mono", Menlo, monospace;
  color: var(--muted);
  white-space: pre;
}
.tok-keyword { color: var(--accent); }
.tok-tag { color: #9dffb0; }
.tok-comment { color: #5c708c; font-style: italic; }
.deckbar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  height: 4rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0 2rem;
  border-top: 1px solid var(--line);
  background: rgba(5, 7, 13, 0.85);
  font-size: 0.85rem;
  color: var(--muted);
}
.deckbar .dots { display: flex; gap: 0.55rem; }
.dot {
  width: 0.65rem;
  height: 0.65rem;
  border-radius: 50%;
  border: 1px solid var(--accent);
  background: transparent;
  padding: 0;
  cursor: pointer;
}
.dot.active { background: var(--accent); }
.counter { color: var(--accent); min-width: 4ch; text-align: right; }`;

// Render the complete, self-contained slideshow document.
export function renderSlideshowHtml(options: SlideshowTemplateOptions): string {
  const total = options.slides.length;
  const sections = options.slides.map((slide, index) => renderSlide(slide, index, total)).join("\n");
  const dots = options.slides
    .map(
      (_slide, index) =>
        `        <button class="dot${index === 0 ? " active" : ""}" data-dot type="button" aria-label="Go to slide ${index + 1}"></button>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(options.title)}</title>
    <style>
${DECK_STYLE}
    </style>
  </head>
  <body>
${sections}
    <footer class="deckbar">
      <span class="foot" data-testid="slideshow-footer">${escapeHtml(options.footer)}</span>
      <span class="dots">
${dots}
      </span>
      <span class="counter" data-counter>1 / ${total}</span>
    </footer>
    <script>
${DECK_SCRIPT}
    </script>
  </body>
</html>
`;
}
