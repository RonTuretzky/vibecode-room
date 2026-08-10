import type { ProjectorProcess } from "./types";

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
}

export function RecordSteerToggle({ process, kind }: RecordSteerToggleProps) {
  const recording = process.steering === true;
  const arm = () => {
    void fetch(`/api/process/${encodeURIComponent(process.upid)}/select`, { method: "POST" }).catch(() => undefined);
  };
  const stop = () => {
    void fetch("/api/process/select/clear", { method: "POST" }).catch(() => undefined);
  };
  return recording ? (
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
