import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectorApp, REQUIRED_PROJECTOR_REGIONS } from "./App";
import {
  AUTOCAL_POLL_ABSENT_MS,
  AUTOCAL_POLL_ACTIVE_MS,
  discGeometry,
  parseAutocalState,
} from "./CalibrationOverlay";
import { ControlDock, DOCK_COLLAPSE_MS, dockCollapseDue } from "./ControlDock";
import { cursorDotsFromStored, fusionSources } from "./gesture/GestureLayer";
import { FLEET_SCROLL_PX_PER_SECOND, FleetScrollRail, hoverScrollDelta, railOverflows } from "./FleetScroll";
import { IdeaTray } from "./IdeaTray";
import { HelpOverlay } from "./HelpOverlay";
import { QrImport, qrPanelState } from "./QrImport";
import { preferredGuestUrl } from "./GuestHands";
import { Slideshow } from "./Slideshow";
import { demoProjectorSnapshot, busyRoomSnapshot } from "./demo-data";
import type { BuildloopProcess, BuildloopSnapshot } from "./buildloop";
import { PRACTICE_ORB_COUNT } from "./guided/machine";

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

  test("the status bar's QR Import control now lives inside the control dock", () => {
    const html = renderToStaticMarkup(<ProjectorApp initialSnapshot={demoProjectorSnapshot} />);
    expect(html).toContain('data-testid="qr-import-button"');
    expect(html).toContain("QR Import");
    // Same control, calmer resting state: it renders within the dock tray.
    expect(html.indexOf('data-testid="qr-import-button"')).toBeGreaterThan(
      html.indexOf('data-testid="control-dock-tray"'),
    );
  });

  test("no URL params (SSR/full view): no wall badge, no gesture overlay", () => {
    const html = renderToStaticMarkup(<ProjectorApp initialSnapshot={demoProjectorSnapshot} />);
    expect(html).not.toContain('data-testid="wall-badge"');
    // The default-on GUEST layer resolves its socket from window.location, so
    // SSR (no window) never mounts it — in a browser the overlay is present
    // by default now (passive until a guest cursor exists).
    expect(html).not.toContain('data-testid="gesture-overlay"');
    expect(html).toContain('data-view="full"');
  });

  test("the capture control no longer promises auto-building (capture ≠ build)", () => {
    const html = renderToStaticMarkup(<ProjectorApp initialSnapshot={demoProjectorSnapshot} />);
    expect(html).not.toContain("every idea builds itself");
  });
});

// NO-MOCKS AUDIT: the default (no initialSnapshot prop) render is the EMPTY
// live baseline — never the Atlas/Cobalt fixture — and the Mock Room fixture
// toggle is hidden unless the launcher opts in with ?mock=1.
describe("no-mocks audit: default UI carries no fixture content", () => {
  test("with no snapshot prop, first paint is the empty live baseline (no fixtures)", () => {
    const html = renderToStaticMarkup(<ProjectorApp />);
    expect(html).not.toContain("Atlas");
    expect(html).not.toContain("Cobalt");
    expect(html).not.toContain("Turn the meeting notes into a blocker announcer.");
    // The wall shell still renders every region.
    for (const region of REQUIRED_PROJECTOR_REGIONS) {
      expect(html).toContain(`data-region="${region}"`);
    }
  });

  test("the Mock Room toggle is HIDDEN by default and appears only with ?mock=1", () => {
    const hidden = renderToStaticMarkup(<ProjectorApp initialSnapshot={demoProjectorSnapshot} />);
    expect(hidden).not.toContain('data-testid="mock-room-button"');

    const gated = renderToStaticMarkup(
      <ProjectorApp initialSnapshot={demoProjectorSnapshot} urlSearch="?live=0&mock=1" />,
    );
    expect(gated).toContain('data-testid="mock-room-button"');
  });
});

// GUIDED DEMO: the coached walkthrough. Entry via the HUD button or
// ?demo=guided; step 1 renders three practice orbs; every step carries
// skip/exit affordances. (Advance conditions are unit-tested in
// guided/machine.test.ts against fake snapshot feeds.)
describe("guided demo overlay", () => {
  test("the HUD always offers the dwellable Guided Demo launch button", () => {
    const html = renderToStaticMarkup(<ProjectorApp initialSnapshot={demoProjectorSnapshot} />);
    expect(html).toContain('data-testid="guided-demo-button"');
    expect(html).toContain("Guided Demo");
  });

  test("without ?demo=guided the overlay does not render", () => {
    const html = renderToStaticMarkup(<ProjectorApp initialSnapshot={demoProjectorSnapshot} />);
    expect(html).not.toContain('data-testid="guided-demo"');
  });

  test("?demo=guided auto-enters step 1 with the practice orbs and skip/exit", () => {
    const html = renderToStaticMarkup(
      <ProjectorApp initialSnapshot={demoProjectorSnapshot} urlSearch="?live=0&demo=guided" />,
    );
    expect(html).toContain('data-testid="guided-demo"');
    expect(html).toContain('data-step="orientation"');
    expect(countOccurrences(html, 'data-testid="practice-orb"')).toBe(PRACTICE_ORB_COUNT);
    expect(html).toContain(`0 / ${PRACTICE_ORB_COUNT} popped`);
    expect(html).toContain('data-testid="guided-skip-button"');
    expect(html).toContain('data-testid="guided-exit-button"');
    // Step 1 explains the mechanic in plain words.
    expect(html).toContain("point at the wall");
  });

  test("an emergency-stopped room is SAID, not wedged (resilience notice)", () => {
    const html = renderToStaticMarkup(
      <ProjectorApp
        initialSnapshot={{ ...demoProjectorSnapshot, emergencyStopTriggered: true }}
        urlSearch="?live=0&demo=guided"
      />,
    );
    expect(html).toContain('data-testid="guided-notice"');
    expect(html).toContain("EMERGENCY STOP");
  });
});

// PER-WALL CONTRACT: the 3D room scene renders in FULL on every window (walls
// differ by camera vantage, never by scene content), but the 2D surfaces +
// controls are scoped by ?view so the two projections stop duplicating each
// other: view=ideas (wall A) carries the idea surface + idea-side controls,
// view=builds (wall B) the build surface + build-side controls, and the
// default full view (single-window desk mode) carries everything.
describe("per-wall scoping: each wall renders ITS surface + ITS controls", () => {
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

  test("the 3D scene stays FULL on wall A, wall B, and the full view (shared room)", () => {
    const full = sceneCounts(fullHtml);
    expect(full.ideas).toBe(demoProjectorSnapshot.ideas?.length ?? -1);
    expect(full.trees).toBe(demoProjectorSnapshot.processes.length);
    expect(sceneCounts(wallAHtml)).toEqual(full);
    expect(sceneCounts(wallBHtml)).toEqual(full);
  });

  test("?view=ideas (wall A): idea surface + idea-side controls, NO build surfaces", () => {
    // Idea surface: tray with every candidate.
    expect(wallAHtml).toContain('data-testid="idea-tray"');
    expect(countOccurrences(wallAHtml, 'data-testid="idea-item"')).toBe(
      demoProjectorSnapshot.ideas?.length ?? -1,
    );
    // Idea-side controls (voice → idea pipeline).
    expect(wallAHtml).toContain('data-testid="mic-capture-button"');
    expect(wallAHtml).toContain('data-testid="auto-build-button"');
    expect(wallAHtml).toContain('data-testid="guided-demo-button"');
    // Build surfaces + build-side controls live on wall B only.
    expect(wallAHtml).not.toContain('data-testid="fleet-panel"');
    expect(wallAHtml).not.toContain('data-region="transcript"');
    // QR Import is deliberately UN-scoped (live-room request): the overlay
    // opens on whichever wall summons it, so its button rides every view.
    expect(wallAHtml).toContain('data-testid="qr-import-button"');
  });

  test("?view=builds (wall B): build surface + build-side controls, NO idea surfaces", () => {
    // Build surface: the whole fleet + transcript rail.
    expect(countOccurrences(wallBHtml, 'data-testid="fleet-panel"')).toBe(
      demoProjectorSnapshot.processes.length,
    );
    expect(wallBHtml).toContain("Atlas");
    expect(wallBHtml).toContain("Cobalt");
    expect(wallBHtml).toContain('data-region="transcript"');
    // Build-side control.
    expect(wallBHtml).toContain('data-testid="qr-import-button"');
    // Idea surfaces + idea-side controls live on wall A only.
    expect(wallBHtml).not.toContain('data-testid="idea-tray"');
    expect(wallBHtml).not.toContain('data-testid="mic-capture-button"');
    expect(wallBHtml).not.toContain('data-testid="auto-build-button"');
    expect(wallBHtml).not.toContain('data-testid="guided-demo-button"');
  });

  test("global chrome renders on BOTH walls (status readouts + scene controls)", () => {
    for (const html of [wallAHtml, wallBHtml]) {
      expect(html).toContain('data-region="status"');
      expect(html).toContain('data-testid="emergency-status"');
      expect(html).toContain('data-testid="scene-controls"');
    }
  });

  test("the default full view (desk mode) still renders everything", () => {
    expect(fullHtml).toContain('data-testid="idea-tray"');
    expect(countOccurrences(fullHtml, 'data-testid="fleet-panel"')).toBe(
      demoProjectorSnapshot.processes.length,
    );
    expect(fullHtml).toContain('data-testid="qr-import-button"');
    expect(fullHtml).toContain('data-testid="mic-capture-button"');
    for (const region of REQUIRED_PROJECTOR_REGIONS) {
      expect(fullHtml).toContain(`data-region="${region}"`);
    }
  });

  test("the wall identity badge is DE-THEMED: bare wall identity, no IDEAS/BUILDS branding", () => {
    expect(wallAHtml).toContain("WALL A");
    expect(wallBHtml).toContain("WALL B");
    expect(wallAHtml).not.toContain("WALL A · IDEAS");
    expect(wallBHtml).not.toContain("WALL B · BUILDS");
    expect(fullHtml).not.toContain('data-testid="wall-badge"');
  });
});

// DE-THEMED WALLS: the two walls are ONE continuous room. On-demand overlays
// (build detail, project deck, QR import, guided demo) open on WHICHEVER wall
// summons them — a person dwelling a build tree on wall A gets the detail
// overlay right there. Only the PERSISTENT single-instance panels stay placed
// per wall (tray/capture cluster on A, fleet rail + QR button on B).
describe("de-themed walls: on-demand overlays are available on BOTH walls", () => {
  test("the build-detail overlay opens on wall A (view=ideas)", () => {
    const html = renderToStaticMarkup(
      <ProjectorApp
        initialSnapshot={demoProjectorSnapshot}
        urlSearch="?live=1&wall=A&view=ideas"
        initialOverlay={{ selected: "Atlas" }}
      />,
    );
    expect(html).toContain('data-testid="build-detail"');
  });

  test("the project deck overlay opens on wall A (view=ideas)", () => {
    const busy = busyRoomSnapshot();
    const html = renderToStaticMarkup(
      <ProjectorApp
        initialSnapshot={busy}
        urlSearch="?live=1&wall=A&view=ideas"
        initialOverlay={{ slideshowUpid: busy.processes[0]!.upid }}
      />,
    );
    expect(html).toContain('data-testid="slideshow-overlay"');
  });

  test("the QR-import overlay AND its launch button are available on wall A (view=ideas)", () => {
    const html = renderToStaticMarkup(
      <ProjectorApp
        initialSnapshot={demoProjectorSnapshot}
        urlSearch="?live=1&wall=A&view=ideas"
        initialOverlay={{ qrOpen: true }}
      />,
    );
    expect(html).toContain('data-testid="qr-overlay"');
    expect(html).toContain('data-testid="qr-import-button"');
  });

  test("the guided demo runs on wall B (view=builds) — only its launch button stays wall-A", () => {
    const html = renderToStaticMarkup(
      <ProjectorApp initialSnapshot={demoProjectorSnapshot} urlSearch="?live=1&wall=B&view=builds&demo=guided" />,
    );
    expect(html).toContain('data-testid="guided-demo"');
    expect(html).not.toContain('data-testid="guided-demo-button"');
  });

  test("overlays still open on wall B (view=builds) as before", () => {
    const html = renderToStaticMarkup(
      <ProjectorApp
        initialSnapshot={demoProjectorSnapshot}
        urlSearch="?live=1&wall=B&view=builds"
        initialOverlay={{ selected: "Atlas", qrOpen: true }}
      />,
    );
    expect(html).toContain('data-testid="build-detail"');
    expect(html).toContain('data-testid="qr-overlay"');
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
    for (const key of ["1–9", "Enter / b", "x", "c", "W A S D", "Shift+A", "k", "m", "u", "q", "? / h", "Shift+E", "Esc"]) {
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

  test("the backend SELECTOR is gone: snapshot.backends[] never renders a chooser (env-driven, server-side)", () => {
    const snapshot: BuildloopSnapshot = {
      ...demoProjectorSnapshot,
      backends: [
        { id: "smithers", label: "Smithers", enabled: true, available: true },
        { id: "native", label: "Native", enabled: false, available: false, reason: "still booting" },
      ],
    };
    const html = renderToStaticMarkup(<ProjectorApp initialSnapshot={snapshot} />);
    expect(html).not.toContain('data-testid="backend-selector"');
    expect(html).not.toContain('data-testid="backend-chip"');
    expect(html).not.toContain("still booting");
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

  test("per-backend tabs label every framework result — ready decks switchable, building/failed said honestly", () => {
    const process: BuildloopProcess = {
      ...demoProjectorSnapshot.processes[0]!,
      builds: [
        { backend: "smithers", label: "Smithers", status: "building", previewUrl: null, summary: null, slideshowUrl: null, progressLabel: "scaffolding" },
        { backend: "eliza", label: "ElizaOS", status: "ready", previewUrl: "http://127.0.0.1:4101/", summary: null, slideshowUrl: "http://127.0.0.1:4101/slides.html" },
        { backend: "native", label: "Native", status: "failed", previewUrl: null, summary: null, slideshowUrl: null },
      ],
    };
    const html = renderToStaticMarkup(
      <Slideshow process={process} onLifecycle={() => {}} onClose={() => {}} />,
    );
    expect(countOccurrences(html, 'data-testid="deck-backend-tab"')).toBe(3);
    // The ready deck's tab is enabled; building/failed tabs are disabled
    // (disabled buttons are excluded from gesture-dwell targeting) + labeled.
    expect(html).toContain('data-backend="eliza"');
    expect(html).toContain("scaffolding");
    expect(html).toContain("failed");
  });

  test("initialBackend opens the deck on that framework's live slide (whichever won)", () => {
    const process: BuildloopProcess = {
      ...demoProjectorSnapshot.processes[0]!,
      builds: [
        { backend: "smithers", label: "Smithers", status: "ready", previewUrl: null, summary: null, slideshowUrl: "http://127.0.0.1:4100/s.html" },
        { backend: "eliza", label: "ElizaOS", status: "ready", previewUrl: null, summary: null, slideshowUrl: "http://127.0.0.1:4101/s.html" },
      ],
    };
    const html = renderToStaticMarkup(
      <Slideshow process={process} onLifecycle={() => {}} onClose={() => {}} initialBackend="eliza" />,
    );
    // Slide index 1 = eliza's live deck (index 0 is smithers').
    expect(html).toContain('data-slide-index="1"');
    expect(html).toContain("http://127.0.0.1:4101/s.html");
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

// TWO-STAGE kickoff/commission UX: a freshly kicked-off project is a CONCEPT
// (mock lanes racing, "mock ready" chips, commission button); an explicit
// commission transforms it (executing chip → BUILT with the full-app link).
describe("two-stage kickoff/commission surfaces", () => {
  const conceptProcess = (): BuildloopProcess => ({
    ...demoProjectorSnapshot.processes[0]!,
    builds: [
      { backend: "smithers", label: "Smithers", status: "building", previewUrl: null, summary: null, slideshowUrl: null, progressLabel: "mocking", percent: 40 },
      { backend: "native", label: "Native", status: "ready", previewUrl: "http://127.0.0.1:4100/", summary: null, slideshowUrl: "http://127.0.0.1:4100/slides.html" },
    ],
  });
  const commissionedProcess = (): BuildloopProcess & { execution: unknown } => ({
    ...conceptProcess(),
    execution: { status: "executing", progressLabel: "run step 2/9", percent: 22 },
  });

  test("a concept fleet card: 🌱 badge, MOCK READY chip tag, and the commission button", () => {
    const processes = demoProjectorSnapshot.processes.map((process, index) =>
      index === 0 ? conceptProcess() : process,
    );
    const html = renderToStaticMarkup(
      <ProjectorApp initialSnapshot={{ ...demoProjectorSnapshot, processes }} />,
    );
    expect(html).toContain('data-testid="process-stage"');
    expect(html).toContain('data-stage="concept"');
    expect(html).toContain('data-testid="build-chip-mock"');
    expect(html).toContain("mock ready");
    expect(html).toContain('data-testid="commission-button"');
    expect(html).not.toContain('data-testid="execution-chip"');
  });

  test("a commissioned card: 🌳 badge + pulsing execution chip, commission button gone", () => {
    const processes = demoProjectorSnapshot.processes.map((process, index) =>
      index === 0 ? commissionedProcess() : process,
    );
    const html = renderToStaticMarkup(
      <ProjectorApp initialSnapshot={{ ...demoProjectorSnapshot, processes }} />,
    );
    expect(html).toContain('data-stage="commissioned"');
    expect(html).toContain('data-testid="execution-chip"');
    expect(html).toContain('data-status="executing"');
    expect(html).toContain("run step 2/9");
    expect(html).not.toContain('data-testid="commission-button"');
  });

  test("a BUILT execution links the full-app preview", () => {
    const built = {
      ...conceptProcess(),
      execution: { status: "built", previewUrl: "http://127.0.0.1:4300/", summary: "The full app." },
    };
    const processes = demoProjectorSnapshot.processes.map((process, index) =>
      index === 0 ? (built as BuildloopProcess) : process,
    );
    const html = renderToStaticMarkup(
      <ProjectorApp initialSnapshot={{ ...demoProjectorSnapshot, processes }} />,
    );
    expect(html).toContain('data-testid="execution-preview-link"');
    expect(html).toContain("http://127.0.0.1:4300/");
    expect(html).toContain("BUILT ✓");
  });

  test("legacy processes with no build surfaces get no stage badge (fixtures stay clean)", () => {
    const html = renderToStaticMarkup(<ProjectorApp initialSnapshot={demoProjectorSnapshot} />);
    expect(html).not.toContain('data-testid="process-stage"');
    expect(html).not.toContain('data-testid="commission-button"');
    expect(html).not.toContain('data-testid="execution-chip"');
  });

  test("the deck shows the stage badge and the dwellable decision bar for concepts", () => {
    const html = renderToStaticMarkup(
      <Slideshow process={conceptProcess()} onLifecycle={() => {}} onClose={() => {}} onDecision={() => {}} />,
    );
    expect(html).toContain('data-testid="deck-stage"');
    expect(html).toContain("CONCEPT");
    // The room-native decision bar: three plain <button>s (auto dwell targets).
    expect(html).toContain('data-testid="deck-decision"');
    expect(html).toContain("How should we continue?");
    expect(html).toContain('data-decision="commission"');
    expect(html).toContain('data-decision="iterate"');
    expect(html).toContain('data-decision="done"');
    expect(html).toContain("Build it for real");
  });

  test("the decision bar disappears once commissioned (and without an onDecision handler)", () => {
    const commissioned = renderToStaticMarkup(
      <Slideshow
        process={commissionedProcess() as BuildloopProcess}
        onLifecycle={() => {}}
        onClose={() => {}}
        onDecision={() => {}}
      />,
    );
    expect(commissioned).toContain("COMMISSIONED");
    expect(commissioned).not.toContain('data-testid="deck-decision"');
    expect(commissioned).toContain('data-testid="execution-chip"');

    const noHandler = renderToStaticMarkup(
      <Slideshow process={conceptProcess()} onLifecycle={() => {}} onClose={() => {}} />,
    );
    expect(noHandler).not.toContain('data-testid="deck-decision"');
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

  test("qr panel decision: an unreachable address REPLACES the QR — a dead code must never render", () => {
    const unreachable = { submitUrl: "http://127.0.0.1:8788/submit", host: "127.0.0.1", lanReachable: false };
    const reachable = { submitUrl: "http://192.168.1.5:8788/submit", host: "192.168.1.5", lanReachable: true };
    // Unreachable wins even when the QR data URL already rendered.
    expect(qrPanelState(unreachable, "data:image/png;base64,xyz")).toBe("unreachable");
    expect(qrPanelState(unreachable, null)).toBe("unreachable");
    expect(qrPanelState(reachable, "data:image/png;base64,xyz")).toBe("image");
    expect(qrPanelState(reachable, null)).toBe("pending");
    expect(qrPanelState(null, null)).toBe("pending");
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

  test("guest hands is default-on: the Guests button renders on a bare URL; ?remote=0 removes it", () => {
    const bare = renderToStaticMarkup(<ProjectorApp initialSnapshot={demoProjectorSnapshot} urlSearch="?live=0" />);
    expect(bare).toContain('data-testid="guest-hands-button"');
    // A Guests button on a wall that is NOT listening would show a URL that
    // connects to nothing — opting out must remove it.
    const optedOut = renderToStaticMarkup(
      <ProjectorApp initialSnapshot={demoProjectorSnapshot} urlSearch="?live=0&remote=0" />,
    );
    expect(optedOut).not.toContain('data-testid="guest-hands-button"');
  });

  test("?remote=ws://… mounts the dwell layer subscribing as THIS window's wall (desk stays desk)", () => {
    const html = renderToStaticMarkup(
      <ProjectorApp
        initialSnapshot={demoProjectorSnapshot}
        urlSearch={`?live=0&wall=B&remote=${encodeURIComponent("ws://room:8788/api/hands/room")}`}
      />,
    );
    expect(html).toContain('data-testid="gesture-overlay"');
    // Wall identity is what keeps one guest from double-firing both windows.
    expect(html).toContain('data-wall="B"');
    expect(html).not.toContain("gesture-mode"); // remote mode alone never hides the OS cursor
  });

  test("preferredGuestUrl: the https listener wins (camera tracking); http is the fallback", () => {
    expect(preferredGuestUrl({ url: "http://10.0.0.2:8788/hands", httpsUrl: "https://10.0.0.2:8789/hands" })).toBe(
      "https://10.0.0.2:8789/hands",
    );
    expect(preferredGuestUrl({ url: "http://10.0.0.2:8788/hands", httpsUrl: null })).toBe("http://10.0.0.2:8788/hands");
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

// FLEET HOVER-SCROLL (FleetScroll.tsx): the dwell cursor cannot wheel-scroll,
// so an overflowing fleet rail grows ▲/▼ strips that scroll WHILE hovered —
// css :hover (mouse) or data-dwell-hot (gesture/joystick/guest cursors).
describe("fleet rail hover-scroll", () => {
  test("the fleet rail always renders inside the hover-scroll wrapper", () => {
    const html = renderToStaticMarkup(<ProjectorApp initialSnapshot={demoProjectorSnapshot} />);
    expect(html).toContain('data-testid="fleet-scroll-rail"');
    // SSR (and any non-overflowing list) shows NO scroll chrome: overflow is
    // measured per-frame in the browser, and a 2-panel fleet never needs it.
    expect(html).not.toContain('data-testid="fleet-scroll-up"');
    expect(html).not.toContain('data-testid="fleet-scroll-down"');
  });

  test("once the list overflows, both strips render as ENABLED plain <button>s (dwell-targetable)", () => {
    const html = renderToStaticMarkup(
      <FleetScrollRail initialOverflowing>
        <div data-testid="fleet-panel" />
      </FleetScrollRail>,
    );
    expect(html).toContain('data-testid="fleet-scroll-up"');
    expect(html).toContain('data-testid="fleet-scroll-down"');
    // The dwell selector is "button:not(:disabled), [data-dwell]" — the strips
    // must be enabled buttons so GestureLayer targets them (and decorates the
    // pointed-at one with data-dwell-hot, which is what drives the scroll).
    expect(countOccurrences(html, "<button")).toBe(2);
    expect(html).not.toContain("disabled");
    // The scrolling list itself still renders the panels between the strips.
    expect(html).toContain('class="fleet-panels"');
    expect(html).toContain('data-testid="fleet-panel"');
  });

  test("hoverScrollDelta: a few hundred px/s, signed by direction", () => {
    // A 60fps frame moves rate/60 px; twenty of them ≈ a third of a second.
    expect(hoverScrollDelta(1, 1 / 60)).toBeCloseTo(FLEET_SCROLL_PX_PER_SECOND / 60);
    expect(hoverScrollDelta(-1, 1 / 60)).toBeCloseTo(-FLEET_SCROLL_PX_PER_SECOND / 60);
    expect(FLEET_SCROLL_PX_PER_SECOND).toBeGreaterThanOrEqual(200);
    expect(FLEET_SCROLL_PX_PER_SECOND).toBeLessThanOrEqual(500);
  });

  test("hoverScrollDelta clamps runaway frame deltas (a resumed background tab must not teleport the list)", () => {
    expect(hoverScrollDelta(1, 5)).toBe(hoverScrollDelta(1, 0.1));
    expect(hoverScrollDelta(1, -0.02)).toBe(0); // clock skew: never scroll backwards
  });

  test("railOverflows: true only past the sub-pixel tolerance", () => {
    expect(railOverflows(900, 300)).toBe(true);
    expect(railOverflows(300, 300)).toBe(false);
    expect(railOverflows(303, 300)).toBe(false); // rounding jitter must not flicker the strips in
  });
});

// PINCH CAMERA (?hands=): camera CONTROL only — an opt-in hidden layer,
// independent of the dwell/gesture layers and composable with them.
describe("pinch camera layer", () => {
  test("?hands=1 mounts the pinch camera layer", () => {
    const html = renderToStaticMarkup(
      <ProjectorApp initialSnapshot={demoProjectorSnapshot} urlSearch="?live=0&wall=A&hands=1" />,
    );
    expect(html).toContain('data-testid="pinch-camera-layer"');
  });

  test("default URL: no pinch camera layer (opt-in only, desk mode untouched)", () => {
    const html = renderToStaticMarkup(<ProjectorApp initialSnapshot={demoProjectorSnapshot} />);
    expect(html).not.toContain('data-testid="pinch-camera-layer"');
  });

  test("?gesture=1&hands=1 composes: dwell overlay AND pinch camera both mount", () => {
    const html = renderToStaticMarkup(
      <ProjectorApp initialSnapshot={demoProjectorSnapshot} urlSearch="?live=0&gesture=1&hands=1" />,
    );
    expect(html).toContain('data-testid="gesture-overlay"');
    expect(html).toContain('data-testid="pinch-camera-layer"');
  });
});

// GESTURE STATUS BAR: at projector distance the status readouts (listening
// orb, session id / global state, active cue, read-only tag, gate %) are
// noise — gesture mode strips them so the bar carries only genuinely
// actionable controls. Desk mode keeps every chip for debugging. The
// emergency banner shows in gesture mode ONLY while an emergency is actually
// active (ALL CLEAR is a desk readout).
describe("gesture-mode status bar keeps only actionable controls", () => {
  const gestureA = renderToStaticMarkup(
    <ProjectorApp initialSnapshot={demoProjectorSnapshot} urlSearch="?live=0&wall=A&view=ideas&gesture=1" />,
  );

  test("status readouts are stripped in gesture mode", () => {
    expect(gestureA).not.toContain('data-testid="listening-indicator"');
    expect(gestureA).not.toContain('class="session-meta"');
    expect(gestureA).not.toContain('data-testid="active-cue"');
    expect(gestureA).not.toContain("READ-ONLY");
    expect(gestureA).not.toContain('class="gate-chip"');
    expect(gestureA).not.toContain('data-testid="emergency-status"');
  });

  test("actionable controls stay (mic+capture / auto-build / guided demo)", () => {
    expect(gestureA).toContain('data-testid="mic-capture-button"');
    expect(gestureA).toContain('data-testid="auto-build-button"');
    expect(gestureA).toContain('data-testid="guided-demo-button"');
  });

  test("a LIVE emergency still shows its banner in gesture mode", () => {
    const html = renderToStaticMarkup(
      <ProjectorApp
        initialSnapshot={{ ...demoProjectorSnapshot, emergencyStopTriggered: true }}
        urlSearch="?live=0&wall=A&view=ideas&gesture=1"
      />,
    );
    expect(html).toContain('data-testid="emergency-status"');
    expect(html).toContain("EMERGENCY STOP");
  });

  test("desk mode keeps every status readout for debugging", () => {
    const desk = renderToStaticMarkup(<ProjectorApp initialSnapshot={demoProjectorSnapshot} />);
    expect(desk).toContain('data-testid="listening-indicator"');
    expect(desk).toContain('data-testid="active-cue"');
    expect(desk).toContain("READ-ONLY · NON-AUTHORITATIVE");
    expect(desk).toContain('data-testid="emergency-status"');
  });
});

// CONTROL DOCK (calm wall): the always-visible control row folded behind ONE
// "⚙ Controls" affordance (ControlDock.tsx). Hover — mouse :hover or a dwell
// cursor's data-dwell-hot, FleetScroll-style — expands the popover tray, and
// ~4s after every cursor leaves it collapses again. SSR renders the tray
// MARKUP with the dock collapsed (data-expanded="false"; CSS hides it), so
// the moved buttons stay assertable by testid.
describe("control dock: one calm affordance replaces the button row", () => {
  const html = renderToStaticMarkup(<ProjectorApp initialSnapshot={demoProjectorSnapshot} />);
  const trayIdx = html.indexOf('data-testid="control-dock-tray"');
  // The dock is the header's last element; everything between the tray marker
  // and the header's closing tag is INSIDE it.
  const headerEndIdx = html.indexOf("</header>");

  test("the dock button renders, collapsed by default", () => {
    expect(html).toContain('data-testid="control-dock" data-expanded="false"');
    expect(html).toContain('data-testid="control-dock-button"');
    expect(html).toContain("⚙ Controls");
    expect(trayIdx).toBeGreaterThan(-1);
    expect(headerEndIdx).toBeGreaterThan(trayIdx);
  });

  test("the routine controls render INSIDE the dock tray", () => {
    for (const id of [
      'data-testid="mic-capture-button"',
      'data-testid="auto-build-button"',
      'data-testid="research-mode-button"',
      'data-testid="qr-import-button"',
      'data-testid="guest-hands-button"',
      'data-testid="guided-demo-button"',
    ]) {
      const idx = html.indexOf(id);
      expect(idx).toBeGreaterThan(trayIdx);
      expect(idx).toBeLessThan(headerEndIdx);
    }
  });

  test("alert-state chrome stays OUTSIDE the dock: emergency banner + the muted room's Unmute", () => {
    // The emergency banner precedes (is outside) the dock.
    expect(html.indexOf('data-testid="emergency-status"')).toBeLessThan(trayIdx);
    // The muted room's Unmute SAFETY control never folds behind the hover.
    const muted = renderToStaticMarkup(
      <ProjectorApp initialSnapshot={{ ...demoProjectorSnapshot, muted: true, listening: false }} />,
    );
    const unmuteIdx = muted.indexOf('data-testid="unmute-button"');
    expect(unmuteIdx).toBeGreaterThan(-1);
    expect(unmuteIdx).toBeLessThan(muted.indexOf('data-testid="control-dock-tray"'));
  });

  test("gesture mode carries the same single dock (the toggle is a .ctl-button → XL dwell target)", () => {
    const gesture = renderToStaticMarkup(
      <ProjectorApp initialSnapshot={demoProjectorSnapshot} urlSearch="?live=0&wall=A&view=ideas&gesture=1" />,
    );
    expect(gesture).toContain('data-testid="control-dock-button"');
    expect(gesture).toContain('data-testid="control-dock" data-expanded="false"');
  });

  test("expanded (test seam): tray buttons stay plain enabled <button>s for dwell targeting", () => {
    const open = renderToStaticMarkup(
      <ControlDock initialExpanded>
        <button type="button" data-testid="docked-button">
          Auto-Build
        </button>
      </ControlDock>,
    );
    expect(open).toContain('data-testid="control-dock" data-expanded="true"');
    expect(open).toContain('data-testid="docked-button"');
    expect(open).not.toContain("disabled");
  });

  test("collapse timing: ~4s of no hover-hot/:hover anywhere folds the dock", () => {
    expect(DOCK_COLLAPSE_MS).toBeGreaterThanOrEqual(3_000);
    expect(DOCK_COLLAPSE_MS).toBeLessThanOrEqual(6_000);
    expect(dockCollapseDue(DOCK_COLLAPSE_MS - 1)).toBe(false);
    expect(dockCollapseDue(DOCK_COLLAPSE_MS + 1)).toBe(true);
  });
});

// CORNER-LOCKED CONTINUOUS SCENE: with ?gesture=1&wall=A|B the two projector
// windows stop being independent vantage points and render ONE continuous 3D
// world wrapping the physical 90° corner — a rigid camera pair (shared eye,
// yaws exactly 90° apart, 90° horizontal FOV; math unit-tested in
// corner-lock.test.ts), surfaced on the scene container as data-corner-lock.
// The desk-only scene chrome (scene-controls cluster + hide menu) would
// duplicate on both walls, so it does not render in gesture mode at all; the
// keyboard shortcuts (G / L / F / Z / `) keep working.
describe("corner-locked two-wall gesture mode", () => {
  test("?gesture=1&wall=A|B: the scene is corner-locked and content stays FULL on both walls", () => {
    for (const wall of ["A", "B"]) {
      const html = renderToStaticMarkup(
        <ProjectorApp initialSnapshot={demoProjectorSnapshot} urlSearch={`?live=0&wall=${wall}&gesture=1`} />,
      );
      expect(html).toContain('data-corner-lock="true"');
      // No scene-content filtering: every idea and every build, both windows.
      expect(html).toContain(`data-idea-count="${demoProjectorSnapshot.ideas?.length ?? -1}"`);
      expect(html).toContain(`data-tree-count="${demoProjectorSnapshot.processes.length}"`);
    }
  });

  test("gesture mode hides the duplicated desk chrome (scene controls) on BOTH walls", () => {
    for (const wall of ["A", "B"]) {
      const html = renderToStaticMarkup(
        <ProjectorApp initialSnapshot={demoProjectorSnapshot} urlSearch={`?live=0&wall=${wall}&gesture=1`} />,
      );
      expect(html).not.toContain('data-testid="scene-controls"');
      expect(html).not.toContain('data-testid="scene-mode-button"');
      expect(html).not.toContain('data-testid="scene-zen-button"');
      expect(html).not.toContain('data-testid="hide-menu"');
    }
  });

  test("desk mode + camera-less wall windows keep the scene controls and stay unlocked", () => {
    const desk = renderToStaticMarkup(<ProjectorApp initialSnapshot={demoProjectorSnapshot} />);
    expect(desk).toContain('data-testid="scene-controls"');
    expect(desk).toContain('data-corner-lock="false"');
    // A bare two-wall projection without cameras (?wall= but no gesture) keeps
    // its independent per-window vantage + desk controls.
    const wallOnly = renderToStaticMarkup(
      <ProjectorApp initialSnapshot={demoProjectorSnapshot} urlSearch="?live=1&wall=A&view=ideas" />,
    );
    expect(wallOnly).toContain('data-testid="scene-controls"');
    expect(wallOnly).toContain('data-corner-lock="false"');
    // ?gesture=1 with NO wall (single-window gesture demo): the dwell layer
    // mounts and desk chrome hides, but there is no pair to corner-lock into.
    const gestureNoWall = renderToStaticMarkup(
      <ProjectorApp initialSnapshot={demoProjectorSnapshot} urlSearch="?live=0&gesture=1" />,
    );
    expect(gestureNoWall).toContain('data-corner-lock="false"');
    expect(gestureNoWall).not.toContain('data-testid="scene-controls"');
  });
});

// FLAT-LOCKED two-wall pair (?flat=1&wall=A|B): the flat-rig sibling of the
// corner lock — two side-by-side projections on ONE wall render halves of a
// single wide frustum (flat-lock.ts / flat-lock.test.ts), surfaced on the
// scene container as data-flat-lock. It applies in desk AND gesture mode
// (the physical wall is flat either way) and wins over the corner lock.
describe("flat-locked two-wall pair", () => {
  test("?flat=1&wall=A|B: the scene is flat-locked (desk mode) and content stays FULL on both walls", () => {
    for (const wall of ["A", "B"]) {
      const html = renderToStaticMarkup(
        <ProjectorApp initialSnapshot={demoProjectorSnapshot} urlSearch={`?live=1&wall=${wall}&flat=1`} />,
      );
      expect(html).toContain('data-flat-lock="true"');
      // No scene-content filtering: every idea and every build, both windows.
      expect(html).toContain(`data-idea-count="${demoProjectorSnapshot.ideas?.length ?? -1}"`);
      expect(html).toContain(`data-tree-count="${demoProjectorSnapshot.processes.length}"`);
    }
  });

  test("?flat=1 in gesture mode replaces the corner lock (one rigid rig at a time)", () => {
    const html = renderToStaticMarkup(
      <ProjectorApp initialSnapshot={demoProjectorSnapshot} urlSearch="?live=0&wall=A&gesture=1&flat=1" />,
    );
    expect(html).toContain('data-flat-lock="true"');
    expect(html).toContain('data-corner-lock="false"');
  });

  test("flat lock needs a wall identity; the pinch camera COMPOSES with it (shared orbit)", () => {
    // No ?wall=: a single window has no half to render — stays unlocked.
    const noWall = renderToStaticMarkup(
      <ProjectorApp initialSnapshot={demoProjectorSnapshot} urlSearch="?live=1&flat=1" />,
    );
    expect(noWall).toContain('data-flat-lock="false"');
    // ?hands= does NOT defeat the flat pair (unlike corner lock): the pinch
    // camera orbits the SHARED panorama — every window applies the identical
    // stream-fed deltas, so the pair stays continuous while it spins.
    const hands = renderToStaticMarkup(
      <ProjectorApp initialSnapshot={demoProjectorSnapshot} urlSearch="?live=1&wall=A&flat=1&hands=1" />,
    );
    expect(hands).toContain('data-flat-lock="true"');
    // And plain desk walls without ?flat=1 keep their independent vantages.
    const plain = renderToStaticMarkup(
      <ProjectorApp initialSnapshot={demoProjectorSnapshot} urlSearch="?live=1&wall=A&view=ideas" />,
    );
    expect(plain).toContain('data-flat-lock="false"');
  });
});

// MULTI-SOURCE FUSION: &fusion= may list several cursor servers (camera
// fusion + the arcade joystick bridge); the gesture layer opens one client
// per source and merges every stream into the same dwell pipeline.
describe("fusionSources: the &fusion= param as a source list", () => {
  test("a single URL stays a single source; a comma-separated list splits", () => {
    expect(fusionSources("ws://localhost:8770")).toEqual(["ws://localhost:8770"]);
    expect(fusionSources("ws://localhost:8770,ws://localhost:8771")).toEqual([
      "ws://localhost:8770",
      "ws://localhost:8771",
    ]);
  });

  test("blanks are dropped: empty string, padding, trailing/doubled commas", () => {
    expect(fusionSources("")).toEqual([]);
    expect(fusionSources(" ws://a:1 , ws://b:2 ")).toEqual(["ws://a:1", "ws://b:2"]);
    expect(fusionSources("ws://a:1,,")).toEqual(["ws://a:1"]);
  });
});

// MERGED MIC+CAPTURE (live-room request): "mic on" and "capturing" are ONE
// button — activating unmutes + starts the browser mic AND turns Idea Capture
// on; deactivating stops both. The two separate controls are gone; 'm' and 'c'
// both drive the merged behavior (see App.tsx keyboard map).
describe("merged mic + capture control", () => {
  test("a single mic-capture button replaces the separate mic and capture controls", () => {
    const html = renderToStaticMarkup(<ProjectorApp initialSnapshot={demoProjectorSnapshot} />);
    expect(countOccurrences(html, 'data-testid="mic-capture-button"')).toBe(1);
    expect(html).not.toContain('data-testid="mic-button"');
    expect(html).not.toContain('data-testid="capture-button"');
    expect(html).not.toContain('data-testid="mic-control"');
  });

  test("inactive by default: the button invites '🎤 Capture idea'", () => {
    const html = renderToStaticMarkup(<ProjectorApp initialSnapshot={demoProjectorSnapshot} />);
    expect(html).toContain('data-testid="mic-capture-button" data-state="off"');
    expect(html).toContain("Capture idea");
    expect(html).not.toContain("● Capturing");
  });

  test("a capturing snapshot lights the merged button up as the live indicator", () => {
    const html = renderToStaticMarkup(
      <ProjectorApp initialSnapshot={{ ...demoProjectorSnapshot, captureMode: true }} />,
    );
    expect(html).toContain('data-testid="mic-capture-button" data-state="on"');
    expect(html).toContain("● Capturing");
  });
});

// CURSOR VISIBILITY (live-room request v2): the per-person cursor dot is
// HIDDEN by default and the on-wall toggle button is GONE — dwell rings are
// the pointing feedback. localStorage "1" is the only opt-in.
describe("gesture cursor dots (hidden default, no toggle)", () => {
  test("no cursor toggle button renders in any dwell mode", () => {
    const gestureWall = renderToStaticMarkup(
      <ProjectorApp initialSnapshot={demoProjectorSnapshot} urlSearch="?live=0&wall=A&gesture=1" />,
    );
    expect(gestureWall).not.toContain('data-testid="cursor-toggle-button"');
    const mouseDwell = renderToStaticMarkup(
      <ProjectorApp initialSnapshot={demoProjectorSnapshot} urlSearch="?live=0&dwell=mouse" />,
    );
    expect(mouseDwell).not.toContain('data-testid="cursor-toggle-button"');
  });

  test("the stored preference parses: only an explicit '1' shows the dots", () => {
    expect(cursorDotsFromStored(null)).toBe(false); // first visit → hidden
    expect(cursorDotsFromStored("1")).toBe(true);
    expect(cursorDotsFromStored("0")).toBe(false);
  });
});

// AUTO-CALIBRATION OVERLAY: wall-bound windows watch the /api/autocal proxy
// and flip into a fullscreen calibration surface whenever the python
// calibrator (gesturewall.autocal) is running. The static renderer cannot
// poll, so the `initialOverlay.calibration` seam boots the overlay with a
// calibrator state (same pattern as selected/slideshowUpid/qrOpen).
describe("auto-calibration overlay: walls flip into calibration mode", () => {
  test("hidden by default: a wall window with no calibrator state renders the room", () => {
    const html = renderToStaticMarkup(
      <ProjectorApp initialSnapshot={demoProjectorSnapshot} urlSearch="?live=1&wall=A&view=ideas" />,
    );
    expect(html).not.toContain('data-testid="calibration-overlay"');
  });

  test("non-wall (desk) windows never mount the overlay, even with a state seam", () => {
    const html = renderToStaticMarkup(
      <ProjectorApp
        initialSnapshot={demoProjectorSnapshot}
        initialOverlay={{ calibration: { phase: "idle", marker: null, msg: "waiting" } }}
      />,
    );
    expect(html).not.toContain('data-testid="calibration-overlay"');
  });

  test("idle: near-black surface with the big wall letter, ready text, and the dwellable Start sweep button", () => {
    const html = renderToStaticMarkup(
      <ProjectorApp
        initialSnapshot={demoProjectorSnapshot}
        urlSearch="?live=1&wall=A&view=ideas"
        initialOverlay={{ calibration: { phase: "idle", marker: null, msg: "waiting" } }}
      />,
    );
    expect(html).toContain('data-testid="calibration-overlay"');
    expect(html).toContain('data-phase="idle"');
    expect(html).toContain('data-testid="calibration-letter"');
    expect(html).toContain("calibration ready");
    // Dwellable: a plain <button> (the dwell selector targets enabled buttons).
    expect(html).toContain('data-testid="calibration-start-button"');
    expect(html).toContain("Start sweep");
  });

  test("running: the white disc renders ONLY for this window's wall, carrying the marker geometry", () => {
    const running = {
      phase: "running" as const,
      marker: { wall: "A", u: 0.5, v: 0.25, r: 0.11 },
      msg: "sweeping",
    };
    const wallA = renderToStaticMarkup(
      <ProjectorApp
        initialSnapshot={demoProjectorSnapshot}
        urlSearch="?live=1&wall=A&view=ideas"
        initialOverlay={{ calibration: running }}
      />,
    );
    expect(wallA).toContain('data-phase="running"');
    expect(wallA).toContain('data-testid="calibration-disc"');
    expect(wallA).toContain('data-u="0.5"');
    expect(wallA).toContain('data-v="0.25"');
    expect(wallA).toContain('data-r="0.11"');
    // Measurement fidelity: no idle chrome pollutes the running surface.
    expect(wallA).not.toContain('data-testid="calibration-start-button"');
    expect(wallA).not.toContain('data-testid="calibration-letter"');

    // The OTHER wall shows the pure-black surface with NO disc while A's
    // marker is up (each projector sweeps its own marker sequence).
    const wallB = renderToStaticMarkup(
      <ProjectorApp
        initialSnapshot={demoProjectorSnapshot}
        urlSearch="?live=1&wall=B&view=builds"
        initialOverlay={{ calibration: running }}
      />,
    );
    expect(wallB).toContain('data-testid="calibration-overlay"');
    expect(wallB).toContain('data-phase="running"');
    expect(wallB).not.toContain('data-testid="calibration-disc"');
  });

  test("done shows the checkmark; error shows the calibrator's message", () => {
    const done = renderToStaticMarkup(
      <ProjectorApp
        initialSnapshot={demoProjectorSnapshot}
        urlSearch="?live=1&wall=A&view=ideas"
        initialOverlay={{ calibration: { phase: "done", marker: null, msg: "ok" } }}
      />,
    );
    expect(done).toContain('data-testid="calibration-done"');
    expect(done).toContain("✓");

    const error = renderToStaticMarkup(
      <ProjectorApp
        initialSnapshot={demoProjectorSnapshot}
        urlSearch="?live=1&wall=A&view=ideas"
        initialOverlay={{ calibration: { phase: "error", marker: null, msg: "camera 1 saw nothing" } }}
      />,
    );
    expect(error).toContain('data-testid="calibration-error"');
    expect(error).toContain("camera 1 saw nothing");
  });

  test("discGeometry: exact showDot parity — fraction radius, 46px floor, disc centered on (u*W, v*H)", () => {
    const g = discGeometry({ wall: "A", u: 0.5, v: 0.25, r: 0.11 }, 1920, 1080);
    expect(g.radius).toBeCloseTo(1080 * 0.11);
    expect(g.left).toBeCloseTo(0.5 * 1920 - g.radius);
    expect(g.top).toBeCloseTo(0.25 * 1080 - g.radius);
    // The 46px floor survives tiny fractions; a null r falls back to 0.11.
    expect(discGeometry({ wall: "A", u: 0, v: 0, r: 0.01 }, 800, 600).radius).toBe(46);
    expect(discGeometry({ wall: "A", u: 0, v: 0, r: null }, 1920, 1080).radius).toBeCloseTo(1080 * 0.11);
  });

  test("parseAutocalState: {up:false} and junk mean 'no calibrator' (overlay stays down)", () => {
    expect(parseAutocalState({ up: false })).toBeNull();
    expect(parseAutocalState(null)).toBeNull();
    expect(parseAutocalState({ phase: "warming" })).toBeNull();
    expect(parseAutocalState({ phase: "idle", marker: null, msg: "waiting" })).toEqual({
      phase: "idle",
      marker: null,
      msg: "waiting",
    });
    expect(
      parseAutocalState({ phase: "running", marker: { wall: "B", u: 0.1, v: 0.9, r: 0.16 }, msg: "sweeping" }),
    ).toEqual({ phase: "running", marker: { wall: "B", u: 0.1, v: 0.9, r: 0.16 }, msg: "sweeping" });
  });

  test("poll cadences: a cheap resting probe, tight tracking while a calibrator runs", () => {
    expect(AUTOCAL_POLL_ABSENT_MS).toBe(3_000);
    expect(AUTOCAL_POLL_ACTIVE_MS).toBe(150);
  });
});

// IDEA ACTION CARD: "✓ Done — build it" moved OUT of the top status bar into a
// contextual card that opens when an idea orb is clicked in the scene. The
// static renderer can't click the WebGL orb, so the `initialOverlay.ideaCard`
// seam (same pattern as selected/slideshowUpid/qrOpen) boots the card open.
describe("idea action card: contextual Done UX replaces the top-bar button", () => {
  const armedSnapshot = {
    ...demoProjectorSnapshot,
    // Empty ledger → the primary suggestion is the lone (id null) orb.
    ideas: [],
    ideaSettle: { armed: true, title: "a dashboard tool", firesInMs: 5_000 },
  };

  test("no card open → no Done button anywhere (top bar included), even while armed", () => {
    const html = renderToStaticMarkup(<ProjectorApp initialSnapshot={armedSnapshot} />);
    expect(html).not.toContain('data-testid="idea-done-button"');
    expect(html).not.toContain('data-testid="idea-action-card"');
  });

  test("card open on the primary suggestion: pitch + confidence + armed countdown + Done + close", () => {
    const html = renderToStaticMarkup(
      <ProjectorApp initialSnapshot={armedSnapshot} initialOverlay={{ ideaCard: { id: null } }} />,
    );
    expect(html).toContain('data-testid="idea-action-card"');
    expect(html).toContain("Turn the meeting notes into a blocker announcer.");
    expect(html).toContain("82% confident");
    expect(html).toContain('data-testid="idea-done-button"');
    expect(html).toContain("Done — build it");
    expect(html).toContain("(5s)");
    expect(html).toContain('data-testid="idea-card-close"');
  });

  test("card open on a ledger idea shows THAT idea's pitch — no settle countdown", () => {
    const html = renderToStaticMarkup(
      <ProjectorApp initialSnapshot={demoProjectorSnapshot} initialOverlay={{ ideaCard: { id: "idea_retro_wall" } }} />,
    );
    expect(html).toContain('data-testid="idea-action-card"');
    expect(html).toContain("A retro wall that clusters this week");
    expect(html).toContain('data-testid="idea-done-button"');
    expect(html).not.toContain("(5s)");
  });

  test("a card whose idea is gone from the snapshot never renders (auto-close contract)", () => {
    const html = renderToStaticMarkup(
      <ProjectorApp initialSnapshot={demoProjectorSnapshot} initialOverlay={{ ideaCard: { id: "idea_vanished" } }} />,
    );
    expect(html).not.toContain('data-testid="idea-action-card"');
    expect(html).not.toContain('data-testid="idea-done-button"');
  });

  test("guided idea step shows heard title + countdown + Done when armed, listening hint otherwise", async () => {
    const { GuidedDemo } = await import("./guided/GuidedDemo");
    const { startGuided } = await import("./guided/machine");
    const ideaState = { ...startGuided(demoProjectorSnapshot), step: "idea" as const };
    const noop = () => undefined;
    const props = {
      state: ideaState,
      micState: "live" as const,
      micError: null,
      onPopOrb: noop,
      onRecord: noop,
      onSkip: noop,
      onExit: noop,
      onFinish: noop,
      onDone: noop,
    };

    const armedHtml = renderToStaticMarkup(<GuidedDemo {...props} snapshot={armedSnapshot} />);
    expect(armedHtml).toContain('data-testid="guided-done-button"');
    expect(armedHtml).toContain("a dashboard tool");
    expect(armedHtml).toContain("Building in 5s");

    // Done is ALWAYS pressable during the idea step — it builds from the
    // transcript (or advances the step) even before anything is armed.
    const idleHtml = renderToStaticMarkup(<GuidedDemo {...props} snapshot={demoProjectorSnapshot} />);
    expect(idleHtml).toContain('data-testid="guided-done-button"');
    expect(idleHtml).toContain('data-testid="guided-settle-waiting"');
  });
});
