// Browser microphone capture for the Vibersyn projector.
//
// Captures the room mic via getUserMedia, downsamples to 16 kHz mono linear16
// PCM (the format the server's Deepgram ASR provider expects), and streams the
// raw bytes over the /api/mic WebSocket. A level callback drives the on-screen
// meter so you can confirm the mic is live even when no ASR key is configured.

const TARGET_SAMPLE_RATE = 16_000;
const FRAME_SIZE = 4096;

export interface MicCaptureOptions {
  onLevel?: (rms: number) => void;
  onStatus?: (status: "connecting" | "live" | "stopped") => void;
  onError?: (message: string) => void;
  // Which microphone: a case-insensitive substring of the device label
  // (?mic=wireless → "Wireless GO RX"). Absent → the ROOM-MIC preference
  // below picks an external mic over the laptop's builtin when one exists.
  deviceLabel?: string;
  // Surfaced once the stream is open, so the wall can SAY which physical mic
  // is feeding the room instead of leaving it to faith.
  onDevice?: (label: string) => void;
  // Fired when the capture SWITCHES devices mid-session (dead mic → fallback,
  // or the preferred mic coming back): the wall shows the reason, never a
  // silent swap.
  onSwitch?: (notice: string, label: string) => void;
}

export interface MicCaptureHandle {
  stop(): void;
}

// Pure device policy, unit-tested: an explicit label substring wins; otherwise
// PREFER AN EXTERNAL MIC over the builtin. A projector room's laptop sits in a
// corner — when somebody has plugged in a real room mic (a RØDE receiver, a
// USB conference puck), silently capturing the laptop's own mic instead is a
// deaf room that looks healthy. Builtin stays the honest fallback.
export function pickMicDevice(
  devices: ReadonlyArray<{ kind: string; label: string; deviceId: string }>,
  preferredLabel?: string,
): { deviceId: string; label: string } | null {
  const inputs = devices.filter((device) => device.kind === "audioinput" && device.deviceId.length > 0);
  if (inputs.length === 0) {
    return null;
  }
  if (preferredLabel !== undefined && preferredLabel.trim().length > 0) {
    const wanted = preferredLabel.trim().toLowerCase();
    const match = inputs.find((device) => device.label.toLowerCase().includes(wanted));
    if (match !== undefined) {
      return { deviceId: match.deviceId, label: match.label };
    }
    // An explicit ask that matches nothing falls through to the default policy
    // (the caller surfaces the label actually used, so the miss is visible).
  }
  const BUILTIN = /\b(built-?in|macbook|internal)\b/iu;
  const VIRTUAL = /virtual|aggregate|zoomaudio|blackhole|loopback|teams|soundflower/iu;
  const external = inputs.find((device) => !BUILTIN.test(device.label) && !VIRTUAL.test(device.label) && device.label.length > 0);
  // Fallback order matters: a real builtin beats the system "default" alias
  // beats whatever virtual device happens to enumerate first — a Zoom loopback
  // must never become the room's ears just by being at index 0.
  const chosen =
    external ??
    inputs.find((device) => BUILTIN.test(device.label)) ??
    inputs.find((device) => device.deviceId === "default") ??
    inputs[0]!;
  return { deviceId: chosen.deviceId, label: chosen.label };
}

// ── dead-mic detection (pure, unit-tested) ──────────────────────────────────
// A powered interface with no RF link (a RØDE receiver whose transmitters are
// off) keeps its device alive and delivers PURE DIGITAL SILENCE — the track
// looks healthy while feeding exact zeros. Real rooms always have a noise
// floor, so a sustained run of all-zero frames means the DEVICE is dead, not
// the room quiet. Live finding: the RØDE went down and the room sat deaf on a
// healthy-looking stream instead of switching to the laptop mic.
export const FLATLINE_MS = 8_000;

export interface FlatlineState {
  lastLiveAtMs: number;
}

// Fold one audio frame: returns the new state and whether the flatline
// threshold has been crossed. A frame with ANY nonzero sample resets the run.
export function foldFlatline(state: FlatlineState, maxAbsSample: number, nowMs: number): { state: FlatlineState; flatlined: boolean } {
  if (maxAbsSample > 1e-7) {
    return { state: { lastLiveAtMs: nowMs }, flatlined: false };
  }
  return { state, flatlined: nowMs - state.lastLiveAtMs >= FLATLINE_MS };
}

// The device to switch TO when the current one dies: re-run the room-mic
// policy over the remaining devices with the dead one excluded. Null when the
// dead device is the only input — nothing to switch to, only to report.
export function pickFallbackDevice(
  devices: ReadonlyArray<{ kind: string; label: string; deviceId: string }>,
  deadLabel: string,
): { deviceId: string; label: string } | null {
  const alive = devices.filter((device) => device.label !== deadLabel);
  const picked = pickMicDevice(alive);
  return picked !== null && picked.label !== deadLabel ? picked : null;
}

export async function startMicCapture(options: MicCaptureOptions = {}): Promise<MicCaptureHandle> {
  if (typeof navigator === "undefined" || navigator.mediaDevices?.getUserMedia === undefined) {
    throw new Error("This browser does not expose navigator.mediaDevices.getUserMedia");
  }

  options.onStatus?.("connecting");

  // Two-step open: device labels are hidden until the origin holds a live
  // audio permission, so open the default mic first, THEN enumerate and — if
  // the policy picks a different physical device — swap the stream to it.
  let mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const picked = pickMicDevice(devices, options.deviceLabel);
    const currentLabel = mediaStream.getAudioTracks()[0]?.label ?? "";
    if (picked !== null && picked.label.length > 0 && picked.label !== currentLabel) {
      const swapped = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: picked.deviceId },
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      for (const track of mediaStream.getTracks()) {
        track.stop();
      }
      mediaStream = swapped;
    }
  } catch {
    // Enumeration/swap failing must never cost the room its mic — the default
    // stream keeps capturing and the device label below reports the truth.
  }
  options.onDevice?.(mediaStream.getAudioTracks()[0]?.label ?? "unknown microphone");

  const AudioCtor: typeof AudioContext =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

  // Ask for a 16 kHz context so capture is already at the target rate; if the
  // platform refuses, we resample per frame below.
  let context: AudioContext;
  try {
    context = new AudioCtor({ sampleRate: TARGET_SAMPLE_RATE });
  } catch {
    context = new AudioCtor();
  }
  if (context.state === "suspended") {
    await context.resume();
  }

  const processor = context.createScriptProcessor(FRAME_SIZE, 1, 1);
  // Route through a muted gain node so ScriptProcessor keeps firing without
  // echoing the mic back out of the speakers.
  const silentSink = context.createGain();
  silentSink.gain.value = 0;

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${window.location.host}/api/mic`);
  socket.binaryType = "arraybuffer";

  let stopped = false;

  socket.addEventListener("open", () => {
    if (!stopped) {
      options.onStatus?.("live");
    }
  });
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      return;
    }
    try {
      const parsed = JSON.parse(event.data) as { type?: string; reason?: string };
      if (parsed.type === "error") {
        options.onError?.(`Server rejected mic stream: ${parsed.reason ?? "unknown"}`);
      }
    } catch {
      // Non-JSON control frame; ignore.
    }
  });
  socket.addEventListener("error", () => {
    options.onError?.("Mic WebSocket error");
  });

  // ── DEAD-MIC FAILOVER ─────────────────────────────────────────────────────
  // Two failure shapes, both switch to the next-best device with a visible
  // notice (never a silent swap): the device VANISHING (track "ended" /
  // devicechange) and the device FLATLINING (alive but feeding digital
  // silence — a receiver with no transmitter link). The socket and audio
  // context survive a switch; only the stream + source rebuild.
  let source = context.createMediaStreamSource(mediaStream);
  let flatline: FlatlineState = { lastLiveAtMs: Date.now() };
  let switching = false;

  const currentLabel = () => mediaStream.getAudioTracks()[0]?.label ?? "unknown microphone";

  const switchDevice = async (reason: string): Promise<void> => {
    if (switching || stopped) {
      return;
    }
    switching = true;
    const deadLabel = currentLabel();
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const fallback = pickFallbackDevice(devices, deadLabel);
      if (fallback === null) {
        options.onError?.(`${deadLabel} ${reason} — and no other microphone exists to switch to`);
        return;
      }
      const next = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: fallback.deviceId }, channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      for (const track of mediaStream.getTracks()) {
        track.stop();
      }
      try {
        source.disconnect();
      } catch {
        // already disconnected
      }
      mediaStream = next;
      source = context.createMediaStreamSource(mediaStream);
      source.connect(processor);
      watchTrackEnd();
      flatline = { lastLiveAtMs: Date.now() };
      options.onDevice?.(fallback.label);
      options.onSwitch?.(`${deadLabel} ${reason} — switched to ${fallback.label}`, fallback.label);
    } catch (error) {
      options.onError?.(`mic switch failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      switching = false;
    }
  };

  const watchTrackEnd = () => {
    const track = mediaStream.getAudioTracks()[0];
    if (track !== undefined) {
      track.onended = () => void switchDevice("disconnected");
    }
  };
  watchTrackEnd();
  const onDeviceChange = () => {
    // The current track may die without an "ended" (some drivers) — re-check.
    const track = mediaStream.getAudioTracks()[0];
    if (track === undefined || track.readyState === "ended") {
      void switchDevice("disconnected");
    }
  };
  navigator.mediaDevices.addEventListener?.("devicechange", onDeviceChange);

  processor.onaudioprocess = (event: AudioProcessingEvent) => {
    const input = event.inputBuffer.getChannelData(0);

    let sumSquares = 0;
    let maxAbs = 0;
    for (let i = 0; i < input.length; i += 1) {
      sumSquares += input[i] * input[i];
      const magnitude = Math.abs(input[i]);
      if (magnitude > maxAbs) {
        maxAbs = magnitude;
      }
    }
    options.onLevel?.(Math.sqrt(sumSquares / input.length));
    const fold = foldFlatline(flatline, maxAbs, Date.now());
    flatline = fold.state;
    if (fold.flatlined && !switching) {
      flatline = { lastLiveAtMs: Date.now() }; // re-arm so a failed switch retries after another window
      void switchDevice("went silent (dead device — digital flatline)");
    }

    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const pcm = floatTo16BitPCM(input, context.sampleRate, TARGET_SAMPLE_RATE);
    if (pcm.byteLength > 0) {
      socket.send(pcm.buffer);
    }
  };

  source.connect(processor);
  processor.connect(silentSink);
  silentSink.connect(context.destination);

  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    navigator.mediaDevices.removeEventListener?.("devicechange", onDeviceChange);
    processor.onaudioprocess = null;
    try {
      source.disconnect();
      processor.disconnect();
      silentSink.disconnect();
    } catch {
      // Already disconnected.
    }
    for (const track of mediaStream.getTracks()) {
      track.stop();
    }
    void context.close().catch(() => undefined);
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
    options.onStatus?.("stopped");
  };

  return { stop };
}

// Linear16 PCM little-endian, resampling by simple linear interpolation when the
// source rate differs from the target. Adequate for speech ASR.
function floatTo16BitPCM(input: Float32Array, sourceRate: number, targetRate: number): Int16Array {
  const samples = sourceRate === targetRate ? input : downsample(input, sourceRate, targetRate);
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out;
}

function downsample(input: Float32Array, sourceRate: number, targetRate: number): Float32Array {
  if (targetRate >= sourceRate) {
    return input;
  }
  const ratio = sourceRate / targetRate;
  const outLength = Math.floor(input.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const position = i * ratio;
    const low = Math.floor(position);
    const high = Math.min(low + 1, input.length - 1);
    const frac = position - low;
    out[i] = input[low] * (1 - frac) + input[high] * frac;
  }
  return out;
}
