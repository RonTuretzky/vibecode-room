import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Slideshow, deckWindowState } from "./Slideshow";
import type { ProcessBuild, BuildloopProcess } from "./buildloop";
import { demoProjectorSnapshot } from "./demo-data";

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// A live process with no fixture slides — the base for build-lane scenarios.
function liveProcess(builds: ProcessBuild[]): BuildloopProcess {
  return { ...demoProjectorSnapshot.processes[0]!, builds };
}

function build(overrides: Partial<ProcessBuild> & Pick<ProcessBuild, "backend" | "status">): ProcessBuild {
  return {
    label: overrides.backend,
    previewUrl: null,
    summary: null,
    slideshowUrl: null,
    ...overrides,
  };
}

// ── deckWindowState: the pure gating/graceful-state decision ────────────────
describe("deckWindowState (pure)", () => {
  test("no slides and no build lanes → the window does not open", () => {
    expect(deckWindowState(false, [])).toBe("none");
  });

  test("any slide present → ready, regardless of lane states", () => {
    expect(deckWindowState(true, [])).toBe("ready");
    expect(deckWindowState(true, [build({ backend: "native", status: "failed" })])).toBe("ready");
  });

  test("lanes still racing with no published deck → building", () => {
    const builds = [
      build({ backend: "smithers", status: "building" }),
      build({ backend: "native", status: "failed" }),
    ];
    expect(deckWindowState(false, builds)).toBe("building");
  });

  test("every lane failed and none published a deck → failed", () => {
    const builds = [
      build({ backend: "smithers", status: "failed" }),
      build({ backend: "native", status: "failed" }),
    ];
    expect(deckWindowState(false, builds)).toBe("failed");
  });

  test("lanes finished ready but published no deck → empty", () => {
    const builds = [build({ backend: "native", status: "ready", slideshowUrl: null })];
    expect(deckWindowState(false, builds)).toBe("empty");
  });
});

// ── The pop-up window chrome (SSR markup) ───────────────────────────────────
describe("Slideshow pop-up window chrome", () => {
  const readyProcess = liveProcess([
    build({
      backend: "native",
      label: "Native",
      status: "ready",
      previewUrl: "http://127.0.0.1:4100/",
      slideshowUrl: "http://127.0.0.1:4100/slides.html",
    }),
  ]);

  test("renders as a labelled modal dialog window with a title bar", () => {
    const html = renderToStaticMarkup(<Slideshow process={readyProcess} onLifecycle={() => {}} onClose={() => {}} />);
    expect(html).toContain('data-testid="slideshow-overlay"');
    expect(html).toContain("slideshow-window");
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("slideshow-titlebar");
  });

  test("the title bar carries the inferred project name AND the callsign", () => {
    const html = renderToStaticMarkup(<Slideshow process={readyProcess} onLifecycle={() => {}} onClose={() => {}} />);
    // Inferred name = the process task; callsign lives in the eyebrow.
    expect(html).toContain(readyProcess.task);
    expect(html).toContain(readyProcess.callsign);
  });

  test("a big dwell-operable close X is present in the window chrome", () => {
    const html = renderToStaticMarkup(<Slideshow process={readyProcess} onLifecycle={() => {}} onClose={() => {}} />);
    expect(html).toContain('data-testid="slideshow-close"');
    expect(html).toContain('aria-label="Close deck window"');
  });

  test("the ready window embeds the generated slideshow as a large iframe body", () => {
    const html = renderToStaticMarkup(<Slideshow process={readyProcess} onLifecycle={() => {}} onClose={() => {}} />);
    expect(html).toContain('data-testid="slideshow-live-frame"');
    expect(html).toContain("http://127.0.0.1:4100/slides.html");
    // The escape hatch out to a real browser window survives.
    expect(html).toContain('data-testid="slideshow-open-live"');
    // Slide navigation renders for a ready deck.
    expect(html).toContain('data-testid="slide-next"');
  });

  test("a process with neither fixture slides nor build lanes renders nothing", () => {
    const html = renderToStaticMarkup(
      <Slideshow process={demoProjectorSnapshot.processes[0]!} onLifecycle={() => {}} onClose={() => {}} />,
    );
    expect(html).toBe("");
  });
});

// ── Graceful body states (opened before/without a deck) ─────────────────────
describe("Slideshow graceful states", () => {
  test("lanes still building → a 'building the deck…' body, never an empty iframe", () => {
    const process = liveProcess([
      build({ backend: "smithers", label: "Smithers", status: "building", progressLabel: "scaffolding" }),
      build({ backend: "native", label: "Native", status: "building", progressLabel: "mocking" }),
    ]);
    const html = renderToStaticMarkup(<Slideshow process={process} onLifecycle={() => {}} onClose={() => {}} />);
    expect(html).toContain('data-testid="deck-placeholder"');
    expect(html).toContain('data-deck-state="building"');
    expect(html).toContain('data-testid="deck-building"');
    expect(html).toContain("Building the deck");
    // Per-lane progress surfaces in the placeholder.
    expect(html).toContain("scaffolding");
    // No iframe while nothing is published.
    expect(html).not.toContain('data-testid="slideshow-live-frame"');
    // The window chrome + close are still there so it can be dismissed.
    expect(html).toContain('data-testid="slideshow-close"');
  });

  test("every lane failed → a clear failure message, no iframe", () => {
    const process = liveProcess([
      build({ backend: "smithers", label: "Smithers", status: "failed" }),
      build({ backend: "native", label: "Native", status: "failed" }),
    ]);
    const html = renderToStaticMarkup(<Slideshow process={process} onLifecycle={() => {}} onClose={() => {}} />);
    expect(html).toContain('data-deck-state="failed"');
    expect(html).toContain('data-testid="deck-failed"');
    expect(html).toContain("Every build lane failed");
    expect(html).not.toContain('data-testid="slideshow-live-frame"');
  });

  test("lanes finished without a deck → a 'no deck published' body", () => {
    const process = liveProcess([build({ backend: "native", label: "Native", status: "ready", slideshowUrl: null })]);
    const html = renderToStaticMarkup(<Slideshow process={process} onLifecycle={() => {}} onClose={() => {}} />);
    expect(html).toContain('data-deck-state="empty"');
    expect(html).toContain('data-testid="deck-empty"');
    expect(html).not.toContain('data-testid="slideshow-live-frame"');
  });
});

// ── Backend switcher tabs (multiple slideshows) ─────────────────────────────
describe("Slideshow backend switcher", () => {
  test("multiple slideshow backends surface as tabs in the window chrome", () => {
    const process = liveProcess([
      build({ backend: "smithers", label: "Smithers", status: "building", progressLabel: "scaffolding" }),
      build({
        backend: "eliza",
        label: "ElizaOS",
        status: "ready",
        slideshowUrl: "http://127.0.0.1:4101/slides.html",
      }),
      build({
        backend: "native",
        label: "Native",
        status: "ready",
        slideshowUrl: "http://127.0.0.1:4102/slides.html",
      }),
    ]);
    const html = renderToStaticMarkup(<Slideshow process={process} onLifecycle={() => {}} onClose={() => {}} />);
    expect(countOccurrences(html, 'data-testid="deck-backend-tab"')).toBe(3);
    expect(html).toContain('data-backend="eliza"');
    expect(html).toContain('data-backend="native"');
    // The still-building lane is labelled honestly and disabled (not dwellable).
    expect(html).toContain("scaffolding");
  });

  test("initialBackend opens the window on that framework's live slide", () => {
    const process = liveProcess([
      build({ backend: "smithers", label: "Smithers", status: "ready", slideshowUrl: "http://127.0.0.1:4100/s.html" }),
      build({ backend: "eliza", label: "ElizaOS", status: "ready", slideshowUrl: "http://127.0.0.1:4101/s.html" }),
    ]);
    const html = renderToStaticMarkup(
      <Slideshow process={process} onLifecycle={() => {}} onClose={() => {}} initialBackend="eliza" />,
    );
    expect(html).toContain('data-slide-index="1"');
    expect(html).toContain("http://127.0.0.1:4101/s.html");
  });
});

// ── Decision/answer bar (mirrored out of the iframe) ────────────────────────
describe("Slideshow decision bar", () => {
  test("concept lanes with an onDecision handler mirror the three answers as room buttons", () => {
    const process = liveProcess([
      build({ backend: "native", label: "Native", status: "ready", slideshowUrl: "http://127.0.0.1:4100/s.html" }),
    ]);
    const html = renderToStaticMarkup(
      <Slideshow process={process} onLifecycle={() => {}} onClose={() => {}} onDecision={() => {}} />,
    );
    expect(html).toContain('data-testid="deck-decision"');
    expect(html).toContain('data-testid="decision-commission"');
    expect(html).toContain('data-testid="decision-iterate"');
    expect(html).toContain('data-testid="decision-done"');
  });

  test("without an onDecision handler the mirrored bar is absent", () => {
    const process = liveProcess([
      build({ backend: "native", label: "Native", status: "ready", slideshowUrl: "http://127.0.0.1:4100/s.html" }),
    ]);
    const html = renderToStaticMarkup(<Slideshow process={process} onLifecycle={() => {}} onClose={() => {}} />);
    expect(html).not.toContain('data-testid="deck-decision"');
  });
});
