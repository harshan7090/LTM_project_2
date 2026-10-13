/* Chapter lighting with a CONSTANT light count.
 *
 * WHY THIS EXISTS
 *
 *   three.js compiles the number of lights into every material's shader.
 *   Each chapter used to own its lights inside its own group, and a hidden
 *   group's lights do not count, so the scene's light count changed every
 *   time a chapter faded in or out (alone, or overlapping its neighbour).
 *   Every material was then recompiled for each new combination, mid-scroll.
 *   Measured on an Intel UHD 620: seventeen shader programs built during the
 *   first scroll, 3.4 s blocked in getProgramInfoLog, stalls of 0.3-0.9 s at
 *   each chapter.
 *
 * HOW
 *
 *   A chapter declares its lights with <ChapterLight>, which renders only an
 *   invisible marker where the light should be. One LightRig, always in the
 *   scene, owns a fixed set of real lights (two slots of one directional and
 *   two point lights) and each frame dresses them as the lights of the one
 *   or two chapters currently on screen, faded by presence. Unused slots sit
 *   at zero intensity. The count never changes, so every material compiles
 *   once, during the warm-up, and never again.
 */
import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Color, DirectionalLight, Object3D, PointLight } from 'three';

import { CHAPTERS, presence } from './journey';
import { journey } from './World';

interface LightSpec {
  kind: 'dir' | 'point';
  anchor: Object3D;          // where the light sits, in the chapter's space
  color: Color;
  intensity: number;
  distance: number;
}

/* Chapter id -> its declared lights. Mutated by ChapterLight on mount. */
const registry = new Map<string, LightSpec[]>();

/** Per chapter, the most each slot can carry. Every chapter in the journey
 *  fits: the pipe scenes use one directional and two point lights. */
const DIR_PER_SLOT = 1;
const POINT_PER_SLOT = 2;
const SLOTS = 2;

export function ChapterLight({
  chapter, kind, position, color, intensity, distance = 0,
}: {
  chapter: string;
  kind: 'dir' | 'point';
  position: [number, number, number];
  color: string;
  intensity: number;
  distance?: number;
}) {
  const anchor = useRef<Object3D>(null);

  useEffect(() => {
    if (!anchor.current) return;
    const spec: LightSpec = {
      kind, anchor: anchor.current, color: new Color(color), intensity, distance,
    };
    const list = registry.get(chapter) ?? [];
    list.push(spec);
    registry.set(chapter, list);
    return () => {
      const l = registry.get(chapter);
      if (l) registry.set(chapter, l.filter((s) => s !== spec));
    };
  }, [chapter, kind, color, intensity, distance]);

  // Only a marker. A directional light aims at the WORLD origin, exactly as
  // a <directionalLight> declared inside a chapter did: its default target
  // was never added to the scene, so it stayed at (0, 0, 0).
  return <object3D ref={anchor} position={position} />;
}

/** The fixed set of real lights. Mounted once, at the scene root. */
export function LightRig() {
  const { scene } = useThree();
  const dirs = useRef<DirectionalLight[]>([]);
  const points = useRef<PointLight[]>([]);

  useEffect(() => {
    const made: Object3D[] = [];
    for (let i = 0; i < SLOTS * DIR_PER_SLOT; i++) {
      const d = new DirectionalLight('#ffffff', 0);
      scene.add(d, d.target);
      made.push(d, d.target);
      dirs.current.push(d);
    }
    for (let i = 0; i < SLOTS * POINT_PER_SLOT; i++) {
      const p = new PointLight('#ffffff', 0, 0, 2);
      scene.add(p);
      made.push(p);
      points.current.push(p);
    }
    return () => {
      made.forEach((o) => scene.remove(o));
      dirs.current = [];
      points.current = [];
    };
  }, [scene]);

  useFrame(() => {
    // The two chapters most on screen, strongest first.
    const ranked = CHAPTERS
      .map((c) => ({ id: c.id, p: presence(journey.t, c) }))
      .filter((c) => c.p > 0.004)
      .sort((a, b) => b.p - a.p)
      .slice(0, SLOTS);

    for (const l of dirs.current) l.intensity = 0;
    for (const l of points.current) l.intensity = 0;

    ranked.forEach(({ id, p }, slot) => {
      const specs = registry.get(id) ?? [];
      let di = 0;
      let pi = 0;
      for (const s of specs) {
        if (s.kind === 'dir' && di < DIR_PER_SLOT) {
          const light = dirs.current[slot * DIR_PER_SLOT + di++];
          if (!light) continue;
          s.anchor.updateWorldMatrix(true, false);
          light.position.setFromMatrixPosition(s.anchor.matrixWorld);
          light.color.copy(s.color);
          light.intensity = s.intensity * p;
        } else if (s.kind === 'point' && pi < POINT_PER_SLOT) {
          const light = points.current[slot * POINT_PER_SLOT + pi++];
          if (!light) continue;
          s.anchor.updateWorldMatrix(true, false);
          light.position.setFromMatrixPosition(s.anchor.matrixWorld);
          light.color.copy(s.color);
          light.distance = s.distance;
          light.intensity = s.intensity * p;
        }
      }
    });
  });

  return null;
}
