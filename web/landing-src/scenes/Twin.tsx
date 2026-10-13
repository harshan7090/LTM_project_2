/* 03 — Digital twin.
 *
 * A section of line, seen from outside and slightly above, taking itself
 * apart: coating, steel wall, sensor layer, flow channel. The layers lift
 * clear of one another as the chapter runs, so you watch the construction
 * rather than read a labelled diagram of it.
 *
 * The layer order is the real one. Coating OUTSIDE the steel is what makes
 * external corrosion a coating-failure story two chapters later, and
 * getting the stack backwards here would undermine everything after it.
 *
 * An earlier version exploded these around the camera, which produced
 * screen-filling cyan sheets and nothing recognisable as a pipe. Sitting
 * the whole assembly ahead of and left of the flight path — clear of the
 * copy on the right — is what makes it legible.
 */
import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { DoubleSide, Group } from 'three';

import { PALETTE, STEEL } from '../palette';
import { applyFade, useActive, useChapter } from '../useScene';
import { PIPE_ROT, PipeLights } from './pipe';

const LEN = 34;

/* Radius, how far the layer lifts when the section opens, and how far it
   slides along the barrel. The flow channel does not move: it is the datum
   the others come off. */
const LAYERS = [
  { id: 'flow',    r: 2.6, lift: 0,    slide: 0,   label: 'Flow channel', note: 'Product, pressure, temperature' },
  { id: 'sensor',  r: 3.4, lift: 5.5,  slide: 1.5, label: 'Sensor layer', note: 'UT, MFL, CP, probes' },
  { id: 'steel',   r: 4.2, lift: 11,   slide: 3,   label: 'Steel wall',   note: 'API 5L grade, Barlow-rated' },
  { id: 'coating', r: 4.8, lift: 16.5, slide: 4.5, label: 'Coating',      note: 'FBE / 3LPE, condition-graded' },
] as const;

export function TwinScene() {
  const root = useRef<Group>(null);
  const shells = useRef<(Group | null)[]>([]);
  const chapter = useChapter('twin');
  const active = useActive('twin', 0.4);

  useFrame(() => {
    const { p, t } = chapter.current;
    applyFade(root.current, p);

    // Opens over the first two thirds, then holds. Holding matters: the
    // copy alongside is being read, and a diagram still moving while
    // someone reads about it is just noise.
    const open = Math.min(t / 0.66, 1);
    const ease = open * open * (3 - 2 * open);

    LAYERS.forEach((layer, i) => {
      const g = shells.current[i];
      if (!g) return;
      g.position.y = layer.lift * ease;
      g.position.x = layer.slide * ease;
    });
  });

  return (
    // Ahead and left of the flight path: the panel owns the right of the
    // frame, and a subject centred on the path would sit underneath it.
    <group ref={root} position={[-5, -3, -36]} rotation={[0.12, 0.42, 0]}>
      <PipeLights chapter="twin" />

      {LAYERS.map((layer, i) => (
        <group key={layer.id} ref={(el) => { shells.current[i] = el; }}>
          <mesh rotation={PIPE_ROT}>
            <cylinderGeometry
              args={[layer.r, layer.r, LEN, layer.id === 'sensor' ? 14 : 44, 1, layer.id !== 'flow']}
            />
            {layer.id === 'flow' ? (
              <meshBasicMaterial color={PALETTE.cyan} transparent opacity={0.5} toneMapped={false} />
            ) : layer.id === 'coating' ? (
              <meshStandardMaterial
                color={PALETTE.blue}
                side={DoubleSide}
                transparent
                opacity={0.4}
                roughness={0.3}
                metalness={0.2}
              />
            ) : layer.id === 'steel' ? (
              <meshStandardMaterial
                color={STEEL.dark}
                side={DoubleSide}
                roughness={0.38}
                metalness={0.92}
              />
            ) : (
              <meshBasicMaterial color={PALETTE.muted} wireframe transparent opacity={0.45} />
            )}
          </mesh>

          {/* Girth welds on the steel, and instrument rings on the sensor
              layer — the two layers that have real features. */}
          {(layer.id === 'steel' || layer.id === 'sensor') &&
            [-11, -3.5, 4, 11.5].map((x) => (
              <mesh key={x} position={[x, 0, 0]} rotation={PIPE_ROT}>
                <torusGeometry args={[layer.r + 0.03, layer.id === 'sensor' ? 0.1 : 0.13, 8, 40]} />
                <meshStandardMaterial
                  color={layer.id === 'sensor' ? PALETTE.cyan : STEEL.light}
                  emissive={layer.id === 'sensor' ? PALETTE.cyan : '#000000'}
                  emissiveIntensity={layer.id === 'sensor' ? 0.7 : 0}
                  roughness={0.5}
                  metalness={0.8}
                />
              </mesh>
            ))}

          {active && (
            <Html
              position={[-LEN / 2 - 1.5, 0, 0]}
              distanceFactor={52}
              zIndexRange={[20, 0]}
              style={{ pointerEvents: 'none' }}
            >
              <div className="tag tag--left">
                <span className="tag__k">{layer.label}</span>
                <span className="tag__v">{layer.note}</span>
              </div>
            </Html>
          )}
        </group>
      ))}
    </group>
  );
}

/* The point this scene most wants you to look at, in the chapter group's
   local space. Checked by web/scripts/check-journey.mjs against the camera
   at this chapter's peak, because a scene can be built perfectly and still
   be placed outside the frame. */
export const FOCUS: [number, number, number] = [-5, 5, -36];
