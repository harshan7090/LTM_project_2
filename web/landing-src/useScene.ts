/* Shared machinery for the chapter scenes.
 *
 * Everything reads from the same journey value. A scene that kept its own
 * clock could disagree with the camera, and the disagreement would show as
 * a seam — so nothing here has an independent timeline.
 */
import { useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Material, Mesh, Object3D } from 'three';

import { CHAPTERS, localT, presence } from './journey';
import { journey } from './World';

export interface SceneState {
  /** How visible this chapter is, 0..1 — fade material opacity by this. */
  p: number;
  /** Progress THROUGH the chapter, 0..1 — drive the chapter's own action
   *  with this. Distinct from `p`, which is only about arriving and
   *  leaving. */
  t: number;
}

/**
 * Per-frame chapter state, delivered through a ref.
 *
 * Deliberately not React state: this changes every frame, and re-rendering
 * a scene graph sixty times a second to animate it would defeat the point
 * of having a scene graph.
 */
export function useChapter(id: string) {
  const state = useRef<SceneState>({ p: 0, t: 0 });
  const chapter = CHAPTERS.find((c) => c.id === id) ?? CHAPTERS[0];

  useFrame(() => {
    state.current.p = presence(journey.t, chapter);
    state.current.t = localT(journey.t, chapter);
  });

  return state;
}

/* ------------------------------------------------------------ geography -- */

/* India, flattened to the local XZ plane of a chapter's station.
 *
 * Equirectangular with a cosine correction on longitude, which is enough at
 * one country's scale and needs no projection library. The console's fleet
 * map uses proper Web Mercator because it has to line up with raster tiles;
 * nothing here does, so the simpler projection is the right one. */
export const INDIA = {
  lat0: 22.5,
  lon0: 80.0,
  /** World units per degree of latitude. */
  scale: 2.6,
};

export function project(lat: number, lon: number): [number, number] {
  const k = Math.cos((INDIA.lat0 * Math.PI) / 180);
  return [
    (lon - INDIA.lon0) * INDIA.scale * k,
    // Negated: latitude increases north, and -Z is "away" in the scene.
    -(lat - INDIA.lat0) * INDIA.scale,
  ];
}

/* ----------------------------------------------------------- fading ----- */

/**
 * Fade a whole chapter group by `p`.
 *
 * Each material's authored opacity is stashed on first contact, so repeated
 * calls scale from the original rather than compounding toward zero. Without
 * that, a material fading in and out a few times would end up invisible and
 * the cause would be very hard to see.
 */
/** Put every material under `root` into the state applyFade leaves it in
 *  (transparent, base opacity recorded) without changing what is drawn.
 *  The warm-up calls this so the shaders it compiles are the variants the
 *  page will actually use, not opaque ones that would be rebuilt later. */
export function primeFade(root: Object3D): void {
  root.traverse((obj) => {
    const mat = (obj as Mesh).material as Material | Material[] | undefined;
    if (!mat) return;
    for (const m of Array.isArray(mat) ? mat : [mat]) {
      if (m.userData.baseOpacity === undefined) {
        m.userData.baseOpacity = m.transparent ? m.opacity : 1;
        m.transparent = true;
      }
    }
  });
}

export function applyFade(root: Object3D | null, p: number): void {
  // A chapter at (near) zero presence is hidden by its ChapterSlot, so its
  // opacities do not matter. Every scene calls this every frame, and walking
  // eight hidden scene graphs per frame was pure waste while scrolling.
  if (!root || p <= 0.004) return;
  root.traverse((obj) => {
    const mat = (obj as Mesh).material as Material | Material[] | undefined;
    if (!mat) return;
    const list = Array.isArray(mat) ? mat : [mat];
    for (const m of list) {
      if (m.userData.baseOpacity === undefined) {
        m.userData.baseOpacity = m.transparent ? m.opacity : 1;
        m.transparent = true;
      }
      m.opacity = m.userData.baseOpacity * p;
    }
  });
}

/**
 * Whether a chapter is close enough to warrant DOM.
 *
 * Meshes are cheap to leave mounted and simply hidden; drei's <Html> is not,
 * because it portals real elements outside the canvas and a hidden parent
 * group does not hide them. So anything with DOM in it mounts and unmounts
 * on this flag instead. React state is correct here precisely because it
 * changes twice per chapter rather than sixty times a second.
 */
export function useActive(id: string, threshold = 0.25): boolean {
  const chapter = CHAPTERS.find((c) => c.id === id) ?? CHAPTERS[0];
  const [active, setActive] = useState(false);
  const activeRef = useRef(false);

  useFrame(() => {
    // Hysteresis: without a dead band, a reader resting exactly on the
    // threshold would thrash the DOM every frame.
    const p = presence(journey.t, chapter);
    const next = activeRef.current ? p > threshold * 0.7 : p > threshold;
    if (next !== activeRef.current) {
      activeRef.current = next;
      setActive(next);
    }
  });

  return active;
}
