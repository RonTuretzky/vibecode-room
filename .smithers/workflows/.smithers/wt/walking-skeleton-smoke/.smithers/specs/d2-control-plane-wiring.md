# Spec: D2 — wire ProcessManager/MetaSession onto the Smithers control plane

## Goal
Make each Panopticon Process a DURABLE SMITHERS RUN (the D1 foundation), so the
process lifecycle is backed by Smithers instead of the in-memory loop — WITHOUT
breaking the existing server (`src/server/index.ts`), web clients, or `seed-demo`.
Smithers runs become the source of truth for process execution; the in-memory
`Map` becomes a projection/cache of metadata.

## What exists (read first)
- `src/core/control-plane.ts` (SmithersControlPlane: launchProcess/steer/pause/resume/kill/getRun/listRuns/streamEvents)
- `src/core/gateway.ts` (startAppGateway / appGatewayUrl)
- `src/core/workflows/process.tsx` (the durable steerable run; one `step` per steer)
- `src/core/meta-session.ts` (owns ProcessManager, SuggestionEngine, InputRouter, EventBus; autonomy tick)
- `src/core/process-manager.ts` (create/modify/kill/fork/merge/pause/resume/switch — emits EventBus events)
- `src/core/process.ts` (per-process session loop; tick() → brain.step())
- `src/core/bus.ts` (EventBus), `src/core/types.ts` (ProcessMetadata, events)
- `src/server/index.ts` (REST commands + `/ws` event stream + QR), `src/scripts/seed-demo.ts`

## Done / acceptance criteria
- **MetaSession boots the app gateway** (`startAppGateway`) on start and holds a `SmithersControlPlane`.
  Provide a clean shutdown (close gateway) and make the port configurable (PANOPTICON_GATEWAY_PORT, default 7332).
- **ProcessManager is backed by the control plane:**
  - `create` → `controlPlane.launchProcess(upid, { directive, processTitle, visualizer, model })`,
    then subscribe `controlPlane.streamEvents(upid, …)` and translate run events into the EXISTING
    EventBus events: a finished `step` node → `process.output` (reply→chat, html→artifact) and
    `process.tick`; run status changes → `process.updated`. Keep ProcessMetadata + the Map as a projection.
  - steering input (from InputRouter / enqueue) → `controlPlane.steer(upid, text)` (NOT the in-memory queue + brain.step).
  - `pause`/`resume`/`kill` → `controlPlane.pause/resume/kill(upid)` (already lifecycle-aware).
  - `fork` → `controlPlane.launchProcess(childUpid, …)` seeded from the parent's directive; keep `parentId` lineage.
  - `getRun`/`listRuns` available; status/listing read through the control plane.
- **Do not double-drive:** the autonomy tick must NOT also run `brain.step()` for control-plane-backed
  processes (the durable run does the work via steer). `Process.tick()` becomes status-sync / no-op for them
  (keep the old in-proc path only behind PANOPTICON_OFFLINE or for mock processes if needed).
- **Contracts preserved:** ProcessManager public method signatures, EventBus event shapes, and ProcessMetadata
  stay compatible so `src/server/index.ts`, the web clients, and `seed-demo` keep working unchanged.
- **Tests (bun test, no mocks):** add an integration test that boots a MetaSession (gateway on port 0),
  creates a process, steers it, and asserts a `process.output` EventBus event is emitted; pause/kill update status.
  Gate behind PANOPTICON_SMOKE_AGENT=1 like the durable-run smoke (it spawns a real agent step).
- `bun run typecheck` AND `bun test` pass; the gated integration test passes with
  `PANOPTICON_SMOKE_AGENT=1 bun test --timeout 180000`.

## Constraints
- APP code only under `src/`. Do NOT touch `panopticon-world/` (separate workstream), `node_modules/`,
  `.smithers/`, `package.json`, `tsconfig.json`.
- Subscriptions only. No raw LLM API. No mocks in product code/tests.
- Keep changes incremental and reviewable; preserve existing behavior where not explicitly replaced.

## Risks
- Breaking the running server/web — mitigate by preserving EventBus/REST contracts and testing app boot.
- Event translation fidelity (Smithers run events → Panopticon EventBus) — research the streamRunEvents
  payload shape (node.finished etc.) and map carefully.
- fork without a gateway forkRun — model as a fresh seeded run + parentId lineage.
