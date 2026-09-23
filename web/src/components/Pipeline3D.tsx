/* A pipe segment, drawn in 3D from its own measurements — and orbitable.
 *
 * WHY PROCEDURAL AND NOT A TEXTURE
 *
 *   A downloaded rusted-metal texture looks better in isolation and is
 *   useless here, because it shows the same corrosion on every segment. The
 *   point of this component is that pitting density, wall thickness and the
 *   accent are functions of THIS segment's values — a 4.2 mpy segment must
 *   visibly differ from a 0.6 mpy one, or the visual is decoration
 *   pretending to be data.
 *
 * WHY THE FIRST VERSION LOOKED LIKE A GREEN BLOB
 *
 *   Three faults compounding:
 *
 *     1. The steel base was dark AND green-biased (0.118–0.290, green
 *        channel highest), so the body had almost no range to light.
 *     2. The risk-band colour was applied by a fresnel term over the whole
 *        silhouette. A cylinder seen side-on is nearly all grazing angle,
 *        so "rim light" became "paint the entire pipe green".
 *     3. There was no specular term, so nothing read as metal at all.
 *
 *   Now: neutral steel with real range, a tight specular highlight, and the
 *   band colour reduced to a narrow edge that reinforces the status without
 *   becoming the subject. The absence of pits on a low-rate segment was
 *   never a fault — that is the component working.
 *
 * WHY NO 3D LIBRARY
 *
 *   The console sends `script-src 'self'`, so everything bundles from this
 *   origin anyway, and three.js would add ~150 KB gzipped to draw one
 *   cylinder with two lights.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';

import type { RiskBand } from '../lib/types';
import { cx } from './ui';

/* ============================================================== shaders == */

const VERT = `
attribute vec3 aPos;
attribute vec3 aNormal;
attribute vec2 aUv;
uniform mat4 uProj, uView;
uniform mat3 uNormalMat;
varying vec3 vNormal, vWorld;
varying vec2 vUv;
void main() {
  vWorld = aPos;
  vNormal = uNormalMat * aNormal;
  vUv = aUv;
  gl_Position = uProj * uView * vec4(aPos, 1.0);
}`;

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec3 vNormal, vWorld;
varying vec2 vUv;
uniform vec3 uCam, uBand;
uniform float uCorrosion, uAlpha, uFlip;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p){
  float s = 0.0, a = 0.5;
  for (int k = 0; k < 4; k++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return s;
}

void main() {
  vec3 N = normalize(vNormal) * (uFlip > 0.5 ? -1.0 : 1.0);
  vec3 V = normalize(uCam - vWorld);
  // Key from over the viewer's shoulder, fill from below-left. Two lights,
  // because one leaves the shaded half of a cylinder flat black.
  vec3 L1 = normalize(vec3(-0.35, 0.78, 0.52));
  vec3 L2 = normalize(vec3(0.62, -0.28, 0.34));

  float d1 = max(dot(N, L1), 0.0);
  float d2 = max(dot(N, L2), 0.0);
  float spec = pow(max(dot(reflect(-L1, N), V), 0.0), 42.0);
  float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);

  vec2 sp = vec2(vUv.x * 44.0, vUv.y * 15.0);
  float grain = fbm(sp * 1.7);

  // The threshold falls as corrosion rises, so the SAME field grows more
  // pitted rather than reshuffling. Two segments with similar rates
  // therefore look similar, which is what makes the visual readable.
  float thresh = mix(0.88, 0.46, clamp(uCorrosion, 0.0, 1.0));
  float pit = smoothstep(thresh, thresh + 0.09, fbm(sp * 3.1 + 11.0));
  float weld = smoothstep(0.972, 0.996, abs(sin(vUv.x * 3.14159 * 5.0)));

  // Neutral steel with real range. The previous base was dark and
  // green-biased, which left nothing for the light to do.
  vec3 steel = mix(vec3(0.34, 0.36, 0.35), vec3(0.72, 0.75, 0.73), grain);
  vec3 rust  = mix(vec3(0.36, 0.18, 0.07), vec3(0.62, 0.32, 0.11), grain);
  vec3 col = mix(steel, rust, pit * 0.92);
  col = mix(col, vec3(0.80, 0.83, 0.80), weld * 0.35);

  col *= 0.30 + 0.72 * d1 + 0.22 * d2;
  // Tight highlight: this is what makes it read as metal rather than as a
  // painted tube. Pits are matte, so they do not take it.
  col += vec3(1.0, 0.97, 0.90) * spec * (1.0 - pit * 0.9) * 0.9;
  // The band colour is a NARROW edge, not a wash. pow(...,4) plus a small
  // weight keeps it on the silhouette instead of over the whole body.
  col += uBand * fres * 0.16;

  gl_FragColor = vec4(col, uAlpha);
}`;

/* ============================================================= geometry == */

function buildTube(radius: number, length: number, radial: number, axial: number) {
  const pos: number[] = [], nrm: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let i = 0; i <= axial; i++) {
    const u = i / axial;
    const x = (u - 0.5) * length;
    for (let j = 0; j <= radial; j++) {
      const v = j / radial;
      const th = v * Math.PI * 2;
      const cy = Math.cos(th), sy = Math.sin(th);
      pos.push(x, cy * radius, sy * radius);
      nrm.push(0, cy, sy);
      uv.push(u, v);
    }
  }
  const stride = radial + 1;
  for (let a = 0; a < axial; a++) {
    for (let b = 0; b < radial; b++) {
      const i0 = a * stride + b, i1 = i0 + 1, i2 = i0 + stride, i3 = i2 + 1;
      idx.push(i0, i2, i1, i1, i2, i3);
    }
  }
  return {
    position: new Float32Array(pos), normal: new Float32Array(nrm),
    uv: new Float32Array(uv), index: new Uint16Array(idx), count: idx.length,
  };
}

/* ============================================================= matrices == */

const perspective = (fovy: number, aspect: number, near: number, far: number) => {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0, 0, f, 0, 0,
    0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0,
  ]);
};

/** General look-at with an explicit up vector. The earlier version assumed
 *  the camera never left the XZ plane; an orbit that can be tilted needs
 *  the real cross products. */
function lookAt(eye: number[], at: number[], up: number[]) {
  let zx = eye[0] - at[0], zy = eye[1] - at[1], zz = eye[2] - at[2];
  const zl = Math.hypot(zx, zy, zz) || 1; zx /= zl; zy /= zl; zz /= zl;
  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  const xl = Math.hypot(xx, xy, xz) || 1; xx /= xl; xy /= xl; xz /= xl;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return new Float32Array([
    xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]), 1,
  ]);
}

/* ============================================================ component == */

const BAND_RGB: Record<RiskBand, [number, number, number]> = {
  critical: [0.894, 0.451, 0.361],
  elevated: [0.878, 0.635, 0.231],
  normal: [0.494, 0.651, 0.290],
};

/** Corrosion rate in mpy mapped to the shader's 0..1 pitting parameter.
 *  4 mpy is a severe external-corrosion rate, so it anchors the top. */
const RATE_CEILING_MPY = 4.0;

/* Orbit limits. Elevation is clamped short of the poles: at exactly
   vertical the up vector and the view direction are parallel and the
   look-at basis collapses. */
const EL_LIMIT = 1.25;
const DIST_MIN = 3.4;
const DIST_MAX = 9.0;
const HOME = { az: 0.42, el: 0.26, dist: 5.4 };

interface Props {
  corrosionRate: number;
  wallThicknessMm?: number;
  riskBand: RiskBand;
  height?: number;
}

export function Pipeline3D({
  corrosionRate, wallThicknessMm, riskBand, height = 132,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  const [touched, setTouched] = useState(false);
  const [dragging, setDragging] = useState(false);

  // The camera lives in a ref, not state: it changes every pointer move and
  // every idle frame, and re-rendering the tree at that rate would be
  // wasteful for something only the canvas reads.
  const orbit = useRef({ ...HOME });
  const drag = useRef<{ x: number; y: number; az: number; el: number } | null>(null);
  const interacted = useRef(false);

  const reset = useCallback(() => {
    orbit.current = { ...HOME };
    interacted.current = false;
    setTouched(false);
  }, []);

  /* ------------------------------------------------------------- input -- */
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      x: e.clientX, y: e.clientY,
      az: orbit.current.az, el: orbit.current.el,
    };
    interacted.current = true;
    setTouched(true);
    setDragging(true);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d) return;
    // Measured from where the drag started, so a long drag cannot drift
    // from accumulated per-frame rounding.
    orbit.current.az = d.az + (e.clientX - d.x) * 0.0105;
    orbit.current.el = Math.max(-EL_LIMIT, Math.min(EL_LIMIT,
      d.el + (e.clientY - d.y) * 0.0085));
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    drag.current = null;
    setDragging(false);
  }, []);

  /* Keyboard orbit. A control that only works with a pointer is not a
     control for everyone. */
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLCanvasElement>) => {
    const step = e.shiftKey ? 0.32 : 0.12;
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft': orbit.current.az -= step; break;
      case 'ArrowRight': orbit.current.az += step; break;
      case 'ArrowUp':
        orbit.current.el = Math.min(EL_LIMIT, orbit.current.el + step); break;
      case 'ArrowDown':
        orbit.current.el = Math.max(-EL_LIMIT, orbit.current.el - step); break;
      case 'Home': reset(); break;
      default: handled = false;
    }
    if (handled) {
      e.preventDefault();
      if (e.key !== 'Home') { interacted.current = true; setTouched(true); }
    }
  }, [reset]);

  /* Wheel, attached natively so it can be non-passive — React's onWheel is
     passive, so preventDefault there is ignored and the panel scrolls
     behind the model. */
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      orbit.current.dist = Math.max(DIST_MIN, Math.min(DIST_MAX,
        orbit.current.dist + e.deltaY * 0.0042));
      interacted.current = true;
      setTouched(true);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  /* ------------------------------------------------------------- render -- */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    let gl: WebGLRenderingContext | null = null;
    try {
      gl = (canvas.getContext('webgl', { alpha: true, antialias: true }) ||
            canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    } catch { gl = null; }
    if (!gl) { setFailed(true); return; }

    const compile = (type: number, src: string) => {
      const sh = gl!.createShader(type)!;
      gl!.shaderSource(sh, src);
      gl!.compileShader(sh);
      return gl!.getShaderParameter(sh, gl!.COMPILE_STATUS) ? sh : null;
    };
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) { setFailed(true); return; }

    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { setFailed(true); return; }
    gl.useProgram(prog);

    // Wall thickness nudges the drawn radius, so a thin-walled segment reads
    // as slighter. Clamped: an indication of proportion, not a scale drawing.
    const wall = wallThicknessMm ?? 12;
    const radius = 1.2 + Math.max(-0.22, Math.min(0.32, (wall - 12) / 40));
    const geo = buildTube(radius, 8.2, 80, 48);

    const buf = (target: number, data: ArrayBufferView) => {
      const b = gl!.createBuffer(); gl!.bindBuffer(target, b);
      gl!.bufferData(target, data, gl!.STATIC_DRAW); return b;
    };
    const bPos = buf(gl.ARRAY_BUFFER, geo.position);
    const bNrm = buf(gl.ARRAY_BUFFER, geo.normal);
    const bUv = buf(gl.ARRAY_BUFFER, geo.uv);
    const bIdx = buf(gl.ELEMENT_ARRAY_BUFFER, geo.index);

    const aPos = gl.getAttribLocation(prog, 'aPos');
    const aNrm = gl.getAttribLocation(prog, 'aNormal');
    const aUv = gl.getAttribLocation(prog, 'aUv');
    const U = (n: string) => gl!.getUniformLocation(prog, n);
    const u = {
      proj: U('uProj'), view: U('uView'), nmat: U('uNormalMat'),
      cam: U('uCam'), band: U('uBand'), corrosion: U('uCorrosion'),
      alpha: U('uAlpha'), flip: U('uFlip'),
    };

    const bind = () => {
      gl!.bindBuffer(gl!.ARRAY_BUFFER, bPos);
      gl!.enableVertexAttribArray(aPos); gl!.vertexAttribPointer(aPos, 3, gl!.FLOAT, false, 0, 0);
      gl!.bindBuffer(gl!.ARRAY_BUFFER, bNrm);
      gl!.enableVertexAttribArray(aNrm); gl!.vertexAttribPointer(aNrm, 3, gl!.FLOAT, false, 0, 0);
      gl!.bindBuffer(gl!.ARRAY_BUFFER, bUv);
      gl!.enableVertexAttribArray(aUv); gl!.vertexAttribPointer(aUv, 2, gl!.FLOAT, false, 0, 0);
      gl!.bindBuffer(gl!.ELEMENT_ARRAY_BUFFER, bIdx);
    };

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.clearColor(0, 0, 0, 0);

    const band = BAND_RGB[riskBand] ?? BAND_RGB.normal;
    const corrosion = Math.max(0, Math.min(1, corrosionRate / RATE_CEILING_MPY));
    // The identity 3x3: the model never moves, only the camera orbits, so
    // normals need no transform.
    const IDENTITY3 = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

    let raf = 0;
    const t0 = performance.now();

    const draw = (now: number) => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      gl!.viewport(0, 0, w, h);

      // Idle drift, until the first interaction. It advertises that the
      // model is live without fighting the user once they take hold of it.
      if (!interacted.current && !reduced && !drag.current) {
        orbit.current.az = HOME.az + Math.sin((now - t0) / 5200) * 0.55;
      }

      const { az, el, dist } = orbit.current;
      const ce = Math.cos(el);
      const eye = [dist * ce * Math.sin(az), dist * Math.sin(el), dist * ce * Math.cos(az)];

      gl!.uniformMatrix4fv(u.proj, false, perspective(38 * Math.PI / 180, w / h, 0.1, 100));
      gl!.uniformMatrix4fv(u.view, false, lookAt(eye, [0, 0, 0], [0, 1, 0]));
      gl!.uniformMatrix3fv(u.nmat, false, IDENTITY3);
      gl!.uniform3f(u.cam, eye[0], eye[1], eye[2]);
      gl!.uniform3f(u.band, band[0], band[1], band[2]);
      gl!.uniform1f(u.corrosion, corrosion);

      gl!.clear(gl!.COLOR_BUFFER_BIT | gl!.DEPTH_BUFFER_BIT);
      gl!.disable(gl!.BLEND);
      gl!.depthMask(true);

      // Bore first (back faces), then the near wall glassy over it — a
      // cutaway with no cutaway geometry.
      bind();
      gl!.cullFace(gl!.FRONT);
      gl!.uniform1f(u.flip, 1); gl!.uniform1f(u.alpha, 1);
      gl!.drawElements(gl!.TRIANGLES, geo.count, gl!.UNSIGNED_SHORT, 0);

      gl!.enable(gl!.BLEND);
      gl!.blendFunc(gl!.SRC_ALPHA, gl!.ONE_MINUS_SRC_ALPHA);
      gl!.depthMask(false);
      gl!.cullFace(gl!.BACK);
      gl!.uniform1f(u.flip, 0); gl!.uniform1f(u.alpha, 0.40);
      gl!.drawElements(gl!.TRIANGLES, geo.count, gl!.UNSIGNED_SHORT, 0);
      gl!.depthMask(true);
      gl!.disable(gl!.BLEND);

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => { if (raf) cancelAnimationFrame(raf); };
  }, [corrosionRate, wallThicknessMm, riskBand]);

  if (failed) {
    return <PipeSection corrosionRate={corrosionRate} riskBand={riskBand} height={height} />;
  }

  return (
    <div className="relative">
      <canvas
        ref={canvasRef}
        tabIndex={0}
        className={cx('block w-full touch-none outline-none',
                      'focus-visible:ring-1 focus-visible:ring-accent',
                      dragging ? 'cursor-grabbing' : 'cursor-grab')}
        style={{ height }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        role="img"
        aria-label={
          `Rotatable 3D view of a pipe segment at ${corrosionRate.toFixed(2)} mils `
          + `per year, ${riskBand} risk. Surface pitting is proportional to the `
          + `predicted rate. Drag or use the arrow keys to rotate.`
        }
      />

      {/* The affordance. Without it a static-looking render gives no reason
          to try dragging it. Fades once the user has. */}
      <div
        className={cx(
          'pointer-events-none absolute bottom-1.5 left-2 transition-opacity duration-500',
          touched ? 'opacity-0' : 'opacity-100',
        )}
      >
        <span className="label" style={{ fontSize: 8 }}>Drag to rotate</span>
      </div>

      {touched && (
        <button
          type="button"
          onClick={reset}
          title="Reset view"
          aria-label="Reset the 3D view"
          className="absolute right-1.5 top-1.5 grid h-[22px] w-[22px] place-items-center
                     border border-line-soft bg-panel/85 text-muted transition-colors
                     hover:text-accent"
        >
          <RotateCcw size={11} />
        </button>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- fallback */

/** Flat section drawing, used when WebGL is unavailable. Carries the same
 *  numbers, so nothing is lost but the depth. */
function PipeSection({
  corrosionRate, riskBand, height,
}: { corrosionRate: number; riskBand: RiskBand; height: number }) {
  const tone = `var(--color-${riskBand})`;
  const pits = Math.round(Math.min(corrosionRate / RATE_CEILING_MPY, 1) * 7);
  return (
    <svg
      className="block w-full" style={{ height }} viewBox="0 0 320 128"
      role="img"
      aria-label={`Pipe section at ${corrosionRate.toFixed(2)} mils per year, ${riskBand} risk`}
    >
      <rect x="0" y="34" width="320" height="16" fill="var(--color-raised)"
            stroke="var(--color-line)" />
      <rect x="0" y="50" width="320" height="28" fill="var(--color-sunken)"
            stroke="var(--color-line)" />
      <rect x="0" y="78" width="320" height="16" fill="var(--color-raised)"
            stroke="var(--color-line)" />
      {Array.from({ length: pits }).map((_, i) => (
        <ellipse key={i} cx={34 + i * 38} cy={38} rx={7} ry={4} fill={tone} opacity="0.85" />
      ))}
      <text x="8" y="114" className="num" fill="var(--color-dim)" fontSize="10">
        {corrosionRate.toFixed(2)} mpy · WebGL unavailable
      </text>
    </svg>
  );
}
