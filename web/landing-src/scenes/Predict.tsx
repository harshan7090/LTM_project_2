/* 06 — Prediction engine.
 *
 * NOT A BRAIN. The brief is explicit and it is right: a glowing neural mesh
 * would be a picture of a different product. What is actually here is
 * gradient-boosted trees over forty-one measured attributes, so what is
 * drawn is an instrument aisle — two racks of feature channels flanking the
 * path, feeding a beam that converges on one value.
 *
 * The rails around the beam are the conformal prediction interval. They
 * start wide and narrow as the chapter runs, and they never close. That is
 * the honest shape of this model: it produces a number AND a bound, and the
 * bound is not zero. A beam converging to a point would be claiming a
 * certainty the measured 89.8% coverage does not support.
 */
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { AdditiveBlending, DoubleSide, Group, Mesh } from 'three';

import { ChapterLight } from '../lights';
import { PALETTE } from '../palette';
import { applyFade, useChapter } from '../useScene';

/** Feature channels per rack. Forty-one attributes, twenty per side plus
 *  the one the beam is made of. */
const PER_RACK = 20;
const RACK_X = 13;
const CELLS = 7;

/** Where the beam converges. Ahead of the camera on the flight path. */
const FOCUS_Z = -54;

export function PredictScene() {
  const root = useRef<Group>(null);
  const cells = useRef<(Mesh | null)[]>([]);
  const railTop = useRef<Mesh>(null);
  const railBot = useRef<Mesh>(null);
  const node = useRef<Mesh>(null);
  const chapter = useChapter('predict');

  /* Deterministic channel layout: each channel has a height, a firing
     phase and a weight. Fixed seed, so the aisle is the same every load. */
  const channels = useMemo(() => {
    let seed = 4113309;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    return Array.from({ length: PER_RACK * 2 }, (_, i) => ({
      side: i < PER_RACK ? -1 : 1,
      slot: i % PER_RACK,
      phase: rnd(),
      weight: 0.25 + rnd() * 0.75,
    }));
  }, []);

  useFrame((state) => {
    const { p, t } = chapter.current;
    applyFade(root.current, p);
    const now = state.clock.elapsedTime;

    // Cells light in a travelling wave down each rack — the aisle reads as
    // being read, column by column, rather than as decoration.
    let k = 0;
    for (const ch of channels) {
      for (let c = 0; c < CELLS; c++) {
        const mesh = cells.current[k++];
        if (!mesh) continue;
        const wave = (now * 0.55 + ch.phase * 4 + ch.slot * 0.12 - c * 0.08) % 3;
        const lit = wave < 0.45 ? 1 - wave / 0.45 : 0;
        const mat = mesh.material as { opacity: number };
        mat.opacity = 0.1 + lit * 0.85 * ch.weight;
      }
    }

    // The interval narrows but does not close. 0.9 -> 0.28 world units of
    // half-width; the floor is the point.
    const narrow = 0.9 - Math.min(t / 0.8, 1) * 0.62;
    if (railTop.current) railTop.current.position.y = narrow;
    if (railBot.current) railBot.current.position.y = -narrow;

    if (node.current) {
      const arrive = Math.min(Math.max((t - 0.45) / 0.4, 0), 1);
      const beat = 1 + Math.sin(now * 2.6) * 0.07;
      node.current.scale.setScalar(arrive * beat * 1.6);
    }
  });

  let cellIndex = 0;

  return (
    // Shifted left: the right-hand rack was rendering underneath the
    // panel copy, which made both harder to read.
    <group ref={root} position={[-12, 0, 0]}>
      {channels.map((ch, i) => {
        const z = 16 - ch.slot * 4.2;
        return (
          <group key={i} position={[ch.side * RACK_X, 0, z]}>
            {/* Channel spine. */}
            <mesh>
              <boxGeometry args={[0.08, CELLS * 1.35, 0.08]} />
              <meshBasicMaterial color={PALETTE.muted} transparent opacity={0.22} />
            </mesh>
            {Array.from({ length: CELLS }, (_, c) => {
              const idx = cellIndex++;
              return (
                <mesh
                  key={c}
                  ref={(el) => { cells.current[idx] = el; }}
                  position={[0, (c - (CELLS - 1) / 2) * 1.35, 0]}
                >
                  <boxGeometry args={[1.5 * ch.weight + 0.3, 0.5, 0.18]} />
                  <meshBasicMaterial
                    color={c > CELLS - 3 ? PALETTE.cyan : PALETTE.blue}
                    transparent
                    opacity={0.2}
                    toneMapped={false}
                  />
                </mesh>
              );
            })}
          </group>
        );
      })}

      {/* The beam: every channel resolving to one value. */}
      <mesh position={[0, 0, FOCUS_Z / 2 + 8]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.16, 0.16, Math.abs(FOCUS_Z) + 32, 12, 1, true]} />
        <meshBasicMaterial
          color={PALETTE.cyan}
          side={DoubleSide}
          transparent
          opacity={0.65}
          blending={AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>

      {/* The conformal interval, as two rails around the beam. */}
      {[railTop, railBot].map((r, i) => (
        <mesh
          key={i}
          ref={r}
          position={[0, i === 0 ? 0.9 : -0.9, FOCUS_Z / 2 + 8]}
          rotation={[Math.PI / 2, 0, 0]}
        >
          <cylinderGeometry args={[0.045, 0.045, Math.abs(FOCUS_Z) + 32, 8, 1, true]} />
          <meshBasicMaterial
            color={PALETTE.warn}
            side={DoubleSide}
            transparent
            opacity={0.5}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
      ))}

      {/* The value. */}
      <mesh ref={node} position={[0, 0, FOCUS_Z]}>
        <icosahedronGeometry args={[1, 2]} />
        <meshBasicMaterial color={PALETTE.cyan} toneMapped={false} />
      </mesh>
      <ChapterLight chapter="predict" kind="point" position={[0, 0, FOCUS_Z]} intensity={420} distance={90} color={PALETTE.cyan} />
      <ChapterLight chapter="predict" kind="point" position={[0, 6, 14]} intensity={180} distance={80} color={PALETTE.blue} />
    </group>
  );
}

/* The point this scene most wants you to look at, in the chapter group's
   local space. Checked by web/scripts/check-journey.mjs against the camera
   at this chapter's peak, because a scene can be built perfectly and still
   be placed outside the frame. */
export const FOCUS: [number, number, number] = [-12, 0, -54];
