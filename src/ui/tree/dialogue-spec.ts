import {
  dialogueBranchLength,
  dialogueBranchPoint,
  dialogueBranches,
  dialogueLeafPosition,
  dialogueLeafT,
  dialogueTrunkHeight,
  type DialogueTopicRef,
  type DialogueTurnRef,
} from "./dialogue-layout";
import { hashSeed, mulberry32, type TreeAdornmentSpec, type TreeBranchSpec3D, type TreeSpec3D, type TreeVec3 } from "./spec";

// ── dialogue → TreeSpec3D (pure) ────────────────────────────────────────────
// Maps the EXISTING (tested) conversation-tree layout into the HD tree spec.
// The contract with the scene's raycast/dwell targeting is exact: branch tips
// land on dialogueBranchPoint(t=1) (topic labels + hit spheres ride there) and
// leaf-tuft adornments sit on dialogueLeafPosition (the interactive turn
// spheres RoomScene keeps as entries occupy the same slots). Only the INTERIOR
// of each branch curve gains a gentle organic wobble — deterministic per
// branch id, zero at both endpoints — so nothing the room points at moves.

export const DIALOGUE_TREE_ID = "dialogue";
// The stable id of the null-topic fallback branch.
export const DIALOGUE_FALLBACK_BRANCH_ID = "__fallback__";
// Branch tips glow canopy-mint like the old tip cluster.
export const DIALOGUE_TIP_COLOR = 0x9affc9;
// Garden-adjacent leaf greens (the meadow's hemisphere bounce is 0x86b46a).
export const DIALOGUE_LEAF_PALETTE = [0x5c8a41, 0x6f9d4c, 0x82b05a, 0x96c06b];

// Spine samples per branch (t = 0..1 in 1/8 steps, like the classic tube).
const SPINE_STEPS = 8;

// Analytic wobbled spine for one branch: the tested layout curve plus a
// deterministic lateral+vertical sway that fades to ZERO at the attachment and
// the tip (sin(πt)), keeping both contract points exact. Returned as a
// function of t so petiole stems can sample the identical curve at leaf slots.
function branchSpine(
  branchIndex: number,
  branchCount: number,
  trunkHeight: number,
  length: number,
  branchId: string,
): (t: number) => TreeVec3 {
  const root = dialogueBranchPoint(branchIndex, branchCount, trunkHeight, length, 0);
  const tip = dialogueBranchPoint(branchIndex, branchCount, trunkHeight, length, 1);
  const dirX = tip.x - root.x;
  const dirZ = tip.z - root.z;
  const mag = Math.hypot(dirX, dirZ) || 1;
  const perpX = -dirZ / mag;
  const perpZ = dirX / mag;
  const rng = mulberry32(hashSeed(`${DIALOGUE_TREE_ID}:${branchId}`));
  const phaseSide = rng() * Math.PI * 2;
  const phaseLift = rng() * Math.PI * 2;
  const ampSide = length * (0.05 + rng() * 0.035);
  const ampLift = length * (0.03 + rng() * 0.025);
  return (t: number): TreeVec3 => {
    const p = dialogueBranchPoint(branchIndex, branchCount, trunkHeight, length, t);
    const fade = Math.sin(Math.PI * t);
    const side = Math.sin(t * 4.1 + phaseSide) * ampSide * fade;
    const lift = Math.sin(t * 3.3 + phaseLift) * ampLift * fade;
    return { x: p.x + perpX * side, y: p.y + lift, z: p.z + perpZ * side };
  };
}

export function dialogueTreeSpec3D(
  turns: readonly DialogueTurnRef[],
  topics: readonly DialogueTopicRef[],
): TreeSpec3D {
  const branches = dialogueBranches(turns, topics);
  const trunkHeight = dialogueTrunkHeight(branches.length);
  const branchSpecs: TreeBranchSpec3D[] = [];
  const adornments: TreeAdornmentSpec[] = [];
  branches.forEach((branch, branchIndex) => {
    const memberCount = branch.turnIds.length;
    const length = dialogueBranchLength(memberCount);
    const id = branch.topicId ?? DIALOGUE_FALLBACK_BRANCH_ID;
    const spine = branchSpine(branchIndex, branches.length, trunkHeight, length, id);
    const points: TreeVec3[] = [];
    for (let step = 0; step <= SPINE_STEPS; step += 1) {
      points.push(spine(step / SPINE_STEPS));
    }
    branchSpecs.push({
      id,
      points,
      // Busier topics grow thicker wood, gently capped.
      thickness: Math.min(0.16, 0.085 + memberCount * 0.012),
      tip: {
        kind: "topic",
        color: DIALOGUE_TIP_COLOR,
        label: branch.label,
        sub: `${memberCount} turn${memberCount === 1 ? "" : "s"}`,
        // Tips pick as the topic's FRESHEST utterance (zero new plumbing).
        pickId: memberCount > 0 ? branch.turnIds[memberCount - 1] : null,
      },
    });
    // A leaf tuft nests each turn's glass sphere: adornment at the EXACT leaf
    // slot, petiole stem on the (wobbled) spine at the leaf's parameter.
    branch.turnIds.forEach((turnId, memberIndex) => {
      const leaf = dialogueLeafPosition(branchIndex, branches.length, trunkHeight, length, memberIndex, memberCount);
      const paletteIndex = hashSeed(turnId) % DIALOGUE_LEAF_PALETTE.length;
      adornments.push({
        id: `tuft:${turnId}`,
        kind: "leaf",
        position: { x: leaf.x, y: leaf.y, z: leaf.z },
        color: DIALOGUE_LEAF_PALETTE[paletteIndex],
        scale: 1,
        stem: spine(dialogueLeafT(memberIndex, memberCount)),
      });
    });
  });
  return {
    id: DIALOGUE_TREE_ID,
    trunk: {
      height: trunkHeight,
      // Trunk girth grows a little with the topic count (matches the presence
      // of the old stacked-cylinder trunk at its 1.7 girth).
      radius: Math.min(0.6, 0.38 + branches.length * 0.04),
    },
    branches: branchSpecs,
    foliage: {
      density: Math.min(1, 0.35 + turns.length * 0.04 + branches.length * 0.06),
      palette: DIALOGUE_LEAF_PALETTE,
    },
    adornments,
  };
}
