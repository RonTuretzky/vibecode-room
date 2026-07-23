import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProjectorProcess } from "./types";
import { buildsOf } from "./buildloop";
import type { LifecycleAction, ProcessBuild } from "./buildloop";
import { BuildChips, ExecutionChip, ProcessControls } from "./BuildChips";
import { TakeHomeQr } from "./TakeHomeQr";
import { executionOf, stageOf } from "./stage";
import type { DecisionChoice } from "./stage";
import "./Slideshow.css";

// Project explainer deck presented as a POP-UP WINDOW floating over the room:
// a centered modal with a window title bar (inferred name + callsign + close
// X), a backdrop that dims the scene, and the generated interactive slideshow
// embedded as a large iframe body. It is opened from the room WITHOUT a phone
// (the fleet card's "Slides ▸"/"Deck ▸" button, a scene node click, or the
// guided demo's decide step) — the published Pages/QR path is a separate,
// take-home surface. ←/→ navigate slides, Esc or a backdrop click closes.
//
// Two slide sources merge into one deck:
//   - fixture slides (process.slides — mock-room explainer HTML, trusted), and
//   - LIVE slides: every backend build that published a REAL generated
//     slideshow (builds[].slideshowUrl) gets an embedded iframe slide with an
//     open-in-window escape hatch.
// The window chrome doubles as the per-process build HUD: the stage badge
// (CONCEPT / COMMISSIONED), the inferred project title, per-backend status
// chips (building pulses / mock ready / failed + Preview links), the
// execution chip once commissioned, and the pause/resume/halt lifecycle
// controls.
//
// GRACEFUL STATES: opening the window before any lane has published a deck
// (guided decide step, an eager scene click) never shows an empty iframe — the
// body renders "building the deck…" while lanes race, a clear failure message
// when every lane failed, and a "no deck published" note when lanes finished
// without one. The window only refuses to render (null) when the process has
// NO deck surface at all: neither fixture slides nor any build lane.
//
// DECK DWELL BRIDGE, half 1 (half 2 = the postMessage parser in stage.ts):
// the generated deck's own "How should we continue?" decision/answer slide (the
// template track's swipe cards) lives INSIDE the iframe, where the room's
// dwell-target system cannot reach (DOM scanning and elementFromPoint stop at
// the frame boundary — an iframe's buttons are never dwellable). So the room
// renders the SAME three answers as a native pinned bar under the deck
// (`deck-decision`): plain <button>s, hence automatic dwell targets, always
// visible whatever slide is showing. The in-iframe data-dwell buttons / swipe
// cards stay mouse/touch-operable and post `{type:"vibersyn:decision", choice}`
// to the parent, which the App routes to the exact same onDecision handler.

type DeckSlide =
  | { kind: "html"; title: string; html: string }
  | { kind: "live"; title: string; url: string; backend: string };

export interface SlideshowProps {
  process: ProjectorProcess;
  // App owns the POST + snapshot application (and the offline-demo fallback).
  onLifecycle: (upid: string, action: LifecycleAction) => void;
  onClose: () => void;
  // Open on THIS backend's live deck slide when it exists (guided demo: the
  // deck starts on whichever framework finished first). Null/absent = slide 0.
  initialBackend?: string | null;
  // "How should we continue?" decision/answer handler (concept stage only).
  // Absent = no decision bar (e.g. plain fixture decks with no build lanes).
  // Fed by BOTH the mirrored room-native buttons below AND the in-iframe swipe
  // answers (App bridges those via postMessage → the same handler).
  onDecision?: (choice: DecisionChoice) => void;
}

// What the pop-up window should show, decided purely from the deck surface:
//   - "none"     → don't open at all (no fixture slides AND no build lanes),
//   - "ready"    → at least one slide exists (fixture or a published live deck),
//   - "building" → lanes still racing, no deck published yet,
//   - "failed"   → every lane failed before publishing a deck,
//   - "empty"    → lanes finished but none published a deck.
// Exported + pure so the gating/graceful-state logic is unit-tested next to the
// component without a DOM.
export type DeckWindowState = "none" | "ready" | "building" | "failed" | "empty";

export function deckWindowState(hasSlides: boolean, builds: ProcessBuild[]): DeckWindowState {
  if (hasSlides) {
    return "ready";
  }
  if (builds.length === 0) {
    return "none";
  }
  if (builds.some((build) => build.status === "building")) {
    return "building";
  }
  if (builds.every((build) => build.status === "failed")) {
    return "failed";
  }
  return "empty";
}

export function Slideshow({ process, onLifecycle, onClose, initialBackend = null, onDecision }: SlideshowProps) {
  const builds = useMemo(() => buildsOf(process), [process]);
  const stage = stageOf(process);
  const execution = executionOf(process);
  const slides = useMemo<DeckSlide[]>(() => {
    const fixture: DeckSlide[] = (process.slides ?? []).map((slide) => ({
      kind: "html",
      title: slide.title,
      html: slide.html,
    }));
    const live: DeckSlide[] = builds
      .filter((build) => build.slideshowUrl !== null)
      .map((build) => ({
        kind: "live" as const,
        title: `Live deck — ${build.label}`,
        url: build.slideshowUrl as string,
        backend: build.backend as string,
      }));
    return [...fixture, ...live];
  }, [process.slides, builds]);

  const [index, setIndex] = useState(() => {
    if (initialBackend !== null) {
      const start = slides.findIndex((slide) => slide.kind === "live" && slide.backend === initialBackend);
      if (start !== -1) {
        return start;
      }
    }
    return 0;
  });
  const clamped = Math.min(index, Math.max(slides.length - 1, 0));

  const prev = useCallback(() => setIndex((i) => Math.max(i - 1, 0)), []);
  const next = useCallback(() => setIndex((i) => Math.min(i + 1, slides.length - 1)), [slides.length]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        // The window owns Escape while it is open — close it here (and stop the
        // room's global handlers) so the pop-up is self-sufficient.
        event.stopPropagation();
        onClose();
      } else if (event.key === "ArrowLeft") {
        event.stopPropagation();
        prev();
      } else if (event.key === "ArrowRight" || event.key === " ") {
        event.stopPropagation();
        next();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [prev, next, onClose]);

  const hasSlides = slides.length > 0;
  const windowState = deckWindowState(hasSlides, builds);
  // The window refuses to render only when there is NOTHING deck-shaped: no
  // fixture slides AND no build lanes. A process mid-build (lanes but no deck
  // yet) still opens the window — into a graceful "building…"/"failed" body.
  if (windowState === "none") {
    return null;
  }
  // Placeholder classification when there is no slide to show yet.
  const pending: Exclude<DeckWindowState, "none" | "ready"> = windowState === "ready" ? "empty" : windowState;

  const slide = hasSlides ? slides[clamped] : null;
  // The INFERRED project title headlines the window; the callsign stays as the
  // eyebrow so the room can still address the build by voice/keyboard.
  const title = process.task.length > 0 ? process.task : process.callsign;

  return (
    <div className="detail-overlay slideshow-overlay" data-testid="slideshow-overlay" onClick={onClose}>
      <article
        className="slideshow-card slideshow-window"
        data-testid="slideshow-card"
        role="dialog"
        aria-modal="true"
        aria-label={`${title} — project deck window`}
        onClick={(clickEvent) => clickEvent.stopPropagation()}
      >
        {/* WINDOW TITLE BAR: inferred name + callsign eyebrow on the left, the
            take-home QR (if published) and a big dwell-operable close X on the
            right. Plain <button>s, so the dwell layer targets the close. */}
        <header className="slideshow-head slideshow-titlebar">
          <div className="slideshow-titlebar-main">
            <span className="detail-eyebrow slideshow-callsign">
              project deck · {process.callsign} · {process.state}
            </span>
            <h2 className="slideshow-title" data-testid="slideshow-project">
              {title}
              {builds.length > 0 || execution !== null ? (
                <span
                  className={`stage-badge stage-${stage}`}
                  data-testid="deck-stage"
                  data-stage={stage}
                  title={
                    stage === "concept"
                      ? "Concept: fast mock lanes + pitch deck. Commission it to build for real."
                      : "Commissioned: the real subscription build is running (or done)."
                  }
                >
                  {stage === "concept" ? "🌱 CONCEPT" : "🌳 COMMISSIONED"}
                </span>
              ) : null}
            </h2>
          </div>
          {/* Window-chrome take-home QR: the published Pages URL, scannable
              from a phone at projector distance. */}
          {typeof process.publishedUrl === "string" && typeof process.publishedQrSvg === "string" ? (
            <TakeHomeQr url={process.publishedUrl} qrSvg={process.publishedQrSvg} size="deck" />
          ) : null}
          <button
            type="button"
            className="ctl-button slideshow-close"
            data-testid="slideshow-close"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close deck window"
          >
            ✕
          </button>
        </header>

        {builds.length > 0 || execution !== null ? (
          <div className="slideshow-builds" data-testid="slideshow-builds">
            <BuildChips builds={builds} stage={stage} />
            {execution !== null ? <ExecutionChip execution={execution} /> : null}
          </div>
        ) : null}
        {builds.length > 0 ? (
          /* Per-framework result tabs (the window's backend switcher): a READY
             build with a generated deck is dwell/click-switchable to its live
             slide; lanes still building or failed are labeled as such (disabled
             = not a dwell target). */
          <div className="deck-tabs" role="tablist" aria-label="Framework results" data-testid="deck-backend-tabs">
            {builds.map((build) => {
              const slideIndex = slides.findIndex(
                (slide) => slide.kind === "live" && slide.backend === (build.backend as string),
              );
              const openable = slideIndex !== -1;
              const current = openable && slideIndex === clamped;
              return (
                <button
                  key={build.backend}
                  type="button"
                  role="tab"
                  aria-selected={current}
                  className={`deck-tab status-${build.status}${current ? " active" : ""}`}
                  data-testid="deck-backend-tab"
                  data-backend={build.backend}
                  data-status={build.status}
                  disabled={!openable}
                  onClick={() => {
                    if (openable) {
                      setIndex(slideIndex);
                    }
                  }}
                  title={
                    openable
                      ? `Show the ${build.label} result.`
                      : build.status === "building"
                        ? `${build.label} is still building.`
                        : build.status === "failed"
                          ? `${build.label} failed.`
                          : `${build.label} published no deck.`
                  }
                >
                  <span className="deck-tab-label">{build.label}</span>
                  <span className="deck-tab-status">
                    {openable
                      ? "deck"
                      : build.status === "building"
                        ? (build.progressLabel ?? "building…")
                        : build.status === "failed"
                          ? "failed"
                          : "ready · no deck"}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}
        <ProcessControls upid={process.upid} state={process.state} onLifecycle={onLifecycle} />

        {slide !== null ? (
          <section className="slide" data-testid="slideshow-slide" data-slide-index={clamped}>
            <h3 className="slide-title">{slide.title}</h3>
            {slide.kind === "html" ? (
              /* Fixture-authored HTML (mock explainer decks), not user input. */
              <div className="slide-body" dangerouslySetInnerHTML={{ __html: slide.html }} />
            ) : (
              <div className="slide-body slide-live" data-testid="slideshow-live">
                <iframe
                  className="slide-live-frame"
                  data-testid="slideshow-live-frame"
                  src={slide.url}
                  title={slide.title}
                />
                <a
                  className="build-chip-link slide-live-open"
                  data-testid="slideshow-open-live"
                  href={slide.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open in window ↗
                </a>
              </div>
            )}
          </section>
        ) : (
          /* GRACEFUL EMPTY BODY — a window opened before any lane published a
             deck. Never an empty iframe: say what is happening instead. */
          <section
            className={`slide slide-placeholder placeholder-${pending}`}
            data-testid="deck-placeholder"
            data-deck-state={pending}
            aria-live="polite"
          >
            {pending === "building" ? (
              <div className="deck-placeholder-inner" data-testid="deck-building">
                <div className="deck-placeholder-spinner" aria-hidden="true" />
                <h3 className="slide-title">Building the deck…</h3>
                <p className="deck-placeholder-note">
                  The interactive slideshow appears here the moment a build lane publishes it.
                </p>
                <ul className="deck-placeholder-lanes">
                  {builds
                    .filter((build) => build.status === "building")
                    .map((build) => (
                      <li key={build.backend}>
                        <span className="deck-placeholder-lane-label">{build.label}</span>
                        <span className="deck-placeholder-lane-status">{build.progressLabel ?? "building…"}</span>
                      </li>
                    ))}
                </ul>
              </div>
            ) : pending === "failed" ? (
              <div className="deck-placeholder-inner" data-testid="deck-failed">
                <h3 className="slide-title">The deck couldn't be built</h3>
                <p className="deck-placeholder-note">
                  Every build lane failed before publishing a slideshow. Reshape the idea and try again.
                </p>
              </div>
            ) : (
              <div className="deck-placeholder-inner" data-testid="deck-empty">
                <h3 className="slide-title">No deck published yet</h3>
                <p className="deck-placeholder-note">
                  These lanes finished without publishing an interactive slideshow.
                </p>
              </div>
            )}
          </section>
        )}

        {/* The room-native "How should we continue?" decision/answer bar
            (concept stage with real build lanes only) — see the DECK DWELL
            BRIDGE note at the top of this file. Every choice is a plain
            <button>, so the dwell layer targets each one automatically, and the
            same choices arrive from the in-iframe swipe cards via postMessage. */}
        {onDecision !== undefined && stage === "concept" && builds.length > 0 ? (
          <div className="deck-decision" data-testid="deck-decision" role="group" aria-label="How should we continue?">
            <span className="deck-decision-title">How should we continue?</span>
            <div className="deck-decision-choices">
              <button
                type="button"
                className="deck-decision-btn decision-commission"
                data-testid="decision-commission"
                data-decision="commission"
                onClick={() => onDecision("commission")}
                title="Commission the real subscription build — the wall keeps building after the demo."
              >
                🚀 Build it for real
              </button>
              <button
                type="button"
                className="deck-decision-btn decision-iterate"
                data-testid="decision-iterate"
                data-decision="iterate"
                onClick={() => onDecision("iterate")}
                title="Keep talking — steer and reshape the concept with more ideas."
              >
                🔁 Keep shaping it
              </button>
              <button
                type="button"
                className="deck-decision-btn decision-done"
                data-testid="decision-done"
                data-decision="done"
                onClick={() => onDecision("done")}
                title="Leave it as a concept on the wall."
              >
                ✓ Keep it as a concept
              </button>
            </div>
          </div>
        ) : null}

        {hasSlides ? (
          <footer className="slideshow-nav">
            <button
              type="button"
              className="ctl-button slide-prev"
              data-testid="slide-prev"
              onClick={prev}
              disabled={clamped === 0}
            >
              ← Prev
            </button>
            <div className="slide-dots" role="tablist" aria-label="Slides">
              {slides.map((each, dotIndex) => (
                <button
                  key={`${each.title}-${dotIndex}`}
                  type="button"
                  role="tab"
                  aria-selected={dotIndex === clamped}
                  className={`slide-dot${dotIndex === clamped ? " active" : ""}`}
                  onClick={() => setIndex(dotIndex)}
                  title={each.title}
                />
              ))}
            </div>
            <button
              type="button"
              className="ctl-button slide-next"
              data-testid="slide-next"
              onClick={next}
              disabled={clamped === slides.length - 1}
            >
              Next →
            </button>
          </footer>
        ) : null}
      </article>
    </div>
  );
}
