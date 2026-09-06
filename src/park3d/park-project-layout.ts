export interface ParkProjectPoint { x: number; y: number; z: number }
interface LayoutGround {
  canPlant: (x: number, z: number) => boolean;
  groundAt: (x: number, z: number) => number;
}
const SPACING = 13;

/** Keep the familiar first five slots, then grow into nearby hexagonal rows.
 * Candidate order is independent of count, so adding a project doesn't move
 * existing automatic roots. Chosen planting locations reserve their space. */
export function parkProjectSlots(count: number, source: LayoutGround, reserved: readonly { x: number; z: number }[] = []): ParkProjectPoint[] {
  function* candidates() {
    for (const slot of [0, -1, 1, -2, 2]) yield { x: slot * SPACING, z: -3.2 - (Math.abs(slot) % 2) * 3.4 };
    for (let ring = 1; ring <= 64; ring++) {
      for (let row = ring; row >= -ring; row--) for (let col = -ring; col <= ring; col++) {
        if (Math.max(Math.abs(col), Math.abs(row), Math.abs(col + row)) !== ring) continue;
        yield { x: (col + row / 2) * SPACING, z: row * SPACING * Math.sqrt(3) / 2 - 3.2 };
      }
    }
  }
  const positions: ParkProjectPoint[] = [], occupied = [...reserved];
  if (count <= 0) return positions;
  for (const p of candidates()) {
    if (!source.canPlant(p.x, p.z) || occupied.some(q => (q.x - p.x) ** 2 + (q.z - p.z) ** 2 < SPACING ** 2 - 1e-6)) continue;
    const y = source.groundAt(p.x, p.z);
    if (!Number.isFinite(y)) continue;
    positions.push({ ...p, y }); occupied.push(p);
    if (positions.length >= count) break;
  }
  return positions;
}
