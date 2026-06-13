import { useMemo } from "react";
import * as THREE from "three";
import { engine, gridToWorld } from "../world/mockEngine.ts";
import { PAL } from "../world/palette.ts";
import type { WorldProcess } from "../world/types.ts";
import { Building } from "./Building.tsx";

// SNES village layout: each process is a building on the island grid; fork
// lineage is drawn as a stone road from parent to child.
export function Overworld({ processes, selected }: { processes: WorldProcess[]; selected: string | null }) {
  const byId = useMemo(() => new Map(processes.map((p) => [p.upid, p])), [processes]);
  return (
    <group>
      {processes.map((p) =>
        p.parentId && byId.has(p.parentId) && p.state !== "dead" ? (
          <Road key={"r" + p.upid} a={byId.get(p.parentId)!.grid} b={p.grid} />
        ) : null,
      )}
      {processes.map((p) => {
        const [x, z] = gridToWorld(p.grid);
        return (
          <group key={p.upid} position={[x, 0.66, z]}>
            <Building p={p} selected={p.upid === selected} onSelect={() => engine.select(p.upid)} />
          </group>
        );
      })}
    </group>
  );
}

function Road({ a, b }: { a: [number, number]; b: [number, number] }) {
  const { pos, rot, len } = useMemo(() => {
    const [ax, az] = gridToWorld(a);
    const [bx, bz] = gridToWorld(b);
    const dx = bx - ax;
    const dz = bz - az;
    const l = Math.hypot(dx, dz);
    return { pos: [(ax + bx) / 2, 0.67, (az + bz) / 2] as [number, number, number], rot: Math.atan2(dz, dx), len: l };
  }, [a, b]);
  return (
    <mesh position={pos} rotation={[-Math.PI / 2, 0, -rot]}>
      <planeGeometry args={[len, 0.7]} />
      <meshStandardMaterial color={PAL.path} roughness={1} side={THREE.DoubleSide} />
    </mesh>
  );
}
