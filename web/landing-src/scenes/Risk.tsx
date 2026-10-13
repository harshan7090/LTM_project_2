/* 08 — Risk intelligence.
 *
 * The 5x5 the discipline already uses: likelihood up, consequence across,
 * band by product. The camera approaches it head-on and the matrix is the
 * last thing in the journey, because it is the thing the whole pipeline of
 * evidence exists to fill in.
 *
 * NO PER-CELL COUNTS. The four band totals are real and live in the
 * overlay; a count printed in each of twenty-five cells would be twenty-five
 * numbers this page cannot support. Band membership is carried by colour,
 * by cell height AND by a legend — never by hue alone, which is the same
 * rule the console's matrix follows.
 */
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { Group, Mesh } from 'three';

import { ChapterLight } from '../lights';
import { PALETTE } from '../palette';
import { applyFade, useActive, useChapter } from '../useScene';

const N = 5;
const CELL = 4.4;
const GAP = 0.45;

/** Band from likelihood x consequence, 1..5 each. The same thresholds the
 *  backend scores with, so the picture and the product agree. */
function band(likelihood: number, consequence: number): 0 | 1 | 2 | 3 {
  const s = likelihood * consequence;
  if (s >= 16) return 3;
  if (s >= 10) return 2;
  if (s >= 5) return 1;
  return 0;
}

const BAND_COLOUR = [PALETTE.success, PALETTE.blue, PALETTE.warn, PALETTE.critical];
const BAND_NAME = ['Low', 'Moderate', 'High', 'Severe'];
const BAND_HEIGHT = [0.35, 0.9, 1.7, 2.8];

/** Where it sits ahead of the camera on the path. */
const AHEAD = -46;

export function RiskScene() {
  const root = useRef<Group>(null);
  const grid = useRef<Group>(null);
  const marker = useRef<Mesh>(null);
  const chapter = useChapter('risk');
  const active = useActive('risk', 0.35);

  const cells = useMemo(() => {
    const out: { l: number; c: number; b: 0 | 1 | 2 | 3; x: number; y: number }[] = [];
    for (let l = 1; l <= N; l++) {
      for (let c = 1; c <= N; c++) {
        out.push({
          l,
          c,
          b: band(l, c),
          x: (c - 1 - (N - 1) / 2) * (CELL + GAP),
          y: (l - 1 - (N - 1) / 2) * (CELL + GAP),
        });
      }
    }
    return out;
  }, []);

  useFrame((state) => {
    const { p, t } = chapter.current;
    applyFade(root.current, p);

    const g = grid.current;
    if (g) {
      g.children.forEach((child, i) => {
        const cell = cells[i];
        // Cells rise in reading order, bottom-left to top-right, so the
        // matrix builds toward its own severe corner.
        const order = ((cell.l - 1) * N + (cell.c - 1)) / (N * N);
        const grow = Math.min(Math.max((t - order * 0.45) / 0.3, 0), 1);
        const ease = grow * grow * (3 - 2 * grow);
        child.scale.z = Math.max(ease, 0.0001);
        child.position.z = (BAND_HEIGHT[cell.b] * ease) / 2;
      });
    }

    // One segment being placed — the journey's own pulse arriving at the
    // cell it earned. Slow, so it reads as a placement and not a cursor.
    if (marker.current) {
      const u = (state.clock.elapsedTime * 0.11) % 1;
      const pick = cells[Math.floor(u * cells.length)];
      marker.current.position.x = pick.x;
      marker.current.position.y = pick.y;
      marker.current.visible = t > 0.5;
    }
  });

  return (
    <group ref={root} position={[0, 0, AHEAD]}>
      <group ref={grid}>
        {cells.map((cell) => (
          <mesh key={`${cell.l}-${cell.c}`} position={[cell.x, cell.y, 0]}>
            <boxGeometry args={[CELL, CELL, BAND_HEIGHT[cell.b]]} />
            <meshStandardMaterial
              color={BAND_COLOUR[cell.b]}
              roughness={0.4}
              metalness={0.2}
              emissive={BAND_COLOUR[cell.b]}
              emissiveIntensity={0.28}
            />
          </mesh>
        ))}
      </group>

      {/* The segment landing in its cell. */}
      <mesh ref={marker} position={[0, 0, 4.5]} visible={false}>
        <torusGeometry args={[CELL * 0.42, 0.11, 8, 32]} />
        <meshBasicMaterial color={PALETTE.text} toneMapped={false} />
      </mesh>

      {active && (
        <>
          <Html
            position={[-(CELL + GAP) * 3.1, 0, 0]}
            distanceFactor={44}
            zIndexRange={[20, 0]}
            style={{ pointerEvents: 'none' }}
          >
            <div className="axis axis--y">Likelihood</div>
          </Html>
          <Html
            position={[0, -(CELL + GAP) * 3.1, 0]}
            distanceFactor={44}
            zIndexRange={[20, 0]}
            style={{ pointerEvents: 'none' }}
          >
            <div className="axis">Consequence</div>
          </Html>
          <Html
            position={[0, (CELL + GAP) * 3.2, 0]}
            distanceFactor={44}
            zIndexRange={[20, 0]}
            style={{ pointerEvents: 'none' }}
          >
            <div className="legend">
              {BAND_NAME.map((n, i) => (
                <span key={n} className="legend__item">
                  <i style={{ background: BAND_COLOUR[i] }} />
                  {n}
                </span>
              ))}
            </div>
          </Html>
        </>
      )}

      <ChapterLight chapter="risk" kind="point" position={[0, 0, 26]} intensity={900} distance={140} color={PALETTE.text} />
      <ChapterLight chapter="risk" kind="point" position={[-18, 14, 18]} intensity={320} distance={120} color={PALETTE.blue} />
    </group>
  );
}

/* The point this scene most wants you to look at, in the chapter group's
   local space. Checked by web/scripts/check-journey.mjs against the camera
   at this chapter's peak, because a scene can be built perfectly and still
   be placed outside the frame. */
export const FOCUS: [number, number, number] = [0, 0, -46];
