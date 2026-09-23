/* Corvex — the hero pipeline, in real 3D.
 *
 * WHY RAW WEBGL AND NOT A LIBRARY
 *
 *   The console sends `script-src 'self'`, so every byte of script has to
 *   come from this origin. A CDN is not an option and this machine cannot
 *   reach one to vendor a copy. That leaves writing it directly — which for
 *   one cylinder, one fluid surface and two lights is about three hundred
 *   lines and no supply chain at all.
 *
 * WHY THIS READS AS A CUTAWAY
 *
 *   There is no cutaway geometry. It is one cylinder drawn twice:
 *
 *     pass 1  cull FRONT  — only back-facing triangles survive, so you are
 *                           looking at the INSIDE of the far wall. That is
 *                           the bore.
 *     pass 2              — the crude, a displaced surface sitting in the
 *                           bottom of that bore.
 *     pass 3  cull BACK   — the near wall, at low alpha, over the top.
 *
 *   Three draws, one geometry, and the glassy near wall does the work that
 *   a modelled cutaway would otherwise have to.
 *
 * WHAT THE SCROLL ACTUALLY DRIVES
 *
 *   Not just rotation. `uCorrosion` rises from 0.12 to 0.9 down the page, so
 *   the wall visibly pits as you read about predicting corrosion. The visual
 *   is making the argument, not decorating it.
 *
 * FAILURE
 *
 *   Every exit path is a clean one. No WebGL, a refused context, a shader
 *   that will not compile on some driver — `init` returns false, the canvas
 *   is removed, and the CSS pipe underneath is what the visitor sees. A
 *   hero that cannot render must never be a hole in the page.
 */
(function (global) {
  'use strict';

  /* ===================================================== small matrices == */
  /* Column-major, the order WebGL wants. Written out rather than pulled in;
     a 4x4 multiply is not worth a dependency. */

  function mat4Identity() {
    return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
  }

  function mat4Perspective(fovyRad, aspect, near, far) {
    var f = 1 / Math.tan(fovyRad / 2);
    var nf = 1 / (near - far);
    return new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) * nf, -1,
      0, 0, 2 * far * near * nf, 0
    ]);
  }

  function mat4LookAt(eye, center, up) {
    var zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
    var zl = Math.hypot(zx, zy, zz) || 1;
    zx /= zl; zy /= zl; zz /= zl;

    var xx = up[1] * zz - up[2] * zy;
    var xy = up[2] * zx - up[0] * zz;
    var xz = up[0] * zy - up[1] * zx;
    var xl = Math.hypot(xx, xy, xz) || 1;
    xx /= xl; xy /= xl; xz /= xl;

    var yx = zy * xz - zz * xy;
    var yy = zz * xx - zx * xz;
    var yz = zx * xy - zy * xx;

    return new Float32Array([
      xx, yx, zx, 0,
      xy, yy, zy, 0,
      xz, yz, zz, 0,
      -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
      -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
      -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
      1
    ]);
  }

  /** Rotation about Y then Z. Rotation only — no scale — which is why the
   *  normal matrix below is just the upper 3x3 and needs no inverse. */
  function mat4RotYZ(ay, az) {
    var cy = Math.cos(ay), sy = Math.sin(ay);
    var cz = Math.cos(az), sz = Math.sin(az);
    // Ry * Rz
    return new Float32Array([
      cy * cz,  sz,      -sy * cz, 0,
      -cy * sz, cz,      sy * sz,  0,
      sy,       0,       cy,       0,
      0,        0,       0,        1
    ]);
  }

  function mat3FromMat4(m) {
    return new Float32Array([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]);
  }

  /* ========================================================== geometry == */

  /** An open-ended tube along X. No caps: it runs past both edges of the
   *  frame, so caps would be geometry nobody ever sees. */
  function buildTube(radius, length, radialSegs, axialSegs) {
    var pos = [], nrm = [], uv = [], idx = [];

    for (var i = 0; i <= axialSegs; i++) {
      var u = i / axialSegs;
      var x = (u - 0.5) * length;
      for (var j = 0; j <= radialSegs; j++) {
        var v = j / radialSegs;
        var th = v * Math.PI * 2;
        var cy = Math.cos(th), sy = Math.sin(th);
        pos.push(x, cy * radius, sy * radius);
        nrm.push(0, cy, sy);
        uv.push(u, v);
      }
    }

    var stride = radialSegs + 1;
    for (var a = 0; a < axialSegs; a++) {
      for (var b = 0; b < radialSegs; b++) {
        var i0 = a * stride + b;
        var i1 = i0 + 1;
        var i2 = i0 + stride;
        var i3 = i2 + 1;
        idx.push(i0, i2, i1, i1, i2, i3);
      }
    }

    return {
      position: new Float32Array(pos),
      normal: new Float32Array(nrm),
      uv: new Float32Array(uv),
      index: new Uint16Array(idx),
      count: idx.length
    };
  }

  /** The fluid surface: a flat grid spanning the chord of the bore at the
   *  fill height. Width is the actual chord, 2*sqrt(r^2 - h^2), so the
   *  surface meets the wall instead of floating inside it or poking through. */
  function buildFluid(radius, length, fillY, segsX, segsZ) {
    var halfW = Math.sqrt(Math.max(radius * radius - fillY * fillY, 0.0001));
    var pos = [], nrm = [], uv = [], idx = [];

    for (var i = 0; i <= segsX; i++) {
      var u = i / segsX;
      for (var j = 0; j <= segsZ; j++) {
        var v = j / segsZ;
        pos.push((u - 0.5) * length, fillY, (v - 0.5) * 2 * halfW);
        nrm.push(0, 1, 0);
        uv.push(u, v);
      }
    }

    var stride = segsZ + 1;
    for (var a = 0; a < segsX; a++) {
      for (var b = 0; b < segsZ; b++) {
        var i0 = a * stride + b;
        var i1 = i0 + 1;
        var i2 = i0 + stride;
        var i3 = i2 + 1;
        idx.push(i0, i2, i1, i1, i2, i3);
      }
    }

    return {
      position: new Float32Array(pos),
      normal: new Float32Array(nrm),
      uv: new Float32Array(uv),
      index: new Uint16Array(idx),
      count: idx.length
    };
  }

  /* =========================================================== shaders == */

  var VERT = [
    'attribute vec3 aPos;',
    'attribute vec3 aNormal;',
    'attribute vec2 aUv;',
    'uniform mat4 uProj;',
    'uniform mat4 uView;',
    'uniform mat4 uModel;',
    'uniform mat3 uNormalMat;',
    'uniform float uTime;',
    'uniform float uWave;',
    'varying vec3 vNormal;',
    'varying vec3 vWorld;',
    'varying vec2 vUv;',
    'void main() {',
    '  vec3 p = aPos;',
    '  vec3 n = aNormal;',
    // uWave is 0 for the steel and 1 for the fluid, so one program serves
    // both and the surface still ripples along the flow direction.
    '  if (uWave > 0.5) {',
    '    float w1 = sin(p.x * 2.6 - uTime * 2.2) * 0.020;',
    '    float w2 = sin(p.x * 5.7 + p.z * 3.1 - uTime * 3.4) * 0.011;',
    '    p.y += w1 + w2;',
    '    float dx = cos(p.x * 2.6 - uTime * 2.2) * 2.6 * 0.020',
    '             + cos(p.x * 5.7 + p.z * 3.1 - uTime * 3.4) * 5.7 * 0.011;',
    '    float dz = cos(p.x * 5.7 + p.z * 3.1 - uTime * 3.4) * 3.1 * 0.011;',
    '    n = normalize(vec3(-dx, 1.0, -dz));',
    '  }',
    '  vec4 world = uModel * vec4(p, 1.0);',
    '  vWorld = world.xyz;',
    '  vNormal = uNormalMat * n;',
    '  vUv = aUv;',
    '  gl_Position = uProj * uView * world;',
    '}'
  ].join('\n');

  var FRAG = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    'varying vec3 vNormal;',
    'varying vec3 vWorld;',
    'varying vec2 vUv;',
    'uniform vec3 uCam;',
    'uniform float uTime;',
    'uniform float uCorrosion;',
    'uniform float uAlpha;',
    'uniform float uFlip;',     // 1.0 when we are looking at the inside
    'uniform float uMode;',     // 0 steel, 1 crude
    'uniform vec3 uTint;',

    'float hash(vec2 p) {',
    '  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);',
    '}',
    'float vnoise(vec2 p) {',
    '  vec2 i = floor(p); vec2 f = fract(p);',
    '  f = f * f * (3.0 - 2.0 * f);',
    '  float a = hash(i);',
    '  float b = hash(i + vec2(1.0, 0.0));',
    '  float c = hash(i + vec2(0.0, 1.0));',
    '  float d = hash(i + vec2(1.0, 1.0));',
    '  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);',
    '}',
    'float fbm(vec2 p) {',
    '  float s = 0.0; float amp = 0.5;',
    '  for (int k = 0; k < 4; k++) {',
    '    s += amp * vnoise(p);',
    '    p *= 2.03; amp *= 0.5;',
    '  }',
    '  return s;',
    '}',

    'void main() {',
    '  vec3 N = normalize(vNormal) * (uFlip > 0.5 ? -1.0 : 1.0);',
    '  vec3 V = normalize(uCam - vWorld);',
    '  vec3 L = normalize(vec3(-0.45, 0.82, 0.36));',
    '  float diff = max(dot(N, L), 0.0);',
    '  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);',

    '  vec3 col;',
    '  float alpha = uAlpha;',

    '  if (uMode < 0.5) {',
    // ---- steel ---------------------------------------------------------
    '    vec2 sp = vec2(vUv.x * 46.0, vUv.y * 17.0);',
    '    float grain = fbm(sp * 1.7);',
    // Pits appear where the field peaks; the threshold falls as corrosion
    // rises, so the same field grows more pitted rather than reshuffling.
    '    float thresh = mix(0.86, 0.50, clamp(uCorrosion, 0.0, 1.0));',
    '    float pit = smoothstep(thresh, thresh + 0.10, fbm(sp * 3.1 + 11.0));',
    // Circumferential weld bands at regular axial stations.
    '    float weld = smoothstep(0.972, 0.995, abs(sin(vUv.x * 3.14159 * 7.0)));',

    '    vec3 steel = mix(vec3(0.118, 0.137, 0.129), vec3(0.290, 0.325, 0.306), grain);',
    '    vec3 rust  = mix(vec3(0.357, 0.180, 0.070), vec3(0.596, 0.290, 0.086), grain);',
    '    col = mix(steel, rust, pit * 0.92);',
    '    col = mix(col, vec3(0.38, 0.42, 0.40), weld * 0.55);',
    '    col *= 0.30 + 0.80 * diff;',
    // Pits sit in shadow: they are holes, so they lose the rim light too.
    '    col += vec3(0.72, 0.82, 0.29) * fres * 0.22 * (1.0 - pit * 0.75);',
    '  } else {',
    // ---- crude ---------------------------------------------------------
    '    float bands = sin(vUv.x * 60.0 - uTime * 5.2) * 0.5 + 0.5;',
    '    float swirl = fbm(vec2(vUv.x * 12.0 - uTime * 1.4, vUv.y * 6.0));',
    '    vec3 deep = vec3(0.035, 0.043, 0.051);',
    '    vec3 lift = vec3(0.129, 0.110, 0.067);',
    '    col = mix(deep, lift, swirl * 0.75 + bands * 0.10);',
    '    col += vec3(0.72, 0.82, 0.29) * pow(max(dot(reflect(-L, N), V), 0.0), 42.0) * 0.85;',
    '    col += vec3(0.72, 0.82, 0.29) * fres * 0.30;',
    '    col *= 0.55 + 0.60 * diff;',
    '  }',

    '  col *= uTint;',
    '  gl_FragColor = vec4(col, alpha);',
    '}'
  ].join('\n');

  /* ============================================================= setup == */

  function compile(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  function makeBuffers(gl, geo) {
    function buf(target, data) {
      var b = gl.createBuffer();
      gl.bindBuffer(target, b);
      gl.bufferData(target, data, gl.STATIC_DRAW);
      return b;
    }
    return {
      position: buf(gl.ARRAY_BUFFER, geo.position),
      normal: buf(gl.ARRAY_BUFFER, geo.normal),
      uv: buf(gl.ARRAY_BUFFER, geo.uv),
      index: buf(gl.ELEMENT_ARRAY_BUFFER, geo.index),
      count: geo.count
    };
  }

  var RADIUS = 1.55;
  var LENGTH = 17.0;
  var FILL_Y = -0.52;

  function Pipe(canvas) {
    this.canvas = canvas;
    this.gl = null;
    this.progress = 0;
    this.raf = 0;
    this.t0 = 0;
    this.reduced = false;
  }

  Pipe.prototype.init = function () {
    var canvas = this.canvas;
    var opts = { alpha: true, antialias: true, depth: true, premultipliedAlpha: false };
    var gl = null;
    try {
      gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
    } catch (e) {
      gl = null;
    }
    if (!gl) return false;

    var vs = compile(gl, gl.VERTEX_SHADER, VERT);
    var fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return false;

    var prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;

    gl.useProgram(prog);

    this.gl = gl;
    this.prog = prog;
    this.attr = {
      pos: gl.getAttribLocation(prog, 'aPos'),
      nrm: gl.getAttribLocation(prog, 'aNormal'),
      uv: gl.getAttribLocation(prog, 'aUv')
    };
    this.uni = {};
    ['uProj', 'uView', 'uModel', 'uNormalMat', 'uTime', 'uWave', 'uCam',
     'uCorrosion', 'uAlpha', 'uFlip', 'uMode', 'uTint'].forEach(function (n) {
      this.uni[n] = gl.getUniformLocation(prog, n);
    }, this);

    this.tube = makeBuffers(gl, buildTube(RADIUS, LENGTH, 96, 72));
    this.fluid = makeBuffers(gl, buildFluid(RADIUS, LENGTH, FILL_Y, 72, 10));

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.clearColor(0, 0, 0, 0);

    this.resize();
    return true;
  };

  Pipe.prototype.resize = function () {
    var gl = this.gl;
    if (!gl) return;
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    var w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    var h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
  };

  Pipe.prototype.bind = function (buffers) {
    var gl = this.gl, a = this.attr;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.position);
    gl.enableVertexAttribArray(a.pos);
    gl.vertexAttribPointer(a.pos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.normal);
    gl.enableVertexAttribArray(a.nrm);
    gl.vertexAttribPointer(a.nrm, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.uv);
    gl.enableVertexAttribArray(a.uv);
    gl.vertexAttribPointer(a.uv, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffers.index);
  };

  Pipe.prototype.draw = function (timeMs) {
    var gl = this.gl;
    if (!gl) return;
    this.resize();

    var p = this.progress;
    var t = timeMs / 1000;

    // Camera pulls back and rises as the page moves, so the pipe turns from
    // a wall you are beside into an object you are above.
    var eye = [0.0, 0.42 + p * 1.55, 4.55 + p * 2.30];
    var view = mat4LookAt(eye, [0.0, -0.12 - p * 0.10, 0.0], [0, 1, 0]);
    var aspect = this.canvas.width / Math.max(1, this.canvas.height);
    var proj = mat4Perspective(42 * Math.PI / 180, aspect, 0.1, 100);

    var model = mat4RotYZ(
      (-9 + p * 17) * Math.PI / 180,
      (-3.5 + p * 7) * Math.PI / 180
    );
    var nmat = mat3FromMat4(model);

    var u = this.uni;
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(u.uProj, false, proj);
    gl.uniformMatrix4fv(u.uView, false, view);
    gl.uniformMatrix4fv(u.uModel, false, model);
    gl.uniformMatrix3fv(u.uNormalMat, false, nmat);
    gl.uniform3f(u.uCam, eye[0], eye[1], eye[2]);
    gl.uniform1f(u.uTime, t);
    gl.uniform1f(u.uCorrosion, 0.12 + p * 0.78);

    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.BLEND);
    gl.depthMask(true);

    // --- 1. the bore: back faces only, so we see the far wall from inside
    gl.cullFace(gl.FRONT);
    this.bind(this.tube);
    gl.uniform1f(u.uWave, 0);
    gl.uniform1f(u.uMode, 0);
    gl.uniform1f(u.uFlip, 1);
    gl.uniform1f(u.uAlpha, 1);
    gl.uniform3f(u.uTint, 1, 1, 1);
    gl.drawElements(gl.TRIANGLES, this.tube.count, gl.UNSIGNED_SHORT, 0);

    // --- 2. the crude, seen from above, so draw both sides
    gl.disable(gl.CULL_FACE);
    this.bind(this.fluid);
    gl.uniform1f(u.uWave, 1);
    gl.uniform1f(u.uMode, 1);
    gl.uniform1f(u.uFlip, 0);
    gl.uniform1f(u.uAlpha, 1);
    gl.drawElements(gl.TRIANGLES, this.fluid.count, gl.UNSIGNED_SHORT, 0);
    gl.enable(gl.CULL_FACE);

    // --- 3. the near wall, glassy, over the top of both
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.cullFace(gl.BACK);
    this.bind(this.tube);
    gl.uniform1f(u.uWave, 0);
    gl.uniform1f(u.uMode, 0);
    gl.uniform1f(u.uFlip, 0);
    gl.uniform1f(u.uAlpha, 0.30);
    gl.uniform3f(u.uTint, 1.05, 1.02, 0.98);
    gl.drawElements(gl.TRIANGLES, this.tube.count, gl.UNSIGNED_SHORT, 0);

    gl.depthMask(true);
    gl.disable(gl.BLEND);
  };

  Pipe.prototype.setProgress = function (p) {
    this.progress = p;
    // With motion reduced there is no loop, so a scroll has to paint once.
    if (this.reduced) this.draw(0);
  };

  Pipe.prototype.start = function (reduced) {
    this.reduced = !!reduced;
    var self = this;
    if (this.reduced) {
      this.draw(0);
      return;
    }
    this.t0 = (global.performance && global.performance.now) ? performance.now() : Date.now();
    (function loop(now) {
      self.draw(now - self.t0);
      self.raf = global.requestAnimationFrame(loop);
    })(this.t0);
  };

  /* ============================================================ export == */

  global.CorvexPipe = {
    /**
     * Returns a live scene, or null when this browser cannot draw it. A null
     * return is the caller's cue to drop the canvas and leave the CSS pipe
     * showing — never to leave an empty box.
     */
    create: function (canvas, reduced) {
      if (!canvas) return null;
      var pipe = new Pipe(canvas);
      var ok = false;
      try {
        ok = pipe.init();
      } catch (e) {
        ok = false;
      }
      if (!ok) return null;
      pipe.start(reduced);
      return pipe;
    }
  };
})(typeof window !== 'undefined' ? window : this);
