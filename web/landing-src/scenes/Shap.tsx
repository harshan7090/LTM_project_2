/* 07 — Explainability.
 *
 * A SHAP waterfall built in space: a baseline spine down the middle, and
 * each feature's contribution pushing right (raises the prediction) or
 * left (lowers it). The camera travels down the aisle of them.
 *
 * The feature NAMES are the model's real inputs. The bar lengths are
 * illustrative of the shape a typical attribution takes, not a specific
 * segment's numbers — so there are deliberately no values printed on them.
 * The console computes and prints the real ones per segment; a marketing
 * page inventing a decimal would be exactly the kind of thing this whole
 * project is arguing against.
 */
import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { Group, Mesh } from 'three';

import { ChapterLight } from '../lights';
import { PALETTE } from '../palette';
import { applyFade, useActive, useChapter } from '../useScene';

/** Ordered by magnitude, the way a waterfall always is. Sign is what the
 *  colour encodes; magnitude is the length. */
const FEATURES = [
  { name: 'Coating condition index', mag: 1.00, up: true },
  { name: 'CP potential (mV)',       mag: 0.82, up: true },
  { name: 'Soil resistivity',        mag: 0.67, up: true },
  { name: 'Age in service',          mag: 0.54, up: true },
  { name: 'Chloride concentration',  mag: 0.41, up: true },
  { name: 'Operating temperature',   mag: 0.33, up: true },
  { name: 'Wall thickness',          mag: 0.46, up: false },
  { name: 'Inhibitor programme',     mag: 0.29, up: false },
  { name: 'Recent recoat',           mag: 0.21, up: false },
] as const;

/* Sized from a screenshot, not from taste: at ROW 3.1 the nine rows
   stood 28 units tall at 28 units of range and ran off both edges of
   the frame. */
const MAX_LEN = 7.5;
const ROW = 2.25;

export function ShapScene() {
  const root = useRef<Group>(null);
  const bars = useRef<(Mesh | null)[]>([]);
  const chapter = useChapter('shap');
  const active = useActive('shap', 0.4);

  useFrame(() => {
    const { p, t } = chapter.current;
    applyFade(root.current, p);

    FEATURES.forEach((f, i) => {
      const bar = bars.current[i];
      if (!bar) return;
      // Top contributor first, then down the list — the reading order of a
      // waterfall, drawn in the order you would read it.
      const onset = (i / FEATURES.length) * 0.5;
      const grow = Math.min(Math.max((t - onset) / 0.35, 0), 1);
      const ease = grow * grow * (3 - 2 * grow);
      const len = f.mag * MAX_LEN * ease;
      bar.scale.x = Math.max(len, 0.0001);
      // Anchored at the spine, growing outward, so the baseline stays put.
      bar.position.x = (f.up ? 1 : -1) * len / 2;
    });
  });

  return (
    <group ref={root} position={[-12, 0, -30]} rotation={[0, -0.16, 0]}>
      {/* The baseline. Everything is a departure from this. */}
      <mesh position={[0, 0, 0]}>
        <boxGeometry args={[0.07, FEATURES.length * ROW + 2, 0.07]} />
        <meshBasicMaterial color={PALETTE.muted} transparent opacity={0.55} />
      </mesh>

      {FEATURES.map((f, i) => {
        const y = (FEATURES.length - 1) / 2 * ROW - i * ROW;
        return (
          <group key={f.name} position={[0, y, 0]}>
            <mesh ref={(el) => { bars.current[i] = el; }} scale={[0.0001, 1, 1]}>
              {/* Unit box scaled on X — scaling is free per frame, whereas
                  rebuilding a box geometry nine times a frame is not. */}
              <boxGeometry args={[1, 1.15, 0.9]} />
              <meshStandardMaterial
                color={f.up ? PALETTE.critical : PALETTE.cyan}
                roughness={0.35}
                metalness={0.25}
                emissive={f.up ? PALETTE.critical : PALETTE.cyan}
                emissiveIntensity={0.35}
              />
            </mesh>

            {active && (
              <Html
                position={[f.up ? -0.9 : 0.9, 0, 0]}
                distanceFactor={30}
                zIndexRange={[20, 0]}
                style={{ pointerEvents: 'none' }}
              >
                <div className={`tag tag--shap ${f.up ? 'is-up' : 'is-down'}`}>
                  <span className="tag__k">{f.name}</span>
                  <span className="tag__v">{f.up ? 'raises' : 'lowers'}</span>
                </div>
              </Html>
            )}
          </group>
        );
      })}

      <ChapterLight chapter="shap" kind="point" position={[14, 6, 16]} intensity={280} distance={90} color={PALETTE.text} />
      <ChapterLight chapter="shap" kind="point" position={[-14, -6, 16]} intensity={200} distance={90} color={PALETTE.blue} />
    </group>
  );
}

/* The point this scene most wants you to look at, in the chapter group's
   local space. Checked by web/scripts/check-journey.mjs against the camera
   at this chapter's peak, because a scene can be built perfectly and still
   be placed outside the frame. */
export const FOCUS: [number, number, number] = [-12, 0, -30];
