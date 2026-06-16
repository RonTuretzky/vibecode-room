/**
 * Ground-truth corpus of room transcript segments.
 *
 * label: "pass"   → observe.pass (no action; background conversation noise)
 * label: "action" → should wake the suggestion engine or route a command
 *
 * Categories of "pass" utterances (what the model must NOT fire on):
 *   - Technical discussion / thinking aloud
 *   - Code review / PR discussion
 *   - Social / off-topic
 *   - Partial / filler / unclear
 *
 * Categories of "action" utterances (what the model MUST catch):
 *   - Buildable idea clearly stated ("we should build X", "let's add Y")
 *   - Magic-word command (callsign + verb: "Daybreak pause", "Nightfall kill")
 *   - Mute/panic word ("stop everything", "Daybreak stop")
 *   - Explicit accept/reject of a pending suggestion ("yeah let's do that", "no skip it")
 */
export type Label = "pass" | "action";
export type ActionReason =
  | "buildable-idea"
  | "magic-word-command"
  | "panic-stop"
  | "suggestion-accept"
  | "suggestion-reject";

export interface Sample {
  id: string;
  text: string;
  label: Label;
  reason?: ActionReason;
  notes?: string;
}

export const CORPUS: Sample[] = [
  // ── PASS: technical discussion ──
  {
    id: "p01",
    text: "The problem is that we're hitting the rate limit on the Deepgram WebSocket about every thirty minutes.",
    label: "pass",
    notes: "factual status update, no intent to build anything new",
  },
  {
    id: "p02",
    text: "Right, because we're reusing the same connection and not sending heartbeats.",
    label: "pass",
    notes: "follow-up explanation",
  },
  {
    id: "p03",
    text: "What does the SDK say the max idle time is?",
    label: "pass",
    notes: "question asked of another person in the room",
  },
  {
    id: "p04",
    text: "I checked it last week, it's twelve minutes without audio.",
    label: "pass",
    notes: "informational answer",
  },
  {
    id: "p05",
    text: "Okay so the fix is to keep-alive with silent PCM every ten minutes.",
    label: "pass",
    notes: "conclusion of a discussion — sounds decision-like but is about the existing code path, not a new buildable",
  },
  {
    id: "p06",
    text: "Let me grep the codebase for where we initialize the WebSocket.",
    label: "pass",
    notes: "intent to look up code, not spawn a new agent",
  },
  {
    id: "p07",
    text: "The test is passing now after the keepalive patch.",
    label: "pass",
    notes: "status update on an existing task",
  },
  {
    id: "p08",
    text: "Hmm, the speaker diarization seems to lag by about two seconds.",
    label: "pass",
    notes: "observation / bug note, not a command or buildable idea",
  },
  {
    id: "p09",
    text: "That's probably the model buffer window on the Deepgram side.",
    label: "pass",
  },
  {
    id: "p10",
    text: "Can you pull up the latency dashboard?",
    label: "pass",
    notes: "directed at a person, not an agent command",
  },
  // ── PASS: code review / PR discussion ──
  {
    id: "p11",
    text: "The type in line 47 should be ReadonlyArray, not Array.",
    label: "pass",
    notes: "code review comment",
  },
  {
    id: "p12",
    text: "Also the function signature doesn't match what the test expects.",
    label: "pass",
  },
  {
    id: "p13",
    text: "I'd rename that variable to observationBuffer, it's clearer.",
    label: "pass",
    notes: "refactor suggestion between humans, no agent needed",
  },
  {
    id: "p14",
    text: "The PR title says fix but this is actually a refactor.",
    label: "pass",
  },
  // ── PASS: social / off-topic ──
  {
    id: "p15",
    text: "Anyone want coffee? I'm doing a run.",
    label: "pass",
    notes: "completely off-topic",
  },
  {
    id: "p16",
    text: "Yeah oat milk please.",
    label: "pass",
  },
  {
    id: "p17",
    text: "How was the standup?",
    label: "pass",
  },
  {
    id: "p18",
    text: "Same as usual, shipping Friday.",
    label: "pass",
  },
  // ── PASS: partial / filler / thinking aloud ──
  {
    id: "p19",
    text: "Um, yeah, I think so.",
    label: "pass",
    notes: "filler",
  },
  {
    id: "p20",
    text: "Wait, no, that's not right.",
    label: "pass",
    notes: "self-correction mid-thought",
  },
  {
    id: "p21",
    text: "So if we—actually never mind.",
    label: "pass",
    notes: "abandoned thought",
  },
  {
    id: "p22",
    text: "Let me think about that.",
    label: "pass",
  },
  {
    id: "p23",
    text: "Mmm.",
    label: "pass",
    notes: "non-verbal",
  },
  {
    id: "p24",
    text: "Okay.",
    label: "pass",
    notes: "acknowledgement, no intent",
  },
  {
    id: "p25",
    text: "It depends.",
    label: "pass",
  },
  // ── PASS: existing agent task status talk ──
  {
    id: "p26",
    text: "The agent is still running the TypeScript compiler checks.",
    label: "pass",
    notes: "status report, not a command",
  },
  {
    id: "p27",
    text: "How long has that been going?",
    label: "pass",
  },
  {
    id: "p28",
    text: "About four minutes.",
    label: "pass",
  },
  // ── ACTION: buildable ideas ──
  {
    id: "a01",
    text: "We should add a reconnect backoff strategy to the WebSocket adapter.",
    label: "action",
    reason: "buildable-idea",
    notes: "clear new feature with a specific scope",
  },
  {
    id: "a02",
    text: "Let's build a small retry wrapper around the Deepgram connection that does exponential backoff.",
    label: "action",
    reason: "buildable-idea",
  },
  {
    id: "a03",
    text: "I think we need a circuit breaker here — if the WebSocket fails three times in a row, pause the session.",
    label: "action",
    reason: "buildable-idea",
    notes: "architectural suggestion that implies an agent task",
  },
  {
    id: "a04",
    text: "Can we add a silent PCM keepalive that fires every eight minutes?",
    label: "action",
    reason: "buildable-idea",
  },
  {
    id: "a05",
    text: "We need a test that proves the observe.pass rate is above ninety percent on normal conversation.",
    label: "action",
    reason: "buildable-idea",
  },
  {
    id: "a06",
    text: "Someone should write an e2e test for the mute word detection.",
    label: "action",
    reason: "buildable-idea",
  },
  {
    id: "a07",
    text: "We should generate the magic word list from a config file so it's easy to tune without a deploy.",
    label: "action",
    reason: "buildable-idea",
  },
  {
    id: "a08",
    text: "I want to add speaker labels to the observability JSONL so we can debug diarization later.",
    label: "action",
    reason: "buildable-idea",
  },
  {
    id: "a09",
    text: "Let's write a load test that simulates a full hour of room audio against the Cue harness.",
    label: "action",
    reason: "buildable-idea",
  },
  {
    id: "a10",
    text: "We need a dashboard widget that shows the current observe.pass rate in real time.",
    label: "action",
    reason: "buildable-idea",
  },
  // ── ACTION: magic-word commands ──
  {
    id: "a11",
    text: "Daybreak, pause.",
    label: "action",
    reason: "magic-word-command",
    notes: "process callsign + verb; must always route",
  },
  {
    id: "a12",
    text: "Nightfall, resume.",
    label: "action",
    reason: "magic-word-command",
  },
  {
    id: "a13",
    text: "Daybreak, fork this and try a different approach with Pipecat instead of Cue.",
    label: "action",
    reason: "magic-word-command",
    notes: "fork command with steer context",
  },
  {
    id: "a14",
    text: "Nightfall kill.",
    label: "action",
    reason: "magic-word-command",
  },
  {
    id: "a15",
    text: "Daybreak, what's your current status?",
    label: "action",
    reason: "magic-word-command",
    notes: "status query directed at named process",
  },
  // ── ACTION: panic / stop ──
  {
    id: "a16",
    text: "Stop everything.",
    label: "action",
    reason: "panic-stop",
    notes: "panic word; must never observe.pass",
  },
  {
    id: "a17",
    text: "Daybreak stop!",
    label: "action",
    reason: "panic-stop",
  },
  // ── ACTION: suggestion accept/reject ──
  {
    id: "a18",
    text: "Yeah, let's do that.",
    label: "action",
    reason: "suggestion-accept",
    notes: "accepting a pending suggestion — tricky, easily confused with filler",
  },
  {
    id: "a19",
    text: "No, skip it, we'll come back to that later.",
    label: "action",
    reason: "suggestion-reject",
  },
  {
    id: "a20",
    text: "Sounds good, go ahead and build it.",
    label: "action",
    reason: "suggestion-accept",
  },
];

export const PASS_COUNT = CORPUS.filter((s) => s.label === "pass").length;
export const ACTION_COUNT = CORPUS.filter((s) => s.label === "action").length;
