import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectorApp, REQUIRED_PROJECTOR_REGIONS } from "./App";
import { IdeaTray } from "./IdeaTray";
import { HelpOverlay } from "./HelpOverlay";
import { QrImport } from "./QrImport";
import { demoProjectorSnapshot } from "./demo-data";
import type { BuildloopProcess, BuildloopSnapshot } from "./buildloop";

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("projector UI contract", () => {
  test("renders every required projector region from deterministic demo state", () => {
    const html = renderToStaticMarkup(<ProjectorApp initialSnapshot={demoProjectorSnapshot} />);

    for (const region of REQUIRED_PROJECTOR_REGIONS) {
      expect(html).toContain(`data-region="${region}"`);
    }

    expect(html).toContain("Atlas");
    expect(html).toContain("Cobalt");
    expect(html).toContain("Turn the meeting notes into a blocker announcer.");
    expect(html).toContain("route.action");
  });

  test("shows the bounded unmute control only while muted", () => {
    const mutedHtml = renderToStaticMarkup(<ProjectorApp initialSnapshot={{ ...demoProjectorSnapshot, muted: true, listening: false }} />);
    const listeningHtml = renderToStaticMarkup(<ProjectorApp initialSnapshot={demoProjectorSnapshot} />);

    expect(mutedHtml).toContain("Unmute");
    expect(listeningHtml).not.toContain("Unmute");
  });

  test("status bar carries the QR Import control", () => {
    const html = renderToStaticMarkup(<ProjectorApp initialSnapshot={demoProjectorSnapshot} />);
    expect(html).toContain('data-testid="qr-import-button"');
    expect(html).toContain("QR Import");
  });

  test("no URL params (SSR/full view): no wall badge, no gesture overlay", () => {
    const html = renderToStaticMarkup(<ProjectorApp initialSnapshot={demoProjectorSnapshot} />);
    expect(html).not.toContain('data-testid="wall-badge"');
    expect(html).not.toContain('data-testid="gesture-overlay"');
    expect(html).toContain('data-view="full"');
  });

  test("the capture control no longer promises auto-building (capture ≠ build)", () => {
    const html = renderToStaticMarkup(<ProjectorApp initialSnapshot={demoProjectorSnapshot} />);
    expect(html).not.toContain("every idea builds itself");
  });
});

describe("idea tray", () => {
  test("demo snapshot renders the tray with every ledger candidate", () => {
    const html = renderToStaticMarkup(<ProjectorApp initialSnapshot={demoProjectorSnapshot} />);
    expect(html).toContain('data-testid="idea-tray"');
    expect(countOccurrences(html, 'data-testid="idea-item"')).toBe(demoProjectorSnapshot.ideas?.length ?? -1);
    expect(html).toContain("A retro wall that clusters this week&#x27;s wins and gripes.");
  });

  test("ready candidates get Build/Dismiss; forming candidates are display-only", () => {
    const ideas = demoProjectorSnapshot.ideas ?? [];
    const readyCount = ideas.filter((idea) => idea.status === "ready").length;
    expect(readyCount).toBeGreaterThan(0);

    const html = renderToStaticMarkup(<IdeaTray ideas={ideas} onBuild={() => {}} onDismiss={() => {}} />);
    expect(countOccurrences(html, 'data-testid="idea-build-button"')).toBe(readyCount);
    expect(countOccurrences(html, 'data-testid="idea-dismiss-button"')).toBe(readyCount);
    expect(html).toContain('data-status="forming"');
  });

  test("empty tray shows the capture hint instead of cards", () => {
    const html = renderToStaticMarkup(<IdeaTray ideas={[]} onBuild={() => {}} onDismiss={() => {}} />);
    expect(html).toContain('data-testid="idea-tray-empty"');
    expect(html).not.toContain('data-testid="idea-item"');
  });

  test("a snapshot without ideas hides the tray entirely (legacy fixtures stay clean)", () => {
    const html = renderToStaticMarkup(
      <ProjectorApp initialSnapshot={{ ...demoProjectorSnapshot, ideas: undefined }} />,
    );
    expect(html).not.toContain('data-testid="idea-tray"');
  });
});

describe("help overlay", () => {
  test("lists the full keyboard map and the voice command set", () => {
    const html = renderToStaticMarkup(<HelpOverlay onClose={() => {}} />);
    expect(html).toContain('data-testid="help-overlay"');
    for (const key of ["1–9", "Enter / b", "x", "c", "a", "k", "m", "u", "q", "? / h", "Shift+E", "Esc"]) {
      expect(html).toContain(`<kbd>${key}</kbd>`);
    }
    expect(html).toContain("Vibersyn, build it");
    expect(html).toContain("Vibersyn, emergency");
  });
});

describe("build loop surfaces (backward compatible)", () => {
  test("a plain snapshot (no backends[], no builds[]) renders neither surface", () => {
    const html = renderToStaticMarkup(<ProjectorApp initialSnapshot={demoProjectorSnapshot} />);
    expect(html).not.toContain('data-testid="backend-selector"');
    expect(html).not.toContain('data-testid="build-chips"');
  });

  test("snapshot.backends[] renders a chip per backend, dimmed + labeled when unavailable", () => {
    const snapshot: BuildloopSnapshot = {
      ...demoProjectorSnapshot,
      backends: [
        { id: "smithers", label: "Smithers", enabled: true, available: true },
        { id: "native", label: "Native", enabled: false, available: false, reason: "still booting" },
      ],
    };
    const html = renderToStaticMarkup(<ProjectorApp initialSnapshot={snapshot} />);
    expect(html).toContain('data-testid="backend-selector"');
    expect(countOccurrences(html, 'data-testid="backend-chip"')).toBe(2);
    expect(html).toContain('data-backend="native"');
    expect(html).toContain('data-available="false"');
    expect(html).toContain("still booting");
  });

  test("process.builds[] renders a chip per backend build with status-driven affordances", () => {
    const processes: BuildloopProcess[] = demoProjectorSnapshot.processes.map((process, index) =>
      index === 0
        ? {
            ...process,
            builds: [
              { backend: "smithers", label: "Smithers", status: "building", previewUrl: null, summary: null, slideshowUrl: null, progressLabel: "scaffolding", percent: 40 },
              { backend: "native", label: "Native", status: "ready", previewUrl: "http://127.0.0.1:4100/", summary: "Built a page.", slideshowUrl: "http://127.0.0.1:4100/slides.html" },
            ],
          }
        : process,
    );
    const html = renderToStaticMarkup(
      <ProjectorApp initialSnapshot={{ ...demoProjectorSnapshot, processes }} />,
    );
    expect(countOccurrences(html, 'data-testid="build-chip"')).toBe(2);
    expect(html).toContain('data-status="building"');
    expect(html).toContain("scaffolding");
    expect(html).toContain('data-status="ready"');
    expect(html).toContain('data-testid="build-preview-link"');
    expect(html).toContain('data-testid="build-slides-link"');
  });

  test("per-card lifecycle buttons match the process state (halted offers none)", () => {
    const processes = demoProjectorSnapshot.processes.map((process) =>
      process.callsign === "Atlas" ? { ...process, state: "halted" as const } : process,
    );
    const html = renderToStaticMarkup(
      <ProjectorApp initialSnapshot={{ ...demoProjectorSnapshot, processes }} />,
    );
    // Atlas (halted): no lifecycle buttons. Cobalt (planning): pause + halt.
    expect(countOccurrences(html, 'data-testid="process-pause-button"')).toBe(1);
    expect(countOccurrences(html, 'data-testid="process-halt-button"')).toBe(1);
    expect(html).not.toContain('data-testid="process-resume-button"');
  });
});

describe("qr import overlay", () => {
  test("first paint (before /api/import/info resolves) shows the pending state", () => {
    // Static render = no effects, so this is the pre-fetch skeleton: the overlay
    // shell + a pending placeholder, never a broken <img>.
    const html = renderToStaticMarkup(<QrImport processes={[]} onClose={() => {}} />);
    expect(html).toContain('data-testid="qr-overlay"');
    expect(html).toContain('data-testid="qr-code-pending"');
    expect(html).not.toContain('data-testid="qr-code-image"');
    expect(html).not.toContain('data-testid="qr-import-success"');
  });
});
