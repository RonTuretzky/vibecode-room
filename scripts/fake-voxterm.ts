#!/usr/bin/env bun
// FAKE VOXTERM — the injected microphone.
//
// This is the ONLY fake in the room-harness's default mode, and it stands
// exactly where the outside world does: the speech recognizer. The production
// server reaches its recognizer through `Bun.spawn(["voxterm"])`
// (src/providers/asr/voxterm-source.ts defaultVoxTermSpawn), so putting a
// `voxterm` on the child's PATH replaces the recognizer WITHOUT ONE LINE OF
// PRODUCTION CHANGE. Everything downstream of this process — the /api/mic
// WebSocket, MicSession, ingestTranscript, the wake router, the record-window
// collector, the snapshot, SSE, the browser — is the real thing.
//
// Contract emitted here is production's own NDJSON segment IPC, documented in
// src/providers/asr/voxterm.ts:
//   {"utteranceId","text","final","speaker"?,"emittedAtMs"}
//
// Timing: frames are replayed against a wall clock from this process's start,
// so interim cadence and endpointing silence are real elapsed time, and the
// `emittedAtMs` stamp we write is the one production turns into the
// observation's `latencyMs` (voxterm.ts measuredLatencyMs) — i.e. the room
// measures OUR injection lag for us.
//
// HONESTY NOTE: this process is handed no audio. Production's own
// defaultVoxTermSpawn opens the child with `stdin: "ignore"` and drops the
// audio stream argument, so in voxterm mode the PCM the harness pushes over
// /api/mic is counted (`mic.bytesReceived`) and then discarded by the runtime.
// The harness reports that rather than pretending otherwise.
//
// Env contract (set by src/testing/room-harness.ts on the SERVER process, which
// Bun.spawn inherits into this child):
//   VIBERSYN_FAKE_VOXTERM_SCRIPT — path to a compiled-script JSON file
//                                  ({frames:[{atMs,utteranceId,text,final,speaker?}]}).
//                                  Re-read at every spawn, so one server can be
//                                  driven through many different conversations.
//   VIBERSYN_FAKE_VOXTERM_LEDGER — optional path; one NDJSON record is APPENDED
//                                  per emitted frame, stamped with the real
//                                  emit time. This is the "spoken at" end of
//                                  the latency ledger.

// argv carries `--session <marker>`, a string unique to the scratch room that
// launched this child. It exists purely so the harness can sweep leftovers with
// `pkill -f <marker>` — the env vars below are invisible to pkill.
//
// The room does NOT reliably kill this child on its own, and that is a
// production defect the harness exposes rather than papers over: closing the
// mic socket runs MicSession.stop(), which closes the audio stream — but
// VoxTermSpawnSource's cleanup lives in the `finally` of a for-await over the
// child's stdout, and a recognizer that (correctly) keeps its session open never
// ends that stream. So the generator never completes, `child.stop()` is never
// reached, and `await drained` inside MicSession.stop() never resolves either.
// Hence both the ppid watchdog below and the harness-side sweep.

import { appendFileSync, readFileSync } from "node:fs";

interface ScriptFrameRecord {
  atMs: number;
  utteranceId: string;
  text: string;
  final: boolean;
  speaker?: number | string;
}

const scriptPath = process.env.VIBERSYN_FAKE_VOXTERM_SCRIPT;
const ledgerPath = process.env.VIBERSYN_FAKE_VOXTERM_LEDGER;
const startedAtMs = Date.now();

// Watchdog: if the room process dies (or is SIGKILLed), this child is reparented
// and must not survive it. Nothing in a test run may outlive the test run.
const originalParentPid = process.ppid;
setInterval(() => {
  if (process.ppid !== originalParentPid) {
    process.exit(0);
  }
}, 500);

const frames = loadFrames(scriptPath);

for (const frame of frames) {
  await sleepUntil(startedAtMs + frame.atMs);
  const emittedAtMs = Date.now();
  const payload: Record<string, unknown> = {
    utteranceId: frame.utteranceId,
    text: frame.text,
    final: frame.final,
    startedAtMs,
    emittedAtMs,
  };
  if (frame.speaker !== undefined) {
    payload.speaker = frame.speaker;
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (ledgerPath !== undefined && ledgerPath.length > 0) {
    // Append-only so concurrent scratch rooms never clobber each other's ledger.
    appendFileSync(ledgerPath, `${JSON.stringify({ ...payload, scriptAtMs: frame.atMs })}\n`);
  }
}

// A real recognizer does NOT hang up when the talking stops — it keeps the
// session open and waits. Ending stdout here would end the ASR generator and
// make the room think the mic died (the exact lie replay mode tells, see
// src/server/composition.ts: the drain's finally clears #interim while
// #micActive stays true). So idle until something kills us: the ppid watchdog
// above, or the harness sweep. NOT the room — see the argv note at the top.
await new Promise<never>(() => {});

function loadFrames(path: string | undefined): ScriptFrameRecord[] {
  if (path === undefined || path.length === 0) {
    return [];
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // No script staged for this session: stay silent rather than crash, so a
    // mic session opened before any speak() behaves like a quiet room.
    return [];
  }
  if (raw.trim().length === 0) {
    return [];
  }
  const parsed = JSON.parse(raw) as { frames?: ScriptFrameRecord[] };
  return Array.isArray(parsed.frames) ? parsed.frames : [];
}

async function sleepUntil(targetMs: number): Promise<void> {
  const remaining = targetMs - Date.now();
  if (remaining > 0) {
    await Bun.sleep(remaining);
  }
}
