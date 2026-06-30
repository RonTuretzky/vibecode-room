// Browser microphone capture for the Panopticon projector.
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
}

export interface MicCaptureHandle {
  stop(): void;
}

export async function startMicCapture(options: MicCaptureOptions = {}): Promise<MicCaptureHandle> {
  if (typeof navigator === "undefined" || navigator.mediaDevices?.getUserMedia === undefined) {
    throw new Error("This browser does not expose navigator.mediaDevices.getUserMedia");
  }

  options.onStatus?.("connecting");

  const mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });

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

  const source = context.createMediaStreamSource(mediaStream);
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

  processor.onaudioprocess = (event: AudioProcessingEvent) => {
    const input = event.inputBuffer.getChannelData(0);

    let sumSquares = 0;
    for (let i = 0; i < input.length; i += 1) {
      sumSquares += input[i] * input[i];
    }
    options.onLevel?.(Math.sqrt(sumSquares / input.length));

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
