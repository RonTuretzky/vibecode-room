import * as THREE from "three";
import { POND_STAGE } from "./park-frame";
import { PARK_SITES } from "./park-sites";

// Metres relative to the room lawn. The fixed projector rigs never use these.
export const PARK_VIEWS = [
  { label: "Project lawn", radius: 20, height: 5.2, lookY: 3.3, targetX: 0, targetZ: 0, angle: 0 },
  { label: "The Pond", radius: 44, height: 10, lookY: -2, targetX: -6, targetZ: -88, angle: -.22 },
  { label: "Park overlook", radius: 155, height: 98, lookY: 8, targetX: 10, targetZ: -120, angle: .32 },
  { label: "Wollman Rink", radius: 100, height: 52, lookY: 0,
    targetX: POND_STAGE.x - PARK_SITES.wollman.x, targetZ: POND_STAGE.z - PARK_SITES.wollman.z, angle: Math.PI },
  { label: "The Arsenal", radius: 82, height: 35, lookY: 8,
    targetX: POND_STAGE.x - PARK_SITES.arsenal.x, targetZ: POND_STAGE.z - PARK_SITES.arsenal.z, angle: -2.1 },
  { label: "Central Park Zoo", radius: 132, height: 83, lookY: 4,
    targetX: POND_STAGE.x - PARK_SITES.zooPool.x, targetZ: POND_STAGE.z - PARK_SITES.zooPool.z, angle: 1.05 },
] as const;

/** Fit the complete project bounds, including crown room, in portrait or
 * landscape. A bounding sphere stays inside the frustum at every orbit yaw. */
export function fitParkProjects(bounds: THREE.Box3, verticalFov: number, aspect: number) {
  const padded = bounds.clone();
  padded.min.x -= 5; padded.max.x += 5;
  padded.min.z -= 5; padded.max.z += 5;
  padded.max.y += 10;
  const sphere = padded.getBoundingSphere(new THREE.Sphere());
  const vertical = THREE.MathUtils.degToRad(verticalFov) / 2;
  const horizontal = Math.atan(Math.tan(vertical) * Math.max(.1, aspect));
  const distance = Math.max(18, sphere.radius * 1.12 / Math.sin(Math.min(vertical, horizontal)));
  const elevation = THREE.MathUtils.lerp(.18, .55, THREE.MathUtils.clamp((distance - 30) / 160, 0, 1));
  return { targetX: sphere.center.x, targetZ: sphere.center.z, lookY: sphere.center.y,
    radius: distance * Math.cos(elevation), height: sphere.center.y + distance * Math.sin(elevation) };
}
