import * as THREE from 'three';

export interface TreeTipDetail {
  label: THREE.Sprite;
  glow: THREE.Sprite;
  bud?: THREE.Mesh;
  targetId?: string;
  // Layout may cap a close sprite's drawn scale. Distance fading must keep
  // using its natural height, or those two adjustments feed back and flicker.
  baseHeight?: number;
}

/** Readable branch detail appears at close range; the underlying branch and
 * pick volumes remain intact in an overview. Use CSS pixels, independent of
 * device pixel ratio, with a gradual fade rather than a distance pop. */
export function updateTreeTipDetail(details: readonly TreeTipDetail[], pixelsPerUnit: number, dt: number, reducedMotion: boolean, highlighted?: (id: string) => boolean, context: "ambient" | "focused" | "background" = "ambient"): number {
  let visible = 0;
  const ease = reducedMotion ? 1 : 1 - Math.exp(-Math.max(0, dt) * 16);
  for (const detail of details) {
    const height = (detail.baseHeight ??= detail.label.scale.y) * pixelsPerUnit;
    const pointedAt = Boolean(detail.targetId && highlighted?.(detail.targetId));
    const label = pointedAt || context === "focused" ? 1 : context === "ambient" ? THREE.MathUtils.smoothstep(height, 18, 30) : 0;
    const glow = context !== "background" || pointedAt ? THREE.MathUtils.smoothstep(height, 6, 15) * .35 : 0;
    detail.label.material.opacity = THREE.MathUtils.lerp(detail.label.material.opacity, label, ease);
    detail.glow.material.opacity = THREE.MathUtils.lerp(detail.glow.material.opacity, glow, ease);
    detail.label.visible = detail.label.material.opacity > .01;
    detail.glow.visible = detail.glow.material.opacity > .01;
    if (detail.bud) detail.bud.visible = height > 5 && (context !== "background" || pointedAt);
    if (detail.label.visible) visible++;
  }
  return visible;
}

/** Frame the actual grown body at its planted elevation and viewport aspect.
 * The old focus changed only orbit radius, retaining the aerial eye height. */
export function projectFocusPose(bounds: THREE.Box3, fov: number, aspect: number) {
  const sphere = bounds.clone().expandByScalar(.8).getBoundingSphere(new THREE.Sphere());
  const vertical = THREE.MathUtils.degToRad(fov) / 2;
  const horizontal = Math.atan(Math.tan(vertical) * Math.max(.1, aspect));
  const distance = Math.max(10, sphere.radius * 1.12 / Math.sin(Math.min(vertical, horizontal)));
  return { targetX: sphere.center.x, targetZ: sphere.center.z, lookY: sphere.center.y,
    height: sphere.center.y + distance * Math.sin(.24), radius: distance * Math.cos(.24) };
}
