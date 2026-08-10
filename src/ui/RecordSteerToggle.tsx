import { useEffect, useState } from "react";
import type { ProjectorProcess, TranscriptLine } from "./types";
import { executionOf } from "./stage";

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
  // The live transcript (finals + trailing interim). When provided, the
  // toggle ECHOES the words spoken since it was armed — the operator sees
  // exactly what the window has heard before pressing stop (live-room
  // request: "show me the text I spoke in the recording component").
  transcript?: TranscriptLine[];
}

export function RecordSteerToggle({ process, kind, transcript }: RecordSteerToggleProps) {
  const recording = process.steering === true;
  // Everything after this watermark was spoken INSIDE the window. Length-based
  // (the interim line revises in place, finals append) — approximate across
  // an in-flight interim at arm time, exact for every final after it.
  const [armMark, setArmMark] = useState<number | null>(null);
  useEffect(() => {
    if (recording) {
      setArmMark((mark) => mark ?? (transcript?.length ?? 0));
    } else {
      setArmMark(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);
  const heard = recording && transcript !== undefined && armMark !== null ? transcript.slice(armMark) : [];
  // STICKY DISPATCH PANEL (live-room directive: stopping must NOT collapse to
  // idle — it read as the room losing the recording). On stop, the captured
  // words freeze into a "got it" panel that stays until the operator presses
  // Record again (or the popup closes); the live run label rides beneath it.
  const [dispatched, setDispatched] = useState<string[] | null>(null);
  useEffect(() => {
    if (!recording && armMark !== null) {
      // recording -> stopped: freeze what the window captured.
      setDispatched(heard.map((line) => line.text).filter((text) => text.length > 0));
    }
    if (recording) {
      setDispatched(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);
  const execution = executionOf(process);
  const runLabel = execution !== null && execution.status === "executing" ? execution.progressLabel : null;
  const arm = () => {
    void fetch(`/api/process/${encodeURIComponent(process.upid)}/select`, { method: "POST" }).catch(() => undefined);
  };
  const stop = () => {
    void fetch("/api/process/select/clear", { method: "POST" }).catch(() => undefined);
  };
  if (!recording && dispatched !== null) {
    return (
      <div className="record-steer-live" data-testid="record-steer-dispatched">
        <div className="record-steer-heard" aria-live="polite">
          <p className="record-steer-got">✓ got it — {kind === "room" ? "the room is building this change" : "shaping this build"}</p>
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
          title="Press, then talk — everything you say goes into this until you press again."
          onClick={() => {
            setDispatched(null);
            arm();
          }}
        >
          🎙 Record another change
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
      >
        <span className="record-steer-dot" aria-hidden="true" />
        Recording — your words {kind === "room" ? "change the room" : "shape this build"} · tap to stop
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
    <button
      type="button"
      className="ctl-button record-steer"
      data-testid="record-steer-start"
      title="Press, then talk — everything you say goes into this until you press again."
      onClick={arm}
    >
      🎙 {kind === "room" ? "Record a change to the room" : "Record a change"}
    </button>
  );
}
