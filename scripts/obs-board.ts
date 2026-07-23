#!/usr/bin/env bun
// CLI entrypoint for the REQ-16 observability board (src/obs/board.ts).
//
// The board app is read-only / non-authoritative / off-path: it renders from an
// in-process BoardEventBus (the same adapter its e2e test uses —
// test/e2e/board.e2e.ts constructs a BoardEventBus and feeds it snapshots).
// This script mounts the exported app standalone and bridges the live room
// server's /api/events SSE stream (seeded from /api/state) into that bus. The
// room snapshot is a superset of BoardSnapshot, so mapping is field-for-field.
//
// Usage:
//   PORT=8790 bun scripts/obs-board.ts
//
//   PORT               port for the board itself (default 8790; refuses 8788
//                      and 7331 — those belong to the live room / other tools)
//   VIBERSYN_ROOM_URL  live room base URL (default http://127.0.0.1:8788)
//
// The board stays up (serving its last snapshot) if the room is unreachable —
// it must never sit on the critical path.

import { BoardEventBus, createBoardApp, type BoardProcess, type BoardSnapshot } from "../src/obs/board";
import type { LogEvent } from "../src/types";

const RESERVED_PORTS = new Set([8788, 7331]);
const BOARD_STATES: ReadonlySet<BoardProcess["state"]> = new Set([
  "planning",
  "active",
  "paused",
  "halted",
  "completed",
  "blocked",
]);

const port = Number(process.env.PORT ?? "8790");
if (!Number.isInteger(port) || port <= 0) {
  console.error(`obs-board: invalid PORT ${JSON.stringify(process.env.PORT)}`);
  process.exit(1);
}
if (RESERVED_PORTS.has(port)) {
  console.error(`obs-board: refusing to bind reserved port ${port} (live room / tooling ports)`);
  process.exit(1);
}

const roomUrl = (process.env.VIBERSYN_ROOM_URL ?? "http://127.0.0.1:8788").replace(/\/+$/u, "");

// Map a live room snapshot (GET /api/state, SSE /api/events "snapshot" events)
// onto the board's BoardSnapshot shape. Defensive: unknown fields fall back to
// board defaults so a malformed frame never crashes the off-path board.
function toBoardPartial(room: Record<string, unknown>): Partial<BoardSnapshot> {
  const partial: Partial<BoardSnapshot> = {};
  if (typeof room.listening === "boolean") partial.listening = room.listening;
  if (typeof room.globalState === "string") partial.globalState = room.globalState;
  if (typeof room.activeCue === "string") partial.activeCue = room.activeCue;
  if (typeof room.emergencyStopTriggered === "boolean") {
    partial.emergencyStopTriggered = room.emergencyStopTriggered;
  }
  if (Array.isArray(room.processes)) {
    partial.processes = room.processes.map((raw): BoardProcess => {
      const process = (raw ?? {}) as Record<string, unknown>;
      const state = process.state as BoardProcess["state"];
      return {
        upid: String(process.upid ?? "unknown-upid"),
        runId: String(process.runId ?? "unknown-run"),
        callsign: String(process.callsign ?? "unknown"),
        state: BOARD_STATES.has(state) ? state : "active",
        selected: process.selected === true,
        lastOutput: String(process.lastOutput ?? ""),
        lastAction: String(process.lastAction ?? ""),
      };
    });
  }
  if (Array.isArray(room.trace)) {
    partial.trace = room.trace as LogEvent[];
  }
  return partial;
}

const bus = new BoardEventBus();
const app = createBoardApp(bus);

async function seedFromRoomState(): Promise<void> {
  const response = await fetch(`${roomUrl}/api/state`, { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) {
    throw new Error(`GET /api/state -> ${response.status}`);
  }
  bus.update(toBoardPartial((await response.json()) as Record<string, unknown>));
  console.log(`obs-board: seeded from ${roomUrl}/api/state`);
}

// Minimal SSE client: reads the room's /api/events stream and applies every
// "snapshot" frame to the bus. Reconnects forever with a small backoff.
async function followRoomEvents(): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(`${roomUrl}/api/events`);
      if (!response.ok || response.body === null) {
        throw new Error(`GET /api/events -> ${response.status}`);
      }
      console.log(`obs-board: following ${roomUrl}/api/events`);
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let boundary: number;
        while ((boundary = buffer.search(/\r?\n\r?\n/u)) !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/u, "");
          applySseFrame(frame);
        }
      }
      throw new Error("event stream ended");
    } catch (error) {
      console.warn(`obs-board: room stream unavailable (${(error as Error).message}); retrying in 2s`);
      await Bun.sleep(2_000);
    }
  }
}

function applySseFrame(frame: string): void {
  let eventName = "message";
  const dataLines: string[] = [];
  for (const line of frame.split(/\r?\n/u)) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (eventName !== "snapshot" || dataLines.length === 0) {
    return;
  }
  try {
    bus.update(toBoardPartial(JSON.parse(dataLines.join("\n")) as Record<string, unknown>));
  } catch (error) {
    console.warn(`obs-board: skipping malformed snapshot frame (${(error as Error).message})`);
  }
}

const server = Bun.serve({
  port,
  idleTimeout: 0, // board /events SSE clients stay open indefinitely
  fetch: (request) => app.fetch(request),
});

console.log(`obs-board: read-only board on http://127.0.0.1:${server.port} (room: ${roomUrl})`);
console.log(`obs-board: routes GET / | /health | /state | /events`);

seedFromRoomState().catch((error) => {
  console.warn(`obs-board: could not seed from room (${(error as Error).message}); board starts empty`);
});
void followRoomEvents();
