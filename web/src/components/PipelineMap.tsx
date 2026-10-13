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

/* Colours for the CANVAS, as literals.
 *
 * A canvas cannot resolve CSS custom properties. A fillStyle of
 * 'var(--color-band-low)' is rejected as invalid and the PREVIOUS fillStyle
 * silently stays in force. That is how every marker used to come out the
 * same dark colour as the imagery wash, in both themes, with no error.
 *
 * Fixed across themes on purpose. The ground under them is imagery darkened
 * for contrast whichever theme is active, so the light theme's inks (made
 * for paper) would vanish here. These are tuned to read over dark ground. */
export const MAP_INK = {
  critical: '#ff6b4f',
  elevated: '#f2b33d',
  normal: '#8ec356',
  // Silver, not a hue: hues on this map mean risk, and a coloured line would
  // compete with the markers sitting on it.
  corridor: '#cfd2d8',
  // White, not amber: amber already means "elevated", and with over half the
  // fleet in an HCA an amber ring turned every corridor the alarm colour.
  hca: 'rgba(241, 243, 237, 0.75)',
  casing: 'rgba(8, 10, 12, 0.8)',
} as const;

/** Marker size grows with risk, so severity reads from size as well as hue
 *  (which also keeps it legible for colour-blind readers). */
function markerRadius(risk: number): number {
  return 2 + (risk / 100) * 3.2;
}

function markerColor(band: string): string {
  return band === 'critical' ? MAP_INK.critical
    : band === 'elevated' ? MAP_INK.elevated : MAP_INK.normal;
}

/** A geographic box, for fitting the opening view to a user's scope. */
export interface GeoBox { latMin: number; latMax: number; lonMin: number; lonMax: number }

/** Fractional zoom and centre that fit `b` in a w x h canvas with a margin.
 *  Centred in MERCATOR space, so the box sits visually centred rather than
 *  drifting north, which a plain average of latitudes would do. */
function fitBox(w: number, h: number, b: GeoBox, pad = 0.2): { zoom: number; centre: [number, number] } {
  const lonFrac = Math.max(b.lonMax - b.lonMin, 0.6) / 360;
  const yTop = mercY(b.latMax, 1);
  const yBot = mercY(b.latMin, 1);
  const latFrac = Math.max(yBot - yTop, 0.6 / 360);
  const z = Math.min(Math.log2(w / (TILE * lonFrac)), Math.log2(h / (TILE * latFrac)));
  const k = Math.exp((0.5 - (yTop + yBot) / 2) * 4 * Math.PI);
  const lat = (Math.asin((k - 1) / (k + 1)) * 180) / Math.PI;
  return { zoom: z - Math.log2(1 + 2 * pad), centre: [lat, (b.lonMin + b.lonMax) / 2] };
}

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

/* ======================================================= tile cache ===== */

/* Every tile is tracked through an explicit lifecycle.
 *
 * The first version kept bare Image objects in a map, and judged "the
 * imagery provider is down" from whichever handful of tiles one view change
 * happened to request. Both choices failed in ordinary use:
 *
 *   A tile requested by one view and arriving after the next was discarded,
 *   but its key stayed in the cache, so it was never requested again. A fast
 *   wheel zoom left the map permanently blank while every tile request in
 *   the network log showed 200.
 *
 *   After a zoom step only one or two tiles are new. If those two failed —
 *   a slow upstream response, the dev server restarting under --reload — "all
 *   of this batch failed" was read as "imagery is unavailable", and the map
 *   switched to the vector basemap for the rest of the session.
 *
 * So: tiles are never discarded because the view moved on, failures are
 * retried with backoff, and imagery is only declared down after a run of
 * consecutive failures with no success in between — and it recovers on the
 * first tile that loads. */
type TileState = 'loading' | 'ready' | 'failed';

interface TileEntry {
  img: HTMLImageElement;
  state: TileState;
  attempts: number;
  /** Earliest time a failed tile may be asked for again. */
  retryAt: number;
  /** Present while the bytes are in flight, so a stale request can be cut. */
  ctrl: AbortController | null;
  /** Object URL once the bytes have arrived. Must be revoked on eviction. */
  url: string | null;
}

/** Backoff for a failed tile; the last step repeats indefinitely.
 *
 *  Short at first, so a dev-server restart heals while the user is still
 *  looking at the map. Never abandoned: an earlier version gave up after four
 *  attempts, which turned a thirty-second wifi drop into holes that lasted
 *  the rest of the session. Only ON-SCREEN tiles are retried, so a provider
 *  that is genuinely down costs a view's worth of requests per thirty
 *  seconds, not a flood. */
const RETRY_MS = [1500, 5000, 15000, 30000];

/** Consecutive failures, with no success between them, before the imagery is
 *  reported as interrupted. One view's worth of tiles, roughly. */
const DEGRADED_AFTER = 6;

/** Wheel zoom produces a new view every few milliseconds. Requesting tiles
 *  for each one fetches every intermediate level and buries the tiles the
 *  user finally stops on behind them in the browser's request queue. */
const SETTLE_MS = 140;

/** Held images. Off-screen tiles beyond this are evicted oldest-first. */
const MAX_CACHED_TILES = 360;

/** Tile index range of a view, at any level — not only the view's own. The
 *  painter uses other levels as placeholders while the current one loads. */
function tileRange(v: View, z: number) {
  const f = 2 ** (z - v.zoom);          // level-z tiles per view-level tile
  const span = 2 ** z;
  return {
    f,
    span,
    x0: Math.floor((v.offX * f) / TILE),
    x1: Math.floor(((v.offX + v.w / v.scale) * f) / TILE),
    y0: Math.max(0, Math.floor((v.offY * f) / TILE)),
    y1: Math.min(span - 1, Math.floor(((v.offY + v.h / v.scale) * f) / TILE)),
  };
}

/** Wrap a tile column round the antimeridian rather than asking for a column
 *  that does not exist, which the backend refuses with a 502. */
const wrapX = (tx: number, span: number) => ((tx % span) + span) % span;

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
  /** Where the map opens. A zone-scoped user should land on their zone, not
   *  on a country where all of their work is one smudge. Derived from the
   *  user's SCOPE, which is fixed for the session; never from a filter. */
  focus?: GeoBox | null;
}

function PipelineMapInner({ segments, routes, config, selected, onPick, focus = null }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overRef = useRef<HTMLCanvasElement>(null);

  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<Segment | null>(null);

  // Tiles keyed z/x/y. A ref, not state: entries change as bytes arrive, and
  // re-rendering the tree per tile would be pointless — `tileTick` is the one
  // signal the painter needs.
  const tiles = useRef(new Map<string, TileEntry>());
  const [tileTick, setTileTick] = useState(0);
  const [retryTick, setRetryTick] = useState(0);

  /* Imagery health, for the footer. Derived from a run of CONSECUTIVE
     failures rather than from any one batch, and reset by the first success,
     so a momentary failure cannot switch the basemap off for good. */
  const failStreak = useRef(0);
  const [imagery, setImagery] = useState<'ok' | 'retrying'>('ok');

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const map = tiles.current;
    return () => {
      mounted.current = false;
      // Object URLs must be revoked, or every tile ever fetched stays
      // resident for the life of the document.
      for (const e of map.values()) {
        e.ctrl?.abort();
        if (e.url) URL.revokeObjectURL(e.url);
      }
      map.clear();
    };
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

  /* "Home": the user's scope if they have one, else the whole country. The
     fit button and an untouched camera both resolve to it. */
  const focusFit = useMemo(() => {
    if (!focus || !size.w || !size.h) return null;
    const f = fitBox(size.w, size.h, focus);
    return { zoom: Math.min(Math.max(f.zoom, fitZ), fitZ + MAX_ZOOM_IN), centre: f.centre };
  }, [focus, size.w, size.h, fitZ]);
  const homeZ = focusFit ? focusFit.zoom : fitZ;
  const homeC = focusFit ? focusFit.centre : BBOX_CENTRE;

  const view = useMemo(() => {
    if (!size.w || !size.h) return null;
    const z = cam ? cam.zoom : homeZ;
    const c = cam ? cam.centre : homeC;
    return makeView(size.w, size.h, z, c);
  }, [size.w, size.h, cam, homeZ, homeC]);

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
      const curZ = prev ? prev.zoom : homeZ;
      const curC = prev ? prev.centre : homeC;
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
  }, [size.w, size.h, homeZ, homeC, clampZoom]);

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

  /** Fetch one tile. Its result is kept whatever the view has done since:
   *  a tile is valid for its z/x/y no matter which view asked for it, and
   *  throwing a finished download away is what left the map blank. */
  const requestTile = useCallback((key: string, attempts: number) => {
    const ctrl = new AbortController();
    const entry: TileEntry = {
      img: new Image(), state: 'loading', attempts, retryAt: 0, ctrl, url: null,
    };
    tiles.current.set(key, entry);

    const fail = () => {
      if (!mounted.current || tiles.current.get(key) !== entry) return;
      entry.state = 'failed';
      entry.ctrl = null;
      entry.attempts += 1;
      entry.retryAt = Date.now() + RETRY_MS[Math.min(entry.attempts - 1, RETRY_MS.length - 1)];
      failStreak.current += 1;
      if (failStreak.current >= DEGRADED_AFTER) setImagery('retrying');
      setRetryTick((t) => t + 1);   // let the loader schedule the retry
    };

    // fetch, NOT img.src. The tile route is authenticated and an <img>
    // cannot send an Authorization header — every request came back 401,
    // and the vector fallback quietly covered for it.
    api.mapTile(key, ctrl.signal)
      .then((url) => {
        if (!mounted.current || tiles.current.get(key) !== entry) {
          URL.revokeObjectURL(url);
          return;
        }
        entry.url = url;
        entry.ctrl = null;
        entry.img.onload = () => {
          if (tiles.current.get(key) !== entry) return;
          entry.state = 'ready';
          if (failStreak.current > 0) {
            // The provider is answering again. Every tile that failed during
            // the gap gets a fresh start now, rather than waiting out a
            // backoff that was sized for an outage which has ended.
            for (const e of tiles.current.values()) {
              if (e.state === 'failed') { e.attempts = 0; e.retryAt = 0; }
            }
            setRetryTick((t) => t + 1);
          }
          failStreak.current = 0;
          setImagery('ok');            // no re-render when already 'ok'
          setTileTick((t) => t + 1);
        };
        entry.img.onerror = fail;
        entry.img.src = url;
      })
      .catch(() => {
        // Aborted because the view moved past it: not a failure, and must
        // not count toward declaring the imagery down.
        if (ctrl.signal.aborted) return;
        fail();
      });
  }, []);

  useEffect(() => {
    if (!view || !config?.available) return;
    let retryTimer: number | undefined;

    const settle = window.setTimeout(() => {
      const map = tiles.current;
      const r = tileRange(view, view.zoom);
      const wanted: string[] = [];
      for (let ty = r.y0; ty <= r.y1; ty++) {
        for (let tx = r.x0; tx <= r.x1; tx++) {
          wanted.push(`${view.zoom}/${wrapX(tx, r.span)}/${ty}`);
        }
      }
      const onScreen = new Set(wanted);

      // Cut downloads for tiles no longer on screen. Only ones still on the
      // wire: once the bytes are here, decoding is local and free to finish.
      for (const [key, e] of map) {
        if (e.state === 'loading' && e.url === null && !onScreen.has(key)) {
          e.ctrl?.abort();
          map.delete(key);
        }
      }

      const now = Date.now();
      let nextRetry = Infinity;
      for (const key of wanted) {
        const e = map.get(key);
        if (e && (e.state === 'ready' || e.state === 'loading')) continue;
        if (e && e.state === 'failed' && e.retryAt > now) {
          nextRetry = Math.min(nextRetry, e.retryAt);
          continue;
        }
        requestTile(key, e?.attempts ?? 0);
      }

      // Evict the oldest off-screen tiles once over budget. Map iteration is
      // insertion order, which is a good enough proxy for least recent.
      if (map.size > MAX_CACHED_TILES) {
        for (const [key, e] of map) {
          if (map.size <= MAX_CACHED_TILES) break;
          if (onScreen.has(key) || e.state === 'loading') continue;
          if (e.url) URL.revokeObjectURL(e.url);
          map.delete(key);
        }
      }

      if (nextRetry < Infinity) {
        retryTimer = window.setTimeout(
          () => setRetryTick((t) => t + 1), Math.max(0, nextRetry - now) + 20,
        );
      }
    }, SETTLE_MS);

    return () => {
      window.clearTimeout(settle);
      window.clearTimeout(retryTimer);
    };
  }, [view, config?.available, retryTick, requestTile]);

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

    let drewTile = false;
    if (config?.available) {
      const cache = tiles.current;
      const drawLevel = (z: number) => {
        if (z < MIN_TILE_Z || z > MAX_TILE_Z) return;
        const r = tileRange(view, z);
        const dw = (TILE / r.f) * view.scale;
        for (let ty = r.y0; ty <= r.y1; ty++) {
          for (let tx = r.x0; tx <= r.x1; tx++) {
            const e = cache.get(`${z}/${wrapX(tx, r.span)}/${ty}`);
            if (!e || e.state !== 'ready' || !e.img.naturalWidth) continue;
            g.drawImage(
              e.img,
              ((tx * TILE) / r.f - view.offX) * view.scale,
              ((ty * TILE) / r.f - view.offY) * view.scale,
              // +1 closes the hairline seams sub-pixel scaling leaves between
              // adjacent tiles, which read as a grid drawn over the map.
              dw + 1, dw + 1,
            );
            drewTile = true;
          }
        }
      };

      /* Placeholders from OTHER levels, under the current one.
       *
       * Crossing a zoom level means none of the new level's tiles are
       * loaded yet. Drawing only the current level made every level change
       * fall through to the vector outline for as long as the new tiles took
       * — seconds, on uncached imagery — which read as the satellite map
       * switching itself off. Coarser levels, scaled up, cover the gap
       * blurrily; the next finer level covers it after a zoom-out. Current
       * level last, so sharp tiles replace blurry ones as they arrive. This
       * is what every web map library does, for the same reason. */
      for (let z = MIN_TILE_Z; z < view.zoom; z++) drawLevel(z);
      drawLevel(view.zoom + 1);
      drawLevel(view.zoom);
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
      g.strokeStyle = MAP_INK.casing;
      g.lineWidth = 4.5;
      g.stroke();
      g.strokeStyle = MAP_INK.corridor;
      g.lineWidth = 1.7;
      g.globalAlpha = 0.8;
      g.stroke();
      g.globalAlpha = 1;
    }

    // --- segments -------------------------------------------------------
    /* Detail follows zoom. At country scale thousands of markers overlap
       along each corridor, and halos and rings drawn there do not add
       information, they add colour: the critical halos alone painted whole
       corridors red while 85% of the fleet is normal. So the map at a
       glance must tell the same story as the risk mix. Rings and halos
       appear once the markers have room to separate. */
    const zoomedIn = view.zoom + Math.log2(view.scale) - fitZ >= 1.1;
    const shrink = zoomedIn ? 1 : 0.8;
    for (const p of pts) {
      const r = markerRadius(p.s.risk_score) * shrink;
      const band = p.s.risk_band;
      const ink = markerColor(band);
      if (zoomedIn && band === 'critical') {
        // The alarm state finds the eye first, as the console's lamps do.
        g.beginPath();
        g.arc(p.x, p.y, r + 3.2, 0, Math.PI * 2);
        g.fillStyle = ink;
        g.globalAlpha = 0.2;
        g.fill();
        g.globalAlpha = 1;
      }
      if (zoomedIn && p.s.is_hca) {
        g.beginPath();
        g.arc(p.x, p.y, r + 2, 0, Math.PI * 2);
        g.strokeStyle = MAP_INK.hca;
        g.lineWidth = 0.8;
        g.stroke();
      }
      g.beginPath();
      g.arc(p.x, p.y, r, 0, Math.PI * 2);
      g.fillStyle = ink;
      g.globalAlpha = band === 'normal' ? 0.8 : 1;
      g.fill();
      g.globalAlpha = 1;
      g.lineWidth = 0.8;
      g.strokeStyle = MAP_INK.casing;
      g.stroke();
    }
  }, [view, pts, routes, config?.available, config?.provider, tileTick, fitZ]);

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
      const r = markerRadius(s.risk_score);
      g.beginPath();
      g.arc(x, y, r + 4.5, 0, Math.PI * 2);
      g.strokeStyle = MAP_INK.casing;
      g.lineWidth = width + 2;
      g.stroke();
      g.strokeStyle = ring;
      g.lineWidth = width;
      g.stroke();
      g.beginPath();
      g.arc(x, y, r + 0.5, 0, Math.PI * 2);
      g.fillStyle = markerColor(s.risk_band);
      g.fill();
    };

    const sel = selected ? segments.find((s) => s.segment_id === selected) : null;
    if (sel) mark(sel, '#ffffff', 2);
    if (hover && hover.segment_id !== selected) mark(hover, MAP_INK.corridor, 1.6);
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
        const start = makeView(view.w, view.h, cam ? cam.zoom : homeZ, d.centre);
        const centre = toLatLon(view.w / 2 - dx, view.h / 2 - dy, start);
        setCam({ zoom: cam ? cam.zoom : homeZ, centre });
        return;
      }
      const found = hitTest(ev);
      setHover((prev) => (prev?.segment_id === found?.segment_id ? prev : found));
    },
    [hitTest, view, cam, homeZ],
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
                  disabled={!!view && (cam ? cam.zoom : homeZ) >= fitZ + MAX_ZOOM_IN - 0.01}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </MapBtn>
          <MapBtn label="Zoom out" onClick={() => zoomAbout(-0.7)}
                  disabled={(cam ? cam.zoom : homeZ) <= fitZ - 0.34}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
              <path d="M5 12h14" />
            </svg>
          </MapBtn>
          <MapBtn label={focus ? 'Fit to my zone' : 'Fit to India'} onClick={resetView}
                  disabled={!cam}>
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

        {/* Legend, on the map rather than under it: the key belongs next to
            the thing it decodes. A dark glass chip in every theme, because
            it sits on darkened imagery in every theme. */}
        <div className="map-legend pointer-events-none absolute bottom-2 left-2 flex
                        items-center gap-3 px-2.5 py-1.5">
          {([
            ['Critical', MAP_INK.critical],
            ['Elevated', MAP_INK.elevated],
            ['Normal', MAP_INK.normal],
          ] as const).map(([label, ink]) => (
            <span key={label} className="flex items-center gap-1.5">
              <span className="inline-block h-[8px] w-[8px] rounded-full"
                    style={{ background: ink, boxShadow: `0 0 0 1px ${MAP_INK.casing}` }} />
              <span className="map-legend-text">{label}</span>
            </span>
          ))}
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-[10px] w-[10px] rounded-full"
                  style={{ border: `1.5px solid ${MAP_INK.hca}` }} />
            <span className="map-legend-text">HCA</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-[2px] w-[14px]"
                  style={{ background: MAP_INK.corridor }} />
            <span className="map-legend-text">Corridor</span>
          </span>
        </div>
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
              {/* Says what is actually happening. "Interrupted" rather than
                  "unavailable": after a dev-server restart it heals within
                  seconds, and the reader should not go hunting for a
                  configuration problem that does not exist. */}
              {!config?.available
                ? 'vector basemap'
                : imagery === 'retrying'
                  ? 'imagery interrupted · retrying'
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
