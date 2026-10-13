/* 01 — Orbit.
 *
 * The establishing shot. A limb of the planet below and a field of stars,
 * with the corridor network already faintly alight on the surface so the
 * next chapter is something you descend INTO rather than cut to.
 *
 * Deliberately restrained: this is the first thing that paints, so it has
 * to be cheap enough to hit frame rate on the machine that is still
 * decompressing the rest of the bundle.
 */
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { AdditiveBlending, BackSide, BufferGeometry, Float32BufferAttribute, Group } from 'three';

import { ChapterLight } from '../lights';
import { PALETTE } from '../palette';
import { applyFade, useChapter } from '../useScene';

const R = 400;
/** Centre of the planet, relative to the anchor on the flight path. The
 *  camera is high here, so the surface sits far below and curves away. */
const CY = -425;

const STARS = 900;

export function OrbitScene() {
  const root = useRef<Group>(null);
  const globe = useRef<Group>(null);
  const chapter = useChapter('orbit');

  const stars = useMemo(() => {
    const g = new BufferGeometry();
    const xyz = new Float32Array(STARS * 3);
    // Deterministic: a fixed seed means the sky is the same on every load,
    // which matters if anyone ever compares two screenshots.
    let seed = 20260925;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < STARS; i++) {
      // Rejection-free spherical distribution on a large shell.
      const u = rnd() * 2 - 1;
      const th = rnd() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      const rad = 900 + rnd() * 350;
      xyz[i * 3] = Math.cos(th) * s * rad;
      xyz[i * 3 + 1] = u * rad * 0.7;
      xyz[i * 3 + 2] = Math.sin(th) * s * rad;
    }
    g.setAttribute('position', new Float32BufferAttribute(xyz, 3));
    return g;
  }, []);

  useFrame((_, dt) => {
    applyFade(root.current, chapter.current.p);
    // A slow roll. Fast enough to prove the frame is live, slow enough that
    // nobody notices it as motion.
    if (globe.current) globe.current.rotation.y += dt * 0.012;
  });

  return (
    <group ref={root}>
      <points geometry={stars}>
        <pointsMaterial
          size={1.9}
          sizeAttenuation
          color={PALETTE.text}
          transparent
          opacity={0.55}
          depthWrite={false}
        />
      </points>

      <group ref={globe} position={[0, CY, -60]}>
        {/* Body. Dark and matte — the planet is not the subject here, the
            network on it is. */}
        <mesh>
          <sphereGeometry args={[R, 64, 48]} />
          <meshStandardMaterial color="#0A1220" roughness={0.95} metalness={0.05} />
        </mesh>

        {/* Graticule. Reads as a surveyed body rather than a ball. */}
        <mesh>
          <sphereGeometry args={[R * 1.001, 48, 24]} />
          <meshBasicMaterial
            color={PALETTE.blue}
            wireframe
            transparent
            opacity={0.07}
            depthWrite={false}
          />
        </mesh>

        {/* Atmosphere. Drawn on the inside of a slightly larger shell, which
            is what puts the glow on the limb instead of over the face. */}
        <mesh>
          <sphereGeometry args={[R * 1.045, 48, 32]} />
          <meshBasicMaterial
            color={PALETTE.cyan}
            side={BackSide}
            transparent
            opacity={0.16}
            blending={AdditiveBlending}
            depthWrite={false}
          />
        </mesh>
      </group>

      {/* A cool key from below, so the limb separates from the sky. */}
      <ChapterLight chapter="orbit" kind="point" position={[-260, CY + R + 120, 140]} intensity={4200} distance={1400} color={PALETTE.blue} />
    </group>
  );
}

/* The point this scene most wants you to look at, in the chapter group's
   local space. Checked by web/scripts/check-journey.mjs against the camera
   at this chapter's peak, because a scene can be built perfectly and still
   be placed outside the frame. */
export const FOCUS: [number, number, number] = [0, -25, -60];
