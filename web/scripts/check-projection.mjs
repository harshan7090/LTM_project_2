/* Checks the fleet map's projection is the right way up and in the right place.
 *
 * WHY THIS EXISTS
 *
 *   An earlier version of PipelineMap rendered the country upside down.
 *   Albers returns y increasing northward, the mathematical convention;
 *   screen y increases downward. Nothing errored, and it still looked like
 *   a map — which is the whole problem. An inverted country reads as
 *   plausible to anyone not checking, and that is everyone.
 *
 *   The map is now Web Mercator (raster tiles are cut in it, so nothing
 *   else would line up with the coastline). Same risk, so same check:
 *   assert against Indian cities whose relative positions are not in
 *   dispute, and against the tile grid the basemap is fetched from.
 *
 *   Constants MUST stay in step with PipelineMap.tsx. Re-run after any
 *   change there:
 *
 *       node web/scripts/check-projection.mjs
 */
const BBOX = { lonMin: 67.0, lonMax: 98.5, latMin: 6.0, latMax: 36.8 };
const TILE = 256;
const mercX = (lon, world) => ((lon + 180) / 360) * world;
const mercY = (lat, world) => {
  const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world;
};

function fitView(w, h, minZoom = 3, maxZoom = 10) {
  const lonFrac = (BBOX.lonMax - BBOX.lonMin) / 360;
  const latFrac = mercY(BBOX.latMin, 1) - mercY(BBOX.latMax, 1);
  const ideal = Math.min(Math.log2(w / (TILE * lonFrac)),
                         Math.log2(h / (TILE * latFrac)));
  const zoom = Math.max(minZoom, Math.min(maxZoom, Math.round(ideal)));
  const world = TILE * 2 ** zoom;
  const sx = mercX(BBOX.lonMax, world) - mercX(BBOX.lonMin, world);
  const sy = mercY(BBOX.latMin, world) - mercY(BBOX.latMax, world);
  const scale = Math.min(w / sx, h / sy);
  return { zoom, world, scale, w, h,
    offX: mercX(BBOX.lonMin, world) - (w / scale - sx) / 2,
    offY: mercY(BBOX.latMax, world) - (h / scale - sy) / 2 };
}
const toPx = (lat, lon, v) => [(mercX(lon, v.world) - v.offX) * v.scale,
                               (mercY(lat, v.world) - v.offY) * v.scale];

const W = 880, H = 412;
const v = fitView(W, H);
console.log(`canvas ${W}x${H} -> tile zoom ${v.zoom}, draw scale ${v.scale.toFixed(3)}`);
{ const sx=(mercX(BBOX.lonMax,v.world)-mercX(BBOX.lonMin,v.world))*v.scale;
  const sy=(mercY(BBOX.latMin,v.world)-mercY(BBOX.latMax,v.world))*v.scale;
  console.log(`india drawn ${sx.toFixed(0)}x${sy.toFixed(0)} = ${(sx/W*100).toFixed(0)}% wide, ${(sy/H*100).toFixed(0)}% tall`); }

const CITIES = {
  Srinagar: [34.08, 74.80], Delhi: [28.61, 77.21], Mumbai: [19.08, 72.88],
  Kolkata: [22.57, 88.36], Chennai: [13.08, 80.27], Kochi: [9.93, 76.27],
  Guwahati: [26.14, 91.74], Jamnagar: [22.47, 70.06],
};
const P = {};
for (const [n, [la, lo]] of Object.entries(CITIES)) {
  const [x, y] = toPx(la, lo, v); P[n] = [x, y];
  console.log(`  ${n.padEnd(10)} x=${x.toFixed(0).padStart(4)} y=${y.toFixed(0).padStart(4)}`);
}

let bad = 0;
const ck = (m, ok) => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${m}`); };
console.log('\norientation:');
ck('Srinagar is above Kochi (north is up)', P.Srinagar[1] < P.Kochi[1]);
ck('Delhi is above Chennai', P.Delhi[1] < P.Chennai[1]);
ck('Jamnagar is left of Kolkata (east is right)', P.Jamnagar[0] < P.Kolkata[0]);
ck('Mumbai is left of Guwahati', P.Mumbai[0] < P.Guwahati[0]);
ck('Kochi is below and left of Kolkata',
   P.Kochi[1] > P.Kolkata[1] && P.Kochi[0] < P.Kolkata[0]);
ck('Delhi is right of Mumbai', P.Delhi[0] > P.Mumbai[0]);
ck('all cities inside the canvas',
   Object.values(P).every(([x, y]) => x >= 0 && x <= W && y >= 0 && y <= H));

console.log('\ntile grid:');
const span = 2 ** v.zoom;
const x0 = Math.floor(v.offX / TILE), x1 = Math.floor((v.offX + W / v.scale) / TILE);
const y0 = Math.floor(v.offY / TILE), y1 = Math.floor((v.offY + H / v.scale) / TILE);
const n = (x1 - x0 + 1) * (y1 - y0 + 1);
console.log(`  x ${x0}..${x1}, y ${y0}..${y1}  -> ${n} tiles`);
ck('tile y rows are inside the pyramid', y0 >= 0 && y1 < span);
ck('tile count is reasonable for one view', n > 0 && n <= 40);

console.log(bad ? `\n${bad} FAILED` : '\nPROJECTION CORRECT — north up, east right');
process.exit(bad ? 1 : 0);
