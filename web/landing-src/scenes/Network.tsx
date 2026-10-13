/* 02 — The network.
 *
 * The fifteen real corridors, laid out below the flight path so the camera
 * passes over them. The geometry comes from corridors.ts, which is
 * generated from the same routes.py the 5,000 segments were placed on —
 * this is the actual network, not a decorative squiggle that looks like
 * one.
 *
 * Each corridor draws itself on as the chapter progresses, staggered by
 * position so the map assembles rather than appearing. Gas pulses then run
 * the finished lines at a rate set by the corridor's own throughput
 * weight, so the trunk lines visibly carry more than the spurs.
 */
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import { AdditiveBlending, CatmullRomCurve3, Group, Mesh, Vector3 } from 'three';
import type { Line2 } from 'three-stdlib';

import { CORRIDORS } from '../corridors';
import { PALETTE } from '../palette';
import { applyFade, project, useChapter } from '../useScene';

/** How far below the view axis the map lies, and how far ahead it sits.
 *  Both were set by measurement, not by eye: at DECK -34 the whole map
 *  projected to ndc y -2.6 and no part of it was ever on screen. */
const DECK = -16;
const MAP_Z = -45;

interface Built {
  name: string;
  weight: number;
  points: Vector3[];
  curve: CatmullRomCurve3;
  /** 0..1 — where in the chapter this corridor starts drawing. */
  delay: number;
  trunk: boolean;
}

export function NetworkScene() {
  const root = useRef<Group>(null);
  const chapter = useChapter('network');
  const lines = useRef<(Line2 | null)[]>([]);
  const runners = useRef<(Mesh | null)[]>([]);

  const built = useMemo<Built[]>(() => {
    return CORRIDORS.map((c, i) => {
      const points = c.path.map(([lat, lon]) => {
        const [x, z] = project(lat, lon);
        return new Vector3(x, DECK, z);
      });
      return {
        name: c.name,
        weight: c.weight,
        points,
        curve: new CatmullRomCurve3(points, false, 'catmullrom', 0.2),
        // Staggered by index rather than at random, so the order is stable
        // between loads and the assembly reads as deliberate.
        delay: (i / CORRIDORS.length) * 0.45,
        trunk: c.weight >= 0.8,
      };
    });
  }, []);

  const at = useRef(new Vector3());

  useFrame((state) => {
    const { p, t } = chapter.current;
    applyFade(root.current, p);

    for (let i = 0; i < built.length; i++) {
      const b = built[i];
      // Draw-on. The dash covers the whole line, and pulling the offset
      // back from a full gap to zero wipes it into existence — cheaper
      // than rebuilding geometry every frame for a reveal.
      const local = Math.min(Math.max((t - b.delay) / 0.4, 0), 1);
      const line = lines.current[i];
      if (line) {
        const mat = line.material as unknown as { dashOffset: number };
        mat.dashOffset = (1 - local) * -2;
      }

      // A pulse running the finished line. Trunk corridors run faster,
      // which is the one place on this page where throughput is drawn
      // rather than stated.
      const runner = runners.current[i];
      if (runner) {
        runner.visible = local > 0.98;
        if (runner.visible) {
          const speed = 0.06 + b.weight * 0.1;
          const u = (state.clock.elapsedTime * speed + i * 0.37) % 1;
          b.curve.getPointAt(u, at.current);
          runner.position.copy(at.current);
        }
      }
    }
  });

  return (
    <group ref={root} position={[0, 0, MAP_Z]}>
      {/* The deck the network sits on. Faint, and only there to give the
          lines somewhere to be — a network floating in black has no sense
          of ground. */}
      <mesh position={[0, DECK - 0.6, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[220, 220, 1, 1]} />
        <meshBasicMaterial color={PALETTE.panel} transparent opacity={0.55} />
      </mesh>
      {/* The grid is a floor reference, not a subject. Its colours are set
          through the constructor args rather than by attaching a material:
          gridHelper draws LineSegments, so a <meshBasicMaterial> replaced a
          line material with a mesh one, discarded the colours passed above
          and rendered the whole grid in default white. On screen it read as
          brighter than the pipeline network drawn on top of it. */}
      <gridHelper
        args={[220, 44, '#16324a', '#0F2333']}
        position={[0, DECK - 0.4, 0]}
      />

      {built.map((b, i) => (
        <group key={b.name}>
          <Line
            ref={(el) => { lines.current[i] = el as unknown as Line2 | null; }}
            points={b.points}
            color={b.trunk ? PALETTE.cyan : PALETTE.blue}
            lineWidth={b.trunk ? 2.4 : 1.5}
            transparent
            opacity={b.trunk ? 0.95 : 0.6}
            dashed
            dashSize={4}
            gapSize={4}
            dashScale={0.25}
          />

          {/* Waypoints. These are the real route vertices, so the shape of
              a corridor is legible as bends rather than as a smooth arc. */}
          {b.points.map((pt, j) => (
            <mesh key={j} position={pt}>
              <sphereGeometry args={[b.trunk ? 0.5 : 0.34, 10, 8]} />
              <meshBasicMaterial
                color={PALETTE.cyan}
                transparent
                opacity={0.8}
                toneMapped={false}
              />
            </mesh>
          ))}

          <mesh ref={(el) => { runners.current[i] = el; }} visible={false}>
            <sphereGeometry args={[0.85, 12, 10]} />
            <meshBasicMaterial
              color={PALETTE.cyan}
              transparent
              opacity={0.9}
              blending={AdditiveBlending}
              depthWrite={false}
              toneMapped={false}
            />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/* The point this scene most wants you to look at, in the chapter group's
   local space. Checked by web/scripts/check-journey.mjs against the camera
   at this chapter's peak, because a scene can be built perfectly and still
   be placed outside the frame. */
export const FOCUS: [number, number, number] = [0, -16, -45];
