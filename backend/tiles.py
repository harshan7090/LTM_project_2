"""
Raster map tiles, relayed through the backend.

WHY RELAY RATHER THAN LET THE BROWSER FETCH

  Two reasons, and the second is the one that decided it.

  1. The console sends `img-src 'self'`. Pointing an <img> at a tile host
     means adding that host to the CSP — a real widening of it, for
     something the server can fetch just as easily.

  2. The API key. A tile URL the browser builds carries the key in it, in
     plain sight in devtools and in any shared screenshot. Geoapify's model
     expects a referrer-restricted client key, but this project's rule is
     that keys do not reach the browser, and there is no reason to make an
     exception for this one.

  So the browser asks this origin for /api/map/tile/{z}/{x}/{y}.png, and
  the server fetches upstream with the key attached.

ON REACHABILITY

  `curl` cannot reach Geoapify from this machine and `requests` can, which
  looks absurd until you remember the TLS-intercepting proxy: curl uses its
  own CA bundle, and src/net_trust puts the OS trust store in front of
  Python's. Do not conclude a host is unreachable from a curl result.

CACHING

  Tiles are immutable for practical purposes, so a small in-process LRU
  keeps the fleet map from re-fetching the same dozen tiles every time
  someone reloads the dashboard. It is bounded — an unbounded tile cache is
  a memory leak with a plausible excuse.
"""
from __future__ import annotations

import collections
import threading

import requests

from config.settings import settings

# The console shows one country at a time; beyond this there is nothing to
# see but the same segments larger, and each extra level quadruples the
# tiles a pan can demand.
MIN_ZOOM = 3
MAX_ZOOM = 10

# ~8 MB at a typical 25 KB per tile. Enough for several full views at a
# couple of zoom levels, small enough to be irrelevant to the process.
CACHE_MAX_TILES = 320

TIMEOUT_S = 15

_cache: collections.OrderedDict[str, tuple[bytes, str]] = collections.OrderedDict()
_lock = threading.Lock()

# A browser-ish UA is a condition of the OSM tile usage policy, and the
# project is identified so the traffic is attributable.
_HEADERS = {"User-Agent": "Corvex-Integrity-Console/1.0 (student project)"}


class TileError(RuntimeError):
    """Upstream could not supply the tile."""


# Geoapify's raster tile API serves VECTOR-DERIVED basemaps only. There is
# no satellite style on it - asking for one returns a 400 listing these as
# the alternatives. Kept here so a bad MAP_STYLE fails with a useful message
# instead of an opaque upstream 400.
GEOAPIFY_STYLES = frozenset({
    "osm-carto", "carto", "dark-matter", "klokantech-basic", "osm-bright",
    "toner", "toner-grey", "osm-liberty", "maptiler-3d", "positron",
    "dark-matter-brown", "dark-matter-dark-grey", "dark-matter-dark-purple",
    "dark-matter-purple-roads", "dark-matter-yellow-roads", "osm-bright-grey",
    "osm-bright-smooth", "positron-blue", "positron-red", "vector",
})

DEFAULT_GEOAPIFY_STYLE = "dark-matter-brown"


def provider() -> str:
    """Which upstream is in play, after resolving 'auto'."""
    configured = (settings.MAP_PROVIDER or "auto").lower()
    if configured != "auto":
        return configured
    # Satellite needs no key and is what an operations map usually wants, so
    # it leads. Geoapify only wins 'auto' when a key is present AND the
    # configured style is one it actually serves.
    if settings.GEOAPIFY_API_KEY and style() in GEOAPIFY_STYLES:
        return "geoapify"
    return "satellite"


def available() -> bool:
    return provider() in ("geoapify", "osm", "satellite")


def attribution() -> str:
    p = provider()
    if p == "geoapify":
        return "© Geoapify · © OpenStreetMap contributors"
    if p == "satellite":
        # Esri's terms require the source to be shown wherever the imagery is.
        return "Imagery © Esri, Maxar, Earthstar Geographics"
    return "© OpenStreetMap contributors"


def style() -> str:
    return (settings.MAP_STYLE or "").strip().lower() or "satellite"


def _upstream_url(z: int, x: int, y: int) -> str:
    p = provider()

    if p == "satellite":
        # Esri World Imagery. Free, keyless, and genuinely photographic -
        # which Geoapify's raster endpoint cannot supply at any price.
        # NOTE the axis order: Esri's path is /{z}/{row}/{col}, so y comes
        # before x. Swapping them silently returns a tile from the wrong
        # place rather than an error, which is the worst kind of bug.
        return (
            "https://server.arcgisonline.com/ArcGIS/rest/services/"
            f"World_Imagery/MapServer/tile/{z}/{y}/{x}"
        )

    if p == "geoapify":
        key = settings.GEOAPIFY_API_KEY
        if not key:
            raise TileError(
                "MAP_PROVIDER is geoapify but GEOAPIFY_API_KEY is empty. "
                "Add a free key from https://myprojects.geoapify.com/ to .env, "
                "or set MAP_PROVIDER=satellite."
            )
        st = style()
        if st not in GEOAPIFY_STYLES:
            raise TileError(
                f"MAP_STYLE '{st}' is not a Geoapify raster style. Geoapify "
                "serves vector-derived basemaps only - it has no satellite "
                "imagery. Use MAP_PROVIDER=satellite for imagery, or one of: "
                + ", ".join(sorted(GEOAPIFY_STYLES))
            )
        return (f"https://maps.geoapify.com/v1/tile/{st}/{z}/{x}/{y}.png"
                f"?apiKey={key}")

    return f"https://tile.openstreetmap.org/{z}/{x}/{y}.png"


def fetch(z: int, x: int, y: int) -> tuple[bytes, str]:
    """One tile as (bytes, content_type).

    z/x/y are validated against the tile pyramid before any URL is built.
    They arrive from the client, and an unchecked value would let a caller
    steer the request — the path is fixed, but the numbers still have to be
    numbers in range.
    """
    if not (MIN_ZOOM <= z <= MAX_ZOOM):
        raise TileError(f"zoom {z} outside {MIN_ZOOM}-{MAX_ZOOM}")
    span = 1 << z
    if not (0 <= x < span and 0 <= y < span):
        raise TileError(f"tile {x},{y} outside the pyramid at zoom {z}")
    if not available():
        raise TileError("tiles are disabled (MAP_PROVIDER=none)")

    ck = f"{provider()}:{style()}:{z}/{x}/{y}"
    with _lock:
        hit = _cache.get(ck)
        if hit is not None:
            _cache.move_to_end(ck)
            return hit

    try:
        r = requests.get(_upstream_url(z, x, y), timeout=TIMEOUT_S, headers=_HEADERS)
    except requests.RequestException as exc:
        raise TileError(f"tile host unreachable: {type(exc).__name__}") from exc

    if r.status_code == 401:
        raise TileError(
            f"{provider()} rejected the credential for style '{style()}'. "
            "Check GEOAPIFY_API_KEY in .env."
        )
    if r.status_code != 200:
        raise TileError(f"tile host returned {r.status_code}")

    ctype = r.headers.get("content-type", "")
    if not ctype.startswith("image/"):
        # An error page rendered into an <img> is a broken icon with no
        # explanation; refusing it lets the console fall back deliberately.
        raise TileError(f"tile host returned {ctype or 'no content type'}, not an image")

    payload = (r.content, ctype)
    with _lock:
        _cache[ck] = payload
        while len(_cache) > CACHE_MAX_TILES:
            _cache.popitem(last=False)
    return payload


def cache_stats() -> dict:
    with _lock:
        return {"tiles": len(_cache), "limit": CACHE_MAX_TILES}
