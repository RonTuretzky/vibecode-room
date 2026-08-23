// The reusable HD tree module: pure conversation-tree layout (extracted from
// RoomScene, re-exported there for compat), the declarative TreeSpec3D and its
// pure builders, and the quality/LOD-aware geometry engine. The research/
// dialogue tree is the first consumer; the GitHub forest (one tree per repo,
// PRs as branches) builds on the same substrate.
export * from "./dialogue-layout";
export * from "./spec";
export * from "./dialogue-spec";
export * from "./build";
