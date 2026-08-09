import * as THREE from "three";

// ── conversation-tree layout (pure, unit-tested) ────────────────────────────
// The dialogue tree's trunk/branch/leaf placement maths, extracted VERBATIM
// from RoomScene into the reusable HD tree module (RoomScene re-exports them,
// so the established import path and the RoomScene.test.ts suite are
// untouched). Everything here is pure geometry — no renderer, no DOM — which
// is what lets the TreeSpec3D builders stay unit-testable.

export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

// The conversation TREE takes center stage at the scene origin.
export const DIALOGUE_CENTER_X = 0;
export const DIALOGUE_CENTER_Z = 0;
// Trunk height envelope.
const TREE_TRUNK_MIN = 4;
const TREE_TRUNK_MAX = 9;
// The unclustered fallback branch (no topic matched / server degraded): the
// tree must NEVER vanish while turns exist.
export const TREE_FALLBACK_LABEL = "new growth";

// Structural refs: the layout only reads these fields, so RoomScene's full
// DialogueNodeSpec/DialogueTopicSpec (and any future forest data source)
// satisfy them without this module importing the scene.
export interface DialogueTurnRef {
  id: string;
  topicId?: string | null;
}

export interface DialogueTopicRef {
  id: string;
  label: string;
  turnIds: string[];
}

// One resolved branch of the conversation tree: a real topic, or the null-
// topic fallback that collects unclustered turns. `turnIds` is the branch's
// members present in the window, in chronological (window) order.
export interface DialogueBranch {
  topicId: string | null;
  label: string;
  turnIds: string[];
}

// Group the windowed turns under their topic branches (array order = topic
// age, oldest first → attached lowest). Membership honors BOTH sides of the
// contract (a turn's topicId or the topic's turnIds); anything unmatched —
// including everything, when the server has no topics yet — falls to a single
// fallback branch so the tree never vanishes while turns exist.
export function dialogueBranches(
  turns: readonly DialogueTurnRef[],
  topics: readonly DialogueTopicRef[],
): DialogueBranch[] {
  const branches: DialogueBranch[] = topics.map((topic) => ({ topicId: topic.id, label: topic.label, turnIds: [] }));
  const byTopic = new Map(branches.map((branch) => [branch.topicId as string, branch]));
  const claimed = new Map<string, string>();
  for (const topic of topics) {
    for (const turnId of topic.turnIds) {
      if (!claimed.has(turnId)) {
        claimed.set(turnId, topic.id);
      }
    }
  }
  const orphans: string[] = [];
  for (const turn of turns) {
    const topicId = turn.topicId ?? claimed.get(turn.id) ?? null;
    const branch = topicId !== null ? byTopic.get(topicId) : undefined;
    if (branch !== undefined) {
      branch.turnIds.push(turn.id);
    } else {
      orphans.push(turn.id);
    }
  }
  if (orphans.length > 0) {
    branches.push({ topicId: null, label: TREE_FALLBACK_LABEL, turnIds: orphans });
  }
  return branches;
}

// Trunk height grows gently with the topic count, clamped to ~4–9 units.
export function dialogueTrunkHeight(branchCount: number): number {
  return Math.min(TREE_TRUNK_MAX, TREE_TRUNK_MIN + Math.max(branchCount, 0) * 0.72);
}

// Branch reach grows with membership so a busy topic's leaves keep separation.
export function dialogueBranchLength(memberCount: number): number {
  return Math.min(7.5, 3.2 + 0.5 * Math.max(0, memberCount - 3));
}

// Point at parameter t ∈ [0,1] along branch `index` of `count`: azimuth by
// golden angle around the trunk, attachment height by topic order (oldest
// lowest), and an outward-plus-upward quadratic curve toward the light.
export function dialogueBranchPoint(
  index: number,
  count: number,
  trunkHeight: number,
  length: number,
  t: number,
): THREE.Vector3 {
  const azimuth = index * GOLDEN_ANGLE + 0.6;
  const attachY = count <= 1 ? trunkHeight * 0.62 : 1.6 + (trunkHeight * 0.85 - 1.6) * (index / (count - 1));
  const reach = t * length;
  const rise = 0.55 + length * 0.28;
  return new THREE.Vector3(
    DIALOGUE_CENTER_X + Math.cos(azimuth) * reach,
    attachY + t * 0.35 + t * t * rise,
    DIALOGUE_CENTER_Z + Math.sin(azimuth) * reach,
  );
}

// Member j of m sits at this branch parameter: chronological along the branch
// so the newest (j = m-1) lands closest to the tip — but never ON it (the tip
// is the topic label's spot).
export function dialogueLeafT(memberIndex: number, memberCount: number): number {
  return (memberIndex + 1) / (Math.max(memberCount, 1) + 0.55);
}

// Leaf world position: its branch-spine slot pushed sideways (alternating, so
// consecutive leaves never overlap) with a small upward lift off the wood.
export function dialogueLeafPosition(
  branchIndex: number,
  branchCount: number,
  trunkHeight: number,
  length: number,
  memberIndex: number,
  memberCount: number,
): THREE.Vector3 {
  const p = dialogueBranchPoint(branchIndex, branchCount, trunkHeight, length, dialogueLeafT(memberIndex, memberCount));
  const side = memberIndex % 2 === 0 ? 1 : -1;
  const radial = Math.hypot(p.x - DIALOGUE_CENTER_X, p.z - DIALOGUE_CENTER_Z);
  if (radial > 1e-6) {
    const offsetX = (-(p.z - DIALOGUE_CENTER_Z) / radial) * side * 0.5;
    const offsetZ = ((p.x - DIALOGUE_CENTER_X) / radial) * side * 0.5;
    p.x += offsetX;
    p.z += offsetZ;
  }
  p.y += 0.22 + (memberIndex % 2) * 0.12;
  return p;
}
