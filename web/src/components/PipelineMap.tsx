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
 * TILES
 *
 *   Fetched from this origin (/api/map/tile/...), which the backend relays
 *   to Geoapify or OSM. The key stays server-side and the CSP keeps
 *   img-src 'self'. If tiles fail the vector outline underneath is drawn
 *   instead, so the panel is never an empty grey box.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { LAND } from '../lib/basemap';
import type { MapConfig, PipelineRoute, Segment } from '../lib/types';
import { BAND_COLOR, toBand } from './fleet';

/* ========================================================== projection == */

/* The Indian landmass with a margin. Fixed, never derived from the data:
 * bounds that follow the filter make the country change shape as you click,
 * which is the single worst thing a map can do. */
const BBOX = { lonMin: 67.0, lonMax: 98.5, latMin: 6.0, latMax: 36.8 };

const TILE = 256;

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

/** Fit the bbox to the canvas.
 *
 *  Snapping to an integer zoom, which is the obvious implementation, wastes
 *  most of the panel: India is nearly square in Mercator, so in a wide slot
 *  the largest level that still fits vertically leaves it filling about 40%
 *  of the width. Real map libraries avoid this with fractional zoom —
 *  tiles are fetched at the nearest integer level and drawn scaled — and
 *  that is what `scale` is. It keeps tiles close to native resolution while
 *  the drawing fills the box exactly. */
function fitView(w: number, h: number, minZoom: number, maxZoom: number): View {
  const lonFrac = (BBOX.lonMax - BBOX.lonMin) / 360;
  const latFrac = mercY(BBOX.latMin, 1) - mercY(BBOX.latMax, 1);
  const ideal = Math.min(
    Math.log2(w / (TILE * lonFrac)),
    Math.log2(h / (TILE * latFrac)),
  );
  const zoom = Math.max(minZoom, Math.min(maxZoom, Math.round(ideal)));

  const world = TILE * 2 ** zoom;
  const sx = mercX(BBOX.lonMax, world) - mercX(BBOX.lonMin, world);
  const sy = mercY(BBOX.latMin, world) - mercY(BBOX.latMax, world);
  const scale = Math.min(w / sx, h / sy);

  return {
    zoom,
    world,
    scale,
    // Centre the bbox: offsets are in world px, so the canvas covers
    // w/scale of them.
    offX: mercX(BBOX.lonMin, world) - (w / scale - sx) / 2,
    offY: mercY(BBOX.latMax, world) - (h / scale - sy) / 2,
    w,
    h,
  };
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

  const view = useMemo(
    () => (size.w && size.h
      ? fitView(size.w, size.h, config?.min_zoom ?? 3, config?.max_zoom ?? 10)
      : null),
    [size.w, size.h, config?.min_zoom, config?.max_zoom],
  );

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

    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (ty < 0 || ty >= span) continue;
        const wx = ((tx % span) + span) % span;   // wrap, so no 502 at the edge
        const key = `${zoom}/${wx}/${ty}`;
        if (tileCache.current.has(key)) continue;
        requested += 1;
        const img = new Image();
        tileCache.current.set(key, img);
        img.onload = () => { if (!cancelled) setTileTick((t) => t + 1); };
        img.onerror = () => {
          tileCache.current.delete(key);
          failures += 1;
          // One dead tile is a gap; all of them means the provider is not
          // working and the vector outline is the honest fallback.
          if (!cancelled && requested > 0 && failures >= requested) {
            setTilesFailed(true);
          }
        };
        img.src = `/api/map/tile/${zoom}/${wx}/${ty}.png`;
      }
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

  const onMove = useCallback(
    (ev: React.MouseEvent<HTMLCanvasElement>) => {
      const found = hitTest(ev);
      setHover((prev) => (prev?.segment_id === found?.segment_id ? prev : found));
    },
    [hitTest],
  );

  const onClick = useCallback(
    (ev: React.MouseEvent<HTMLCanvasElement>) => {
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
          className="absolute inset-0 h-full w-full cursor-crosshair"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
          onClick={onClick}
          role="img"
          aria-label={`${pts.length} pipeline segments on ${routes.length} corridors across India`}
        />
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
              marker size is risk · ring marks an HCA
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
