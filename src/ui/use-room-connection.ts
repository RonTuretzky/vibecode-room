import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { ProjectorSnapshot } from "./types";

/** Owns initial synchronization, SSE, tab refocus, and reconnect cleanup. */
export function useRoomConnection({ enabled, mockModeRef, setSnapshot, setStreamLive }: {
  enabled: boolean;
  mockModeRef: RefObject<boolean>;
  setSnapshot: Dispatch<SetStateAction<ProjectorSnapshot>>;
  setStreamLive: Dispatch<SetStateAction<boolean>>;
}) {
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;

    let closed = false;
    let events: EventSource | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let backoffMs = 1_000;

    // Pull the authoritative snapshot from /api/state. Runs on first load and on
    // EVERY (re)connect / tab re-focus, so a server restart or dropped SSE stream
    // can never leave the projector frozen on stale state.
    async function syncState() {
      try {
        const response = await fetch("/api/state", { headers: { accept: "application/json" } });
        if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
          return;
        }
        const liveSnapshot = (await response.json()) as ProjectorSnapshot;
        if (!closed && !mockModeRef.current) {
          // Out-of-order guard: a resync ISSUED before a state change can
          // RESOLVE after that change's SSE push — applying it blindly would
          // revert the wall to pre-change state with nothing left to correct
          // it (no further push comes). Never let a fetched snapshot roll the
          // clock back over one the stream already delivered.
          setSnapshot((current) =>
            typeof current.updatedAt === "string" &&
            typeof liveSnapshot.updatedAt === "string" &&
            liveSnapshot.updatedAt < current.updatedAt
              ? current
              : liveSnapshot,
          );
        }
      } catch {
        // Transient (e.g. server restarting); the reconnect loop will retry.
      }
    }

    function openStream() {
      if (closed || typeof EventSource === "undefined") {
        return;
      }
      const source = new EventSource("/api/events");
      events = source;
      source.addEventListener("open", () => {
        backoffMs = 1_000; // healthy connection — reset backoff
        void syncState(); // resync current state immediately on (re)connect
      });
      source.addEventListener("snapshot", (messageEvent) => {
        if (closed || mockModeRef.current) {
          return;
        }
        try {
          setSnapshot(JSON.parse((messageEvent as MessageEvent).data) as ProjectorSnapshot);
          setStreamLive(true);
        } catch {
          // Ignore a malformed frame; the next push or a resync recovers.
        }
      });
      // Lightweight mic byte-counter ticks: merge into the current snapshot's
      // mic section without a full-snapshot parse (the server no longer pushes
      // whole snapshots just to move this counter).
      source.addEventListener("mic", (messageEvent) => {
        if (closed || mockModeRef.current) {
          return;
        }
        try {
          const mic = JSON.parse((messageEvent as MessageEvent).data) as ProjectorSnapshot["mic"];
          setSnapshot((current) => ({ ...current, mic }));
        } catch {
          // Ignore a malformed frame; the next push or a resync recovers.
        }
      });
      source.addEventListener("error", () => {
        // The stream dropped (server restart / network blip). Tear it down and
        // reconnect with capped exponential backoff so the tab self-heals instead
        // of silently going stale — the root cause of "the bubble stopped showing".
        source.close();
        if (closed) {
          return;
        }
        // SAY SO. Reconnecting silently meant a killed server left the wall
        // projecting a confident, frozen room forever — same status chips, same
        // last transcript line, still reading "listening". Nobody in the room
        // could tell a quiet room from a dead one. The banner clears itself the
        // moment a frame lands again.
        setStreamLive(false);
        reconnectTimer = setTimeout(openStream, backoffMs);
        backoffMs = Math.min(backoffMs * 2, 15_000);
      });
    }

    // Re-focusing the tab may have missed pushes while backgrounded/disconnected.
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void syncState();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    void syncState();
    openStream();

    return () => {
      closed = true;
      events?.close();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, mockModeRef, setSnapshot, setStreamLive]);

}
