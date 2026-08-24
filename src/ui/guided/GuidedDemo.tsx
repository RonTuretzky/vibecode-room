import { useEffect, useRef, useState } from "react";
import type { ProjectorSnapshot } from "../types";
import { buildsOf } from "../buildloop";
import {
  PLANT_COPY,
  PRACTICE_ORB_COUNT,
  exitCopy,
  focusProcess,
  freshTranscript,
  guidedLanes,
  guidedNotice,
  guidedSettle,
  laneStatusLabel,
  lanesAllFailed,
  orientationCopy,
  raceSkippable,
  recordCopy,
  skipCopy,
  stepCount,
  stepNumber,
  stepTitle,
  type GuidedState,
  type PointerRig,
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
  // Which physical input moves the cursor — the coaching copy must describe
  // the real rig (machine.stepTitle/orientationCopy/recordCopy variants).
  pointer: PointerRig;
  // Practice orb popped (orientation).
  onPopOrb: () => void;
  // The big Record button: REALLY unmute + capture + auto-build + mic.
  onRecord: () => void;
  onSkip: () => void;
  onExit: () => void;
  // Story step complete.
  onFinish: () => void;
  // "🌱 Plant this idea": accept the armed idea NOW instead of waiting out the
  // settle countdown (idea step) — the accepted idea grows a real tree.
  onDone: () => void;
  // "↺ Start over" (idea step, two-stage confirm): re-stamps the server's
  // guided-hold boundary and re-watermarks the machine so the words so far
  // stop counting toward the plan. Nothing already built is touched.
  onStartOver: () => void;
  // "⚘ Choose its spot…" (race/decide, once the focus tree exists): enter
  // planting mode for the freshly-grown tree — click the ground to move it.
  // Null hides the affordance (step without a tree yet, or a rig without it).
  onPlantSpot?: (() => void) | null;
}

// Practice-orb resting spots (viewport %), spread so a visitor sweeps the wall.
// The rightmost spot stays clear of the fleet rail (left edge ≈ 1434px on the
// 1920px full view): 68% keeps the orb — even dwell-grown — off the rail.
const ORB_SPOTS: ReadonlyArray<{ left: string; top: string }> = [
  { left: "24%", top: "34%" },
  { left: "50%", top: "22%" },
  { left: "68%", top: "38%" },
];

export function GuidedDemo({
  state,
  snapshot,
  micState,
  micError,
  pointer,
  onPopOrb,
  onRecord,
  onSkip,
  onExit,
  onFinish,
  onDone,
  onStartOver,
  onPlantSpot = null,
}: GuidedDemoProps) {
  // Which practice orbs this run has popped (local render state; the machine
  // holds only the count). GuidedDemo unmounts on exit, so re-entry is fresh.
  const [popped, setPopped] = useState<readonly boolean[]>(() =>
    Array.from({ length: PRACTICE_ORB_COUNT }, () => false),
  );
  // Transient celebration when the spoken idea REALLY became a project.
  // HONEST gate: 🎉 fires only once a focus process exists — a skipped-through
  // run (no kickoff, focusUpid null) must not read as success. The adoption
  // may lag the idea→race edge by a snapshot, so the focusUpid transition
  // itself also triggers while the race/decide steps are up.
  const [celebrate, setCelebrate] = useState(false);
  const prevStepRef = useRef(state.step);
  const prevFocusRef = useRef(state.focusUpid);
  useEffect(() => {
    const prevStep = prevStepRef.current;
    const prevFocus = prevFocusRef.current;
    prevStepRef.current = state.step;
    prevFocusRef.current = state.focusUpid;
    const raceOrDecide = state.step === "race" || state.step === "decide";
    const enteredFromIdea = prevStep === "idea" && raceOrDecide;
    const adoptedNow = raceOrDecide && prevFocus === null && state.focusUpid !== null;
    if (state.focusUpid !== null && (enteredFromIdea || adoptedNow)) {
      setCelebrate(true);
      const timer = setTimeout(() => setCelebrate(false), 3_200);
      return () => clearTimeout(timer);
    }
  }, [state.step, state.focusUpid]);

  const notice = guidedNotice(state, snapshot);
  const step = state.step;
  const slim = step === "decide";
  const handsLive = state.handsLive === true;
  const rigCopy = orientationCopy(pointer);
  // The record step's whole job is already done when the mic streams into an
  // unmuted room — the big button never renders then (operator rule).
  const recordAlreadyLive = micState === "live" && !snapshot.muted;
  // The race refuses to be skipped while mocks genuinely build (the machine
  // enforces it; the overlay says it instead of showing a dead button).
  const skippable = step !== "race" || raceSkippable(state, snapshot);
  const skip = skipCopy(step, handsLive);
  const exit = exitCopy(step);

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
                aria-label={`Practice orb ${index + 1} — ${rigCopy.orbHint}`}
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

      {step === "record" && !recordAlreadyLive ? (
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
            guided demo · step {stepNumber(step, handsLive)} of {stepCount(handsLive)}
          </span>
          <h2 className="guided-title">{stepTitle(step, pointer)}</h2>
        </header>

        {notice !== null ? (
          <p className="guided-notice" data-testid="guided-notice" role="alert">
            ⚠ {notice}
          </p>
        ) : null}

        {step === "orientation" ? (
          <OrientationBody poppedCount={state.orbsPopped} copy={rigCopy} />
        ) : null}
        {step === "hands" ? <HandsBody onContinue={onSkip} /> : null}
        {step === "record" ? (
          <RecordBody
            snapshot={snapshot}
            micState={micState}
            micError={micError}
            pointer={pointer}
            alreadyLive={recordAlreadyLive}
          />
        ) : null}
        {step === "idea" ? (
          <IdeaBody state={state} snapshot={snapshot} micState={micState} onDone={onDone} onStartOver={onStartOver} />
        ) : null}
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
          ) : skippable ? (
            <button
              type="button"
              className="ctl-button guided-skip"
              data-testid="guided-skip-button"
              onClick={onSkip}
              title={skip.title}
            >
              {skip.label}
            </button>
          ) : null}
          {onPlantSpot !== null ? (
            <button
              type="button"
              className="ctl-button guided-plant"
              data-testid="guided-plant-button"
              onClick={onPlantSpot}
              title="Your idea's tree is growing — click the ground anywhere in the park to choose its spot (Esc keeps it where it is)."
            >
              ⚘ Choose its spot…
            </button>
          ) : null}
          <button
            type="button"
            className="ctl-button guided-exit"
            data-testid="guided-exit-button"
            onClick={onExit}
            title={`${exit.subtitle} (Esc)`}
          >
            {exit.label}
          </button>
        </footer>
        {!skippable ? (
          <p className="guided-race-locked" data-testid="guided-race-locked">
            The mocks are building — this step finishes itself when the first
            mock is ready; leaving the guide would not stop it.
          </p>
        ) : null}
        {/* The leave verb's truth, visible without hovering: what keeps
            running if the visitor walks away from the guide right now. */}
        <p className="guided-exit-note" data-testid="guided-exit-note">
          {exit.subtitle}
        </p>
      </section>
    </div>
  );
}

function OrientationBody({ poppedCount, copy }: { poppedCount: number; copy: ReturnType<typeof orientationCopy> }) {
  // Rig-true coaching (machine.orientationCopy): hand cameras, joystick or
  // mouse — never "point with your hand" at a visitor holding a lever.
  return (
    <div className="guided-body">
      <p className="guided-lede">{copy.lede}</p>
      <p className="guided-sub">{copy.practice}</p>
      <p className="guided-progress" data-testid="guided-orb-progress">
        {poppedCount} / {PRACTICE_ORB_COUNT} popped
      </p>
    </div>
  );
}

// The hands coaching step (only in the order when the pinch-camera rig is
// LIVE): teaches the REAL camera grammar — pinch-hold-drag orbits, both-hands
// pinch zooms, the palm depth-dolly flies. Pure coaching: the only advance is
// the explicit Continue button (routed through onSkip) — no fake state gate
// pretending to detect a "good enough" orbit.
function HandsBody({ onContinue }: { onContinue: () => void }) {
  return (
    <div className="guided-body">
      <p className="guided-lede">
        Your hands are LIVE on the room camera. <strong>Pinch and hold, then
        drag</strong> — the room orbits with your hand.{" "}
        <strong>Pinch with both hands</strong> and pull them apart or push them
        together to zoom.
      </p>
      <p className="guided-sub">
        To fly: <strong>palm toward the wall</strong> glides you in,{" "}
        <strong>palm back toward you</strong> pulls you out. Take a lap around
        the garden, then continue.
      </p>
      <button
        type="button"
        className="ctl-button guided-hands-continue"
        data-testid="guided-hands-continue-button"
        onClick={onContinue}
        title="Continue to the recording step — your hands stay live on the camera."
      >
        ✓ Got it — continue
      </button>
    </div>
  );
}

function RecordBody({
  snapshot,
  micState,
  micError,
  pointer,
  alreadyLive,
}: {
  snapshot: ProjectorSnapshot;
  micState: "off" | "connecting" | "live";
  micError: string | null;
  pointer: PointerRig;
  alreadyLive: boolean;
}) {
  return (
    <div className="guided-body">
      {alreadyLive ? (
        // Mic live + room unmuted: there is no button to press (it never
        // renders) — the truthful coaching is that the step completes off the
        // visitor's own speech once capture is on (the chips below say so).
        <p className="guided-lede" data-testid="guided-record-live">
          The room is <strong>already listening</strong> — the mic is live and
          the room is unmuted, so there is nothing to start. Say a few words
          and this step completes itself.
        </p>
      ) : (
        <p className="guided-lede">{recordCopy(pointer)}</p>
      )}
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
  state,
  snapshot,
  micState,
  onDone,
  onStartOver,
}: {
  state: GuidedState;
  snapshot: ProjectorSnapshot;
  micState: "off" | "connecting" | "live";
  onDone: () => void;
  onStartOver: () => void;
}) {
  // ONLY this demo run's speech and ideas: session history (old transcript
  // lines, a countdown armed before the demo entered) is behind the machine's
  // watermarks and never showcased as the visitor's own.
  const lines = freshTranscript(state, snapshot).slice(-4);
  const settle = guidedSettle(state, snapshot);
  const armed = settle !== null;
  // TWO-STAGE Start over (house rule for destructive acts — it discards the
  // described idea): first press arms the confirm, the second fires
  // onStartOver; no follow-through auto-disarms a few seconds later (the
  // TreeMenu delete/remove confirm pattern).
  const [restartArmed, setRestartArmed] = useState(false);
  useEffect(() => {
    if (!restartArmed) {
      return;
    }
    const timer = setTimeout(() => setRestartArmed(false), 6_000);
    return () => clearTimeout(timer);
  }, [restartArmed]);
  return (
    <div className="guided-body">
      <p className="guided-lede">
        <strong>Say your idea out loud</strong> — take your time and describe
        the whole thing. The room transcribes as you go and{" "}
        <strong>grows nothing until you plant it</strong>: your words only
        shape what it will make, they never launch it.
      </p>
      {armed ? (
        <div className="guided-settle" data-testid="guided-settle">
          {settle?.title ? (
            <p className="guided-settle-heard">
              Heard: <strong>{settle.title}</strong>
            </p>
          ) : null}
          <p className="guided-settle-countdown">
            Got it — keep talking to sharpen it, then{" "}
            <strong>{PLANT_COPY.label}</strong> when it&rsquo;s all said. That
            starts the concept race.
          </p>
        </div>
      ) : (
        <p className="guided-settle-waiting" data-testid="guided-settle-waiting">
          The room is listening for the shape of an idea. Describe it fully —
          nothing kicks off on its own — then plant it.
        </p>
      )}
      <div className="guided-idea-actions">
        <button
          type="button"
          className="ctl-button guided-done"
          data-testid="guided-done-button"
          onClick={onDone}
          title={PLANT_COPY.subtitle}
        >
          {PLANT_COPY.label}
        </button>
        {restartArmed ? (
          <button
            type="button"
            className="ctl-button guided-restart is-armed"
            data-testid="guided-restart-button"
            data-armed="true"
            onClick={() => {
              setRestartArmed(false);
              onStartOver();
            }}
            title="Press again to really start over — the words so far stop counting toward the plan. Nothing already built is touched."
          >
            ↺ Really start over? Your words so far stop counting
          </button>
        ) : (
          <button
            type="button"
            className="ctl-button guided-restart"
            data-testid="guided-restart-button"
            data-armed="false"
            onClick={() => setRestartArmed(true)}
            title="Start the description over (asks once more): the room forgets what you said so far and listens fresh. Nothing already built is touched."
          >
            ↺ Start over
          </button>
        )}
      </div>
      <p className="guided-plant-sub">{PLANT_COPY.subtitle}</p>
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
      {process !== null && lanes.length > 0 ? (
        <div className="guided-lanes" data-testid="guided-lanes">
          {/* DE-THEMED lanes: real per-lane telemetry, labeled generically —
              the room never presents its build backends as UI. No focus
              process → no lanes: a skipped-through run must not show phantom
              "queued…" rows for a kickoff that never happened. */}
          {lanes.map((lane, index) => (
            <div
              key={lane.id}
              className={`guided-lane status-${lane.status}`}
              data-testid="guided-lane"
              data-status={lane.status}
            >
              <span className="guided-lane-label">Concept {index + 1}</span>
              <span className="guided-lane-status">{laneStatusLabel(lane)}</span>
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
          Continue without a mock, or leave the guide and try another idea.
        </p>
      ) : null}
    </div>
  );
}

function DecideBody({ state, snapshot }: { state: GuidedState; snapshot: ProjectorSnapshot }) {
  const process = focusProcess(state, snapshot);
  // HONEST no-kickoff state: a skipped-through run never built anything, so
  // there is no mock, no deck and nothing to decide — say so plainly instead
  // of narrating a build that never happened.
  if (process === null) {
    return (
      <div className="guided-body">
        <p className="guided-lede" data-testid="guided-no-kickoff">
          Nothing was kicked off this run — no idea was spoken and built, so
          there is no deck to decide on. Finish below to end the demo, or exit
          and try again with a spoken idea.
        </p>
      </div>
    );
  }
  const builds = buildsOf(process);
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
            " and no preview is up — that is the honest state of this kickoff"
          )}
          . Finish below to complete the demo.
        </p>
      )}
    </div>
  );
}
