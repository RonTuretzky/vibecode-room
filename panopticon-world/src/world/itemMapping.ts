// ─────────────────────────────────────────────────────────────────────────────
// THE DESIGN: every Panopticon feature → an in-game item.
// This file is the single source of truth for "what does X look like in-world".
// ─────────────────────────────────────────────────────────────────────────────

import type { ModelId, VisualizerKind } from "./types.ts";

export type BuildingKind =
  | "factory" // code  — produces code; smokestacks puff, gears turn
  | "workshop" // web   — a storefront/builder's cottage with a glowing sign
  | "garden" // art   — a blossom tree producing flower "variations"
  | "library" // book  — a tower of books / scriptorium
  | "signpost" // text  — a carved wooden sign / scroll
  | "observatory"; // data  — a telescope dome under a constellation of bars

export const VIS_TO_BUILDING: Record<VisualizerKind, BuildingKind> = {
  code: "factory",
  web: "workshop",
  art: "garden",
  book: "library",
  text: "signpost",
  data: "observatory",
};

export interface BuildingMeta {
  kind: BuildingKind;
  label: string;
  icon: string; // emoji used in the legend / UI chips
  feature: string; // the Panopticon feature it represents
  produces: string; // the artifact it "manufactures"
}

export const BUILDING_META: Record<BuildingKind, BuildingMeta> = {
  factory: {
    kind: "factory",
    label: "Code Factory",
    icon: "🏭",
    feature: "Process · visualizer = code",
    produces: "functions & scripts on a conveyor",
  },
  workshop: {
    kind: "workshop",
    label: "Web Workshop",
    icon: "🏠",
    feature: "Process · visualizer = web",
    produces: "live sites behind a glowing marquee",
  },
  garden: {
    kind: "garden",
    label: "Blossom Garden",
    icon: "🌸",
    feature: "Process · visualizer = art",
    produces: "flower variations (the 'blooming fruit')",
  },
  library: {
    kind: "library",
    label: "Library",
    icon: "📚",
    feature: "Process · visualizer = book",
    produces: "chapters & outlines",
  },
  signpost: {
    kind: "signpost",
    label: "Signpost",
    icon: "🪧",
    feature: "Process · visualizer = text",
    produces: "one-pagers & notes",
  },
  observatory: {
    kind: "observatory",
    label: "Observatory",
    icon: "🔭",
    feature: "Process · visualizer = data",
    produces: "charts as constellations",
  },
};

// Model tier (spec §5.9 — no Opus in the hot loop) → the worker living inside.
export const MODEL_WORKER: Record<ModelId, { rank: string; icon: string }> = {
  "claude-fable-5": { rank: "Master Wizard (orchestrator)", icon: "🧙" },
  "claude-sonnet-4-6": { rank: "Journeyman (I/O loop)", icon: "👷" },
  "claude-haiku-4-5-20251001": { rank: "Apprentice (cheap hot loop)", icon: "🧒" },
};

export const AGENT_CREATURE: Record<string, string> = {
  mock: "training dummy",
  eliza: "familiar spirit",
  nanoclaw: "clockwork crab",
  smithers: "loyal butler-golem",
};

// The legend the player can pop open (the whole point: the mapping is legible).
export interface LegendEntry {
  icon: string;
  title: string;
  feature: string; // supports <b> for the spec term
}

export const LEGEND: LegendEntry[] = [
  {
    icon: "🌍",
    title: "The Overworld + day/night",
    feature: "The <b>meta-session</b>: the always-on outer loop. Sun arcs once per <b>autonomy tick</b>.",
  },
  {
    icon: "⛲",
    title: "Idea Spring (center fountain)",
    feature: "The <b>room transcript</b>, the only always-on channel — conversation bubbles up into ideas.",
  },
  {
    icon: "🫧",
    title: "Floating idea orbs",
    feature: "<b>Suggestion bubbles</b>: each carries a live demo + clarifying questions and bobs as it drifts.",
  },
  {
    icon: "⏳",
    title: "Orb fades & pops",
    feature: "The suggestion <b>TTL</b> — uncaught ideas expire. Two close orbs <b>merge in place</b>.",
  },
  {
    icon: "🔮",
    title: "Violet orb from the owl",
    feature: "A <b>model-initiated</b> bubble — the system volunteers prior art unprompted.",
  },
  {
    icon: "🌱",
    title: "Catch an orb → it plants",
    feature: "<b>Accept → spawn</b>: a building rises out of the ground (a new <b>Process</b>).",
  },
  {
    icon: "🏗️",
    title: "Scaffolding / blueprint",
    feature: "Process state <b>planning</b> — the building is still under construction.",
  },
  {
    icon: "💨",
    title: "Smoke, lights, spinning gears",
    feature: "Process state <b>active</b> — the session loop is running and emitting output.",
  },
  {
    icon: "❄️",
    title: "Frozen building with Zzz",
    feature: "Process state <b>paused</b> — independently pausable without touching siblings (C4).",
  },
  {
    icon: "🪦",
    title: "Ruin + tombstone",
    feature: "Process <b>killed</b>. The tombstone is the pre-kill <b>context archive</b> (C6).",
  },
  {
    icon: "🛤️",
    title: "Roads between buildings",
    feature: "<b>Fork / spawn lineage</b> — a child process is wired back to its parent (parentId).",
  },
  {
    icon: "🧙",
    title: "The worker inside",
    feature: "The process <b>model</b>: Fable (orchestrate) · Sonnet (I/O) · Haiku (cheap). No Opus in the hot loop.",
  },
  {
    icon: "🎯",
    title: "Glowing selection ring",
    feature: "<b>Select a process</b> (click). Steering input is bound only to the selected one (C2/C3).",
  },
  {
    icon: "📥",
    title: "Conveyor inbox",
    feature: "The process <b>input queue</b> — prompts you steer in land here and feed the loop.",
  },
  {
    icon: "🌀",
    title: "Portal signpost",
    feature: "The <b>QR code</b>: scan to pair a phone as a mic+chat device (mobile pathway, §5.7).",
  },
  {
    icon: "💬",
    title: "Dialogue box (bottom)",
    feature: "The live <b>room conversation</b> feeding the ambient suggestion engine.",
  },
  {
    icon: "🎛️",
    title: "Options menu (left)",
    feature: "The tunable <b>knobs</b>: bubbles/min, TTL, safe/dangerous, optimistic/explicit.",
  },
];
