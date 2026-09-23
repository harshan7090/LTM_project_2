/* The fleet map.
 *
 * WHY THE DASHBOARD WAS LAGGING
 *
 *   This component was the cause, not the table. It emitted one <circle>
 *   per segment plus a ring for every HCA — about 7,700 SVG nodes — and
 *   React diffed all of them on every render of the parent. Selecting a
 *   row, hovering a matrix cell or typing in the filter re-reconciled the
 *   entire map. On a 5,000-segment fleet that is tens of milliseconds of
 *   main-thread work per keystroke, which is exactly what scrolling felt
 *   like.
 *
 *   It is now two canvases and no per-segment DOM at all:
 *
 *     base     tiles, corridors and all 5,000 points. Repainted only when
 *              the data, the size or the tiles change.
 *     overlay  the hover and selection marks. Repainted on pointer move,
 *              and it draws two shapes.
 *
 *   Hover testing uses a coarse spatial grid rather than a scan of 5,000
 *   points, so pointer move stays O(a handful).
 *
 * PROJECTION
 *
 *   Web Mercator, because that is what raster tiles are cut in. Anything
 *   else and the corridors would slide off the coastline. The previous
 *   version scaled points to the bounding box of whatever was filtered,
 *   which is not a projection at all — the country changed shape as you
 *   clicked around.
 *
 * TILES, AND WHY THEY WERE ALL FAILING
 *
 *   Tiles come from this origin (/api/map/tile/...), which the backend
 *   relays upstream with the API key attached, so the key never reaches the
 *   browser and the CSP keeps img-src 'self'.
 *
 *   That route requires a bearer token — and an <img src> cannot send one.
 *   Every tile returned 401, the fallback dutifully drew the vector
 *   outline, and the map looked like it was working as designed. The
 *   fallback was hiding the bug.
 *
 *   So tiles are fetched with `fetch` (which CAN carry the header) and
 *   handed to an Image as an object URL. Those URLs are revoked on unmount;
 *   a tile cache of un-revoked blobs is a memory leak that only shows up
 *   after a long session.
 *
 * ZOOM
 *
 *   The view is no longer a fixed fit. Wheel, buttons and drag change zoom
 *   and centre, and `fit()` returns to the whole country. Wheel zoom only
 *   acts when the pointer is over the canvas and calls preventDefault
 *   there, so the page still scrolls normally everywhere else.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '../lib/api';
import { LAND } from '../lib/basemap';
import type { MapConfig, PipelineRoute, Segment } from '../lib/types';
import { BAND_COLOR, toBand } from './fleet';
import { cx } from './ui';

/* ========================================================== projection == */

/* The Indian landmass with a margin. Fixed, never derived from the data:
 * bounds that follow the filter make the country change shape as you click,
 * which is the single worst thing a map can do. */
const BBOX = { lonMin: 67.0, lonMax: 98.5, latMin: 6.0, latMax: 36.8 };

const TILE = 256;

/* Matches the backend's tile pyramid guard. Asking for a level it refuses
   just produces a 502 per tile and an empty map. */
const MIN_TILE_Z = 3;
const MAX_TILE_Z = 10;

/* How far the user may zoom, as fractional levels beyond the country fit.
   Capped because past this the segments are the same dots further apart. */
const MAX_ZOOM_IN = 4.5;

/* Geographic centre of the view box, used as the default camera target. */
const BBOX_CENTRE: [number, number] = [
  (BBOX.latMin + BBOX.latMax) / 2,
  (BBOX.lonMin + BBOX.lonMax) / 2,
];

function mercX(lon: number, world: number): number {
  return ((lon + 180) / 360) * world;
}
function mercY(lat: number, world: number): number {
  const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world;
}

interface View {
  zoom: number;   // integer, the level tiles are fetched at
  world: number;  // world pixels at that level
  scale: number;  // continuous zoom on top of it
  offX: number;   // world x at the canvas's left edge
  offY: number;
  w: number;
  h: number;
}

/** The whole-country fractional zoom that exactly fills the canvas. */
function fitZoom(w: number, h: number): number {
  const lonFrac = (BBOX.lonMax - BBOX.lonMin) / 360;
  const latFrac = mercY(BBOX.latMin, 1) - mercY(BBOX.latMax, 1);
  return Math.min(
    Math.log2(w / (TILE * lonFrac)),
    Math.log2(h / (TILE * latFrac)),
  );
}

/** Build a view from a FRACTIONAL zoom and a geographic centre.
 *
 *  Zoom is fractional on purpose. Snapping to integers is the obvious
 *  implementation and wastes most of the panel — India is nearly square in
 *  Mercator, so in a wide slot the largest integer level that still fits
 *  vertically leaves it filling about 40% of the width. Real map libraries
 *  solve this the same way: fetch tiles at the nearest INTEGER level and
 *  draw them scaled by the fractional remainder, which keeps tiles close to
 *  native resolution while the drawing fills the box exactly. */
function makeView(
  w: number, h: number, fracZoom: number, centre: [number, number],
): View {
  const zoom = Math.max(MIN_TILE_Z, Math.min(MAX_TILE_Z, Math.round(fracZoom)));
  const world = TILE * 2 ** zoom;
  const scale = 2 ** (fracZoom - zoom);

  // World-pixel coordinate of the canvas's top-left corner.
  const cx = mercX(centre[1], world);
  const cy = mercY(centre[0], world);
  return {
    zoom, world, scale,
    offX: cx - w / scale / 2,
    offY: cy - h / scale / 2,
    w, h,
  };
}

/** Canvas pixel back to [lat, lon] — needed so a wheel zoom can keep the
 *  point under the cursor fixed, which is what makes zooming feel anchored
 *  rather than like the map jumping. */
function toLatLon(px: number, py: number, v: View): [number, number] {
  const wx = v.offX + px / v.scale;
  const wy = v.offY + py / v.scale;
  const lon = (wx / v.world) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * wy) / v.world;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return [lat, lon];
}

function toPx(lat: number, lon: number, v: View): [number, number] {
  return [
    (mercX(lon, v.world) - v.offX) * v.scale,
    (mercY(lat, v.world) - v.offY) * v.scale,
  ];
}

/* ====================================================== hover index ===== */

const CELL = 24; // px

/** A coarse bucket grid. Scanning 5,000 points on every pointer move is
 *  what makes a canvas map feel worse than the SVG one it replaced. */
function buildIndex(pts: { s: Segment; x: number; y: number }[], w: number, h: number) {
  const cols = Math.max(1, Math.ceil(w / CELL));
  const rows = Math.max(1, Math.ceil(h / CELL));
  const buckets: number[][] = Array.from({ length: cols * rows }, () => []);
  pts.forEach((p, i) => {
    const cx = Math.min(cols - 1, Math.max(0, Math.floor(p.x / CELL)));
    const cy = Math.min(rows - 1, Math.max(0, Math.floor(p.y / CELL)));
    buckets[cy * cols + cx].push(i);
  });
  return { buckets, cols, rows };
}

/* =========================================================== component == */

interface Props {
  segments: Segment[];
  routes: PipelineRoute[];
  config: MapConfig | null;
  selected: string | null;
  onPick: (id: string) => void;
}

function PipelineMapInner({ segments, routes, config, selected, onPick }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overRef = useRef<HTMLCanvasElement>(null);

  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<Segment | null>(null);
  const [tilesFailed, setTilesFailed] = useState(false);

  // Loaded tile images, keyed z/x/y. Kept in a ref: this changes as images
  // arrive and must not re-render the tree each time.
  const tileCache = useRef(new Map<string, HTMLImageElement>());
  const [tileTick, setTileTick] = useState(0);

  /* Object URLs behind those images. They must be revoked, or every tile
     ever fetched stays resident for the life of the document — a leak that
     only shows up after a long session with a lot of panning. */
  const blobUrls = useRef(new Set<string>());
  useEffect(() => () => {
    blobUrls.current.forEach((u) => URL.revokeObjectURL(u));
    blobUrls.current.clear();
  }, []);

  /* --------------------------------------------------------- sizing --- */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* The camera. `null` zoom means "not yet positioned" — it resolves to the
     whole-country fit as soon as the panel has a size, and after that the
     user owns it. Storing the fit itself would mean a resize silently
     throwing away wherever they had panned to. */
  const [cam, setCam] = useState<{ zoom: number; centre: [number, number] } | null>(null);

  const fitZ = useMemo(
    () => (size.w && size.h ? fitZoom(size.w, size.h) : 0),
    [size.w, size.h],
  );

  const view = useMemo(() => {
    if (!size.w || !size.h) return null;
    const z = cam ? cam.zoom : fitZ;
    const c = cam ? cam.centre : BBOX_CENTRE;
    return makeView(size.w, size.h, z, c);
  }, [size.w, size.h, cam, fitZ]);

  /* ---------------------------------------------------------- zooming -- */
  const clampZoom = useCallback(
    (z: number) => Math.max(fitZ - 0.35, Math.min(fitZ + MAX_ZOOM_IN, z)),
    [fitZ],
  );

  /** Zoom about a canvas point, keeping whatever is under it fixed. Zooming
   *  about the centre instead makes the map lurch away from what the user
   *  was aiming at. */
  const zoomAbout = useCallback((delta: number, px?: number, py?: number) => {
    setCam((prev) => {
      if (!size.w || !size.h) return prev;
      const curZ = prev ? prev.zoom : fitZ;
      const curC = prev ? prev.centre : BBOX_CENTRE;
      const nextZ = clampZoom(curZ + delta);
      if (nextZ === curZ) return prev;
      if (px === undefined || py === undefined) {
        return { zoom: nextZ, centre: curC };
      }
      const before = makeView(size.w, size.h, curZ, curC);
      const anchor = toLatLon(px, py, before);
      const after = makeView(size.w, size.h, nextZ, curC);
      const moved = toLatLon(px, py, after);
      return {
        zoom: nextZ,
        centre: [
          curC[0] + (anchor[0] - moved[0]),
          curC[1] + (anchor[1] - moved[1]),
        ],
      };
    });
  }, [size.w, size.h, fitZ, clampZoom]);

  const resetView = useCallback(() => setCam(null), []);

  /* Wheel zoom, attached natively so it can be non-passive. React's onWheel
     is passive in modern browsers, so preventDefault there is ignored and
     the page scrolls behind the map. */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAbout(-e.deltaY * 0.0022, e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAbout]);

  /* ---------------------------------------------------------- panning -- */
  const drag = useRef<{ x: number; y: number; centre: [number, number] } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!view) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      x: e.clientX, y: e.clientY,
      centre: cam ? cam.centre : BBOX_CENTRE,
    };
    setDragging(true);
  }, [view, cam]);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    drag.current = null;
    setDragging(false);
  }, []);

  /* ---------------------------------------------------- projected pts -- */
  const pts = useMemo(() => {
    if (!view) return [];
    const out = segments
      .filter((s) => s.latitude != null && s.longitude != null)
      .map((s) => {
        const [x, y] = toPx(s.latitude as number, s.longitude as number, view);
        return { s, x, y };
      });
    // Highest risk painted last, so a critical segment is never buried
    // under the benign ones around it.
    out.sort((a, b) => a.s.risk_score - b.s.risk_score);
    return out;
  }, [segments, view]);

  const index = useMemo(
    () => (view ? buildIndex(pts, view.w, view.h) : null),
    [pts, view],
  );

  /* ------------------------------------------------------ tile loading -- */
  useEffect(() => {
    if (!view || !config?.available || tilesFailed) return;
    const { zoom, scale, offX, offY, w, h } = view;
    const span = 2 ** zoom;
    const x0 = Math.floor(offX / TILE);
    const x1 = Math.floor((offX + w / scale) / TILE);
    const y0 = Math.floor(offY / TILE);
    const y1 = Math.floor((offY + h / scale) / TILE);

    let cancelled = false;
    let failures = 0;
    let requested = 0;

    const wanted: string[] = [];
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (ty < 0 || ty >= span) continue;
        const wx = ((tx % span) + span) % span;   // wrap, so no 502 at the edge
        const key = `${zoom}/${wx}/${ty}`;
        if (tileCache.current.has(key)) continue;
        wanted.push(key);
      }
    }

    for (const key of wanted) {
      requested += 1;
      const img = new Image();
      tileCache.current.set(key, img);

      // fetch, NOT img.src. The tile route is authenticated and an <img>
      // cannot send an Authorization header — every request came back 401,
      // and the vector fallback quietly covered for it.
      api.mapTile(key)
        .then((url) => {
          if (cancelled) { URL.revokeObjectURL(url); return; }
          blobUrls.current.add(url);
          img.onload = () => { if (!cancelled) setTileTick((t) => t + 1); };
          img.src = url;
        })
        .catch(() => {
          tileCache.current.delete(key);
          failures += 1;
          // One dead tile is a gap. All of them means the provider is not
          // working, and the vector outline is the honest answer.
          if (!cancelled && requested > 0 && failures >= requested) {
            setTilesFailed(true);
          }
        });
    }
    return () => { cancelled = true; };
  }, [view, config?.available, tilesFailed]);

  /* --------------------------------------------------------- base paint - */
  useEffect(() => {
    const cv = baseRef.current;
    if (!cv || !view) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(view.w * dpr);
    cv.height = Math.round(view.h * dpr);
    const g = cv.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, view.w, view.h);

    const css = getComputedStyle(document.documentElement);
    const tok = (n: string, f: string) => css.getPropertyValue(n).trim() || f;

    // --- ground -------------------------------------------------------
    g.fillStyle = tok('--color-bg', '#0d1013');
    g.fillRect(0, 0, view.w, view.h);

    const showTiles = config?.available && !tilesFailed;
    let drewTile = false;
    if (showTiles) {
      const span = 2 ** view.zoom;
      const x0 = Math.floor(view.offX / TILE);
      const x1 = Math.floor((view.offX + view.w / view.scale) / TILE);
      const y0 = Math.floor(view.offY / TILE);
      const y1 = Math.floor((view.offY + view.h / view.scale) / TILE);
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          if (ty < 0 || ty >= span) continue;
          const wx = ((tx % span) + span) % span;
          const img = tileCache.current.get(`${view.zoom}/${wx}/${ty}`);
          if (!img || !img.complete || !img.naturalWidth) continue;
          const dw = TILE * view.scale;
          g.drawImage(
            img,
            (tx * TILE - view.offX) * view.scale,
            (ty * TILE - view.offY) * view.scale,
            // +1 closes the hairline seams sub-pixel scaling leaves between
            // adjacent tiles, which read as a grid drawn over the map.
            dw + 1, dw + 1,
          );
          drewTile = true;
        }
      }
      /* Knock the basemap back so the segments read on top of it. The
         amount depends on WHAT the basemap is: photographic imagery is far
         busier than a vector basemap - every field boundary and cloud is
         competing detail - so it needs noticeably more. A single fixed
         value either washes out the vector styles or loses the data on
         satellite. */
      if (drewTile) {
        const photographic = config?.provider === 'satellite';
        g.fillStyle = photographic ? 'rgba(8,11,10,0.60)' : 'rgba(8,11,10,0.44)';
        g.fillRect(0, 0, view.w, view.h);
      }
    }

    // --- vector fallback ----------------------------------------------
    if (!drewTile) {
      for (const land of LAND) {
        g.beginPath();
        for (const ring of land.r) {
          for (let i = 0; i < ring.length; i += 2) {
            const [x, y] = toPx(ring[i + 1], ring[i], view);
            if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
          }
          g.closePath();
        }
        g.fillStyle = land.self
          ? tok('--color-raised', '#1b2026')
          : tok('--color-panel', '#14181d');
        g.globalAlpha = land.self ? 0.92 : 0.5;
        g.fill();
        g.globalAlpha = 1;
        g.strokeStyle = tok('--color-line', '#252c34');
        g.lineWidth = 0.9;
        g.stroke();
      }
    }

    // --- corridors, under the segments that sit on them ----------------
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (const r of routes) {
      g.beginPath();
      r.path.forEach(([lat, lon], i) => {
        const [x, y] = toPx(lat, lon, view);
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      });
      // A dark casing first, so the line reads over bright satellite ground.
      g.strokeStyle = 'rgba(8,10,12,0.72)';
      g.lineWidth = 4.5;
      g.stroke();
      g.strokeStyle = tok('--color-accent', '#f5a524');
      g.lineWidth = 1.7;
      g.globalAlpha = 0.85;
      g.stroke();
      g.globalAlpha = 1;
    }

    // --- segments -------------------------------------------------------
    const ringColor = tok('--color-accent', '#f5a524');
    for (const p of pts) {
      const r = 1.5 + (p.s.risk_score / 100) * 2.9;
      if (p.s.is_hca) {
        g.beginPath();
        g.arc(p.x, p.y, r + 2.1, 0, Math.PI * 2);
        g.strokeStyle = ringColor;
        g.globalAlpha = 0.4;
        g.lineWidth = 0.8;
        g.stroke();
        g.globalAlpha = 1;
      }
      g.beginPath();
      g.arc(p.x, p.y, r, 0, Math.PI * 2);
      g.fillStyle = BAND_COLOR[toBand(p.s.risk_band)];
      g.globalAlpha = 0.9;
      g.fill();
      g.globalAlpha = 1;
      g.lineWidth = 0.6;
      g.strokeStyle = 'rgba(8,10,12,0.85)';
      g.stroke();
    }
  }, [view, pts, routes, config?.available, tilesFailed, tileTick]);

  /* ------------------------------------------------------ overlay paint - */
  useEffect(() => {
    const cv = overRef.current;
    if (!cv || !view) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(view.w * dpr);
    cv.height = Math.round(view.h * dpr);
    const g = cv.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, view.w, view.h);

    const mark = (s: Segment, ring: string, width: number) => {
      if (s.latitude == null || s.longitude == null) return;
      const [x, y] = toPx(s.latitude, s.longitude, view);
      const r = 1.5 + (s.risk_score / 100) * 2.9;
      g.beginPath();
      g.arc(x, y, r + 4.5, 0, Math.PI * 2);
      g.strokeStyle = ring;
      g.lineWidth = width;
      g.stroke();
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fillStyle = BAND_COLOR[toBand(s.risk_band)];
      g.fill();
    };

    const sel = selected ? segments.find((s) => s.segment_id === selected) : null;
    if (sel) mark(sel, '#e8e6e1', 2);
    if (hover && hover.segment_id !== selected) mark(hover, '#f5a524', 1.6);
  }, [hover, selected, segments, view]);

  /* ------------------------------------------------------------ pointer - */
  const hitTest = useCallback(
    (ev: React.MouseEvent<HTMLCanvasElement>) => {
      if (!view || !index) return null;
      const rect = ev.currentTarget.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      const cx = Math.floor(mx / CELL);
      const cy = Math.floor(my / CELL);
      let best: { s: Segment; d: number } | null = null;
      // The point may be in a neighbouring bucket, so sweep 3x3.
      for (let j = cy - 1; j <= cy + 1; j++) {
        for (let i = cx - 1; i <= cx + 1; i++) {
          if (i < 0 || j < 0 || i >= index.cols || j >= index.rows) continue;
          for (const k of index.buckets[j * index.cols + i]) {
            const p = pts[k];
            const d = Math.hypot(p.x - mx, p.y - my);
            if (d <= 7 && (!best || d < best.d)) best = { s: p.s, d };
          }
        }
      }
      return best ? best.s : null;
    },
    [view, index, pts],
  );

  const moved = useRef(0);

  const onMove = useCallback(
    (ev: React.MouseEvent<HTMLCanvasElement>) => {
      const d = drag.current;
      if (d && view) {
        // Pan in GEOGRAPHIC space, from the centre the drag started at, so
        // the map cannot creep from accumulated rounding over a long drag.
        const dx = ev.clientX - d.x;
        const dy = ev.clientY - d.y;
        moved.current = Math.max(moved.current, Math.hypot(dx, dy));
        // The content follows the pointer, so the point that should end up
        // at the centre is the one currently (dx, dy) BEHIND it. Measured
        // from the view the drag started in, so a long drag cannot creep
        // from accumulated rounding.
        const start = makeView(view.w, view.h, cam ? cam.zoom : fitZ, d.centre);
        const centre = toLatLon(view.w / 2 - dx, view.h / 2 - dy, start);
        setCam({ zoom: cam ? cam.zoom : fitZ, centre });
        return;
      }
      const found = hitTest(ev);
      setHover((prev) => (prev?.segment_id === found?.segment_id ? prev : found));
    },
    [hitTest, view, cam, fitZ],
  );

  const onClick = useCallback(
    (ev: React.MouseEvent<HTMLCanvasElement>) => {
      // A drag ends in a click event. Selecting a segment because the user
      // finished panning over one would be maddening.
      if (moved.current > 4) { moved.current = 0; return; }
      moved.current = 0;
      const found = hitTest(ev);
      if (found) onPick(found.segment_id);
    },
    [hitTest, onPick],
  );

  /* -------------------------------------------------------------- render */
  return (
    <div>
      <div
        ref={wrapRef}
        className="relative w-full"
        style={{ height: 412 }}
      >
        <canvas ref={baseRef} className="absolute inset-0 h-full w-full" />
        <canvas
          ref={overRef}
          className={cx('absolute inset-0 h-full w-full',
                        dragging ? 'cursor-grabbing' : 'cursor-crosshair')}
          onMouseMove={onMove}
          onMouseLeave={() => { setHover(null); }}
          onClick={onClick}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          role="img"
          aria-label={`${pts.length} pipeline segments on ${routes.length} corridors across India`}
        />

        {/* Zoom controls. Buttons as well as the wheel, because a wheel is
            not available to a keyboard user and is awkward on a trackpad
            over a scrolling page. */}
        <div className="absolute right-2 top-2 flex flex-col border border-line-soft
                        bg-panel/92">
          <MapBtn label="Zoom in" onClick={() => zoomAbout(0.7)}
                  disabled={!!view && cam !== null && cam.zoom >= fitZ + MAX_ZOOM_IN - 0.01}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </MapBtn>
          <MapBtn label="Zoom out" onClick={() => zoomAbout(-0.7)}
                  disabled={!cam || cam.zoom <= fitZ - 0.34}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
              <path d="M5 12h14" />
            </svg>
          </MapBtn>
          <MapBtn label="Fit to India" onClick={resetView} disabled={!cam}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
            </svg>
          </MapBtn>
        </div>

        {cam && (
          <div className="pointer-events-none absolute left-2 top-2 border
                          border-line-soft bg-panel/92 px-2 py-[3px]">
            <span className="num text-[10px] text-dim">
              z{(cam.zoom - fitZ + 1).toFixed(1)}×
            </span>
          </div>
        )}
      </div>

      {/* Readout pinned below rather than following the cursor: a floating
          tooltip over a dense scatter covers the neighbours you are trying
          to compare against. */}
      <div className="mt-1 flex items-center gap-3 border border-line-soft
                      bg-panel px-2.5 py-1.5 text-[11px]">
        {hover ? (
          <>
            <span className="num text-ink">{hover.segment_id}</span>
            <span className="text-muted">{hover.region}</span>
            {hover.is_hca && (
              <span className="label border border-accent/50 px-1 text-accent"
                    style={{ fontSize: 8 }}>HCA</span>
            )}
            <div className="flex-1" />
            <span className="num text-muted">{hover.predicted_rate_mpy.toFixed(2)} mpy</span>
            <span className="num font-semibold"
                  style={{ color: BAND_COLOR[toBand(hover.risk_band)] }}>
              risk {hover.risk_score.toFixed(0)}
            </span>
          </>
        ) : (
          <>
            <span className="text-dim">
              {pts.length.toLocaleString()} segments · {routes.length} corridors ·
              scroll to zoom, drag to pan
            </span>
            <div className="flex-1" />
            <span className="text-dim" style={{ fontSize: 9.5 }}>
              {tilesFailed || !config?.available
                ? 'vector basemap'
                : config.attribution}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

/* Memoised. The dashboard re-renders on every keystroke in the filter and
 * on every hover in the risk matrix; without this the map would repaint
 * with it, which is the lag this component was rewritten to remove. */
export const PipelineMap = memo(PipelineMapInner);

/** A control on the map surface. Square, 26px, with a real title so the
 *  icon is not the only affordance. */
function MapBtn({
  label, onClick, disabled, children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="grid h-[26px] w-[26px] place-items-center border-b border-line-soft
                 text-muted transition-colors last:border-b-0
                 hover:bg-raised hover:text-accent
                 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent
                 disabled:hover:text-muted"
    >
      {children}
    </button>
  );
}
