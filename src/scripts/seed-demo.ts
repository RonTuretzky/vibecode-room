import { demoProjectorSnapshot } from "../ui/demo-data";
import type { ProjectorProcess, ProjectorSnapshot } from "../ui/types";

function listeningLabel(snapshot: ProjectorSnapshot): string {
  if (!snapshot.listening) {
    return "off";
  }

  return snapshot.muted ? "on, muted" : "on, unmuted";
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function processLine(process: ProjectorProcess, index: number): string {
  const selected = process.selected ? "selected" : "background";

  return [
    `${index + 1}. ${process.callsign} (${process.state}, ${selected})`,
    `   task: ${process.task}`,
    `   run: ${process.runId} / ${process.upid}`,
    `   model: ${process.model}`,
    `   progress: ${process.progress}% - ${process.progressLabel}`,
    `   last action: ${process.lastAction}`,
    `   last output: ${process.lastOutput}`,
  ].join("\n");
}

function renderSummary(snapshot: ProjectorSnapshot): string {
  const suggestion = snapshot.suggestion;
  const gate = suggestion.gate;
  const recentTranscript = snapshot.transcript.slice(-3);
  const recentTrace = snapshot.trace.slice(-3);

  return [
    "Vibersyn demo seed",
    "====================",
    "",
    `Session: ${snapshot.sessionId}`,
    `Updated: ${snapshot.updatedAt}`,
    `Global state: ${snapshot.globalState}`,
    `Listening: ${listeningLabel(snapshot)}`,
    `Active cue: ${snapshot.activeCue}`,
    `Emergency stop: ${snapshot.emergencyStopTriggered ? "triggered" : "clear"}`,
    "",
    "Audio",
    "-----",
    `Last spoken: ${snapshot.audio.lastSpoken}`,
    `Earcon: ${snapshot.audio.earcon}`,
    `Silence ratio: ${percent(snapshot.audio.silenceRatio)}`,
    "",
    "Processes",
    "---------",
    ...snapshot.processes.map(processLine),
    "",
    "Suggestion",
    "----------",
    `State: ${suggestion.state}`,
    `Pitch: ${suggestion.pitch}`,
    `Confidence: ${percent(suggestion.confidence)}`,
    `Gate: ${gate.words}/${gate.minWords} words, ${gate.seconds}/${gate.minSeconds} seconds`,
    "Questions:",
    ...suggestion.questions.map((question) => `- ${question}`),
    "",
    "Recent Transcript",
    "-----------------",
    ...recentTranscript.map((line) => `- [${line.time}] ${line.speaker}: ${line.text}`),
    "",
    "Trace",
    "-----",
    `Events: ${snapshot.trace.length}`,
    ...recentTrace.map((event) => `- ${event.event} (${event.correlationId})`),
  ].join("\n");
}

console.log(renderSummary(demoProjectorSnapshot));
