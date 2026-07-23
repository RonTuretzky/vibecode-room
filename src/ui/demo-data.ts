import type { LogEvent } from "../types";
import type { ProjectorSnapshot } from "./types";

const trace = (event: string, correlationId: string, meta: Record<string, unknown>, upid?: string): LogEvent => ({
  level: "info",
  event,
  sessionId: "projector-demo",
  correlationId,
  upid,
  latencyMs: 42,
  meta,
});

export const demoProjectorSnapshot: ProjectorSnapshot = {
  sessionId: "projector-demo",
  listening: true,
  muted: false,
  globalState: "ready",
  activeCue: "Atlas steering window",
  emergencyStopTriggered: false,
  suggestion: {
    state: "queued",
    pitch: "Turn the meeting notes into a blocker announcer.",
    confidence: 0.82,
    gate: {
      words: 74,
      minWords: 60,
      seconds: 128,
      minSeconds: 90,
    },
    questions: ["Which repo?", "Should it post to Slack?", "Who reviews first?"],
  },
  audio: {
    lastSpoken: "Atlas active. I will include the run name in the summary.",
    earcon: "route-steer double click",
    silenceRatio: 0.91,
  },
  processes: [
    {
      upid: "upid_atlas_7f3",
      runId: "smithers_run_9c12",
      callsign: "Atlas",
      state: "active",
      selected: true,
      task: "Blocker announcer",
      model: "Codex gpt-5.5",
      progressLabel: "writing summary",
      progress: 68,
      lastOutput: "Done with scan. Updating the announcement copy now.",
      lastAction: "steer: include run name",
      events: ["spawn confirmed", "plan accepted", "steered by room", "summary emitted"],
    },
    {
      upid: "upid_cobalt_5e0",
      runId: "smithers_run_9c55",
      callsign: "Cobalt",
      state: "planning",
      selected: false,
      task: "Migration dry-run",
      model: "Claude Sonnet 4.6",
      progressLabel: "checking resources",
      progress: 24,
      lastOutput: "Planning the dry-run path before touching files.",
      lastAction: "spawned from accepted suggestion",
      events: ["spawn confirmed", "resource check", "planning"],
    },
  ],
  transcript: [
    {
      time: "12:04:31",
      speaker: "Room",
      kind: "room",
      text: "Atlas, also include the run name in the spoken summary.",
    },
    {
      time: "12:04:32",
      speaker: "Vibersyn",
      kind: "vibersyn",
      text: "Routed to Atlas.",
    },
    {
      time: "12:05:02",
      speaker: "Room",
      kind: "room",
      text: "The standup notes keep losing blockers.",
    },
    {
      time: "12:05:40",
      speaker: "Vibersyn",
      kind: "vibersyn",
      text: "Idea queued for the next idle gap.",
    },
  ],
  trace: [
    trace("observe.final", "corr-atlas-001", { utteranceId: "utt-218", speaker: "speaker-1" }),
    trace("route.action", "corr-atlas-001", { action: "steer", targetUPID: "upid_atlas_7f3" }, "upid_atlas_7f3"),
    trace("process.steer", "corr-atlas-001", { runId: "smithers_run_9c12" }, "upid_atlas_7f3"),
    trace("output.tts", "corr-atlas-001", { text: "Routed to Atlas." }, "upid_atlas_7f3"),
    trace("observe.pass", "corr-room-224", { reason: "ambient", wordCount: 18 }),
    trace("suggestion.queued", "corr-suggest-009", { confidence: 0.82, idlePreferred: true }),
  ],
  // The idea tray fixture: ready candidates first (buildable/dismissable), then a
  // dimmed forming one — so the offline demo shows the full explicit-confirm flow.
  ideas: [
    {
      id: "idea_blocker_announcer",
      pitch: "Turn the meeting notes into a blocker announcer.",
      confidence: 0.82,
      status: "ready",
      maturity: "actionable",
      verified: true,
      rationale: "Concrete, scoped, and the pain was mentioned twice.",
      evidence: "The standup notes keep losing blockers.",
    },
    {
      id: "idea_retro_wall",
      pitch: "A retro wall that clusters this week's wins and gripes.",
      confidence: 0.63,
      status: "ready",
      maturity: "proposed",
      verified: false,
      evidence: "We never see the wins next to the gripes.",
    },
    {
      id: "idea_focus_chime",
      pitch: "Ambient focus chime keyed to who is speaking.",
      confidence: 0.31,
      status: "forming",
      maturity: "forming",
      verified: false,
    },
  ],
  voice: null,
  // RESEARCH MODE fixture: the 3D dialogue tree grows from these turns, and
  // the quests show the full lifecycle — a proposed fact-check (clickable), a
  // researching deep-dive with live progress, and a completed dossier. The
  // completed quest's deckUrl is null in the offline fixture (no server to
  // render the deck), which the overlay handles with an explicit notice.
  // Research is a MODE SWITCH now, so the demo boots in the NORMAL room
  // (garden + idea surfaces); flipping 🔍 Research reveals these fixtures.
  researchMode: false,
  dialogue: [
    { id: "rturn-0001", speaker: "speaker-1", text: "The standup notes keep losing blockers.", atMs: 1750096800000 },
    { id: "rturn-0002", speaker: "speaker-2", text: "I read that most remote teams miss half their blockers in async standups.", atMs: 1750096815000 },
    { id: "rturn-0003", speaker: "speaker-1", text: "We could turn the meeting notes into a blocker announcer.", atMs: 1750096832000 },
    { id: "rturn-0004", speaker: "speaker-3", text: "How do other tools handle surfacing blockers automatically?", atMs: 1750096851000 },
    { id: "rturn-0005", speaker: "speaker-2", text: "Apparently the biggest standup tools all pivoted away from daily meetings entirely.", atMs: 1750096870000 },
  ],
  // Tray order mirrors the live loop contract: researching → proposed →
  // complete, so the offline demo reads the same as a live room.
  research: [
    {
      id: "rq_blocker_tools",
      kind: "deep-dive",
      topic: "How tools surface blockers automatically",
      claim: "How do existing standup tools detect and surface blockers automatically?",
      confidence: 0.6,
      status: "researching",
      progress: 45,
      progressLabel: "fact-checking findings",
      evidence: "How do other tools handle surfacing blockers automatically?",
      turnId: "rturn-0004",
      sourceCount: 0,
      biasCount: 0,
      deckUrl: null,
    },
    {
      id: "rq_async_blockers",
      kind: "fact-check",
      topic: "Remote teams miss half their blockers",
      claim: "Most remote teams miss half their blockers in async standups.",
      confidence: 0.74,
      status: "proposed",
      progress: 0,
      progressLabel: "",
      rationale: "A specific reported statistic — worth verifying before building around it.",
      evidence: "I read that most remote teams miss half their blockers in async standups.",
      turnId: "rturn-0002",
      sourceCount: 0,
      biasCount: 0,
      deckUrl: null,
    },
    {
      id: "rq_standup_pivot",
      kind: "bias-scan",
      topic: "Standup tools pivoting away from meetings",
      claim: "The biggest standup tools all pivoted away from daily meetings entirely.",
      confidence: 0.68,
      status: "complete",
      progress: 100,
      progressLabel: "report ready",
      evidence: "Apparently the biggest standup tools all pivoted away from daily meetings entirely.",
      turnId: "rturn-0005",
      sourceCount: 4,
      biasCount: 2,
      verdicts: { supported: 1, refuted: 1, mixed: 1, unverified: 0 },
      deckUrl: null,
    },
  ],
  updatedAt: new Date("2026-06-16T18:00:00.000Z").toISOString(),
};

// A deliberately BUSY room: several projects building at once, each in a
// different state (planning / active / blocked / completed) with a lively
// transcript, idea tray, and trace. Powered by the "Mock room" toggle so a
// viewer can see what a full room in flight looks like without needing real
// builds. Pure fixture — safe to show over any live/offline snapshot.
export function busyRoomSnapshot(): ProjectorSnapshot {
  return {
    sessionId: "projector-mock-busy",
    listening: true,
    muted: false,
    globalState: "5 projects in flight",
    activeCue: "Ember steering window",
    emergencyStopTriggered: false,
    suggestion: {
      state: "queued",
      pitch: "A live leaderboard for the hack-day demos.",
      confidence: 0.77,
      gate: { words: 88, minWords: 60, seconds: 140, minSeconds: 90 },
      questions: ["Which projects count?", "Public or room-only?"],
      rationale: "Mentioned twice and everyone wants a scoreboard.",
    },
    audio: {
      lastSpoken: "Ember, ship the Slack digest to the standup channel.",
      earcon: "route-steer double click",
      silenceRatio: 0.34,
    },
    processes: [
      {
        upid: "upid_atlas_7f3",
        runId: "smithers_run_9c12",
        callsign: "Atlas",
        state: "active",
        selected: false,
        task: "Blocker announcer",
        model: "Claude Opus 4.8",
        progressLabel: "wiring Slack post",
        progress: 72,
        lastOutput: "Announcement copy done — posting to #standup next.",
        lastAction: "steer: include run name",
        events: ["spawn confirmed", "plan accepted", "steered by room", "summary emitted"],
        buildStatus: "ready",
        previewUrl: "http://127.0.0.1:4801/",
        slides: [
          {
            title: "What Atlas does",
            html: "<p><strong>Blocker announcer</strong> — reads the standup notes, finds anything phrased as a blocker, and posts a spoken + written announcement so nothing gets lost.</p><ul><li>Watches the meeting-notes doc</li><li>Extracts blockers with a small LLM pass</li><li>Announces to <code>#standup</code> with owner + age</li></ul>",
          },
          {
            title: "How it's going",
            html: "<p>Scan pipeline is done and the announcement copy is written. Currently wiring the Slack post.</p><p><strong>72%</strong> complete · preview is live — click the fleet panel to open it.</p>",
          },
          {
            title: "Try it",
            html: "<p>Say a blocker out loud in standup and watch it surface within a minute. The room steered it once already: <em>“include the run name in the summary.”</em></p>",
          },
        ],
      },
      {
        upid: "upid_ember_2a9",
        runId: "smithers_run_9d41",
        callsign: "Ember",
        state: "active",
        selected: true,
        steering: true,
        task: "Slack standup digest bot",
        model: "Claude Sonnet 5",
        progressLabel: "rendering digest",
        progress: 55,
        lastOutput: "Grouped 14 updates into 3 themes. Formatting the digest.",
        lastAction: "steered: ship to standup channel",
        events: ["spawn confirmed", "plan accepted", "fetching messages", "clustering"],
        buildStatus: "building",
        slides: [
          {
            title: "What Ember does",
            html: "<p><strong>Slack standup digest bot</strong> — pulls the day's updates, clusters them into themes, and ships one readable digest instead of forty pings.</p><ul><li>14 updates → 3 themes so far</li><li>Digest formatted as a single threaded post</li></ul>",
          },
          {
            title: "Status",
            html: "<p>Mid-build at <strong>55%</strong> — the room just steered it to ship into the standup channel. Rendering the digest now.</p>",
          },
        ],
      },
      {
        upid: "upid_cobalt_5e0",
        runId: "smithers_run_9c55",
        callsign: "Cobalt",
        state: "planning",
        selected: false,
        task: "Repo migration dry-run",
        model: "Claude Sonnet 5",
        progressLabel: "checking resources",
        progress: 18,
        lastOutput: "Planning the dry-run path before touching files.",
        lastAction: "spawned from accepted suggestion",
        events: ["spawn confirmed", "resource check", "planning"],
        slides: [
          {
            title: "What Cobalt does",
            html: "<p><strong>Repo migration dry-run</strong> — rehearses the monorepo move on a throwaway clone and reports what would break, before anything is touched.</p>",
          },
          {
            title: "Status",
            html: "<p>Early planning (<strong>18%</strong>): mapping the import graph and checking runner capacity. No files modified yet — dry-run by design.</p>",
          },
        ],
      },
      {
        upid: "upid_iris_913",
        runId: "smithers_run_9e08",
        callsign: "Iris",
        state: "blocked",
        selected: false,
        task: "PR triage dashboard",
        model: "Claude Opus 4.8",
        progressLabel: "needs a token",
        progress: 40,
        lastOutput: "Blocked: GitHub token missing the repo scope.",
        lastAction: "waiting on room input",
        events: ["spawn confirmed", "plan accepted", "auth check failed"],
        buildStatus: "failed",
        source: { kind: "github-import", url: "https://github.com/acme/pr-triage" },
        slides: [
          {
            title: "What Iris does",
            html: "<p><strong>PR triage dashboard</strong> — imported from <code>acme/pr-triage</code> via the QR wall. Ranks open PRs by review urgency.</p>",
          },
          {
            title: "Why it's blocked",
            html: "<p>The GitHub token is missing the <code>repo</code> scope, so the API calls 403. <strong>Fix:</strong> re-issue the token with repo scope and say <em>“Vibersyn, resume Iris.”</em></p>",
          },
        ],
      },
      {
        upid: "upid_nova_44c",
        runId: "smithers_run_9b77",
        callsign: "Nova",
        state: "completed",
        selected: false,
        task: "Retro wall",
        model: "Claude Sonnet 5",
        progressLabel: "shipped",
        progress: 100,
        lastOutput: "Retro wall is live — clustered 22 cards into wins/gripes.",
        lastAction: "build finished",
        events: ["spawn confirmed", "plan accepted", "built", "preview ready"],
        buildStatus: "ready",
        previewUrl: "http://127.0.0.1:4802/",
        slides: [
          {
            title: "What Nova shipped",
            html: "<p><strong>Retro wall</strong> — clusters the week's wins and gripes side by side so the retro starts from evidence, not memory.</p><ul><li>22 cards clustered</li><li>Wins vs gripes, auto-grouped by theme</li></ul>",
          },
          {
            title: "Done — see it live",
            html: "<p>Build finished at <strong>100%</strong>; the preview is being served locally. This is what talk→build looks like when it lands.</p>",
          },
        ],
      },
    ],
    transcript: [
      { time: "14:21:03", speaker: "Room", kind: "room", text: "Ember, ship the Slack digest to the standup channel." },
      { time: "14:21:04", speaker: "Vibersyn", kind: "vibersyn", text: "Routed to Ember." },
      { time: "14:21:22", speaker: "Nova", kind: "process", text: "Retro wall is live — preview is up." },
      { time: "14:21:37", speaker: "Room", kind: "room", text: "Iris looks stuck — what does it need?" },
      { time: "14:21:39", speaker: "Iris", kind: "process", text: "Blocked: the GitHub token is missing the repo scope." },
      { time: "14:22:05", speaker: "Room", kind: "room", text: "Someone build us a leaderboard for the demos." },
      { time: "14:22:08", speaker: "Vibersyn", kind: "vibersyn", text: "Idea queued — leaderboard for the hack-day demos." },
    ],
    trace: [
      trace("observe.final", "corr-ember-014", { utteranceId: "utt-771", speaker: "speaker-2" }),
      trace("route.action", "corr-ember-014", { action: "steer", targetUPID: "upid_ember_2a9" }, "upid_ember_2a9"),
      trace("process.steer", "corr-ember-014", { runId: "smithers_run_9d41" }, "upid_ember_2a9"),
      trace("build.ready", "corr-nova-006", { previewUrl: "http://127.0.0.1:4802/" }, "upid_nova_44c"),
      trace("process.blocked", "corr-iris-003", { reason: "missing-scope" }, "upid_iris_913"),
      trace("suggestion.queued", "corr-suggest-021", { confidence: 0.77, idlePreferred: true }),
    ],
    ideas: [
      {
        id: "idea_demo_leaderboard",
        pitch: "A live leaderboard for the hack-day demos.",
        confidence: 0.85,
        status: "ready",
        maturity: "actionable",
        verified: true,
        rationale: "Mentioned twice and everyone wants a scoreboard.",
        evidence: "Someone build us a leaderboard for the demos.",
      },
      {
        id: "idea_blocker_radar",
        pitch: "A radar page that pings when a build has been blocked for 10 minutes.",
        confidence: 0.71,
        status: "ready",
        maturity: "elaborated",
        verified: true,
        rationale: "Iris sat blocked for a while before anyone noticed.",
        evidence: "Nobody saw Iris was stuck until we looked up.",
      },
      {
        id: "idea_standup_heatmap",
        pitch: "A heatmap of which repos get the most standup blockers.",
        confidence: 0.58,
        status: "ready",
        maturity: "proposed",
        verified: false,
        evidence: "The same repos keep coming up as blockers.",
      },
      {
        id: "idea_voice_recap",
        pitch: "A one-tap voice recap of everything the room shipped today.",
        confidence: 0.44,
        status: "forming",
        maturity: "proposed",
        verified: false,
        evidence: "What did we actually finish today?",
      },
      {
        id: "idea_demo_timer",
        pitch: "A shared demo timer that rings between presenters.",
        confidence: 0.29,
        status: "forming",
        maturity: "forming",
        verified: false,
      },
      {
        id: "idea_room_dj",
        pitch: "Ambient music that shifts with how many builds are running.",
        confidence: 0.18,
        status: "forming",
        maturity: "forming",
        verified: false,
      },
    ],
    voice: { lastCommand: "steer ember", at: new Date("2026-06-16T18:00:00.000Z").toISOString() },
    steeringUpid: "upid_ember_2a9",
    autoAccept: false,
    captureMode: true,
    updatedAt: new Date("2026-06-16T18:00:00.000Z").toISOString(),
  };
}

// The neutral, fixture-free baseline the LIVE runtime publishes before any real
// activity: zero processes, an empty transcript, an idle suggestion with an empty
// pitch, and an empty trace/audio. The demo fixture above is reserved for the
// OFFLINE-DEMO (?live=0) UI path and tests; the live /api/state must reflect real
// state only, so it starts from this instead of spreading demoProjectorSnapshot.
export const emptyProjectorSnapshot: ProjectorSnapshot = {
  sessionId: "projector-live",
  listening: true,
  muted: false,
  globalState: "ready",
  activeCue: "idle",
  emergencyStopTriggered: false,
  suggestion: {
    state: "idle",
    pitch: "",
    confidence: 0,
    gate: { words: 0, minWords: 0, seconds: 0, minSeconds: 0 },
    questions: [],
  },
  audio: {
    lastSpoken: "",
    earcon: "",
    silenceRatio: 1,
  },
  processes: [],
  transcript: [],
  trace: [],
  ideas: [],
  voice: null,
  updatedAt: new Date(0).toISOString(),
  steeringUpid: null,
  autoAccept: false,
};

export function withUnmuted(snapshot: ProjectorSnapshot): ProjectorSnapshot {
  return {
    ...snapshot,
    listening: true,
    muted: false,
    globalState: "ready",
    activeCue: "ambient listening",
    audio: {
      ...snapshot.audio,
      lastSpoken: "Unmuted.",
      earcon: "ambient E2 restored",
    },
    trace: [
      ...snapshot.trace,
      trace("mute.released", `corr-unmute-${Date.now()}`, { trigger: "unmute-button", streamingToCloud: true }),
    ].slice(-80),
    updatedAt: new Date().toISOString(),
  };
}
