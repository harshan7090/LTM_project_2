/* A pipe segment, drawn in 3D from its own measurements.
 *
 * WHY PROCEDURAL AND NOT A TEXTURE
 *
 *   A downloaded rusted-metal texture looks better in isolation and is
 *   useless here, because it shows the same corrosion on every segment. The
 *   point of this component is that the pitting density, the wall thickness
 *   and the colour are all functions of THIS segment's values — a 4.2 mpy
 *   segment must visibly differ from a 0.6 mpy one, or the visual is
 *   decoration pretending to be data.
 *
 * WHY NO 3D LIBRARY
 *
 *   The console sends `script-src 'self'`, so everything is bundled from
 *   this origin anyway. three.js would add ~150 KB gzipped to render one
 *   cylinder with two lights. The shader below is the same approach already
 *   proven on the landing hero.
 *
 * FAILURE
 *
 *   Every exit path is clean. No WebGL, a refused context, a shader that
 *   will not compile — the canvas is replaced by a labelled 2D section
 *   drawing carrying the same numbers. A panel that cannot render must
 *   never become a hole.
 */
import { useEffect, useRef, useState } from 'react';

import type { RiskBand } from '../lib/types';

/* ============================================================== shaders == */

const VERT = `
attribute vec3 aPos;
attribute vec3 aNormal;
attribute vec2 aUv;
uniform mat4 uProj, uView, uModel;
uniform mat3 uNormalMat;
varying vec3 vNormal, vWorld;
varying vec2 vUv;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vWorld = w.xyz;
  vNormal = uNormalMat * aNormal;
  vUv = aUv;
  gl_Position = uProj * uView * w;
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
  vec3 L = normalize(vec3(-0.42, 0.84, 0.36));
  float diff = max(dot(N, L), 0.0);
  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);

  vec2 sp = vec2(vUv.x * 40.0, vUv.y * 15.0);
  float grain = fbm(sp * 1.7);

  // The threshold falls as corrosion rises, so the SAME noise field grows
  // more pitted rather than reshuffling into a different pattern. Two
  // segments with similar rates therefore look similar, which is the
  // property that makes the visual readable as data.
  float thresh = mix(0.88, 0.46, clamp(uCorrosion, 0.0, 1.0));
  float pit = smoothstep(thresh, thresh + 0.09, fbm(sp * 3.1 + 11.0));
  float weld = smoothstep(0.972, 0.996, abs(sin(vUv.x * 3.14159 * 5.0)));

  vec3 steel = mix(vec3(0.118, 0.137, 0.129), vec3(0.290, 0.325, 0.306), grain);
  vec3 rust  = mix(vec3(0.322, 0.153, 0.063), vec3(0.545, 0.259, 0.078), grain);
  vec3 col = mix(steel, rust, pit * 0.92);
  col = mix(col, vec3(0.38, 0.42, 0.40), weld * 0.5);
  col *= 0.28 + 0.82 * diff;
  // Rim light in the segment's own risk colour: the band is already
  // encoded by a label and a lamp elsewhere, so this reinforces, never
  // carries, the meaning.
  col += uBand * fres * 0.30 * (1.0 - pit * 0.7);

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

const lookAt = (eye: number[], at: number[]) => {
  let zx = eye[0] - at[0], zy = eye[1] - at[1], zz = eye[2] - at[2];
  const zl = Math.hypot(zx, zy, zz) || 1; zx /= zl; zy /= zl; zz /= zl;
  let xx = zz, xy = 0, xz = -zx;
  const xl = Math.hypot(xx, xy, xz) || 1; xx /= xl; xy /= xl; xz /= xl;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return new Float32Array([
    xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]), 1,
  ]);
};

const rotYZ = (ay: number, az: number) => {
  const cy = Math.cos(ay), sy = Math.sin(ay), cz = Math.cos(az), sz = Math.sin(az);
  return new Float32Array([
    cy * cz, sz, -sy * cz, 0, -cy * sz, cz, sy * sz, 0, sy, 0, cy, 0, 0, 0, 0, 1,
  ]);
};

/* ============================================================ component == */

const BAND_RGB: Record<RiskBand, [number, number, number]> = {
  critical: [0.894, 0.451, 0.361],
  elevated: [0.878, 0.635, 0.231],
  normal: [0.494, 0.651, 0.290],
};

/** Corrosion rate in mpy, mapped to the shader's 0..1 pitting parameter.
 *  4 mpy is a severe external-corrosion rate, so it anchors the top. */
const RATE_CEILING_MPY = 4.0;

interface Props {
  corrosionRate: number;
  wallThicknessMm?: number;
  riskBand: RiskBand;
  /** Pause rotation. Also honoured automatically under reduced motion. */
  still?: boolean;
  height?: number;
}

export function Pipeline3D({
  corrosionRate, wallThicknessMm, riskBand, still = false, height = 128,
}: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const canvas = ref.current;
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

    // Wall thickness scales the drawn radius a little, so a thin-walled
    // segment reads as slighter. Clamped: this is an indication of
    // proportion, not a scale drawing.
    const wall = wallThicknessMm ?? 12;
    const radius = 1.25 + Math.max(-0.25, Math.min(0.35, (wall - 12) / 40));
    const geo = buildTube(radius, 9, 72, 44);

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
      proj: U('uProj'), view: U('uView'), model: U('uModel'), nmat: U('uNormalMat'),
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

    let raf = 0;
    const t0 = performance.now();

    const draw = (now: number) => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      gl!.viewport(0, 0, w, h);

      const spin = (still || reduced) ? 0 : ((now - t0) / 1000) * 0.16;
      const model = rotYZ(-0.22 + Math.sin(spin) * 0.22, -0.05);
      const eye = [0, 0.5, 5.0];

      gl!.uniformMatrix4fv(u.proj, false, perspective(40 * Math.PI / 180, w / h, 0.1, 100));
      gl!.uniformMatrix4fv(u.view, false, lookAt(eye, [0, 0, 0]));
      gl!.uniformMatrix4fv(u.model, false, model);
      gl!.uniformMatrix3fv(u.nmat, false, new Float32Array([
        model[0], model[1], model[2], model[4], model[5], model[6],
        model[8], model[9], model[10],
      ]));
      gl!.uniform3f(u.cam, eye[0], eye[1], eye[2]);
      gl!.uniform3f(u.band, band[0], band[1], band[2]);
      gl!.uniform1f(u.corrosion, corrosion);

      gl!.clear(gl!.COLOR_BUFFER_BIT | gl!.DEPTH_BUFFER_BIT);
      gl!.disable(gl!.BLEND);
      gl!.depthMask(true);

      // Bore first (back faces), then the near wall glassy over it — the
      // same cutaway trick as the landing hero, and no cutaway geometry.
      bind();
      gl!.cullFace(gl!.FRONT);
      gl!.uniform1f(u.flip, 1); gl!.uniform1f(u.alpha, 1);
      gl!.drawElements(gl!.TRIANGLES, geo.count, gl!.UNSIGNED_SHORT, 0);

      gl!.enable(gl!.BLEND);
      gl!.blendFunc(gl!.SRC_ALPHA, gl!.ONE_MINUS_SRC_ALPHA);
      gl!.depthMask(false);
      gl!.cullFace(gl!.BACK);
      gl!.uniform1f(u.flip, 0); gl!.uniform1f(u.alpha, 0.34);
      gl!.drawElements(gl!.TRIANGLES, geo.count, gl!.UNSIGNED_SHORT, 0);
      gl!.depthMask(true);
      gl!.disable(gl!.BLEND);

      if (!(still || reduced)) raf = requestAnimationFrame(draw);
    };

    draw(t0);
    return () => { if (raf) cancelAnimationFrame(raf); };
  }, [corrosionRate, wallThicknessMm, riskBand, still]);

  if (failed) {
    return <PipeSection corrosionRate={corrosionRate} riskBand={riskBand} height={height} />;
  }
  return (
    <canvas
      ref={ref}
      className="block w-full"
      style={{ height }}
      role="img"
      aria-label={
        `Pipe segment rendered at ${corrosionRate.toFixed(2)} mils per year, ` +
        `${riskBand} risk. Surface pitting is proportional to the predicted rate.`
      }
    />
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
