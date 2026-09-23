/* The orbit basis must stay orthonormal at every reachable angle. At the
 * poles the up vector and the view direction become parallel and the cross
 * product collapses to zero - the render would go blank or invert with no
 * error anywhere. EL_LIMIT exists to prevent that; this proves it does. */
const EL_LIMIT = 1.25, DIST_MIN = 3.4, DIST_MAX = 9.0;

function lookAt(eye, at, up) {
  let zx = eye[0]-at[0], zy = eye[1]-at[1], zz = eye[2]-at[2];
  const zl = Math.hypot(zx,zy,zz) || 1; zx/=zl; zy/=zl; zz/=zl;
  let xx = up[1]*zz - up[2]*zy, xy = up[2]*zx - up[0]*zz, xz = up[0]*zy - up[1]*zx;
  const xl = Math.hypot(xx,xy,xz) || 1; xx/=xl; xy/=xl; xz/=xl;
  const yx = zy*xz - zz*xy, yy = zz*xx - zx*xz, yz = zx*xy - zy*xx;
  return { x:[xx,xy,xz], y:[yx,yy,yz], z:[zx,zy,zz], xl };
}
const dot = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const len = (a) => Math.hypot(...a);

let bad = 0, worstDeg = 0, worstUnit = 0, minCross = Infinity;
for (let ai = 0; ai < 48; ai++) {
  for (let ei = -24; ei <= 24; ei++) {
    for (const dist of [DIST_MIN, 5.4, DIST_MAX]) {
      const az = (ai/48)*Math.PI*2;
      const el = (ei/24)*EL_LIMIT;              // full reachable range
      const ce = Math.cos(el);
      const eye = [dist*ce*Math.sin(az), dist*Math.sin(el), dist*ce*Math.cos(az)];
      const b = lookAt(eye, [0,0,0], [0,1,0]);
      minCross = Math.min(minCross, b.xl);
      for (const v of [b.x,b.y,b.z]) {
        if (!v.every(Number.isFinite)) { bad++; console.log('NaN at az',az,'el',el); }
        worstUnit = Math.max(worstUnit, Math.abs(len(v)-1));
      }
      worstDeg = Math.max(worstDeg,
        Math.abs(dot(b.x,b.y)), Math.abs(dot(b.x,b.z)), Math.abs(dot(b.y,b.z)));
    }
  }
}
console.log(`samples: ${48*49*3}`);
console.log(`worst deviation from unit length : ${worstUnit.toExponential(2)}`);
console.log(`worst deviation from orthogonal  : ${worstDeg.toExponential(2)}`);
console.log(`smallest up x view cross length  : ${minCross.toFixed(4)}  (0 = collapse)`);
if (worstUnit > 1e-9 || worstDeg > 1e-9) { bad++; console.log('BASIS NOT ORTHONORMAL'); }
if (minCross < 0.2) { bad++; console.log('TOO CLOSE TO THE POLE — raise EL_LIMIT guard'); }
console.log(bad ? `\n${bad} PROBLEM(S)` : '\nORBIT BASIS SOUND AT EVERY REACHABLE ANGLE');
process.exit(bad ? 1 : 0);
