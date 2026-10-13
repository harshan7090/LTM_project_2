/* 04 — Sensor intelligence.
 *
 * The same line, closer, with its instrumentation on it. Each sensor emits
 * an expanding ring on its own period — pressure fast, wall thickness slow
 * — so the run has the texture of a system polled at different rates
 * rather than a set of lights sharing one clock.
 *
 * The six channels are the six the model actually consumes. A seventh
 * added for visual balance would be an invented instrument.
 */
import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { AdditiveBlending, DoubleSide, Group, Mesh } from 'three';

import { PALETTE } from '../palette';
import { applyFade, useActive, useChapter } from '../useScene';
import { FlowCore, PipeBody, PipeLights } from './pipe';

const LEN = 40;
const R = 4.2;

/* Channel, ring period in seconds, and where it sits along the run. Seated
   on the upper half of the barrel so the pucks are not hidden by it. */
const CHANNELS = [
  { id: 'Pressure',        unit: 'bar',   period: 1.1, x: -15.5, a: 1.15, row: 0 },
  { id: 'Temperature',     unit: 'degC',  period: 2.3, x: -9.5, a: 2.05, row: 1 },
  { id: 'UT wall',         unit: 'mm',    period: 4.4, x: -3,   a: 1.40, row: 0 },
  { id: 'MFL',             unit: 'index', period: 3.1, x: 3.5,  a: 2.30, row: 1 },
  { id: 'Corrosion probe', unit: 'mpy',   period: 5.2, x: 9.5,  a: 1.00, row: 0 },
  { id: 'CP potential',    unit: 'mV',    period: 2.7, x: 15.5, a: 1.90, row: 1 },
] as const;

export function SensorScene() {
  const root = useRef<Group>(null);
  const rings = useRef<(Mesh | null)[]>([]);
  const chapter = useChapter('sensors');
  const active = useActive('sensors', 0.35);

  useFrame((state) => {
    applyFade(root.current, chapter.current.p);
    const now = state.clock.elapsedTime;

    CHANNELS.forEach((c, i) => {
      const ring = rings.current[i];
      if (!ring) return;
      // One ping per period, expanding and fading. Phase-offset by index so
      // the six never fire together and read as a single flash.
      const u = ((now / c.period) + i * 0.17) % 1;
      const s = 1 + u * 4.5;
      ring.scale.set(s, s, 1);
      (ring.material as { opacity: number }).opacity = (1 - u) * 0.8;
    });
  });

  return (
    <group ref={root} position={[-13, -2, -34]} rotation={[0.16, 0.34, 0]}>
      <PipeLights chapter="sensors" />
      <PipeBody length={LEN} radius={R} welds={6} />
      <FlowCore length={LEN} radius={R * 0.55} />

      {CHANNELS.map((c, i) => {
        // Seated on the barrel surface at angle a, measured in the YZ plane
        // because the pipe runs along X.
        const y = Math.sin(c.a) * R;
        const z = Math.cos(c.a) * R;
        return (
          <group key={c.id} position={[c.x, y, z]} rotation={[0, 0, 0]}>
            <mesh>
              <sphereGeometry args={[0.38, 14, 12]} />
              <meshStandardMaterial
                color={PALETTE.cyan}
                emissive={PALETTE.cyan}
                emissiveIntensity={1.4}
                toneMapped={false}
              />
            </mesh>

            {/* The ping. Lies flat against the barrel by facing outward
                along the seat normal. */}
            <mesh
              ref={(el) => { rings.current[i] = el; }}
              rotation={[Math.PI / 2 - c.a, 0, 0]}
            >
              <ringGeometry args={[0.55, 0.72, 32]} />
              <meshBasicMaterial
                color={PALETTE.cyan}
                side={DoubleSide}
                transparent
                opacity={0.7}
                blending={AdditiveBlending}
                depthWrite={false}
                toneMapped={false}
              />
            </mesh>

            {active && (
              <Html
                position={[0, c.row ? 4.6 : 1.8, 0]}
                distanceFactor={46}
                zIndexRange={[20, 0]}
                style={{ pointerEvents: 'none' }}
              >
                <div className="tag tag--pin">
                  <span className="tag__k">{c.id}</span>
                  <span className="tag__v">{c.unit}</span>
                </div>
              </Html>
            )}
          </group>
        );
      })}
    </group>
  );
}

/* See Twin.tsx for what FOCUS is and why it is checked. */
export const FOCUS: [number, number, number] = [-13, -1, -34];
