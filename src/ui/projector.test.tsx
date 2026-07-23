import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectorApp, REQUIRED_PROJECTOR_REGIONS } from "./App";
import { IdeaTray } from "./IdeaTray";
import { HelpOverlay } from "./HelpOverlay";
import { QrImport } from "./QrImport";
import { Slideshow } from "./Slideshow";
import { demoProjectorSnapshot, busyRoomSnapshot } from "./demo-data";
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

// TWO-WALL CONTRACT: wall A and wall B both render the COMPLETE room. The
// legacy ?view=ideas|builds param is accepted (old run-room.sh URLs keep
// working, and it still labels the wall badge) but it must NEVER filter the
// scene's node sets or the 2D surfaces.
describe("both walls render the full scene (legacy ?view is inert)", () => {
  function sceneCounts(html: string): { ideas: number; trees: number } {
    const ideas = html.match(/data-idea-count="(\d+)"/);
    const trees = html.match(/data-tree-count="(\d+)"/);
    expect(ideas).not.toBeNull();
    expect(trees).not.toBeNull();
    return { ideas: Number(ideas![1]), trees: Number(trees![1]) };
  }

  const fullHtml = renderToStaticMarkup(<ProjectorApp initialSnapshot={demoProjectorSnapshot} />);
  const wallAHtml = renderToStaticMarkup(
    <ProjectorApp initialSnapshot={demoProjectorSnapshot} urlSearch="?live=1&wall=A&view=ideas" />,
  );
  const wallBHtml = renderToStaticMarkup(
    <ProjectorApp initialSnapshot={demoProjectorSnapshot} urlSearch="?live=1&wall=B&view=builds" />,
  );

  test("the 3D scene gets identical node sets on wall A, wall B, and the full view", () => {
    const full = sceneCounts(fullHtml);
    expect(full.ideas).toBe(demoProjectorSnapshot.ideas?.length ?? -1);
    expect(full.trees).toBe(demoProjectorSnapshot.processes.length);
    expect(sceneCounts(wallAHtml)).toEqual(full);
    expect(sceneCounts(wallBHtml)).toEqual(full);
  });

  test("?view=ideas (wall A) still renders the whole build fleet", () => {
    expect(countOccurrences(wallAHtml, 'data-testid="fleet-panel"')).toBe(
      demoProjectorSnapshot.processes.length,
    );
    expect(wallAHtml).toContain("Atlas");
    expect(wallAHtml).toContain("Cobalt");
  });

  test("?view=builds (wall B) still renders every idea surface", () => {
    expect(wallBHtml).toContain('data-testid="idea-tray"');
    expect(countOccurrences(wallBHtml, 'data-testid="idea-item"')).toBe(
      demoProjectorSnapshot.ideas?.length ?? -1,
    );
    expect(wallBHtml).toContain('data-region="suggestion"');
  });

  test("the wall identity badge still labels each window", () => {
    expect(wallAHtml).toContain("WALL A · IDEAS");
    expect(wallBHtml).toContain("WALL B · BUILDS");
    expect(fullHtml).not.toContain('data-testid="wall-badge"');
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

describe("project deck (slideshow)", () => {
  test("a mock-room process renders its fixture deck headed by the inferred title", () => {
    const process = busyRoomSnapshot().processes[0]!;
    const html = renderToStaticMarkup(
      <Slideshow process={process} onLifecycle={() => {}} onClose={() => {}} />,
    );
    expect(html).toContain('data-testid="slideshow-overlay"');
    // The deck headline is the INFERRED project title, not the upid/callsign.
    expect(html).toContain("Blocker announcer");
    expect(html).toContain('data-slide-index="0"');
    expect(html).not.toContain('data-testid="slideshow-live-frame"');
  });

  test("a build with a real slideshowUrl becomes an embedded live slide with an open link", () => {
    const process: BuildloopProcess = {
      ...demoProjectorSnapshot.processes[0]!,
      builds: [
        {
          backend: "native",
          label: "Native",
          status: "ready",
          previewUrl: "http://127.0.0.1:4100/",
          summary: null,
          slideshowUrl: "http://127.0.0.1:4100/slides.html",
        },
      ],
    };
    const html = renderToStaticMarkup(
      <Slideshow process={process} onLifecycle={() => {}} onClose={() => {}} />,
    );
    expect(html).toContain('data-testid="slideshow-live-frame"');
    expect(html).toContain('data-testid="slideshow-open-live"');
    expect(html).toContain("http://127.0.0.1:4100/slides.html");
    // The deck HUD surfaces per-backend build chips + lifecycle controls.
    expect(html).toContain('data-testid="slideshow-builds"');
    expect(html).toContain('data-testid="build-chip"');
    expect(html).toContain('data-testid="fleet-controls"');
  });

  test("a process with neither fixture slides nor live decks renders no deck", () => {
    const html = renderToStaticMarkup(
      <Slideshow process={demoProjectorSnapshot.processes[0]!} onLifecycle={() => {}} onClose={() => {}} />,
    );
    expect(html).toBe("");
  });

  test("the fleet card offers Deck ▸ only when a deck exists", () => {
    const processes: BuildloopProcess[] = demoProjectorSnapshot.processes.map((process, index) =>
      index === 0
        ? {
            ...process,
            builds: [
              {
                backend: "smithers",
                label: "Smithers",
                status: "ready",
                previewUrl: null,
                summary: null,
                slideshowUrl: "http://127.0.0.1:4200/deck/",
              },
            ],
          }
        : process,
    );
    const withDeck = renderToStaticMarkup(
      <ProjectorApp initialSnapshot={{ ...demoProjectorSnapshot, processes }} />,
    );
    expect(countOccurrences(withDeck, 'data-testid="process-deck-button"')).toBe(1);

    const without = renderToStaticMarkup(<ProjectorApp initialSnapshot={demoProjectorSnapshot} />);
    expect(without).not.toContain('data-testid="process-deck-button"');
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

// GESTURE-DWELL CURSOR POLICY: in gesture mode the UI hides the OS cursor
// (gesture-mode class → cursor:none) and mounts the dwell layer; ?dwell=mouse
// mounts the SAME dwell layer for desk testing but keeps the OS cursor.
describe("gesture dwell-select interaction", () => {
  test("?gesture=1: dwell layer mounts and the OS cursor is hidden (gesture-mode)", () => {
    const html = renderToStaticMarkup(
      <ProjectorApp initialSnapshot={demoProjectorSnapshot} urlSearch="?live=0&wall=A&gesture=1" />,
    );
    expect(html).toContain('data-testid="gesture-overlay"');
    expect(html).toContain("gesture-mode");
    expect(html).toContain('data-gesture="true"');
  });

  test("?dwell=mouse: dwell layer mounts WITHOUT hiding the OS cursor", () => {
    const html = renderToStaticMarkup(
      <ProjectorApp initialSnapshot={demoProjectorSnapshot} urlSearch="?live=0&dwell=mouse" />,
    );
    expect(html).toContain('data-testid="gesture-overlay"');
    expect(html).not.toContain("gesture-mode");
    expect(html).toContain('data-gesture="false"');
  });

  test("fleet panels opt into dwell targeting via data-dwell", () => {
    const html = renderToStaticMarkup(<ProjectorApp initialSnapshot={demoProjectorSnapshot} />);
    expect(html).toContain('data-dwell="steer"');
  });

  test("help overlay documents the gesture dwell mechanic and the camera lock", () => {
    const html = renderToStaticMarkup(<HelpOverlay onClose={() => {}} gestureMode />);
    expect(html).toContain('data-testid="help-gesture"');
    expect(html).toContain("point, hold, select");
    expect(html).toContain("LOCKED in gesture mode");
  });
});
