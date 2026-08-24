import { useEffect, useRef, useState } from "react";
import type { ProjectorProcess, TranscriptLine } from "./types";
import { executionOf } from "./stage";

// Identity of a transcript line, stable across the interim→final rewrite of
// LATER lines (this one is already committed when it becomes a watermark).
export function lineKey(line: TranscriptLine): string {
  return `${line.time}|${line.speaker}|${line.text}`;
}

// The lines spoken INSIDE the record window. Pure so the watermark rule can be
// tested without a room: locate the line that was last present when the window
// armed and take everything after it; once the 40-line cap has pushed that line
// out of the window entirely, fall back to the arm-time clock stamp so the echo
// keeps working instead of silently going blank.
export function heardSince(
  transcript: readonly TranscriptLine[],
  armPoint: { key: string | null; at: string } | null,
): TranscriptLine[] {
  if (armPoint === null) {
    return [];
  }
  if (armPoint.key !== null) {
    for (let index = transcript.length - 1; index >= 0; index -= 1) {
      if (lineKey(transcript[index]!) === armPoint.key) {
        return transcript.slice(index + 1);
      }
    }
  }
  return transcript.filter((line) => line.time >= armPoint.at);
}

// The room goes on collecting FINALs for STEER_GRACE_MS (2_500, composition.ts)
// after the toggle is released, then cuts the branch and publishes the landing.
// Until that round trip has had its chance, "no landing yet" and "the room
// heard nothing" are the same observation from here — the drain writes no
// receipt at all for an empty window. Claiming the second one during the gap is
// the false negative this exists to prevent, so the receipt waits. Deliberately
// generous: a late receipt is a nuisance, a wrong one is the bug.
export const SETTLE_MS = 6_000;

/**
 * WHOSE RECEIPT IS THIS? Two ways a landing lies if taken at face value:
 *
 *  • STALE. The server never clears #selfLanding, so the prop still holds the
 *    PREVIOUS change's receipt for the seconds this one spends being cut —
 *    long enough to stamp a ✓ and someone else's branch name onto a graft that
 *    has not happened, or to report an old refusal over a fresh success.
 *    Freshness is decided by comparing the STAMP observed when this window
 *    armed, never by comparing clocks: browser/server skew cannot forge it.
 *  • WRONG TREE. selfLanding is the mirror's receipt. A "build" card that
 *    borrowed it would report "couldn't graft onto room/…" about a branch that
 *    has nothing to do with the fleet project it is steering.
 */
export function freshLanding<T extends { atMs: number }>(
  kind: "room" | "build",
  landing: T | null,
  atArm: number | null,
): T | null {
  if (kind !== "room" || landing === null || landing.atMs === atArm) {
    return null;
  }
  return landing;
}

// WHAT THE RECEIPT IS ALLOWED TO SAY.
export type ReceiptState =
  | "refused" // the server watched it fail, and why
  | "landed" // the server watched it land, and where
  | "cutting" // dispatched; the room has not answered YET
  | "sent" // build tree: registry.steer IS the dispatch, no receipt exists
  | "unanswered" // the room's window closed and no receipt ever came
  | "silent"; // the room genuinely heard nothing

/**
 * The post-Stop verdict, ranked so THE SERVER OUTRANKS THE ECHO.
 *
 * The old order asked this card's own echo first and short-circuited on an
 * empty one, so a card that had simply not been handed the transcript
 * announced "heard nothing — no graft was made" over a graft the room had
 * really cut, on the very branch the room was running. A surface must never
 * say a thing did not happen when it did.
 *
 * Pure and exported for the same reason heardSince is: the rank order IS the
 * honesty rule, and it has to be testable without a room (the static renderer
 * runs no effects, so the receipt never renders in SSR).
 */
export function receiptState(input: {
  kind: "room" | "build";
  // Words THIS CARD saw. 0 is not evidence of silence unless `wired`.
  words: number;
  // Was this card handed the transcript at all? A card that was not wired
  // cannot tell a silent room from its own blindness, and must not guess.
  wired: boolean;
  // THIS window's landing (freshness already applied), or null.
  landed: { branch: string | null; error: string | null } | null;
  // Has the room had its endpointing grace plus the branch cut?
  settled: boolean;
}): ReceiptState {
  const { kind, words, wired, landed, settled } = input;
  // 1. A landing is written for every self window that dispatched text
  //    (composition.ts #drainSteerGrace returns early on an empty slice), so
  //    its presence — refusal or not — is itself proof the room heard.
  if (landed !== null) {
    return landed.error !== null && landed.error.length > 0 ? "refused" : "landed";
  }
  // 2. A build tree has no receipt to wait for; there is nothing to outrank.
  if (kind === "build" && words > 0) {
    return "sent";
  }
  // 3. Still inside the room's answering window — say so, claim nothing.
  if (!settled) {
    return "cutting";
  }
  // 4. Only a card that was actually watching may report silence.
  if (wired && words === 0) {
    return "silent";
  }
  // 5. Words went out and nothing came back. Not a success, not a refusal —
  //    say exactly that rather than pick one. A blank here would be the silent
  //    no-op the room's rules forbid.
  return "unanswered";
}

// The words on the glass for each verdict. Exported with receiptState so the
// copy is asserted in tests instead of only the enum.
export function receiptLine(
  state: ReceiptState,
  input: { kind: "room" | "build"; words: number; landed: { branch: string | null; onto: string | null; error: string | null } | null },
): string {
  const { kind, words, landed } = input;
  const short = (name: string): string => name.replace(/^room\//u, "");
  switch (state) {
    case "refused":
      return `couldn't graft${landed?.onto != null ? ` onto ${short(landed.onto)}` : ""} — ${landed?.error ?? ""}`;
    case "landed":
      return landed?.branch == null
        ? "✓ graft taken — the room is growing this change"
        : landed.onto != null
          ? `✓ grafted onto ${short(landed.branch)} — it is growing this change`
          : `✓ graft taken — growing on ${short(landed.branch)}`;
    case "sent":
      return "✓ got it — shaping this build";
    case "silent":
      return kind === "room" ? "heard nothing — no graft was made" : "heard nothing — nothing was sent";
    case "cutting":
      return words === 0
        ? "stopped — checking what the room heard…"
        : kind === "room"
          ? "✓ heard — the room is cutting the branch…"
          : "✓ heard — sending this to the build…";
    default:
      return kind === "build"
        ? "stopped — no receipt came back from the room"
        : words > 0
          ? "heard you — the room hasn’t said where this landed"
          : "stopped — the room hasn’t said where this landed";
  }
}

/**
 * RECORD-A-CHANGE toggle — the one steering surface (live-room directive:
 * every "type a change" text input dies; typing at projector distance was
 * never real).
 *
 * Press → this process becomes the room's steering target
 * (POST /api/process/:upid/select) and EVERYTHING spoken routes into it as
 * revisions until the toggle is pressed again (POST /api/process/select/clear
 * → speech returns to ambient idea detection). The lit state comes straight
 * from the live snapshot's process.steering flag, so every window shows the
 * same truth and the button never lies about where words are going.
 */
export interface RecordSteerToggleProps {
  process: ProjectorProcess;
  // "room" = the mirror (words change the room's own source); "build" = a
  // fleet project (words steer its mocks/build).
  kind: "room" | "build";
  // The live transcript (finals + trailing interim): the toggle ECHOES the
  // words spoken since the window opened, so the operator sees what the room
  // has heard before pressing stop.
  //
  // REQUIRED, and `null` is the only way to say "this surface has none". It
  // used to be optional, and three call sites quietly omitted it with no
  // compile error — including the branch card for the branch the room was
  // running, which then echoed nothing while the room heard every word AND
  // announced "heard nothing — no graft was made" over a graft it had really
  // cut. `null` = not wired (the card refuses to claim either way);
  // `[]` = wired and the room said nothing.
  transcript: readonly TranscriptLine[] | null;
  // STEER AN EXISTING BRANCH. Absent (the default) = every spoken change is
  // its own fresh branch. Set = arm scoped to THIS branch, and the server
  // stands the room on it before the run, so the words grow the branch you
  // picked instead of a sibling of it.
  branch?: string | null;
  // The server's landing receipt for the last window (snapshot.selfLanding) —
  // where the change actually went, or why it went nowhere.
  landing?: { branch: string | null; onto: string | null; error: string | null; atMs: number } | null;
}

export function RecordSteerToggle({ process, kind, transcript, branch = null, landing = null }: RecordSteerToggleProps) {
  const recording = process.steering === true;
  // A card handed `null` is BLIND, not a witness to silence.
  const wired = transcript !== null;
  const lines = transcript ?? [];
  // WHEN THIS WINDOW OPENED, as the ROOM stamps it (HH:MM:SS UTC, the same
  // format the transcript lines carry). The card used to work this out alone,
  // by watching `steering` flip true — so a card that MOUNTED mid-window (the
  // branch popup opened after the graft was armed from the tend chip) put its
  // watermark at "now" and echoed nothing that had already been said. The room
  // knows; it says so, and the server's stamp wins.
  const windowStamp = process.steeringSince ?? null;
  // WATERMARK BY CONTENT, NOT BY INDEX. The live transcript is capped at 40
  // lines server-side (MAX_LIVE_TRANSCRIPT_LINES), so in any real session the
  // array stops growing after a few minutes — an index watermark then slices
  // nothing forever and the echo goes permanently blank while the room is
  // plainly still hearing you. Remember the LINE that was last present when
  // the window armed; once even that line ages out of the cap, fall back to
  // the room's window stamp (or, on a server too old to send one, the clock
  // stamp taken at the same moment).
  const [armed, setArmed] = useState<{ key: string | null; at: string } | null>(null);
  const armedRef = useRef(false);
  const sawIdleRef = useRef(false);
  // WHICH WINDOW A LANDING BELONGS TO. The server never clears #selfLanding
  // (composition.ts writes it at the end of the drain and nothing resets it),
  // so the prop still holds the PREVIOUS change's receipt while this one is
  // being cut — long enough to stamp a ✓ and someone else's branch name onto a
  // graft that has not happened. Remember the stamp present at arm; only a
  // DIFFERENT stamp is this window's verdict. Compares stamps, never clocks,
  // so browser/server skew cannot forge freshness.
  const landingAtArmRef = useRef<number | null>(null);
  const [dispatched, setDispatched] = useState<string[] | null>(null);
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!recording) {
      sawIdleRef.current = true;
      armedRef.current = false;
      return;
    }
    if (armedRef.current) {
      return; // idempotent: StrictMode double-invokes effects
    }
    armedRef.current = true;
    landingAtArmRef.current = landing?.atMs ?? null;
    setArmed({
      // Only a card that WATCHED the flip may narrow the window with its own
      // content watermark; one that woke up inside the window must take the
      // room's stamp whole, or it silently drops everything said before it
      // opened.
      key: sawIdleRef.current && lines.length > 0 ? lineKey(lines[lines.length - 1]!) : null,
      at: windowStamp ?? new Date().toISOString().slice(11, 19),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);
  // The render-time fallback is what makes the echo work with no effects at
  // all (the static renderer, and the first paint of a card that opens
  // mid-window): the room's own stamp is enough to select this window's lines.
  const armPoint = armed ?? (windowStamp !== null ? { key: null, at: windowStamp } : null);
  // The window is still GATHERING after the toggle is released: the room keeps
  // collecting finals through its endpointing grace, so the last sentence
  // usually finalizes AFTER the release. Freezing the echo at stop under-
  // reported what was actually dispatched, and on a "build" card (whose only
  // witness is this echo) one short sentence spoken just before stop read as
  // "heard nothing".
  const collecting = recording || (dispatched !== null && !settled);
  const heard = heardSince(collecting ? lines : [], armPoint);
  const heardTexts = heard.map((line) => line.text).filter((text) => text.length > 0);
  // STICKY DISPATCH PANEL (live-room directive: stopping must NOT collapse to
  // idle — it read as the room losing the recording). On stop, the captured
  // words freeze into a receipt that stays until the operator presses Record
  // again (or the popup closes); the live run label rides beneath it.
  //
  // The freeze reads a REF, not `heard`. Keyed on [recording], the effect body
  // runs when `recording` is already false — so it closed over the not-
  // recording branch and froze an empty list every single time, in every room.
  const heardRef = useRef<string[]>([]);
  const wasRecordingRef = useRef(false);
  useEffect(() => {
    if (collecting) {
      heardRef.current = heardTexts;
    }
  }, [collecting, heardTexts.join(" ")]);
  useEffect(() => {
    if (recording) {
      wasRecordingRef.current = true;
      setDispatched(null);
      setSettled(false);
      return undefined;
    }
    if (wasRecordingRef.current) {
      wasRecordingRef.current = false;
      setDispatched(heardRef.current);
      const timer = setTimeout(() => setSettled(true), SETTLE_MS);
      return () => {
        clearTimeout(timer);
      };
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);
  // Keep absorbing the trailing finals the room is still collecting, so the
  // receipt lists the same words the dispatch actually carried.
  useEffect(() => {
    if (recording || settled || dispatched === null || heardTexts.length <= dispatched.length) {
      return;
    }
    setDispatched(heardTexts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, settled, dispatched, heardTexts.join(" ")]);
  const execution = executionOf(process);
  const runLabel = execution !== null && execution.status === "executing" ? execution.progressLabel : null;
  // ACKNOWLEDGE THE PRESS. The lit state derives only from the next pushed
  // snapshot, so over a slow link the button sat visually inert for the whole
  // round trip — measured 3.6s of nothing with a 3s delay on the select POST.
  // At projector distance that is a dead button, and the natural response is
  // to press it again. Show "arming" the instant it is pressed; the snapshot
  // still decides the real state, and a failure says so rather than sticking.
  const [pending, setPending] = useState<"arming" | "stopping" | null>(null);
  const [pressError, setPressError] = useState<string | null>(null);
  // The wall runs a three.js loop at ~8fps under load, so a React state update
  // took ~490ms to reach the glass — still a dead-feeling button. Stamp the
  // SAME attribute React manages, synchronously in the handler, so the press
  // is on screen at the next frame instead of after React's next render.
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const markPressed = (state: "arming" | "stopping") => {
    if (buttonRef.current !== null) {
      buttonRef.current.dataset.state = state;
    }
  };
  useEffect(() => {
    // Whatever the server says is the truth — it always wins over the guess.
    setPending(null);
  }, [recording]);
  const arm = () => {
    setPressError(null);
    markPressed("arming");
    setPending("arming");
    void fetch(`/api/process/${encodeURIComponent(process.upid)}/select`, {
      method: "POST",
      ...(branch === null
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify({ branch }) }),
    })
      .then((response) => {
        if (!response.ok) {
          setPending(null);
          setPressError(`could not start recording (${response.status})`);
        }
      })
      .catch(() => {
        setPending(null);
        setPressError("could not reach the room");
      });
  };
  const stop = () => {
    setPressError(null);
    markPressed("stopping");
    setPending("stopping");
    void fetch("/api/process/select/clear", { method: "POST" })
      .then((response) => {
        if (!response.ok) {
          setPending(null);
          setPressError(`could not stop recording (${response.status})`);
        }
      })
      .catch(() => {
        setPending(null);
        setPressError("could not reach the room");
      });
  };
  if (!recording && dispatched !== null) {
    // ── THE RECEIPT ────────────────────────────────────────────────────────
    // Ranked in receiptState, and THE SERVER OUTRANKS THE ECHO. An EMPTY
    // window must still never claim a change (the room once announced "✓ got
    // it" 342ms after a stop that captured nothing) — but "empty echo" is no
    // longer allowed to MEAN "empty window", because a card that was simply
    // never handed the transcript announced "heard nothing — no graft was
    // made" over a graft the room had really cut.
    //
    // A "build" tree gets NO landing — the room publishes selfLanding only for
    // its own mirror — and must not borrow the room's, or a fleet project's
    // card would report "couldn't graft onto room/…" about a branch that has
    // nothing to do with it.
    const landed = freshLanding(kind, landing, landingAtArmRef.current);
    const state = receiptState({ kind, words: dispatched.length, wired, landed, settled });
    const failing = state === "refused" || state === "silent" || state === "unanswered";
    return (
      <div className="record-steer-live" data-testid="record-steer-dispatched">
        <div className="record-steer-heard" aria-live="polite">
          <p
            className={failing ? "record-steer-got record-steer-empty" : "record-steer-got"}
            data-testid="record-steer-verdict"
            data-verdict={state}
          >
            {receiptLine(state, { kind, words: dispatched.length, landed })}
          </p>
          {dispatched.slice(-4).map((text, index) => (
            <p key={`${index}-${text.slice(0, 12)}`} className="record-steer-heard-line">
              {text}
            </p>
          ))}
          {runLabel !== null ? (
            <p className="record-steer-runlabel" data-testid="record-steer-runlabel">
              {runLabel}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          className="ctl-button record-steer"
          data-testid="record-steer-start"
          title={
            kind === "room"
              ? "Press, then speak — the room grows your words on a fresh branch."
              : "Press, then talk — everything you say goes into this until you press again."
          }
          onClick={() => {
            setDispatched(null);
            arm();
          }}
        >
          {kind === "room" ? "🌱 Graft another change" : "🎙 Record another change"}
        </button>
      </div>
    );
  }
  return recording ? (
    <div className="record-steer-live" data-testid="record-steer-live">
      <button
        type="button"
        className="ctl-button record-steer is-recording"
        data-testid="record-steer-stop"
        title="Everything you say is being recorded into this — press to stop."
        onClick={stop}
        ref={buttonRef}
        data-state={pending === "stopping" ? "stopping" : "recording"}
      >
        <span className="record-steer-dot" aria-hidden="true" />
        {pending === "stopping"
          ? "stopping…"
          : kind === "room"
            ? "● grafting — your words grow the change · tap to stop"
            : "Recording — your words shape this build · tap to stop"}
      </button>
      {heard.length > 0 ? (
        <div className="record-steer-heard" data-testid="record-steer-heard" aria-live="polite">
          {heard.slice(-4).map((line, index) => (
            <p key={`${index}-${line.text.slice(0, 12)}`} className="record-steer-heard-line">
              {line.text}
            </p>
          ))}
        </div>
      ) : (
        <p className="record-steer-heard-empty" data-testid="record-steer-heard-empty">
          listening — say the whole change, then tap stop
        </p>
      )}
    </div>
  ) : (
    <div className="record-steer-idle">
      <button
        type="button"
        ref={buttonRef}
        className={`ctl-button record-steer${pending === "arming" ? " is-pending" : ""}`}
        data-testid="record-steer-start"
        data-state={pending === "arming" ? "arming" : "idle"}
        title={
          kind === "room"
            ? branch === null
              ? "Press, then speak — the room grows your words on a fresh branch."
              : `Press, then speak — the room climbs onto ${branch} and grows your words THERE, not on a new branch.`
            : "Press, then talk — everything you say goes into this until you press again."
        }
        onClick={arm}
      >
        {pending === "arming"
          ? kind === "room"
            ? "🌱 starting…"
            : "🎙 starting…"
          : kind === "room"
            ? branch === null
              ? "🌱 Graft a change"
              : "🌱 Graft onto this branch"
            : "🎙 Record a change"}
      </button>
      {pressError !== null ? (
        <p className="record-steer-error" data-testid="record-steer-error">
          {pressError}
        </p>
      ) : null}
    </div>
  );
}
