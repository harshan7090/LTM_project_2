/* The Corvex landing scene.
 *
 * ONE SCENE, NOT TEN
 *
 *   The page reads as a single continuous journey, so it is a single
 *   persistent Three.js scene that the scroll moves a camera through —
 *   rather than a stack of sections each with its own canvas. Swapping
 *   canvases is what makes a "cinematic" page feel like a slideshow: every
 *   boundary is a cut, and cuts are exactly what this is trying to avoid.
 *
 *   The whole visual state is therefore one number: `progress`, 0 to 1 down
 *   the page. Camera position, camera target, fog density, corrosion,
 *   network opacity and dust drift are all functions of it. Nothing is
 *   animated on a timer that the scroll does not own, which is why
 *   scrubbing backwards looks identical to scrubbing forwards.
 *
 * WHAT IS PROCEDURAL AND WHY
 *
 *   The corrosion is a shader, not a texture. A pasted rust map shows the
 *   same damage everywhere and cannot respond to anything; a field whose
 *   threshold falls as `uCorrosion` rises grows visibly worse as the reader
 *   scrolls into the section that explains corrosion. The visual makes the
 *   argument rather than decorating it.
 *
 * FAILURE
 *
 *   `create` returns null if WebGL is unavailable or the context is lost.
 *   The caller removes the canvas and the page keeps its flat fallback. A
 *   hero that cannot render must never be a hole.
 */
import {
  AdditiveBlending, AmbientLight, BufferAttribute, BufferGeometry,
  CatmullRomCurve3, Color, CylinderGeometry, DirectionalLight, DoubleSide, Fog,
  Group, InstancedMesh, Line, LineBasicMaterial, Mesh, MeshStandardMaterial,
  Object3D, PerspectiveCamera, Points, PointsMaterial, Scene, ShaderMaterial,
  SRGBColorSpace, TubeGeometry, Vector3, WebGLRenderer,
} from 'three';

/* ============================================================== palette == */
/* Same values as the console. Kept as numbers here because Three wants
   linear colour, and reading them from CSS would mean a layout read on
   every frame. */
const C = {
  bg: 0x0d1110,
  steelDark: 0x1e2522,
  steelLight: 0x4a544e,
  accent: 0xb8d04a,
  amber: 0xd99a32,
  critical: 0xe4735c,
  dust: 0x8d9690,
};

/* ============================================================== shaders == */

const PIPE_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const PIPE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vWorld;

uniform vec3 uCam;
uniform vec3 uSteelDark, uSteelLight, uRust, uRim;
uniform float uCorrosion;
uniform float uTime;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p){
  float s = 0.0, a = 0.5;
  for (int k = 0; k < 5; k++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return s;
}

void main() {
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(uCam - vWorld);
  vec3 L = normalize(vec3(-0.4, 0.86, 0.32));

  float diff = max(dot(N, L), 0.0);
  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);

  // uv.x runs ALONG the tube, uv.y around it. Scaling them differently is
  // what stops the grain looking like wrapping paper.
  vec2 sp = vec2(vUv.x * 160.0, vUv.y * 13.0);
  float grain = fbm(sp * 1.6);

  // The threshold falls as corrosion rises, so the same field grows more
  // pitted instead of reshuffling into a different pattern. Two moments in
  // the scroll therefore look continuous rather than like a cross-fade.
  float thresh = mix(0.90, 0.44, clamp(uCorrosion, 0.0, 1.0));
  float pit = smoothstep(thresh, thresh + 0.085, fbm(sp * 2.7 + 13.0));

  // Girth welds at regular stations, and a longitudinal seam.
  float weld = smoothstep(0.988, 0.999, abs(sin(vUv.x * 3.14159 * 46.0)));
  float seam = smoothstep(0.02, 0.0, abs(vUv.y - 0.5));

  vec3 col = mix(uSteelDark, uSteelLight, grain);
  col = mix(col, uRust, pit * 0.94);
  col = mix(col, uSteelLight * 1.15, max(weld, seam * 0.5) * 0.45);
  col *= 0.24 + 0.86 * diff;

  // Pits are holes: they lose the rim light as well as the diffuse.
  col += uRim * fres * 0.34 * (1.0 - pit * 0.8);

  gl_FragColor = vec4(col, 1.0);
}`;

/* =========================================================== the route == */

/* The corridor the camera flies along. Deliberately not straight: a
   perfectly straight tube gives the camera nothing to reveal, and the whole
   point of moving is that something new comes into view. */
const ROUTE_POINTS = [
  new Vector3(-150, -6, 40),
  new Vector3(-96, -2, 12),
  new Vector3(-44, 3, -14),
  new Vector3(6, 1, -30),
  new Vector3(58, -3, -20),
  new Vector3(104, 2, 10),
  new Vector3(152, 8, 44),
];

/* Lateral routes, lit later in the scroll when the single line becomes a
   network. Offsets from the trunk rather than independent curves, so they
   read as branches instead of unrelated lines. */
const BRANCH_DEFS: { at: number; dir: Vector3; len: number }[] = [
  { at: 0.22, dir: new Vector3(-0.4, 0.1, 1), len: 46 },
  { at: 0.38, dir: new Vector3(0.6, -0.05, 0.9), len: 34 },
  { at: 0.55, dir: new Vector3(-0.8, 0.15, -0.5), len: 52 },
  { at: 0.72, dir: new Vector3(0.5, 0.2, -1), len: 40 },
  { at: 0.86, dir: new Vector3(-0.3, -0.1, 1), len: 30 },
];

export interface SceneHandle {
  setProgress(p: number): void;
  resize(): void;
  dispose(): void;
  readonly reduced: boolean;
}

export function create(canvas: HTMLCanvasElement, reduced: boolean): SceneHandle | null {
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({
      canvas, antialias: true, alpha: true, powerPreference: 'high-performance',
    });
  } catch {
    return null;
  }
  if (!renderer.getContext()) return null;

  renderer.setClearColor(C.bg, 0);
  renderer.outputColorSpace = SRGBColorSpace;

  const scene = new Scene();
  // Fog is doing the atmospheric work that a post-processing pass usually
  // does, at a fraction of the cost and with no extra render target.
  scene.fog = new Fog(C.bg, 40, 260);

  const camera = new PerspectiveCamera(46, 1, 0.5, 600);

  /* ---------------------------------------------------------- lighting -- */
  scene.add(new AmbientLight(0x2a332e, 1.0));
  const key = new DirectionalLight(0xdfe6d2, 1.5);
  key.position.set(-40, 70, 30);
  scene.add(key);
  const fill = new DirectionalLight(C.amber, 0.35);
  fill.position.set(60, -20, -40);
  scene.add(fill);

  /* ------------------------------------------------------- the pipeline -- */
  const curve = new CatmullRomCurve3(ROUTE_POINTS, false, 'catmullrom', 0.4);
  const pipeGeo = new TubeGeometry(curve, 420, 2.6, 28, false);

  const pipeUniforms = {
    uCam: { value: new Vector3() },
    uSteelDark: { value: new Color(C.steelDark) },
    uSteelLight: { value: new Color(C.steelLight) },
    uRust: { value: new Color(0x6b3a17) },
    uRim: { value: new Color(C.accent) },
    uCorrosion: { value: 0.08 },
    uTime: { value: 0 },
  };
  const pipeMat = new ShaderMaterial({
    vertexShader: PIPE_VERT,
    fragmentShader: PIPE_FRAG,
    uniforms: pipeUniforms,
    fog: false,
    side: DoubleSide,
  });
  const pipe = new Mesh(pipeGeo, pipeMat);
  scene.add(pipe);

  /* Flanges. Instanced, because forty separate meshes is forty draw calls
     for what is one piece of repeated hardware. */
  const FLANGE_N = 26;
  const flangeGeo = new CylinderGeometry(3.5, 3.5, 1.1, 24, 1, true);
  const flangeMat = new MeshStandardMaterial({
    color: C.steelLight, roughness: 0.72, metalness: 0.85, side: DoubleSide,
  });
  const flanges = new InstancedMesh(flangeGeo, flangeMat, FLANGE_N);
  {
    const dummy = new Object3D();
    const up = new Vector3(0, 1, 0);
    for (let i = 0; i < FLANGE_N; i++) {
      const t = (i + 0.5) / FLANGE_N;
      const pos = curve.getPointAt(t);
      const tan = curve.getTangentAt(t).normalize();
      dummy.position.copy(pos);
      // The cylinder's axis is +Y; align it with the tube's tangent so the
      // flange sits square on the pipe rather than skewed through it.
      dummy.quaternion.setFromUnitVectors(up, tan);
      dummy.updateMatrix();
      flanges.setMatrixAt(i, dummy.matrix);
    }
    flanges.instanceMatrix.needsUpdate = true;
  }
  scene.add(flanges);

  /* ------------------------------------------------------ branch network -- */
  const network = new Group();
  network.visible = false;
  for (const b of BRANCH_DEFS) {
    const root = curve.getPointAt(b.at);
    const dir = b.dir.clone().normalize();
    const pts: Vector3[] = [];
    for (let i = 0; i <= 6; i++) {
      const k = i / 6;
      pts.push(new Vector3(
        root.x + dir.x * b.len * k + Math.sin(k * 3.1) * 5,
        root.y + dir.y * b.len * k,
        root.z + dir.z * b.len * k + Math.cos(k * 2.4) * 5,
      ));
    }
    const bg = new BufferGeometry().setFromPoints(pts);
    const bm = new LineBasicMaterial({ color: C.accent, transparent: true, opacity: 0.0 });
    network.add(new Line(bg, bm));
  }
  scene.add(network);

  /* ------------------------------------------------------------- dust ---- */
  /* Atmospheric particles. Capped hard: a particle field is the easiest
     place on a page like this to spend a frame budget with nothing to show
     for it. */
  const DUST_N = reduced ? 0 : 1400;
  const dustGeo = new BufferGeometry();
  {
    const arr = new Float32Array(DUST_N * 3);
    for (let i = 0; i < DUST_N; i++) {
      arr[i * 3] = (Math.random() - 0.5) * 340;
      arr[i * 3 + 1] = (Math.random() - 0.5) * 90;
      arr[i * 3 + 2] = (Math.random() - 0.5) * 200;
    }
    dustGeo.setAttribute('position', new BufferAttribute(arr, 3));
  }
  const dust = new Points(dustGeo, new PointsMaterial({
    color: C.dust, size: 0.34, transparent: true, opacity: 0.32,
    depthWrite: false, blending: AdditiveBlending, sizeAttenuation: true,
  }));
  if (DUST_N) scene.add(dust);

  /* ------------------------------------------------------ camera rig ----- */
  /* The camera runs along its own curve, offset outboard from the pipe, and
     looks at a point further down the route than it is. That look-ahead is
     what makes travel feel like travel: aiming at your own position reads
     as sliding sideways. */
  const camCurve = new CatmullRomCurve3(
    ROUTE_POINTS.map((p, i) => new Vector3(
      p.x, p.y + 6 + (i % 2) * 2, p.z + 16,
    )), false, 'catmullrom', 0.4,
  );

  let progress = 0;
  let raf = 0;
  let disposed = false;
  const clock = { t0: performance.now() };
  const tmpCam = new Vector3();
  const tmpLook = new Vector3();

  function layout() {
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    // Capped at 1.75: beyond that the pixel count costs more than the
    // sharpness is worth on a full-screen scene.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function apply(p: number, elapsed: number) {
    // Camera travels the first 70% of the page; the last 30% holds near the
    // end of the line while the closing sections are read.
    const travel = Math.min(p / 0.7, 1);
    const eased = travel * travel * (3 - 2 * travel);   // smoothstep

    camCurve.getPointAt(Math.min(eased, 0.999), tmpCam);
    // Pull back and rise as the story widens from one pipe to a network.
    const widen = Math.min(Math.max((p - 0.18) / 0.32, 0), 1);
    camera.position.set(
      tmpCam.x,
      tmpCam.y + widen * 38,
      tmpCam.z + widen * 62,
    );

    curve.getPointAt(Math.min(eased + 0.06, 1), tmpLook);
    camera.lookAt(tmpLook);

    // Corrosion climbs through the corrosion chapter and stays high after,
    // because the pipe does not heal when you scroll past.
    pipeUniforms.uCorrosion.value = 0.08 + Math.min(Math.max((p - 0.30) / 0.28, 0), 1) * 0.82;
    pipeUniforms.uCam.value.copy(camera.position);
    pipeUniforms.uTime.value = elapsed;

    // The branches light as the single line becomes a network.
    const net = Math.min(Math.max((p - 0.16) / 0.22, 0), 1);
    network.visible = net > 0.01;
    network.children.forEach((child, i) => {
      const line = child as Line;
      const mat = line.material as LineBasicMaterial;
      // Staggered so they appear in sequence rather than all at once.
      const k = Math.min(Math.max((net - i * 0.09) / 0.4, 0), 1);
      mat.opacity = k * 0.62;
    });

    // Fog closes in for the corrosion chapter, then opens out again.
    const close = Math.min(Math.max((p - 0.28) / 0.2, 0), 1)
                * (1 - Math.min(Math.max((p - 0.56) / 0.2, 0), 1));
    (scene.fog as Fog).near = 40 - close * 26;
    (scene.fog as Fog).far = 260 - close * 130;

    if (DUST_N && !reduced) {
      dust.rotation.y = elapsed * 0.006;
      dust.position.y = Math.sin(elapsed * 0.12) * 1.6;
    }
  }

  function frame() {
    if (disposed) return;
    const elapsed = (performance.now() - clock.t0) / 1000;
    apply(progress, elapsed);
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }

  layout();

  if (reduced) {
    // One frame, no loop. The scene is still correct and still shows the
    // pipeline; it simply does not move on its own.
    apply(0, 0);
    renderer.render(scene, camera);
  } else {
    raf = requestAnimationFrame(frame);
  }

  return {
    reduced,
    setProgress(p: number) {
      progress = Math.min(Math.max(p, 0), 1);
      if (reduced) {
        apply(progress, 0);
        renderer.render(scene, camera);
      }
    },
    resize() {
      layout();
      if (reduced) {
        apply(progress, 0);
        renderer.render(scene, camera);
      }
    },
    dispose() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      pipeGeo.dispose();
      pipeMat.dispose();
      flangeGeo.dispose();
      flangeMat.dispose();
      dustGeo.dispose();
      network.children.forEach((c) => {
        (c as Line).geometry.dispose();
        ((c as Line).material as LineBasicMaterial).dispose();
      });
      renderer.dispose();
    },
  };
}
