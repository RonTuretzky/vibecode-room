// Where each idea-tree was PLANTED. The idea card's "Plant…" button lets a
// person choose the spot for the tree an accepted idea grows into (anywhere
// inside the park boundary in ?env=park; on the meadow otherwise), instead of
// the automatic slot row.
//
// Positions are client-side by design: the projector rig's two wall windows
// share one browser profile, so localStorage IS the cross-wall channel — the
// other window hears the `storage` event and repositions the same tree
// without any server surface. Scene coordinates are the room's local metres
// (the same frame TreeSpec nodes render in).

export interface PlantedPosition {
  x: number;
  z: number;
}

export const PLANTED_STORAGE_KEY = "vibersyn-planted-positions-v1";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

const defaultStorage = (): StorageLike | null => (typeof window === "undefined" ? null : window.localStorage);

export function loadPlantedPositions(storage: StorageLike | null = defaultStorage()): Record<string, PlantedPosition> {
  if (storage === null) {
    return {};
  }
  try {
    const raw = storage.getItem(PLANTED_STORAGE_KEY);
    if (raw === null) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, PlantedPosition>;
    const out: Record<string, PlantedPosition> = {};
    for (const [upid, p] of Object.entries(parsed)) {
      if (typeof p?.x === "number" && Number.isFinite(p.x) && typeof p?.z === "number" && Number.isFinite(p.z)) {
        out[upid] = { x: p.x, z: p.z };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function savePlantedPosition(upid: string, position: PlantedPosition, storage: StorageLike | null = defaultStorage()): void {
  if (storage === null || upid.length === 0) {
    return;
  }
  try {
    const all = loadPlantedPositions(storage);
    all[upid] = { x: position.x, z: position.z };
    storage.setItem(PLANTED_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Quota/private-mode failures degrade to the automatic slot — never block accept.
  }
}

// The accept endpoints return the fresh snapshot but not the new process's
// upid; the planted position binds to whichever upid the accept ADDED.
// Ambiguity (zero or several new upids — e.g. a mock snapshot or a race with
// another wall's accept) returns null and the tree takes the default slot.
export function newUpidAfterAccept(before: string[], after: string[]): string | null {
  const known = new Set(before);
  const fresh = after.filter((upid) => !known.has(upid));
  return fresh.length === 1 ? fresh[0] : null;
}
