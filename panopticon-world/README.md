# Panopticon — Overworld

A **standalone, SNES-style game world** that visualizes every Panopticon feature
as an in-game item. This is a **design prototype**: it is not wired to the real
backend and runs on **mocks only**. Its whole job is to answer *"what could this
look like?"*

Built with **React + Vite + three.js / react-three-fiber + drei +
postprocessing**. Two views over the same live mock state:

- **🏘 Village (Overworld)** — the SNES kingdom: an Idea Spring bubbles up
  floating **idea orbs**; catch one and a **building** rises.
- **🌳 Grove (Tree)** — the same processes as a **growing lineage tree** you can
  **re-graft**. Inspired by
  [RonTuretzky/conductor-github-visualizer](https://github.com/RonTuretzky/conductor-github-visualizer)
  (freshness-colored nodes, hierarchy = branches).

## Run it

```bash
cd panopticon-world
bun install     # already done if you see node_modules/
bun run dev     # → http://localhost:5273
```

`bun run build` / `bun run typecheck` also work.

## Try it

1. The **Legend** opens first — it maps every game item to a Panopticon feature.
   Close it (✕ or click outside).
2. Watch the **Idea Spring** at the center: as the scripted room talks (bottom
   **ROOM** dialogue box), **idea bubbles** rise on the right and float in 3D.
3. **Catch a bubble**: click a floating orb, or hit **Accept → spawn** in the
   sidebar. A **building rises** (a Process).
4. **Click a building** to select it → the **Inspector** (bottom-left) shows its
   metadata and lets you **steer** it (type → Enter), **Fork**, **Pause**,
   **Kill**, or open its **QR**.
5. Toggle **🌳 Grove** (top HUD) to see the lineage as a tree. Select a node,
   hit **✥ Graft**, then click another node to **move that idea to a different
   branch**.
6. Tweak the **Options** (left): bubbles/min, suggestion TTL, optimistic/explicit,
   safe/dangerous.

## The mapping (feature → item)

| Panopticon feature | In-game item |
|---|---|
| Meta-session (always-on outer loop) | The overworld + day/night (autonomy tick) |
| Room transcript (always-on ambient channel) | The **Idea Spring** + JRPG dialogue box |
| Suggestion bubbles (demo + questions, TTL, merge) | **Idea orbs** that bob, carry a live demo, and pop on TTL |
| Model-initiated suggestion (prior art) | A **violet orb** with a crown |
| Accept → spawn a Process | **Catch the orb → a building rises / a seed sprouts** |
| Process visualizer = code / web / art / book / text / data | **Factory / Workshop / Blossom Garden / Library / Signpost / Observatory** |
| State planning / active / paused / dead | **Scaffold → alive & smoking → frozen w/ 💤 → ruin + 🪦 (pre-kill archive)** |
| Fork lineage (parentId) | **Roads** (Village) / **branches** (Grove) |
| Model tier fable / sonnet / haiku | The **worker** inside (Master Wizard → Apprentice) |
| Select + steer (C2/C3) | **Selection ring** + a steerable input queue (📥 inbox) |
| QR / mobile pairing (§5.7) | A **portal signpost** beside each building |
| Freshness (how recently a process emitted) | **Node color** green→red (conductor-style), Grove mode |
| Config knobs (§4) | The **Options menu** |

## Files

```
src/world/      types · palette · itemMapping (the design) · mockEngine (the sim)
src/scene/      WorldCanvas · Atmosphere · Ground · IdeaSpring · Bubbles
                Building (6 kinds + states) · Overworld · Grove · helpers · Effects
src/ui/         Hud · DialogueBox · BubbleQueue · Inspector · OptionsMenu · Legend
```

`src/world/itemMapping.ts` is the single source of truth for the feature→item
mapping. `src/world/mockEngine.ts` mirrors the real Panopticon loop (ambient
transcript → suggestion bubbles → spawned processes → session-loop output) with
zero backend, ported from the real mock brain in `../src/core/brain/mock.ts`.
