/* The Corvex landing scene — a pipeline corridor in late-afternoon light.
 *
 * WHY THIS IS NOT THE DARK VERSION
 *
 *   The first version put dark steel (#1e2522–#4a544e) on a near-black
 *   ground (#0d1110) under a 94%-opacity scrim. The pipe was rendering
 *   correctly and was invisible: near-black on near-black, behind a curtain.
 *   No amount of camera work fixes a subject that has no contrast with its
 *   background.
 *
 *   So the scene is daylight. Sunlit steel against grass and sky is high
 *   contrast by construction, which means the pipeline reads instantly
 *   instead of having to be hunted for. The copy keeps its dark treatment
 *   via a left-weighted gradient in CSS, so the type system is unchanged.
 *
 * ONE SCENE, NOT TEN
 *
 *   The canvas is fixed behind every section and one camera travels one
 *   route for the whole page. The entire visual state is a single number,
 *   `progress`, 0 to 1. Camera, sun, corrosion, haze and flare are all
 *   functions of it — which is why scrubbing back up looks identical to
 *   scrolling down.
 *
 * FAILURE
 *
 *   `create` returns null if WebGL is unavailable. The caller removes the
 *   canvas and the flat CSS fallback shows through.
 */
import {
  AdditiveBlending, AmbientLight, BackSide, BoxGeometry, CatmullRomCurve3,
  Color, CylinderGeometry, DirectionalLight, DoubleSide, Fog, Group,
  HemisphereLight, InstancedMesh, Mesh, MeshStandardMaterial, Object3D,
  PerspectiveCamera, PlaneGeometry, Scene, ShaderMaterial, SRGBColorSpace,
  SphereGeometry, TubeGeometry, Vector3, WebGLRenderer,
} from 'three';

/* ============================================================== palette == */
const C = {
  skyTop: 0x6f9ec6,
  skyHaze: 0xd6d7c4,
  grass: 0x5d7a3c,
  grassLit: 0x86a352,
  steel: 0x9aa49b,
  steelLit: 0xd3d9d0,
  rust: 0x8a4a1e,
  accent: 0xb8d04a,
  flame: 0xffa32e,
  tank: 0x8e968f,
};

/* ============================================================== shaders == */

const SKY_FRAG = /* glsl */ `
precision mediump float;
varying vec3 vPos;
uniform vec3 uTop, uHaze;
void main() {
  // Normalised height on the dome. The haze band sits low and tight, the
  // way real aerial perspective does - a linear top-to-bottom ramp reads
  // as a gradient backdrop rather than as sky.
  float h = clamp(normalize(vPos).y * 0.5 + 0.5, 0.0, 1.0);
  float t = pow(clamp((h - 0.42) / 0.5, 0.0, 1.0), 0.75);
  gl_FragColor = vec4(mix(uHaze, uTop, t), 1.0);
}`;

const SKY_VERT = /* glsl */ `
varying vec3 vPos;
void main() {
  vPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const GROUND_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const GROUND_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying vec3 vWorld;
uniform vec3 uGrass, uGrassLit, uHaze;
uniform float uFogNear, uFogFar;
uniform vec3 uCam;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0,0.0)), f.x),
             mix(hash(i + vec2(0.0,1.0)), hash(i + vec2(1.0,1.0)), f.x), f.y);
}
float fbm(vec2 p){
  float s = 0.0, a = 0.5;
  for (int k = 0; k < 4; k++) { s += a * vnoise(p); p *= 2.05; a *= 0.5; }
  return s;
}

void main() {
  // Two scales of variation: broad patches, and a fine break-up so the
  // ground does not read as a flat sheet of colour close to the camera.
  float broad = fbm(vWorld.xz * 0.012);
  float fine  = fbm(vWorld.xz * 0.19);
  vec3 col = mix(uGrass, uGrassLit, broad * 0.75 + fine * 0.25);

  // A worn right-of-way strip either side of the line: the corridor is
  // mown and driven on, so it should not look like untouched meadow.
  float corridor = smoothstep(16.0, 6.0, abs(vWorld.z + 8.0));
  col = mix(col, col * 1.12 + vec3(0.05, 0.045, 0.03), corridor * 0.7);

  // Aerial perspective, applied here rather than by scene fog so the
  // horizon dissolves into the SAME haze the sky uses.
  float d = distance(vWorld, uCam);
  float f = clamp((d - uFogNear) / max(uFogFar - uFogNear, 1.0), 0.0, 1.0);
  gl_FragColor = vec4(mix(col, uHaze, f), 1.0);
}`;

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

uniform vec3 uCam, uSteel, uSteelLit, uRust, uHaze, uSun;
uniform float uCorrosion, uFogNear, uFogFar;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0,0.0)), f.x),
             mix(hash(i + vec2(0.0,1.0)), hash(i + vec2(1.0,1.0)), f.x), f.y);
}
float fbm(vec2 p){
  float s = 0.0, a = 0.5;
  for (int k = 0; k < 5; k++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return s;
}

void main() {
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(uCam - vWorld);
  vec3 L = normalize(uSun);

  float diff = max(dot(N, L), 0.0);
  float spec = pow(max(dot(reflect(-L, N), V), 0.0), 34.0);
  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);

  // uv.x runs along the tube, uv.y around it. Different scales, or the
  // grain looks like wrapping paper.
  vec2 sp = vec2(vUv.x * 150.0, vUv.y * 12.0);
  float grain = fbm(sp * 1.6);

  // The threshold falls as corrosion rises, so the SAME field grows more
  // pitted rather than reshuffling - two moments in the scroll therefore
  // look continuous instead of like a cross-fade.
  float thresh = mix(0.92, 0.46, clamp(uCorrosion, 0.0, 1.0));
  float pit = smoothstep(thresh, thresh + 0.08, fbm(sp * 2.7 + 13.0));

  float weld = smoothstep(0.988, 0.999, abs(sin(vUv.x * 3.14159 * 44.0)));

  vec3 col = mix(uSteel, uSteelLit, grain * 0.8);
  col = mix(col, uRust, pit * 0.9);
  col = mix(col, uSteelLit, weld * 0.4);

  // Sunlit steel: a strong diffuse term plus a tight highlight is what
  // makes a cylinder read as metal rather than as a painted tube.
  col *= 0.42 + 0.78 * diff;
  col += vec3(1.0, 0.96, 0.86) * spec * (1.0 - pit * 0.85) * 0.85;
  col += uHaze * fres * 0.22;

  float d = distance(vWorld, uCam);
  float f = clamp((d - uFogNear) / max(uFogFar - uFogNear, 1.0), 0.0, 1.0);
  gl_FragColor = vec4(mix(col, uHaze, f), 1.0);
}`;

const FLAME_FRAG = /* glsl */ `
precision mediump float;
varying vec2 vUv;
uniform float uTime;
uniform vec3 uFlame;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0,0.0)), f.x),
             mix(hash(i + vec2(0.0,1.0)), hash(i + vec2(1.0,1.0)), f.x), f.y);
}

void main() {
  // Flame rises: scrolling the noise DOWN in uv makes the detail travel up
  // the quad. Wind shear leans it as it climbs.
  float lean = (vUv.y * vUv.y) * 0.34;
  vec2 p = vec2(vUv.x * 3.0 - lean, vUv.y * 2.2 - uTime * 1.9);
  float n = vnoise(p) * 0.6 + vnoise(p * 2.3) * 0.4;

  // Taper to a point, and fade out at the top.
  float width = 1.0 - smoothstep(0.0, 1.0, vUv.y) * 0.72;
  float across = smoothstep(width, 0.0, abs(vUv.x - 0.5 + lean * 0.5) * 2.0);
  float up = (1.0 - smoothstep(0.35, 1.0, vUv.y));

  float a = across * up * (0.55 + n * 0.7);
  a = clamp(a, 0.0, 1.0);

  // Hotter and whiter at the base.
  vec3 col = mix(uFlame, vec3(1.0, 0.95, 0.78), (1.0 - vUv.y) * 0.6);
  gl_FragColor = vec4(col, a);
}`;

const FLAME_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/* =========================================================== the route == */

const GROUND_Y = -7;
const PIPE_Y = -2.4;

/* The corridor. Deliberately not straight: a straight tube gives the camera
   nothing to reveal, and the whole point of travelling is that something
   new comes into view. */
const ROUTE_POINTS = [
  new Vector3(-300, PIPE_Y - 1, 26),
  new Vector3(-200, PIPE_Y, 4),
  new Vector3(-100, PIPE_Y + 1, -12),
  new Vector3(0, PIPE_Y, -18),
  new Vector3(105, PIPE_Y + 1, -8),
  new Vector3(210, PIPE_Y, 14),
  new Vector3(320, PIPE_Y + 2, 40),
];

const SUN = new Vector3(-0.42, 0.58, 0.70);

export interface SceneHandle {
  setProgress(p: number): void;
  resize(): void;
  dispose(): void;
  readonly reduced: boolean;
}

export function create(canvas: HTMLCanvasElement, reduced: boolean): SceneHandle | null {
  /* Only the renderer constructor used to be guarded, which covered the
     one failure everybody thinks of — no WebGL — and none of the ones that
     actually happen: a driver refusing a texture size, a shader that will
     not compile on some GPU, a geometry parameter out of range. Any of
     those threw out of here and took the whole page's start-up with it.
     The caller guards this too; belt and braces, because a landing page
     that cannot draw a pipe should still be a readable landing page. */
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({
      canvas, antialias: true, alpha: false, powerPreference: 'high-performance',
    });
    if (!renderer.getContext()) return null;
  } catch {
    return null;
  }

  renderer.setClearColor(C.skyHaze, 1);
  renderer.outputColorSpace = SRGBColorSpace;

  const scene = new Scene();
  const camera = new PerspectiveCamera(48, 1, 0.5, 4000);

  const hazeCol = new Color(C.skyHaze);
  const FOG_NEAR = 120;
  const FOG_FAR = 1050;
  scene.fog = new Fog(C.skyHaze, FOG_NEAR, FOG_FAR);

  /* ---------------------------------------------------------- lighting -- */
  /* A warm low sun plus a sky/ground hemisphere. The hemisphere is what
     stops shadowed sides going flat black the way a single directional
     light leaves them. */
  scene.add(new HemisphereLight(C.skyTop, C.grass, 1.25));
  scene.add(new AmbientLight(0xffffff, 0.22));
  const sun = new DirectionalLight(0xffe9c4, 2.1);
  sun.position.copy(SUN).multiplyScalar(300);
  scene.add(sun);

  /* --------------------------------------------------------------- sky -- */
  const sky = new Mesh(
    new SphereGeometry(2200, 32, 20),
    new ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: { uTop: { value: new Color(C.skyTop) }, uHaze: { value: hazeCol } },
      side: BackSide,
      fog: false,
      depthWrite: false,
    }),
  );
  scene.add(sky);

  /* ------------------------------------------------------------ ground -- */
  const groundUniforms = {
    uGrass: { value: new Color(C.grass) },
    uGrassLit: { value: new Color(C.grassLit) },
    uHaze: { value: hazeCol },
    uFogNear: { value: FOG_NEAR },
    uFogFar: { value: FOG_FAR },
    uCam: { value: new Vector3() },
  };
  const ground = new Mesh(
    new PlaneGeometry(4000, 4000, 1, 1),
    new ShaderMaterial({
      vertexShader: GROUND_VERT,
      fragmentShader: GROUND_FRAG,
      uniforms: groundUniforms,
      fog: false,
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = GROUND_Y;
  scene.add(ground);

  /* ---------------------------------------------------------- pipeline -- */
  const curve = new CatmullRomCurve3(ROUTE_POINTS, false, 'catmullrom', 0.4);
  const pipeUniforms = {
    uCam: { value: new Vector3() },
    uSteel: { value: new Color(C.steel) },
    uSteelLit: { value: new Color(C.steelLit) },
    uRust: { value: new Color(C.rust) },
    uHaze: { value: hazeCol },
    uSun: { value: SUN.clone() },
    uCorrosion: { value: 0.06 },
    uFogNear: { value: FOG_NEAR },
    uFogFar: { value: FOG_FAR },
  };
  const pipeGeo = new TubeGeometry(curve, 520, 3.0, 30, false);
  const pipe = new Mesh(pipeGeo, new ShaderMaterial({
    vertexShader: PIPE_VERT,
    fragmentShader: PIPE_FRAG,
    uniforms: pipeUniforms,
    fog: false,
    side: DoubleSide,
  }));
  scene.add(pipe);

  /* Sleeper supports. Instanced — forty separate meshes would be forty draw
     calls for one piece of repeated hardware. */
  const SUPPORTS = 40;
  const supportGeo = new BoxGeometry(2.4, 5.4, 2.4);
  const supportMat = new MeshStandardMaterial({ color: 0x9a978c, roughness: 0.95 });
  const supports = new InstancedMesh(supportGeo, supportMat, SUPPORTS);
  {
    const d = new Object3D();
    for (let i = 0; i < SUPPORTS; i++) {
      const t = (i + 0.5) / SUPPORTS;
      const p = curve.getPointAt(t);
      d.position.set(p.x, (p.y + GROUND_Y) / 2 - 0.6, p.z);
      d.updateMatrix();
      supports.setMatrixAt(i, d.matrix);
    }
    supports.instanceMatrix.needsUpdate = true;
  }
  scene.add(supports);

  /* Flanges at the girth welds. */
  const FLANGES = 30;
  const flangeGeo = new CylinderGeometry(3.7, 3.7, 1.0, 22, 1, true);
  const flangeMat = new MeshStandardMaterial({
    color: C.steel, roughness: 0.62, metalness: 0.75, side: DoubleSide,
  });
  const flanges = new InstancedMesh(flangeGeo, flangeMat, FLANGES);
  {
    const d = new Object3D();
    const up = new Vector3(0, 1, 0);
    for (let i = 0; i < FLANGES; i++) {
      const t = (i + 0.5) / FLANGES;
      d.position.copy(curve.getPointAt(t));
      // The cylinder's axis is +Y; align it to the tube's tangent or the
      // flange sits skewed through the pipe instead of square on it.
      d.quaternion.setFromUnitVectors(up, curve.getTangentAt(t).normalize());
      d.updateMatrix();
      flanges.setMatrixAt(i, d.matrix);
    }
    flanges.instanceMatrix.needsUpdate = true;
  }
  scene.add(flanges);

  /* ---------------------------------------------------------- refinery -- */
  /* Far background, offset well off the corridor so the camera passes it
     rather than through it. Built from primitives: at this distance and
     under this much haze, silhouette is all that survives, and a detailed
     model would be spending polygons on nothing. */
  const refinery = new Group();
  refinery.position.set(240, 0, -430);

  const tankMat = new MeshStandardMaterial({ color: C.tank, roughness: 0.85, metalness: 0.25 });
  const tankGeo = new CylinderGeometry(15, 15, 17, 18);
  const tanks = new InstancedMesh(tankGeo, tankMat, 7);
  {
    const d = new Object3D();
    const spots: [number, number, number][] = [
      [-84, 0, 26], [-44, 0, 8], [-6, 0, 30], [34, 0, 6],
      [74, 0, 28], [112, 0, 4], [150, 0, 24],
    ];
    spots.forEach((s, i) => {
      const h = 0.7 + (i % 3) * 0.22;
      d.position.set(s[0], GROUND_Y + 8.5 * h, s[2]);
      d.scale.set(0.8 + (i % 2) * 0.3, h, 0.8 + (i % 2) * 0.3);
      d.updateMatrix();
      tanks.setMatrixAt(i, d.matrix);
    });
    tanks.instanceMatrix.needsUpdate = true;
  }
  refinery.add(tanks);

  const towerMat = new MeshStandardMaterial({ color: 0x7f887f, roughness: 0.9 });
  const towerGeo = new CylinderGeometry(3.4, 3.4, 60, 12);
  const towers = new InstancedMesh(towerGeo, towerMat, 9);
  {
    const d = new Object3D();
    for (let i = 0; i < 9; i++) {
      const h = 0.55 + ((i * 7) % 5) * 0.16;
      d.position.set(-70 + i * 27, GROUND_Y + 30 * h, -16 + ((i * 5) % 3) * 12);
      d.scale.set(1, h, 1);
      d.updateMatrix();
      towers.setMatrixAt(i, d.matrix);
    }
    towers.instanceMatrix.needsUpdate = true;
  }
  refinery.add(towers);

  /* The flare stack, and the one lit thing on the horizon. */
  const stack = new Mesh(
    new CylinderGeometry(2.4, 3.2, 96, 12),
    new MeshStandardMaterial({ color: 0x6f776f, roughness: 0.92 }),
  );
  stack.position.set(186, GROUND_Y + 48, -30);
  refinery.add(stack);

  const flameUniforms = { uTime: { value: 0 }, uFlame: { value: new Color(C.flame) } };
  const flame = new Mesh(
    new PlaneGeometry(26, 46),
    new ShaderMaterial({
      vertexShader: FLAME_VERT,
      fragmentShader: FLAME_FRAG,
      uniforms: flameUniforms,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      fog: false,
      side: DoubleSide,
    }),
  );
  flame.position.set(186, GROUND_Y + 96 + 20, -30);
  refinery.add(flame);
  scene.add(refinery);

  /* ------------------------------------------------------- camera rig --- */
  /* Offset outboard and above the line, looking further down the route than
     it is. That look-ahead is what makes travel feel like travel — aiming
     at your own position reads as sliding sideways. */
  const camCurve = new CatmullRomCurve3(
    ROUTE_POINTS.map((p, i) => new Vector3(p.x, p.y + 7.5 + (i % 2) * 1.5, p.z + 19)),
    false, 'catmullrom', 0.4,
  );

  let progress = 0;
  let raf = 0;
  let disposed = false;
  const t0 = performance.now();
  const tmpCam = new Vector3();
  const tmpLook = new Vector3();

  function layout() {
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    // Capped: beyond 1.75 the pixel count costs more than the sharpness is
    // worth on a full-screen scene.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function apply(p: number, elapsed: number) {
    // The camera travels the first 72% of the page; the last stretch holds
    // near the end of the line while the closing sections are read.
    const travel = Math.min(p / 0.72, 1);
    const eased = travel * travel * (3 - 2 * travel);

    camCurve.getPointAt(Math.min(eased, 0.999), tmpCam);
    // Rise and pull out as the story widens from one pipe to a network.
    const widen = Math.min(Math.max((p - 0.20) / 0.34, 0), 1);
    camera.position.set(tmpCam.x, tmpCam.y + widen * 30, tmpCam.z + widen * 46);

    curve.getPointAt(Math.min(eased + 0.055, 1), tmpLook);
    // Lift the aim toward the horizon as we pull out, so the refinery and
    // the flare come into frame rather than staying below it.
    tmpLook.y += widen * 16;
    camera.lookAt(tmpLook);

    // The sky dome rides with the camera; a fixed dome would be escaped.
    sky.position.copy(camera.position);

    // Corrosion climbs through the corrosion chapter and stays high after —
    // the pipe does not heal because you scrolled past.
    pipeUniforms.uCorrosion.value =
      0.06 + Math.min(Math.max((p - 0.16) / 0.26, 0), 1) * 0.84;
    pipeUniforms.uCam.value.copy(camera.position);
    groundUniforms.uCam.value.copy(camera.position);

    if (!reduced) flameUniforms.uTime.value = elapsed;
    // A flare flickers; a steady cone reads as a traffic cone.
    const flick = reduced ? 1 : 0.9 + Math.sin(elapsed * 7.3) * 0.06
                                + Math.sin(elapsed * 13.1) * 0.04;
    flame.scale.set(flick, 0.94 + flick * 0.09, 1);
    // Billboard it, so it never turns edge-on and vanishes.
    flame.lookAt(camera.position.x, flame.position.y, camera.position.z);
  }

  function frame() {
    if (disposed) return;
    apply(progress, (performance.now() - t0) / 1000);
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }

  layout();

  if (reduced) {
    apply(0, 0);
    renderer.render(scene, camera);
  } else {
    raf = requestAnimationFrame(frame);
  }

  return {
    reduced,
    setProgress(p: number) {
      progress = Math.min(Math.max(p, 0), 1);
      if (reduced) { apply(progress, 0); renderer.render(scene, camera); }
    },
    resize() {
      layout();
      if (reduced) { apply(progress, 0); renderer.render(scene, camera); }
    },
    dispose() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      scene.traverse((o) => {
        const m = o as Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material as MeshStandardMaterial | undefined;
        if (mat && typeof mat.dispose === 'function') mat.dispose();
      });
      renderer.dispose();
    },
  };
}
