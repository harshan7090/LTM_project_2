/* A length of pipe, seen from outside.
 *
 * WHY FROM OUTSIDE
 *
 *   The first version of chapters three, four and five put the camera
 *   INSIDE the pipe, on the theory that flying through it would feel
 *   immersive. Screenshots settled it: from inside, a smooth tube with no
 *   near-field detail is a dark void with a bright disc at the far end.
 *   The exploded twin read as abstract cyan sheets, the sensor run as a
 *   stack of giant rings, and the corrosion chapter as a brown triangle.
 *   None of them read as a pipe.
 *
 *   So all three now show the same asset from outside, at increasing
 *   magnification — the network, then the section, then the wall. That also
 *   gives the middle of the journey a subject that persists across three
 *   chapters instead of three unrelated abstractions.
 *
 * ORIENTATION
 *
 *   The pipe runs along local X, across the view, because the copy sits on
 *   the right of the frame and a pipe running away from the camera would
 *   vanish underneath it. Cylinder geometry is built along Y, so every pipe
 *   here carries a z-rotation of a quarter turn.
 */
import { DoubleSide } from 'three';

import { ChapterLight } from '../lights';
import { PALETTE, STEEL } from '../palette';

export const PIPE_ROT: [number, number, number] = [0, 0, Math.PI / 2];

/**
 * Steel body plus girth welds.
 *
 * The welds are not decoration: a smooth cylinder has no sense of length,
 * and at this scale the eye reads the ring spacing as distance travelled.
 */
export function PipeBody({
  length,
  radius,
  welds = 5,
  color = STEEL.dark,
  open = false,
}: {
  length: number;
  radius: number;
  welds?: number;
  color?: string;
  /** Open-ended, for a layer in an exploded view. */
  open?: boolean;
}) {
  const step = length / (welds + 1);
  return (
    <group>
      <mesh rotation={PIPE_ROT} castShadow={false}>
        <cylinderGeometry args={[radius, radius, length, 44, 1, open]} />
        <meshStandardMaterial
          color={color}
          roughness={0.38}
          metalness={0.92}
          side={open ? DoubleSide : undefined}
        />
      </mesh>

      {Array.from({ length: welds }, (_, i) => {
        const x = -length / 2 + step * (i + 1);
        return (
          <mesh key={i} position={[x, 0, 0]} rotation={PIPE_ROT}>
            <torusGeometry args={[radius + 0.02, radius * 0.028, 8, 44]} />
            <meshStandardMaterial color={STEEL.light} roughness={0.55} metalness={0.8} />
          </mesh>
        );
      })}
    </group>
  );
}

/**
 * The product inside, shown as a soft additive core.
 *
 * Additive rather than a lit material: this is meant to read as contained
 * energy, and a shaded cylinder inside another shaded cylinder just reads
 * as a second pipe.
 */
export function FlowCore({ length, radius }: { length: number; radius: number }) {
  return (
    <mesh rotation={PIPE_ROT}>
      <cylinderGeometry args={[radius, radius, length * 0.995, 28, 1, false]} />
      <meshBasicMaterial
        color={PALETTE.cyan}
        transparent
        opacity={0.42}
        toneMapped={false}
      />
    </mesh>
  );
}

/** Lighting that makes steel look like steel: a hard key for the specular
 *  roll-off along the top of the barrel, and a cool fill so the shadowed
 *  underside does not go to pure black. */
export function PipeLights({ chapter }: { chapter: string }) {
  // Declared, not created: the LightRig carries them (see lights.tsx).
  return (
    <>
      <ChapterLight chapter={chapter} kind="dir" position={[6, 16, 14]} intensity={2.4} color={PALETTE.text} />
      <ChapterLight chapter={chapter} kind="point" position={[-14, -8, 10]} intensity={420} distance={90} color={PALETTE.blue} />
      <ChapterLight chapter={chapter} kind="point" position={[10, 4, 16]} intensity={260} distance={70} color={PALETTE.cyan} />
    </>
  );
}
