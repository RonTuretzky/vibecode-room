import { useEffect, useRef, useState } from "react";
import type { ProjectorSnapshot } from "../types";
import { buildsOf } from "../buildloop";
import {
  PRACTICE_ORB_COUNT,
  focusProcess,
  guidedLanes,
  guidedNotice,
  lanesAllFailed,
  stepNumber,
  type GuidedState,
} from "./machine";

/**
 * Guided demo overlay — the coached, projector-friendly walkthrough of the
 * KICKOFF/IDEA phase (see ./machine.ts for the rescoped step contract: the
 * demo ends at the deck's "How should we continue?" decision; a "Build it for
 * real" pick fires the commission as an epilogue, never waited on).
 *
 * Big glass panels over the live room; EVERYTHING shown is real room state
 * (the machine in ./machine.ts reads only the live snapshot). The overlay
 * container is pointer-events:none so the room stays interactive/dwellable
 * through it; only the cards, orbs and buttons take input — and every control
 * is a <button>, so the gesture dwell layer targets them automatically.
 */

export interface GuidedDemoProps {
  state: GuidedState;
  snapshot: ProjectorSnapshot;
  micState: "off" | "connecting" | "live";
  micError: string | null;
  // Practice orb popped (orientation).
  onPopOrb: () => void;
  // The big Record button: REALLY unmute + capture + auto-build + mic.
  onRecord: () => void;
  onSkip: () => void;
  onExit: () => void;
  // Story step complete.
  onFinish: () => void;
  // "Done — build it": accept the armed idea NOW instead of waiting out the
  // settle countdown (idea step).
  onDone: () => void;
}

const STEP_TITLES: Record<GuidedState["step"], string> = {
  orientation: "Point with your hand",
  record: "Start the room recording",
  idea: "Describe your idea",
  race: "Watch the concepts race",
  decide: "How should we continue?",
};

// Practice-orb resting spots (viewport %), spread so a visitor sweeps the wall.
const ORB_SPOTS: ReadonlyArray<{ left: string; top: string }> = [
  { left: "24%", top: "34%" },
  { left: "50%", top: "22%" },
  { left: "74%", top: "38%" },
];

export function GuidedDemo({
  state,
  snapshot,
  micState,
  micError,
  onPopOrb,
  onRecord,
  onSkip,
  onExit,
  onFinish,
  onDone,
}: GuidedDemoProps) {
  // Which practice orbs this run has popped (local render state; the machine
  // holds only the count). GuidedDemo unmounts on exit, so re-entry is fresh.
  const [popped, setPopped] = useState<readonly boolean[]>(() =>
    Array.from({ length: PRACTICE_ORB_COUNT }, () => false),
  );
  // Transient celebration when the spoken idea REALLY became a project.
  const [celebrate, setCelebrate] = useState(false);
  const prevStepRef = useRef(state.step);
  useEffect(() => {
    const prev = prevStepRef.current;
    prevStepRef.current = state.step;
    if (prev === "idea" && (state.step === "race" || state.step === "decide")) {
      setCelebrate(true);
      const timer = setTimeout(() => setCelebrate(false), 3_200);
      return () => clearTimeout(timer);
    }
  }, [state.step]);

  const notice = guidedNotice(state, snapshot);
  const step = state.step;
  const slim = step === "decide";

  return (
    <div className={`guided-demo guided-step-${step}`} data-testid="guided-demo" data-step={step}>
      {celebrate ? (
        <div className="guided-celebrate" data-testid="guided-celebrate" role="status">
          🎉 Idea captured — the room is sketching concepts
        </div>
      ) : null}

      {step === "orientation" ? (
        <div className="guided-orbs" data-testid="guided-orbs">
          {ORB_SPOTS.map((spot, index) =>
            popped[index] ? (
              <div
                key={index}
                className="practice-orb popped"
                data-testid="practice-orb-popped"
                style={{ left: spot.left, top: spot.top }}
                aria-hidden="true"
              />
            ) : (
              <button
                key={index}
                type="button"
                className="practice-orb"
                data-testid="practice-orb"
                style={{ left: spot.left, top: spot.top, animationDelay: `${index * 0.7}s` }}
                aria-label={`Practice orb ${index + 1} — point and hold to pop`}
                onClick={() => {
                  setPopped((current) => current.map((was, i) => (i === index ? true : was)));
                  onPopOrb();
                }}
              >
                <span className="practice-orb-core" aria-hidden="true" />
              </button>
            ),
          )}
        </div>
      ) : null}

      {step === "record" ? (
        <div className="guided-record-stage">
          <button
            type="button"
            className="guided-record"
            data-testid="guided-record-button"
            onClick={onRecord}
            aria-label="Start recording — unmutes the room and turns on Idea Capture"
          >
            <span className="guided-record-dot" aria-hidden="true" />
            Start Recording
          </button>
        </div>
      ) : null}

      <section className={`guided-card${slim ? " slim" : ""}`} data-testid="guided-card">
        <header className="guided-head">
          <span className="guided-eyebrow">
            guided demo · step {stepNumber(step)} of 5
          </span>
          <h2 className="guided-title">{STEP_TITLES[step]}</h2>
        </header>

        {notice !== null ? (
          <p className="guided-notice" data-testid="guided-notice" role="alert">
            ⚠ {notice}
          </p>
        ) : null}

        {step === "orientation" ? (
          <OrientationBody poppedCount={state.orbsPopped} />
        ) : null}
        {step === "record" ? (
          <RecordBody snapshot={snapshot} micState={micState} micError={micError} />
        ) : null}
        {step === "idea" ? <IdeaBody snapshot={snapshot} micState={micState} onDone={onDone} /> : null}
        {step === "race" ? <RaceBody state={state} snapshot={snapshot} /> : null}
        {step === "decide" ? <DecideBody state={state} snapshot={snapshot} /> : null}

        <footer className="guided-actions">
          {step === "decide" ? (
            <button
              type="button"
              className="ctl-button guided-finish"
              data-testid="guided-finish-button"
              onClick={onFinish}
            >
              ✓ Finish
            </button>
          ) : (
            <button
              type="button"
              className="ctl-button guided-skip"
              data-testid="guided-skip-button"
              onClick={onSkip}
              title="Skip this step."
            >
              Skip ▸
            </button>
          )}
          <button
            type="button"
            className="ctl-button guided-exit"
            data-testid="guided-exit-button"
            onClick={onExit}
            title="Exit the guided demo (Esc)."
          >
            ✕ Exit
          </button>
        </footer>
      </section>
    </div>
  );
}

function OrientationBody({ poppedCount }: { poppedCount: number }) {
  return (
    <div className="guided-body">
      <p className="guided-lede">
        Open your hand and <strong>point at the wall</strong>. Whatever you aim
        at grows and glows — <strong>hold still</strong> and a ring fills around
        it. When the ring completes, that&rsquo;s your click.
      </p>
      <p className="guided-sub">
        Practice: pop the {PRACTICE_ORB_COUNT} floating orbs. Point at one, hold
        until the ring closes.
      </p>
      <p className="guided-progress" data-testid="guided-orb-progress">
        {poppedCount} / {PRACTICE_ORB_COUNT} popped
      </p>
    </div>
  );
}

function RecordBody({
  snapshot,
  micState,
  micError,
}: {
  snapshot: ProjectorSnapshot;
  micState: "off" | "connecting" | "live";
  micError: string | null;
}) {
  return (
    <div className="guided-body">
      <p className="guided-lede">
        Point at the big <strong>Start Recording</strong> button and hold. It
        really unmutes the room, turns on Idea Capture and Auto-Build, and
        starts the microphone — from here on, the room is listening.
      </p>
      <div className="guided-status-row" data-testid="guided-record-status">
        <span className={`guided-chip ${snapshot.muted ? "pending" : "ok"}`}>
          {snapshot.muted ? "muted" : "unmuted ✓"}
        </span>
        <span className={`guided-chip ${snapshot.captureMode ? "ok" : "pending"}`}>
          {snapshot.captureMode ? "capturing ✓" : "capture off"}
        </span>
        <span className={`guided-chip ${micState === "live" ? "ok" : "pending"}`}>
          {micState === "live" ? "mic live ✓" : micState === "connecting" ? "mic starting…" : "mic off"}
        </span>
      </div>
      {micError !== null ? (
        <p className="guided-sub guided-mic-error" data-testid="guided-mic-error">
          Mic problem: {micError}
        </p>
      ) : null}
    </div>
  );
}

function IdeaBody({
  snapshot,
  micState,
  onDone,
}: {
  snapshot: ProjectorSnapshot;
  micState: "off" | "connecting" | "live";
  onDone: () => void;
}) {
  const lines = snapshot.transcript.slice(-4);
  const settle = snapshot.ideaSettle;
  const armed = settle?.armed === true;
  return (
    <div className="guided-body">
      <p className="guided-lede">
        <strong>Say an idea out loud</strong> — and take your time describing
        it. The room transcribes you live and listens for a buildable idea; it
        waits for a natural pause before kicking anything off, so keep talking
        until you&rsquo;ve said the whole thing.
      </p>
      {armed ? (
        <div className="guided-settle" data-testid="guided-settle">
          {settle?.title ? (
            <p className="guided-settle-heard">
              Heard: <strong>{settle.title}</strong>
            </p>
          ) : null}
          <p className="guided-settle-countdown">
            {settle?.firesInMs !== null && settle?.firesInMs !== undefined
              ? `Building in ${Math.max(1, Math.ceil(settle.firesInMs / 1000))}s — keep talking to refine, or hit Done.`
              : "Ready to build — keep talking to refine, or hit Done."}
          </p>
          <button
            type="button"
            className="ctl-button guided-done"
            data-testid="guided-done-button"
            onClick={onDone}
          >
            ✓ Done — build it
          </button>
        </div>
      ) : (
        <p className="guided-settle-waiting" data-testid="guided-settle-waiting">
          The room is listening — a Done button appears as soon as it has heard
          a buildable idea.
        </p>
      )}
      <div className="guided-transcript" data-testid="guided-transcript">
        {lines.length === 0 ? (
          <p className="guided-transcript-empty" data-testid="guided-transcript-empty">
            {micState === "live" ? "listening…" : "waiting for audio…"}
          </p>
        ) : (
          lines.map((line) => (
            <p key={`${line.time}-${line.speaker}-${line.text}`} className={`guided-tx guided-tx-${line.kind}`}>
              <strong>{line.speaker}</strong> {line.text}
            </p>
          ))
        )}
      </div>
    </div>
  );
}

function RaceBody({ state, snapshot }: { state: GuidedState; snapshot: ProjectorSnapshot }) {
  const lanes = guidedLanes(state, snapshot);
  const process = focusProcess(state, snapshot);
  const allFailed = lanesAllFailed(lanes);
  return (
    <div className="guided-body">
      <p className="guided-lede">
        {process !== null ? (
          <>
            <strong>{process.task.length > 0 ? process.task : process.callsign}</strong>{" "}
            is being sketched into competing concept MOCKS right now — the same
            idea, several sketches racing. The first mock ready opens the pitch
            deck.
          </>
        ) : (
          <>Waiting for a project… say an idea (or skip back) — no kickoff has started yet.</>
        )}
      </p>
      {lanes.length > 0 ? (
        <div className="guided-lanes" data-testid="guided-lanes">
          {/* DE-THEMED lanes: real per-lane telemetry, labeled generically —
              the room never presents its build backends as UI. */}
          {lanes.map((lane, index) => (
            <div
              key={lane.id}
              className={`guided-lane status-${lane.status}`}
              data-testid="guided-lane"
              data-status={lane.status}
            >
              <span className="guided-lane-label">Concept {index + 1}</span>
              <span className="guided-lane-status">
                {lane.status === "queued"
                  ? "queued…"
                  : lane.status === "building"
                    ? `${lane.progressLabel ?? "mocking…"}${lane.percent !== null ? ` · ${Math.round(lane.percent)}%` : ""}`
                    : lane.status === "ready"
                      ? "MOCK READY ✓"
                      : "FAILED"}
              </span>
              <span className="guided-lane-track" aria-hidden="true">
                <span
                  className="guided-lane-fill"
                  style={{
                    width:
                      lane.status === "ready"
                        ? "100%"
                        : lane.status === "failed"
                          ? "100%"
                          : `${Math.round(lane.percent ?? 0)}%`,
                  }}
                />
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {allFailed ? (
        <p className="guided-sub guided-all-failed" data-testid="guided-all-failed">
          Every lane failed — that&rsquo;s the honest state of this kickoff.
          Skip ahead, or exit and try another idea.
        </p>
      ) : null}
    </div>
  );
}

function DecideBody({ state, snapshot }: { state: GuidedState; snapshot: ProjectorSnapshot }) {
  const process = focusProcess(state, snapshot);
  const builds = process !== null ? buildsOf(process) : [];
  const hasDeck = builds.some((build) => build.slideshowUrl !== null);
  const readyPreview = builds.find((build) => build.status === "ready" && build.previewUrl !== null);
  return (
    <div className="guided-body">
      {hasDeck ? (
        <p className="guided-lede">
          The pitch deck is open — it was <strong>generated from the winning
          concept</strong>. Dwell a choice on its{" "}
          <strong>&ldquo;How should we continue?&rdquo;</strong> bar to finish:
          any choice completes the demo, and <strong>Build it for real</strong>{" "}
          commissions the full build as an epilogue (the wall keeps working
          after you&rsquo;re done).
        </p>
      ) : (
        <p className="guided-lede">
          The first mock finished <strong>without publishing a deck</strong>
          {readyPreview !== undefined && readyPreview.previewUrl !== null ? (
            <>
              {" — but its concept preview is real: "}
              <a href={readyPreview.previewUrl} target="_blank" rel="noreferrer">
                open preview ↗
              </a>
            </>
          ) : (
            " and no preview is up — that is the honest state of this kickoff."
          )}
          . Finish below to complete the demo.
        </p>
      )}
    </div>
  );
}
