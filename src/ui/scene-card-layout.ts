import * as THREE from 'three';

export interface ScreenCard {
  id: string; x: number; y: number; width: number; height: number; depth: number; priority: number; preferred?: { dx: number; dy: number };
}
export interface PlacedCard extends ScreenCard { dx: number; dy: number }
export interface CardObstacle { left: number; top: number; width: number; height: number }

/** Keep cards near their plant, with the nearest/highlighted cards winning
 * crowded space. A suppressed card can return when its plant is hovered. */
export function placeSceneCards(cards: readonly ScreenCard[], width: number, height: number, obstacles: readonly CardObstacle[] = []): PlacedCard[] {
  const placed: PlacedCard[] = [], gap = 8, margin = 16;
  const ordered = [...cards].sort((a, b) => b.priority - a.priority || a.depth - b.depth || a.id.localeCompare(b.id));
  for (const card of ordered) {
    if (![card.x, card.y, card.width, card.height, card.depth].every(Number.isFinite) || card.depth <= 0 ||
      card.width < 52 || card.height < 12 || card.width > width - margin * 2 || card.y < margin || card.y > height + card.height) continue;
    const clampX = (x: number) => Math.max(margin + card.width / 2, Math.min(width - margin - card.width / 2, x));
    const xs = card.preferred ? [clampX(card.x + card.preferred.dx)] : [clampX(card.x), clampX(card.x - 72), clampX(card.x + 72)];
    let best: PlacedCard | null = null, bestCost = Infinity;
    for (const x of xs) {
      if (Math.abs(x - card.x) > 72) continue;
      let bottom = Math.min(card.y + (card.preferred?.dy ?? 0), height - 64);
      // Each upward step clears at least one obstacle. Also try small lateral
      // moves, so a crowded crown need not become a tall stack of cards.
      for (let pass = 0; pass <= placed.length + obstacles.length; pass++) {
        const overlaps = placed.filter(other => x - card.width / 2 < other.x + other.dx + other.width / 2 + gap &&
          x + card.width / 2 > other.x + other.dx - other.width / 2 - gap &&
          bottom > other.y + other.dy - other.height - gap && bottom - card.height < other.y + other.dy + gap);
        const blocked = obstacles.filter(other => x - card.width / 2 < other.left + other.width + gap &&
          x + card.width / 2 > other.left - gap && bottom > other.top - gap && bottom - card.height < other.top + other.height + gap);
        if (!overlaps.length && !blocked.length) break;
        bottom = Math.min(...overlaps.map(other => other.y + other.dy - other.height - gap), ...blocked.map(other => other.top - gap));
      }
      if (bottom - card.height < margin || card.y - bottom > Math.min(160, height * .28)) continue;
      const dx = x - card.x, dy = bottom - card.y, cost = Math.abs(dy) + Math.abs(dx) * 1.35;
      if (cost < bestCost) { best = { ...card, dx, dy }; bestCost = cost; }
    }
    if (best) placed.push(best);
  }
  return placed;
}

export interface SceneCard { id: string; label: THREE.Sprite; priority: number; maxWidth?: number; preserveSlot?: boolean }

/** Screen-space placement on the existing 3D sprites. Changing sprite.center
 * keeps the plant anchor fixed and lets Three's real raycast follow the card. */
export function createSceneCardLayout() {
  const group = new THREE.Group(); group.name = 'park-card-leaders';
  const material = new THREE.LineBasicMaterial({ color: 0xb8d7c7, transparent: true, opacity: .42, depthTest: false, depthWrite: false, toneMapped: false });
  let geometry = new THREE.BufferGeometry(), capacity = 0;
  const lines = new THREE.LineSegments(geometry, material); lines.renderOrder = 11; lines.frustumCulled = false; lines.visible = false; group.add(lines);
  const records = new Map<THREE.Sprite, { base: THREE.Vector3; center: THREE.Vector2; offset?: { dx: number; dy: number } }>();
  const anchor = new THREE.Vector3(), view = new THREE.Vector3(), scale = new THREE.Vector3();
  const endpoint = new THREE.Vector3();
  let lastCards: SceneCard[] = [];
  const reset = () => {
    for (const [label, original] of records) {
      label.scale.copy(original.base); label.center.copy(original.center); label.visible = label.material.opacity > .01;
      delete label.userData.sceneCardRect;
    }
    records.clear(); lastCards = []; geometry.setDrawRange(0, 0); lines.visible = false;
  };
  return { group, reset, update(camera: THREE.PerspectiveCamera, width: number, height: number, cards: SceneCard[], obstacles: readonly CardObstacle[] = []) {
    const live = new Set(cards.map(card => card.label));
    for (const [label, original] of records) if (!live.has(label)) {
      label.scale.copy(original.base); label.center.copy(original.center);
      delete label.userData.sceneCardRect; records.delete(label);
    }
    lastCards = cards;
    camera.updateMatrixWorld();
    const projection = height * camera.projectionMatrix.elements[5]! / 2;
    const screen: ScreenCard[] = [], anchors = new Map<string, THREE.Vector3>();
    for (const { id, label, priority, maxWidth = 220, preserveSlot = false } of cards) {
      let original = records.get(label);
      if (!original) { original = { base: label.scale.clone(), center: label.center.clone() }; records.set(label, original); }
      label.scale.copy(original.base); label.center.copy(original.center); label.visible = false;
      delete label.userData.sceneCardRect;
      if (label.material.opacity < .05) continue;
      label.updateWorldMatrix(true, false); label.getWorldPosition(anchor); view.copy(anchor).applyMatrix4(camera.matrixWorldInverse);
      if (view.z >= -camera.near) continue;
      label.getWorldScale(scale);
      const naturalWidth = scale.x * projection / -view.z;
      // A close flower's label must not grow into a billboard. Keep small
      // distant cards quiet; hovering their plant restores a readable label.
      const pixelWidth = Math.min(Math.min(maxWidth, width - 32), Math.max(priority > 0 ? 120 : 0, naturalWidth));
      if (naturalWidth <= 0) continue;
      const factor = pixelWidth / naturalWidth;
      label.scale.multiplyScalar(factor); label.updateWorldMatrix(false, false);
      const pixelHeight = scale.y * factor * projection / -view.z;
      endpoint.copy(anchor).project(camera);
      if (endpoint.z < -1 || endpoint.z > 1) continue;
      screen.push({ id, x: (endpoint.x + 1) * width / 2, y: (1 - endpoint.y) * height / 2,
        width: pixelWidth, height: pixelHeight, depth: -view.z, priority, preferred: preserveSlot ? original.offset : undefined });
      anchors.set(id, anchor.clone());
    }
    const placed = placeSceneCards(screen, width, height, obstacles);
    records.forEach(original => { original.offset = undefined; });
    const byId = new Map(cards.map(card => [card.id, card.label]));
    if (capacity < cards.length) {
      capacity = Math.max(16, cards.length * 2); geometry.dispose(); geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(capacity * 6), 3).setUsage(THREE.DynamicDrawUsage)); lines.geometry = geometry;
    }
    const positions = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    let vertices = 0;
    for (const card of placed) {
      const label = byId.get(card.id)!;
      records.get(label)!.offset = { dx: card.dx, dy: card.dy };
      label.visible = true; label.center.set(.5 - card.dx / card.width, card.dy / card.height);
      label.userData.sceneCardRect = { id: card.id, left: card.x + card.dx - card.width / 2, top: card.y + card.dy - card.height,
        width: card.width, height: card.height };
      if (Math.hypot(card.dx, card.dy) < 5) continue;
      const start = anchors.get(card.id)!;
      endpoint.copy(start).project(camera);
      endpoint.x += card.dx * 2 / width; endpoint.y -= card.dy * 2 / height; endpoint.unproject(camera);
      positions!.setXYZ(vertices++, start.x, start.y, start.z); positions!.setXYZ(vertices++, endpoint.x, endpoint.y, endpoint.z);
    }
    geometry.setDrawRange(0, vertices); lines.visible = vertices > 0; if (positions) positions.needsUpdate = true;
    return placed.length;
  }, rects() { return lastCards.flatMap(card => card.label.userData.sceneCardRect ? [card.label.userData.sceneCardRect] : []); },
  pick(x: number, y: number) {
    for (const card of lastCards) {
      const r = card.label.userData.sceneCardRect;
      if (r && x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height) return card.label.userData.pick ?? null;
    }
    return null;
  }, dispose() { reset(); group.removeFromParent(); geometry.dispose(); material.dispose(); } };
}
