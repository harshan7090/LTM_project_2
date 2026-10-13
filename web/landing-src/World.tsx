/* The world.
 *
 * ONE SPLINE, EIGHT STATIONS
 *
 *   Every chapter sits ON a single continuous curve through world space.
 *   The camera flies that curve; scenes fade in as it nears them and out as
 *   it passes. There is no cut anywhere, because there is nothing to cut
 *   between — it is one scene graph the whole way down.
 *
 *   Scenes are anchored at the curve point the camera is LOOKING AT when
 *   that chapter peaks, not at the station index. Those are different
 *   points: a Catmull-Rom curve is arc-length reparameterised, so station
 *   five is not at t=0.5. Anchoring by geometry rather than by index is
 *   what keeps each scene centred in frame when its copy is on screen.
 *
 *   Because the anchor is on the path, the camera flies THROUGH each scene.
 *   Scenes are therefore built around the origin — a tunnel, a ring, a
 *   plane below — rather than as a picture placed in front of the lens.
 *
 * THE PULSE LEADS THE CAMERA
 *
 *   The camera looks at a point slightly AHEAD of itself on the spline,
 *   where the pulse is. Following something reads as purpose; a camera
 *   moving on its own reads as a drone shot. It is a small difference in
 *   code and a large one on screen.
 */
import { Suspense, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { PerformanceMonitor } from '@react-three/drei';
import { Bloom, EffectComposer, SMAA, Vignette } from '@react-three/postprocessing';
import type { EffectComposer as ComposerImpl } from 'postprocessing';
import { CatmullRomCurve3, Color, Fog, Group, Object3D, Quaternion, Vector3 } from 'three';
import type { PerspectiveCamera as ThreePerspectiveCamera } from 'three';

import { CHAPTERS, presence } from './journey';
import { primeFade } from './useScene';
import { LightRig } from './lights';
import { PALETTE } from './palette';
import { Pulse } from './Pulse';
import { OrbitScene } from './scenes/Orbit';
import { NetworkScene } from './scenes/Network';
import { TwinScene } from './scenes/Twin';
import { SensorScene } from './scenes/Sensors';
import { CorrosionScene } from './scenes/Corrosion';
import { PredictScene } from './scenes/Predict';
import { ShapScene } from './scenes/Shap';
import { RiskScene } from './scenes/Risk';

/* Where the journey goes. The path descends and turns, so the trip has a
   direction you can feel rather than being a dolly down a corridor. */
export const STATIONS: Vector3[] = [
  new Vector3(0, 240, 320),     // 01 orbit — high above
  new Vector3(0, 60, 150),      // 02 network — over India
  new Vector3(-30, 14, 60),     // 03 twin — down at asset level
  new Vector3(10, 10, -20),     // 04 sensors
  new Vector3(-6, 2, -96),      // 05 corrosion — inside the pipe
  new Vector3(26, 14, -178),    // 06 prediction — back out, elevated
  new Vector3(-14, 16, -262),   // 07 shap
  new Vector3(4, 30, -350),     // 08 risk — pulls up and away
];

/** The one curve. Shared by the camera rig, the pulse and every chapter
 *  anchor, so none of them can drift out of agreement with the others. */
export const CURVE = new CatmullRomCurve3(STATIONS, false, 'catmullrom', 0.35);

/** How far ahead of itself the camera looks. The pulse rides here too. */
export const LOOK_AHEAD = 0.035;

const SCENES = {
  orbit: OrbitScene,
  network: NetworkScene,
  twin: TwinScene,
  sensors: SensorScene,
  corrosion: CorrosionScene,
  predict: PredictScene,
  shap: ShapScene,
  risk: RiskScene,
} as const;

/** Journey position, written by the scroll driver and read every frame.
 *  A ref rather than state: this changes at frame rate, and re-rendering
 *  the React tree sixty times a second to move a camera would be absurd. */
export const journey = { t: 0, target: 0 };

/** Where a chapter's scene is anchored: the point the camera is aimed at
 *  when that chapter is at full presence. Exported so the verification
 *  script can check each scene's focal point actually lands in frame. */
export function anchorFor(from: number, to: number): Vector3 {
  const mid = (from + to) / 2;
  return CURVE.getPointAt(Math.min(mid + LOOK_AHEAD, 1));
}

/** The orientation a chapter's scene is built in: local -Z points along the
 *  direction of travel.
 *
 *  Without this, local -Z is world -Z, which is the view direction only on
 *  the straight parts of the path. Where it turns — and it turns hardest
 *  around chapters six and eight — content placed deep in local Z slides
 *  off the side of the frame. That was measured, not guessed:
 *  check-journey.mjs had the prediction engine's value node sitting at ndc
 *  x -0.88, a hair from being cropped. */
export function orientationFor(from: number, to: number): Quaternion {
  const mid = (from + to) / 2;
  const at = Math.min(mid + LOOK_AHEAD, 1);
  const probe = new Object3D();
  probe.position.copy(CURVE.getPointAt(at));
  // NOTE: Object3D.lookAt points local +Z at the target — only cameras and
  // lights use the -Z convention. Scenes here are authored with -Z ahead,
  // so the probe is aimed BACKWARDS along the tangent. Getting this the
  // intuitive way round put four of the eight scenes behind the camera.
  probe.lookAt(probe.position.clone().sub(CURVE.getTangentAt(at)));
  probe.updateMatrixWorld();
  return probe.quaternion.clone();
}

function Rig() {
  const { camera } = useThree();
  const pos = useRef(new Vector3());
  const look = useRef(new Vector3());

  useFrame(() => {
    const t = Math.min(Math.max(journey.t, 0), 1);
    CURVE.getPointAt(t, pos.current);
    CURVE.getPointAt(Math.min(t + LOOK_AHEAD, 1), look.current);

    camera.position.copy(pos.current);
    camera.lookAt(look.current);
    const cam = camera as ThreePerspectiveCamera;
    // Widens slightly through the middle of the journey, which reads as
    // acceleration without the camera actually moving faster.
    cam.fov = 46 + Math.sin(t * Math.PI) * 6;
    cam.updateProjectionMatrix();
  });

  return null;
}

/** Mounts a chapter's scene at its anchor and hides it when the camera is
 *  nowhere near. The visibility flip is per-frame and free; the React tree
 *  is left alone, because mounting and unmounting geometry at frame rate
 *  would cost far more than drawing nothing. */
function ChapterSlot({ index, children }: { index: number; children: React.ReactNode }) {
  const group = useRef<Group>(null);
  const chapter = CHAPTERS[index];
  const anchor = useMemo(() => anchorFor(chapter.from, chapter.to), [chapter]);
  const facing = useMemo(() => orientationFor(chapter.from, chapter.to), [chapter]);

  useFrame(() => {
    const g = group.current;
    if (!g) return;
    g.visible = presence(journey.t, chapter) > 0.004;
  });

  return (
    <group ref={group} position={anchor} quaternion={facing} visible={false}
           userData={{ chapterSlot: true }}>
      {children}
    </group>
  );
}

/* Resolves once every shader the journey uses has been built. main.tsx
   holds the loader until then. */
let resolveWarm: () => void = () => {};
export const warmupDone = new Promise<void>((r) => { resolveWarm = r; });

/** Builds every shader the journey will need, once, behind the loader.
 *
 *  Each chapter's first appearance mid-scroll was a visible stall: on an
 *  Intel UHD 620, 0.6-1.9 s frames exactly where a chapter first came into
 *  view, gone on a second pass over the same page. That is first-use cost.
 *  On Windows, WebGL runs over Direct3D, which builds a shader variant for
 *  the exact render target a material is drawn into, so compiling against
 *  the screen (renderer.compile) did not help, and visiting each chapter
 *  with the camera missed objects that only appear late in a chapter.
 *
 *  So for ONE frame, behind the loader, everything is drawn: every object
 *  forced visible, culling off, materials primed into the transparent
 *  state the fades will leave them in, and the frame pushed through the
 *  whole bloom and SMAA chain. Then every flag is put back exactly. */
function Warmup({ composer }: { composer: React.RefObject<ComposerImpl | null> }) {
  const { scene } = useThree();
  const done = useRef(false);
  useFrame(() => {
    if (done.current) return;
    const c = composer.current;
    if (!c) return;                       // composer not built yet; next frame
    done.current = true;
    const t0 = performance.now();
    const saved: [Object3D, boolean, boolean][] = [];
    scene.traverse((o) => {
      saved.push([o, o.visible, o.frustumCulled]);
      o.visible = true;
      o.frustumCulled = false;
      if (o.userData.chapterSlot) primeFade(o);
    });
    c.render(0);
    for (const [o, v, f] of saved) { o.visible = v; o.frustumCulled = f; }
    (window as unknown as { __corvexWarmMs?: number }).__corvexWarmMs =
      Math.round(performance.now() - t0);
    resolveWarm();
  }, -2);   // before the scenes' own per-frame work, so the flags restored
            // are the true ones and the normal render follows unchanged
  return null;
}

function Stage() {
  const { scene } = useThree();
  useMemo(() => {
    scene.fog = new Fog(new Color(PALETTE.bg).getHex(), 40, 520);
    scene.background = new Color(PALETTE.bg);
  }, [scene]);

  return (
    <>
      <Rig />
      <LightRig />
      <ambientLight intensity={0.5} />
      <directionalLight position={[40, 80, 40]} intensity={1.0} color={PALETTE.text} />
      <hemisphereLight args={[PALETTE.blue, PALETTE.bg, 0.45]} />

      <Pulse curve={CURVE} />

      {CHAPTERS.map((c, i) => {
        const Scene = SCENES[c.id as keyof typeof SCENES];
        return (
          <ChapterSlot key={c.id} index={i}>
            <Scene />
          </ChapterSlot>
        );
      })}
    </>
  );
}

/* Resolution adapts to the machine. The scene is fill-bound (every pixel
   goes through bloom), so pixel count is the lever that matters on an
   integrated GPU. Start at the screen's density capped at 1.5, drop to 1
   when the frame rate sags, and climb back when there is headroom. */
const DPR_HIGH = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 1.5);
const DPR_LOW = 1;

export function World() {
  const [dpr, setDpr] = useState(DPR_HIGH);
  const composer = useRef<ComposerImpl>(null);
  return (
    <Canvas
      className="world"
      /* The position MUST be set here and not in app.css.
       *
       * R3F writes `position: relative; width: 100%; height: 100%` as INLINE
       * styles on its wrapper, and inline beats a class rule. Left to the
       * stylesheet, the wrapper stays `relative` inside #root — a plain
       * flow div with auto height — so `height: 100%` resolves against an
       * indefinite parent and computes to ZERO. The canvas is then 0px tall
       * and the entire journey is invisible, with nothing in the console to
       * say why. R3F spreads `style` last, so this wins. */
      style={{ position: 'fixed', inset: 0 }}
      // alpha off: the clear colour shows for the frame before the scene
      // paints, and a white flash on a page this dark is jarring.
      // antialias off: with post-processing the scene renders into the
      // composer's own buffer, so the canvas's MSAA was paid for and never
      // used. Edges are smoothed by SMAA at the end of the chain instead.
      gl={{ antialias: false, alpha: false, powerPreference: 'high-performance' }}
      dpr={dpr}
      camera={{ fov: 46, near: 0.5, far: 1600, position: [0, 240, 320] }}
    >
      <PerformanceMonitor
        onDecline={() => setDpr(DPR_LOW)}
        onIncline={() => setDpr(DPR_HIGH)}
        flipflops={3}
        onFallback={() => setDpr(DPR_LOW)}
      />
      <Suspense fallback={null}>
        <Stage />
        {/* multisampling 0: the composer's default is 8x MSAA on its render
            target, which on an integrated GPU was the single largest cost
            in the frame. SMAA gives comparable edges for a fraction of it. */}
        <EffectComposer ref={composer} multisampling={0}>
          {/* Bloom is the whole look here — the glow on the pulse and on the
              corridor lines is what makes this read as energy rather than as
              coloured line art. Thresholded so only genuinely bright things
              bloom; a low threshold turns the entire frame to fog. */}
          <Bloom
            intensity={1.15}
            luminanceThreshold={0.62}
            luminanceSmoothing={0.25}
            mipmapBlur
          />
          <Vignette offset={0.32} darkness={0.66} />
          <SMAA />
        </EffectComposer>
        <Warmup composer={composer} />
      </Suspense>
    </Canvas>
  );
}
