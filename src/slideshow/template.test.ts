import { describe, expect, test } from "bun:test";
import {
  appendTakeHomeSlide,
  escapeHtml,
  renderSlideshowHtml,
  TAKE_HOME_SLIDE_MARKER,
  type Slide,
  type SlideDecision,
  type SlideMock,
} from "./template";

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

const MOCKS: SlideMock[] = [
  { id: "smithers", label: "Smithers", src: "/preview/upid-3/smithers/", caption: "smithers · concept mock" },
  { id: "eliza", label: "ElizaOS", src: "/preview/upid-3/eliza/", caption: "eliza · concept mock" },
  { id: "native", label: "Native", src: null, caption: "native · concept mock" },
];

const DECISIONS: SlideDecision[] = [
  {
    id: "execute",
    label: "Build it for real",
    detail: "Commission the full build.",
    endpoint: "/api/process/upid-3/execute",
    confirmation: "Commissioned — watch the wall.",
    terminal: true,
  },
  {
    id: "steer",
    label: "Steer it",
    detail: "Speak or type a correction.",
    endpoint: "/api/process/upid-3/steer",
    confirmation: "Correction sent.",
    prompt: {
      hint: "Say the correction out loud — or type it and send:",
      field: "text",
      placeholder: "e.g. make it neon",
      submitLabel: "Send correction",
    },
  },
  {
    id: "dismiss",
    label: "Park it for later",
    endpoint: "/api/idea/idea-9/dismiss",
    confirmation: "Parked.",
    terminal: true,
  },
];

const PITCH_SLIDES: Slide[] = [
  {
    kicker: "Heard in the room",
    title: "The idea, verbatim",
    hero: true,
    quote: "build me a thing",
    bullets: ["Process upid-3"],
  },
  {
    kicker: "The concept",
    title: "A <cool> idea & more",
    paragraphs: ["A pitch summary paragraph."],
    bullets: ["point one", "point two"],
  },
  { kicker: "The mocks", title: "3 concept mocks, live", mocks: MOCKS },
  { kicker: "Your call", title: "How should we continue?", decisions: DECISIONS },
];

function renderPitch(): string {
  return renderSlideshowHtml({ title: "My Pitch", footer: "upid-3 · native · falcon", slides: PITCH_SLIDES });
}

describe("renderSlideshowHtml — document + deck chrome", () => {
  test("renders one complete self-contained HTML document (no external scripts/styles)", () => {
    const html = renderPitch();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>My Pitch</title>");
    expect(html).toContain('data-testid="slideshow-footer">upid-3 · native · falcon<');
    // No external network resources: no <link>, no CDN <script src>, and no
    // absolute http(s) URLs anywhere (mock srcs here are root-relative).
    expect(html).not.toMatch(/https?:\/\//u);
    expect(html).not.toMatch(/<link\b/u);
    expect(html).not.toMatch(/<script\s+src=/u);
  });

  test("renders one <section data-slide> per slide, first marked active, hero flagged", () => {
    const html = renderPitch();
    const sections = html.match(/<section class="slide[^"]*" data-slide/gu) ?? [];
    expect(sections).toHaveLength(4);
    expect(html).toContain('<section class="slide hero active" data-slide aria-label="Slide 1 of 4">');
    expect(html).toContain('aria-label="Slide 4 of 4">');
  });

  test("escapes user-influenced titles, quotes, and bullets", () => {
    const html = renderPitch();
    expect(html).toContain("A &lt;cool&gt; idea &amp; more");
    expect(html).not.toContain("<cool>");
  });

  test("renders one nav dot per slide and a 1-based counter seed", () => {
    const html = renderPitch();
    const dots = html.match(/<button class="dot[^"]*" data-dot/gu) ?? [];
    expect(dots).toHaveLength(4);
    expect(html).toContain('<span class="counter" data-counter>1 / 4</span>');
  });

  test("handles zero slides without throwing", () => {
    const html = renderSlideshowHtml({ title: "Empty", footer: "f", slides: [] });
    expect(html).toContain("1 / 0");
    expect(html).not.toMatch(/<section/u);
  });

  test("nav script never advances on interactive elements and never hijacks typing", () => {
    const html = renderPitch();
    // Click-nav guard covers buttons/forms/inputs/links/iframes…
    expect(html).toContain("INTERACTIVE = { A: 1, BUTTON: 1, INPUT: 1, TEXTAREA: 1, SELECT: 1, LABEL: 1, FORM: 1, IFRAME: 1 }");
    // …and key-nav ignores keystrokes targeted at form fields.
    expect(html).toContain('if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT")');
  });
});

describe("renderSlideshowHtml — mock gallery", () => {
  test("renders a switchable tab per mock with data-mock-tab + data-dwell", () => {
    const html = renderPitch();
    expect(html).toContain('data-mock-tab="smithers" data-dwell="mock-tab-smithers"');
    expect(html).toContain('data-mock-tab="eliza" data-dwell="mock-tab-eliza"');
    expect(html).toContain('data-mock-tab="native" data-dwell="mock-tab-native"');
    // Tabs are plain <button> elements (dwell system operates all buttons).
    const tabs = html.match(/<button class="mock-tab[^"]*" type="button" data-mock-tab/gu) ?? [];
    expect(tabs).toHaveLength(3);
  });

  test("renders one panel per mock; live lanes get an iframe, missing lanes a placeholder", () => {
    const html = renderPitch();
    expect(html).toContain('data-mock-panel="smithers"');
    expect(html).toContain('<iframe class="mock-frame" src="/preview/upid-3/smithers/"');
    expect(html).toContain('<iframe class="mock-frame" src="/preview/upid-3/eliza/"');
    // The null-src lane renders the placeholder, not an iframe.
    expect(html).toContain('<div class="mock-frame mock-missing">mock preview not ready yet</div>');
    const iframes = html.match(/<iframe /gu) ?? [];
    expect(iframes).toHaveLength(2);
  });

  test("first panel and tab start active", () => {
    const html = renderPitch();
    expect(html).toContain('class="mock-tab active"');
    expect(html).toContain('class="mock-panel active"');
  });

  test("a single mock renders its panel without a tab bar", () => {
    const html = renderSlideshowHtml({
      title: "t",
      footer: "f",
      slides: [{ kicker: "The mocks", title: "One mock", mocks: [MOCKS[0]!] }],
    });
    expect(html).not.toContain("data-mock-tabs");
    expect(html).toContain('data-mock-panel="smithers"');
  });

  test("mock srcs and captions are HTML-escaped", () => {
    const evil: SlideMock = { id: "x", label: "L", src: '"/><script>alert(1)</script>', caption: "<b>c</b>" };
    const html = renderSlideshowHtml({
      title: "t",
      footer: "f",
      slides: [{ kicker: "k", title: "t", mocks: [evil] }],
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<b>c</b>");
  });
});

describe("renderSlideshowHtml — decision slide", () => {
  test("renders each decision as a plain <button> with data-decision + data-dwell", () => {
    const html = renderPitch();
    expect(html).toContain('data-decision="execute" data-dwell="decision-execute"');
    expect(html).toContain('data-decision="steer" data-dwell="decision-steer"');
    expect(html).toContain('data-decision="dismiss" data-dwell="decision-dismiss"');
    const buttons = html.match(/<button class="decision" type="button" data-decision/gu) ?? [];
    expect(buttons).toHaveLength(3);
  });

  test("encodes the POST endpoints and confirmations on the buttons", () => {
    const html = renderPitch();
    expect(html).toContain('data-endpoint="/api/process/upid-3/execute"');
    expect(html).toContain('data-endpoint="/api/process/upid-3/steer"');
    expect(html).toContain('data-endpoint="/api/idea/idea-9/dismiss"');
    expect(html).toContain('data-confirmation="Commissioned — watch the wall."');
  });

  test("execute and dismiss are terminal; steer opens the typed-fallback form instead", () => {
    const html = renderPitch();
    expect(html).toMatch(/data-decision="execute"[^>]*data-terminal="1"/u);
    expect(html).toMatch(/data-decision="dismiss"[^>]*data-terminal="1"/u);
    expect(html).toMatch(/data-decision="steer"[^>]*data-prompt="1"/u);
    expect(html).not.toMatch(/data-decision="steer"[^>]*data-terminal/u);
  });

  test("renders the steer typed-fallback form, hidden, with field + endpoint + submit button", () => {
    const html = renderPitch();
    expect(html).toContain('data-decision-form="steer"');
    expect(html).toMatch(/data-decision-form="steer"[^>]*data-endpoint="\/api\/process\/upid-3\/steer"/u);
    expect(html).toMatch(/data-decision-form="steer"[^>]*data-field="text"/u);
    expect(html).toMatch(/data-decision-form="steer"[^>]*hidden/u);
    expect(html).toContain('data-decision-input type="text"');
    expect(html).toContain('data-dwell="decision-steer-send"');
    expect(html).toContain("Say the correction out loud — or type it and send:");
  });

  test("renders a live decision-status line for confirmations", () => {
    const html = renderPitch();
    expect(html).toContain('data-decision-status role="status" aria-live="polite"');
  });

  test("the deck script POSTs decision endpoints with a JSON content-type", () => {
    const html = renderPitch();
    expect(html).toContain('method: "POST"');
    expect(html).toContain('"content-type": "application/json"');
  });

  test("decision labels, endpoints, and confirmations are HTML-escaped", () => {
    const evil: SlideDecision = {
      id: "x",
      label: '<img src=x onerror="alert(1)">',
      endpoint: '/api/x" onmouseover="alert(1)',
      confirmation: "<b>done</b>",
    };
    const html = renderSlideshowHtml({
      title: "t",
      footer: "f",
      slides: [{ kicker: "k", title: "t", decisions: [evil] }],
    });
    expect(html).not.toContain("<img");
    expect(html).not.toContain('" onmouseover="');
    expect(html).not.toContain("<b>done</b>");
  });
});

describe("appendTakeHomeSlide", () => {
  const QR = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 37 37"><path d="M0 0"/></svg>';
  const URL = "https://roomtester.github.io/snow-sip-calculator/";
  const baseDeck = () =>
    renderSlideshowHtml({
      title: "Snow — pitch",
      footer: "upid-1 · native",
      slides: [
        { kicker: "k1", title: "one" },
        { kicker: "k2", title: "two" },
      ],
    });

  test("appends a final QR slide + nav dot before the deck bar", () => {
    const out = appendTakeHomeSlide(baseDeck(), { url: URL, qrSvg: QR });
    expect(out).toContain(TAKE_HOME_SLIDE_MARKER);
    expect(out).toContain(QR);
    expect(out).toContain(`href="${URL}"`);
    // The new section sits BEFORE the deck bar, so it is the last slide.
    const sectionAt = out.indexOf(TAKE_HOME_SLIDE_MARKER);
    const footerAt = out.indexOf('<footer class="deckbar">');
    expect(sectionAt).toBeGreaterThan(-1);
    expect(sectionAt).toBeLessThan(footerAt);
    // One more slide section and one more dot than the base deck.
    const count = (html: string, needle: string) => html.split(needle).length - 1;
    expect(count(out, "data-slide")).toBe(count(baseDeck(), "data-slide") + 1);
    expect(count(out, "data-dot")).toBe(count(baseDeck(), "data-dot") + 1);
  });

  test("is idempotent — a deck never accumulates duplicate take-home slides", () => {
    const once = appendTakeHomeSlide(baseDeck(), { url: URL, qrSvg: QR });
    const twice = appendTakeHomeSlide(once, { url: URL, qrSvg: QR });
    expect(twice).toBe(once);
  });

  test("the Pages URL is HTML-escaped; a non-deck document passes through untouched", () => {
    const out = appendTakeHomeSlide(baseDeck(), { url: 'https://x.test/"><script>', qrSvg: QR });
    expect(out).not.toContain('href="https://x.test/"><script>');
    expect(out).toContain("&quot;&gt;&lt;script&gt;");
    expect(appendTakeHomeSlide("<html><body>not a deck</body></html>", { url: URL, qrSvg: QR })).toBe(
      "<html><body>not a deck</body></html>",
    );
  });
});
