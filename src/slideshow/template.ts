// Self-contained pitch-deck HTML template. Pure string rendering: slides in,
// ONE complete projector-ready HTML document out — inline CSS, a small inline
// vanilla-JS deck controller, no external scripts/styles, no web fonts, no
// frameworks. Everything user-influenced (titles, copy, URLs) is escaped here
// so callers never handle HTML. Palette + font stack match the house prototype
// pages (see src/server/idea-builder.ts) so wall projections feel like one app.
//
// Interactivity contract (the room's dwell system + plain clicks):
// - Every actionable control is a plain <button> with a data-dwell attribute,
//   so the gesture wall's dwell selector ("button:not(:disabled), [data-dwell]")
//   picks it up and its synthesized .click() drives the same code path a mouse
//   click does. Nothing here requires hover, drag, or keyboard.
// - Mock gallery: button.mock-tab[data-mock-tab=<id>] switches [data-mock-panel=<id>].
// - Decisions: button.decision[data-decision=<id>] POSTs its data-endpoint
//   (JSON body {}), or — when data-prompt="1" — reveals the typed-fallback
//   form[data-decision-form=<id>] whose submit POSTs {<data-field>: text}.
//   Results land in [data-decision-status].

// One switchable concept-mock panel on the mocks slide.
export interface SlideMock {
  id: string; // stable panel id (backend id) used in data-mock-tab / data-mock-panel
  label: string; // tab label, e.g. "Smithers"
  src: string | null; // iframe URL for the live mock; null renders a placeholder panel
  caption?: string; // small line under the frame
}

// The typed fallback for a spoken decision (the steer button): activating the
// decision reveals a small form instead of POSTing immediately.
export interface SlideDecisionPrompt {
  hint: string; // e.g. "Say the correction out loud — or type it and send:"
  field: string; // JSON body key the typed text is sent under, e.g. "text"
  placeholder: string;
  submitLabel: string;
}

// One large decision button on the closing slide.
export interface SlideDecision {
  id: string; // "execute" | "steer" | "dismiss" (template stays generic)
  label: string; // the big button label
  detail?: string; // supporting line inside the button
  endpoint: string; // same-origin POST target, e.g. /api/process/upid-3/execute
  confirmation: string; // status line shown after a successful POST
  terminal?: boolean; // success disables the whole decision group (execute/dismiss)
  prompt?: SlideDecisionPrompt; // present => typed-fallback form before POSTing
}

// One slide. Every field is optional except the headline pair; the template
// renders only what is present, in a fixed order: quote, paragraphs, bullets,
// mock gallery, decision group.
export interface Slide {
  kicker: string; // small eyebrow label above the headline
  title: string; // the big projector headline
  hero?: boolean; // big-type variant (slide 1: the verbatim idea)
  quote?: string; // rendered as a large blockquote (the verbatim spoken idea)
  paragraphs?: readonly string[];
  bullets?: readonly string[];
  mocks?: readonly SlideMock[];
  decisions?: readonly SlideDecision[];
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

function renderMocks(mocks: readonly SlideMock[]): string {
  const parts: string[] = ['      <div class="mocks" data-mocks>'];
  if (mocks.length > 1) {
    const tabs = mocks
      .map(
        (mock, index) =>
          `          <button class="mock-tab${index === 0 ? " active" : ""}" type="button" ` +
          `data-mock-tab="${escapeHtml(mock.id)}" data-dwell="mock-tab-${escapeHtml(mock.id)}" ` +
          `aria-label="Show the ${escapeHtml(mock.label)} mock">${escapeHtml(mock.label)}</button>`,
      )
      .join("\n");
    parts.push('        <div class="mock-tabs" role="tablist" data-mock-tabs>');
    parts.push(tabs);
    parts.push("        </div>");
  }
  const panels = mocks
    .map((mock, index) => {
      const frame =
        mock.src === null
          ? '<div class="mock-frame mock-missing">mock preview not ready yet</div>'
          : `<iframe class="mock-frame" src="${escapeHtml(mock.src)}" ` +
            `title="${escapeHtml(mock.label)} concept mock" loading="lazy"></iframe>`;
      const caption =
        mock.caption === undefined
          ? ""
          : `<p class="mock-caption">${escapeHtml(mock.caption)}</p>`;
      return (
        `          <div class="mock-panel${index === 0 ? " active" : ""}" ` +
        `data-mock-panel="${escapeHtml(mock.id)}">${frame}${caption}</div>`
      );
    })
    .join("\n");
  parts.push('        <div class="mock-panels">');
  parts.push(panels);
  parts.push("        </div>");
  parts.push("      </div>");
  return parts.join("\n");
}

function renderDecisions(decisions: readonly SlideDecision[]): string {
  const parts: string[] = ['      <div class="decisions" data-decisions>'];
  for (const decision of decisions) {
    const attrs = [
      'class="decision"',
      'type="button"',
      `data-decision="${escapeHtml(decision.id)}"`,
      `data-dwell="decision-${escapeHtml(decision.id)}"`,
      `data-endpoint="${escapeHtml(decision.endpoint)}"`,
      `data-confirmation="${escapeHtml(decision.confirmation)}"`,
    ];
    if (decision.terminal === true) {
      attrs.push('data-terminal="1"');
    }
    if (decision.prompt !== undefined) {
      attrs.push('data-prompt="1"');
    }
    const detail =
      decision.detail === undefined
        ? ""
        : `<span class="decision-detail">${escapeHtml(decision.detail)}</span>`;
    parts.push(
      `        <button ${attrs.join(" ")}>` +
        `<span class="decision-label">${escapeHtml(decision.label)}</span>${detail}</button>`,
    );
  }
  parts.push("      </div>");
  for (const decision of decisions) {
    if (decision.prompt === undefined) {
      continue;
    }
    parts.push(
      `      <form class="decision-form" data-decision-form="${escapeHtml(decision.id)}" ` +
        `data-endpoint="${escapeHtml(decision.endpoint)}" data-field="${escapeHtml(decision.prompt.field)}" ` +
        `data-confirmation="${escapeHtml(decision.confirmation)}" hidden>` +
        `<p class="decision-hint">${escapeHtml(decision.prompt.hint)}</p>` +
        `<input class="decision-input" data-decision-input type="text" ` +
        `placeholder="${escapeHtml(decision.prompt.placeholder)}" />` +
        `<button class="decision-send" type="submit" data-dwell="decision-${escapeHtml(decision.id)}-send">` +
        `${escapeHtml(decision.prompt.submitLabel)}</button></form>`,
    );
  }
  parts.push(
    '      <p class="decision-status" data-decision-status role="status" aria-live="polite"></p>',
  );
  return parts.join("\n");
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
  const mocks = slide.mocks ?? [];
  if (mocks.length > 0) {
    parts.push(renderMocks(mocks));
  }
  const decisions = slide.decisions ?? [];
  if (decisions.length > 0) {
    parts.push(renderDecisions(decisions));
  }
  const classes = ["slide"];
  if (slide.hero === true) {
    classes.push("hero");
  }
  if (index === 0) {
    classes.push("active");
  }
  return [
    `    <section class="${classes.join(" ")}" data-slide aria-label="Slide ${index + 1} of ${total}">`,
    parts.join("\n"),
    "    </section>",
  ].join("\n");
}

// The deck controller. Fully static (no interpolation, so no injection surface).
// Navigation: arrow keys / space / PageUp+Down / Home+End, click-right = next +
// click-left = prev, clickable dots, a live counter, and #N hash sync so refresh
// keeps place. Clicks on interactive elements (buttons, links, the steer form)
// NEVER advance slides, and typing in an input never triggers key nav.
// Interactivity: mock-tab switching, and decision buttons that POST their
// data-endpoint (with the steer button's typed-fallback form).
const DECK_SCRIPT = `(function () {
  "use strict";
  var slides = Array.prototype.slice.call(document.querySelectorAll("[data-slide]"));
  var dots = Array.prototype.slice.call(document.querySelectorAll("[data-dot]"));
  var counter = document.querySelector("[data-counter]");
  var statusEl = document.querySelector("[data-decision-status]");
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
  function closest(node, test) {
    while (node && node !== document.body) {
      if (test(node)) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }
  var INTERACTIVE = { A: 1, BUTTON: 1, INPUT: 1, TEXTAREA: 1, SELECT: 1, LABEL: 1, FORM: 1, IFRAME: 1 };
  document.addEventListener("keydown", function (event) {
    var tag = event.target && event.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      return;
    }
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
  function setStatus(text, ok) {
    if (statusEl) {
      statusEl.textContent = text;
      statusEl.classList.toggle("ok", !!ok);
    }
  }
  function send(endpoint, body, confirmation, terminalButton) {
    setStatus("Sending…", false);
    fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {})
    }).then(function (response) {
      if (response.ok) {
        setStatus(confirmation, true);
        if (terminalButton) {
          var all = document.querySelectorAll("[data-decision]");
          for (var i = 0; i < all.length; i++) {
            all[i].disabled = true;
            all[i].classList.toggle("chosen", all[i] === terminalButton);
          }
        }
      } else {
        setStatus("The room said no (HTTP " + response.status + ") — try again.", false);
      }
    }, function () {
      setStatus("Could not reach the room — is the server running?", false);
    });
  }
  document.addEventListener("click", function (event) {
    var tab = closest(event.target, function (node) {
      return node.hasAttribute && node.hasAttribute("data-mock-tab");
    });
    if (tab) {
      var mockId = tab.getAttribute("data-mock-tab");
      var root = closest(tab, function (node) {
        return node.hasAttribute && node.hasAttribute("data-mocks");
      });
      if (root) {
        var tabs = root.querySelectorAll("[data-mock-tab]");
        for (var t = 0; t < tabs.length; t++) {
          tabs[t].classList.toggle("active", tabs[t] === tab);
        }
        var panels = root.querySelectorAll("[data-mock-panel]");
        for (var p = 0; p < panels.length; p++) {
          panels[p].classList.toggle("active", panels[p].getAttribute("data-mock-panel") === mockId);
        }
      }
      return;
    }
    var decision = closest(event.target, function (node) {
      return node.hasAttribute && node.hasAttribute("data-decision");
    });
    if (decision && !decision.disabled) {
      if (decision.getAttribute("data-prompt") === "1") {
        var form = document.querySelector('[data-decision-form="' + decision.getAttribute("data-decision") + '"]');
        if (form) {
          form.hidden = !form.hidden;
          if (!form.hidden) {
            var promptInput = form.querySelector("[data-decision-input]");
            if (promptInput) {
              promptInput.focus();
            }
          }
        }
      } else {
        send(
          decision.getAttribute("data-endpoint"),
          {},
          decision.getAttribute("data-confirmation"),
          decision.getAttribute("data-terminal") === "1" ? decision : null
        );
      }
      return;
    }
    if (closest(event.target, function (node) { return INTERACTIVE[node.tagName] === 1; })) {
      return;
    }
    if (event.clientX < window.innerWidth * 0.3) {
      show(index - 1);
    } else {
      show(index + 1);
    }
  });
  document.addEventListener("submit", function (event) {
    var form = event.target;
    if (!form.hasAttribute || !form.hasAttribute("data-decision-form")) {
      return;
    }
    event.preventDefault();
    var input = form.querySelector("[data-decision-input]");
    var text = input ? input.value.trim() : "";
    if (text.length === 0) {
      setStatus("Type a correction first — or just say it out loud.", false);
      return;
    }
    var body = {};
    body[form.getAttribute("data-field") || "text"] = text;
    send(form.getAttribute("data-endpoint"), body, form.getAttribute("data-confirmation"), null);
    form.hidden = true;
    if (input) {
      input.value = "";
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
  --ok: #9dffb0;
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
.hero .headline { font-size: clamp(1.4rem, 2.6vw, 2rem); color: var(--muted); }
.hero .quote {
  font-size: clamp(2.2rem, 5.4vw, 4.4rem);
  line-height: 1.18;
  border-left-width: 6px;
  max-width: 30ch;
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
.mocks { display: flex; flex-direction: column; gap: 0.9rem; min-height: 0; }
.mock-tabs { display: flex; gap: 0.9rem; flex-wrap: wrap; }
.mock-tab {
  font: inherit;
  font-size: clamp(1rem, 1.8vw, 1.35rem);
  padding: 0.9rem 1.9rem;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--wash);
  color: var(--muted);
  cursor: pointer;
  transition: color 140ms ease, background 140ms ease, border-color 140ms ease;
}
.mock-tab:hover, .mock-tab[data-dwell-hot] { border-color: var(--accent); color: var(--fg); }
.mock-tab.active { background: var(--accent); border-color: var(--accent); color: var(--bg); }
.mock-panels { position: relative; height: 52vh; }
.mock-panel {
  position: absolute;
  inset: 0;
  display: none;
  flex-direction: column;
  gap: 0.5rem;
}
.mock-panel.active { display: flex; }
.mock-frame {
  flex: 1;
  width: 100%;
  min-height: 0;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: #0b1426;
}
.mock-missing {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  font-size: clamp(1.1rem, 2vw, 1.5rem);
  background: var(--wash);
}
.mock-caption {
  margin: 0;
  color: var(--muted);
  font-size: 0.9rem;
  letter-spacing: 0.08em;
}
.decisions {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 1.4rem;
  margin-top: 0.6rem;
}
.decision {
  font: inherit;
  min-height: 22vh;
  padding: 2rem;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 0.8rem;
  text-align: left;
  color: var(--fg);
  background: var(--wash);
  border: 2px solid var(--line);
  border-radius: 18px;
  cursor: pointer;
  transition: border-color 140ms ease, background 140ms ease, transform 140ms ease;
}
.decision:hover, .decision[data-dwell-hot] {
  border-color: var(--accent);
  background: rgba(90, 209, 255, 0.12);
  transform: translateY(-2px);
}
.decision:disabled { opacity: 0.45; cursor: default; transform: none; }
.decision.chosen { opacity: 1; border-color: var(--ok); background: rgba(157, 255, 176, 0.1); }
.decision-label { font-size: clamp(1.5rem, 2.8vw, 2.4rem); font-weight: 650; }
.decision-detail { color: var(--muted); font-size: clamp(0.95rem, 1.6vw, 1.25rem); }
.decision-form {
  display: flex;
  gap: 0.8rem;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 1.2rem;
}
.decision-form[hidden] { display: none; }
.decision-hint { flex-basis: 100%; margin: 0; color: var(--accent); }
.decision-input {
  flex: 1;
  min-width: 260px;
  font: inherit;
  font-size: 1.1rem;
  padding: 0.9rem 1.1rem;
  color: var(--fg);
  background: rgba(5, 7, 13, 0.7);
  border: 1px solid var(--line);
  border-radius: 12px;
  cursor: text;
  user-select: text;
}
.decision-send {
  font: inherit;
  font-size: 1.05rem;
  padding: 0.9rem 1.7rem;
  color: var(--bg);
  background: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 12px;
  cursor: pointer;
}
.decision-status {
  min-height: 1.6em;
  margin: 1rem 0 0;
  color: var(--muted);
  font-size: clamp(1rem, 1.8vw, 1.3rem);
}
.decision-status.ok { color: var(--ok); }
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

// Render the complete, self-contained pitch-deck document.
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
