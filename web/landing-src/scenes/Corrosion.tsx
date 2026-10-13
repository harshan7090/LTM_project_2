/* 05 — Corrosion.
 *
 * The closest look at the same line: the coating has failed in patches, and
 * pitting deepens through the chapter. The point being made is that
 * corrosion is a process with a RATE, not a defect that is either present
 * or absent, so the wall visibly degrades while you read about it.
 *
 * Two details worth keeping honest:
 *
 *   The pits CLUSTER. Real external corrosion follows coating holidays and
 *   cathodic-protection shadows, so it arrives in patches. Pits scattered
 *   evenly would look tidier and would be wrong.
 *
 *   Depth is carried by colour AND by size, never by colour alone — the
 *   same rule the console's risk bands follow, for the same reason.
 */
import { useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Color, Group, InstancedMesh, Object3D } from 'three';

import { PALETTE, STEEL } from '../palette';
import { applyFade, useChapter } from '../useScene';
import { PipeBody, PipeLights } from './pipe';

const LEN = 40;
const R = 5.0;
const PITS = 90;

/* Coating holidays — the bare patches the pitting organises itself around.
   Positioned along the barrel (x) and around it (a). */
const HOLIDAYS = [
  { x: -11, a: 1.30, spread: 5.0 },
  { x: 2,   a: 1.75, spread: 6.5 },
  { x: 14,  a: 1.05, spread: 4.0 },
];

interface Pit { x: number; y: number; z: number; a: number; r: number; sev: number }

export function CorrosionScene() {
  const root = useRef<Group>(null);
  const pitMesh = useRef<InstancedMesh>(null);
  const chapter = useChapter('corrosion');

  const pits = useMemo<Pit[]>(() => {
    let seed = 991733;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const out: Pit[] = [];
    for (let i = 0; i < PITS; i++) {
      const h = HOLIDAYS[i % HOLIDAYS.length];
      // The sum of two uniforms clusters toward the middle, which puts most
      // pits near the centre of a holiday and a few out at its edge.
      const dx = (rnd() + rnd() - 1) * h.spread;
      const da = (rnd() + rnd() - 1) * 0.55;
      const a = h.a + da;
      out.push({
        x: h.x + dx,
        y: Math.sin(a) * (R + 0.04),
        z: Math.cos(a) * (R + 0.04),
        a,
        r: 0.16 + rnd() * 0.3,
        // Deepest at the centre of a holiday, where the coating has been
        // open longest.
        sev: Math.min(1, 1 - Math.abs(dx) / (h.spread * 1.7) + rnd() * 0.2),
      });
    }
    return out;
  }, []);

  /* Each pit's colour depends only on its severity, so it is worked out
     once. This used to be recomputed for all ninety pits on every frame
     with a fresh Color allocated each time, and that garbage was enough to
     make the scroll hitch. */
  const pitColors = useMemo(() => {
    const warn = new Color(PALETTE.warn);
    const crit = new Color(PALETTE.critical);
    const rust = new Color(STEEL.rust);
    return pits.map((pit) => (pit.sev < 0.5
      ? rust.clone().lerp(warn, pit.sev * 2)
      : warn.clone().lerp(crit, (pit.sev - 0.5) * 2)));
  }, [pits]);

  useLayoutEffect(() => {
    const m = pitMesh.current;
    if (!m) return;
    pitColors.forEach((c, i) => m.setColorAt(i, c));
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [pitColors]);

  const dummy = useMemo(() => new Object3D(), []);
  const lastT = useRef(-1);

  useFrame(() => {
    const { p, t } = chapter.current;
    // Nothing to do while the chapter is off screen: its group is hidden.
    if (p <= 0.004) return;
    applyFade(root.current, p);

    const m = pitMesh.current;
    // Pit sizes only change with scroll position, so skip the rewrite
    // while the reader is still.
    if (!m || Math.abs(t - lastT.current) < 0.001) return;
    lastT.current = t;
    pits.forEach((pit, i) => {
      // Not linear: shallow pits appear first and the deep ones arrive
      // late, which is roughly how a wall actually gives up.
      const onset = (1 - pit.sev) * 0.5;
      const grow = Math.min(Math.max((t - onset) / 0.5, 0), 1);
      const s = grow * (0.35 + pit.sev * 0.65);
      dummy.position.set(pit.x, pit.y, pit.z);
      dummy.scale.setScalar(Math.max(s * pit.r, 1e-4));
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
  });

  return (
    <group ref={root} position={[-10, -2, -32]} rotation={[0.2, 0.3, 0]}>
      <PipeLights chapter="corrosion" />
      <PipeBody length={LEN} radius={R} welds={4} />

      {/* Coating holidays — the bare patches, as rust staining on the
          barrel, so the pitting has a visible reason to be where it is.
          A squashed sphere sitting just proud of the surface, rather than
          a cylinder segment: getting a partial cylinder to hug the barrel
          needs a compound rotation that produced a brown wedge floating
          under the pipe instead of a patch on it. An ellipsoid only has to
          be positioned, and it cannot be oriented wrongly. */}
      {HOLIDAYS.map((h, i) => (
        // Rotated about X so the ellipsoid's own Y axis points radially
        // outward at this holiday's seat angle. That is what lets it be
        // made THIN in the one direction that matters — scaled uniformly it
        // balloons off the barrel as a brown blob, which is what the first
        // attempt at this did.
        <group
          key={i}
          position={[h.x, Math.sin(h.a) * R, Math.cos(h.a) * R]}
          rotation={[h.a - Math.PI / 2, 0, 0]}
        >
          <mesh scale={[h.spread * 1.05, 0.3, 2.9]}>
            <sphereGeometry args={[1, 20, 12]} />
            <meshStandardMaterial
              color={STEEL.rust}
              transparent
              opacity={0.62}
              roughness={0.96}
              metalness={0.08}
            />
          </mesh>
        </group>
      ))}

      {/* All ninety pits in ONE draw call. They were ninety meshes with
          ninety geometries; instancing draws the lot at once. Per-pit colour
          rides on the instance colour, per-pit size on the instance matrix. */}
      <instancedMesh ref={pitMesh} args={[undefined, undefined, PITS]} frustumCulled={false}>
        <sphereGeometry args={[1, 10, 8]} />
        <meshStandardMaterial roughness={0.92} metalness={0.15}
                              emissive={PALETTE.warn} emissiveIntensity={0.1} />
      </instancedMesh>
    </group>
  );
}

/* See Twin.tsx for what FOCUS is and why it is checked. */
export const FOCUS: [number, number, number] = [-10, 0, -32];
