/* The gas pulse — the thing the camera is following.
 *
 * It runs slightly ahead of the camera on the same spline for the whole
 * journey, so it is the one object continuously on screen from orbit to the
 * risk matrix. That continuity is what stitches eight chapters into one
 * trip: whatever else changes, the pulse is still there, still moving, and
 * you are still behind it.
 *
 * It is drawn as a bright core inside a larger soft shell. The core is what
 * the bloom pass picks up; the shell is what gives it volume. A single
 * sphere blooms into a featureless white blob.
 */
import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { AdditiveBlending, CatmullRomCurve3, Group, Vector3 } from 'three';

import { journey } from './World';
import { PALETTE } from './palette';

/** How far ahead of the camera the pulse sits, in journey units. Matches
 *  the camera's own look-ahead in World.tsx, so the camera is always aimed
 *  at it rather than near it. */
const LEAD = 0.035;

/** Trailing sparks. Capped hard — a particle field is the easiest place on
 *  a page like this to spend a frame budget with nothing to show for it. */
const SPARKS = 14;

export function Pulse({ curve }: { curve: CatmullRomCurve3 }) {
  const group = useRef<Group>(null);
  const sparks = useRef<Group>(null);
  const at = useRef(new Vector3());

  useFrame((state) => {
    const g = group.current;
    if (!g) return;
    const t = Math.min(journey.t + LEAD, 1);
    curve.getPointAt(t, at.current);
    g.position.copy(at.current);

    // Breathes, so it reads as a pressure pulse in a line rather than as a
    // marker pinned to a path.
    const beat = 1 + Math.sin(state.clock.elapsedTime * 3.1) * 0.12;
    g.scale.setScalar(beat);

    // The trail lags behind on the spline, which draws the direction of
    // travel without needing a motion-blur pass.
    const s = sparks.current;
    if (s) {
      s.children.forEach((child, i) => {
        const back = Math.max(t - (i + 1) * 0.0022, 0);
        curve.getPointAt(back, at.current);
        child.position.copy(at.current).sub(g.position);
        const wob = Math.sin(state.clock.elapsedTime * 4 + i) * 0.5;
        child.position.x += wob;
        child.position.y += Math.cos(state.clock.elapsedTime * 3.3 + i) * 0.5;
      });
    }
  });

  return (
    <group ref={group}>
      {/* Core — small and very bright, so the bloom threshold catches it. */}
      <mesh>
        <sphereGeometry args={[0.34, 20, 16]} />
        <meshBasicMaterial color={PALETTE.cyan} toneMapped={false} />
      </mesh>

      {/* Shell — large, faint, additive. This is what gives the core volume
          instead of letting it bloom into a flat disc. */}
      <mesh>
        <sphereGeometry args={[0.95, 20, 16]} />
        <meshBasicMaterial
          color={PALETTE.cyan}
          transparent
          opacity={0.16}
          blending={AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>

      <pointLight color={PALETTE.cyan} intensity={55} distance={48} decay={2} />

      <group ref={sparks}>
        {Array.from({ length: SPARKS }).map((_, i) => (
          <mesh key={i}>
            <sphereGeometry args={[0.09 * (1 - i / SPARKS) + 0.02, 8, 6]} />
            <meshBasicMaterial
              color={i % 3 === 0 ? PALETTE.blue : PALETTE.cyan}
              transparent
              opacity={0.7 * (1 - i / SPARKS)}
              blending={AdditiveBlending}
              depthWrite={false}
              toneMapped={false}
            />
          </mesh>
        ))}
      </group>
    </group>
  );
}
