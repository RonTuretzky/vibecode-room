import { useCallback, useEffect, useState } from "react";
import type { ProjectorProcess } from "./types";

// Project explainer slideshow: a glass overlay deck opened by clicking a
// project in the 3D scene (when the process carries `slides`). ←/→ navigate,
// Esc or the backdrop closes. Slide bodies are trusted fixture HTML.

export interface SlideshowProps {
  process: ProjectorProcess;
  onClose: () => void;
}

export function Slideshow({ process, onClose }: SlideshowProps) {
  const slides = process.slides ?? [];
  const [index, setIndex] = useState(0);
  const clamped = Math.min(index, Math.max(slides.length - 1, 0));

  const prev = useCallback(() => setIndex((i) => Math.max(i - 1, 0)), []);
  const next = useCallback(() => setIndex((i) => Math.min(i + 1, slides.length - 1)), [slides.length]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "ArrowLeft") {
        event.stopPropagation();
        prev();
      } else if (event.key === "ArrowRight" || event.key === " ") {
        event.stopPropagation();
        next();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [prev, next]);

  if (slides.length === 0) {
    return null;
  }
  const slide = slides[clamped];

  return (
    <div className="detail-overlay slideshow-overlay" data-testid="slideshow-overlay" onClick={onClose}>
      <article
        className="slideshow-card"
        data-testid="slideshow-card"
        onClick={(clickEvent) => clickEvent.stopPropagation()}
      >
        <header className="slideshow-head">
          <div>
            <span className="detail-eyebrow">project deck</span>
            <h2 className="slideshow-title" data-testid="slideshow-project">
              {process.callsign} — {process.task}
            </h2>
          </div>
          <button type="button" className="ctl-button" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </header>

        <section className="slide" data-testid="slideshow-slide" data-slide-index={clamped}>
          <h3 className="slide-title">{slide.title}</h3>
          {/* Fixture-authored HTML (mock explainer decks), not user input. */}
          <div className="slide-body" dangerouslySetInnerHTML={{ __html: slide.html }} />
        </section>

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
      </article>
    </div>
  );
}
