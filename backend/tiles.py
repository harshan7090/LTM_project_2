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


def provider() -> str:
    """Which upstream is in play, after resolving 'auto'."""
    configured = (settings.MAP_PROVIDER or "auto").lower()
    if configured == "auto":
        return "geoapify" if settings.GEOAPIFY_API_KEY else "osm"
    return configured


def available() -> bool:
    return provider() in ("geoapify", "osm")


def attribution() -> str:
    if provider() == "geoapify":
        return "© Geoapify · © OpenStreetMap contributors"
    return "© OpenStreetMap contributors"


def style() -> str:
    return settings.MAP_STYLE or "satellite"


def _upstream_url(z: int, x: int, y: int) -> str:
    if provider() == "geoapify":
        key = settings.GEOAPIFY_API_KEY
        if not key:
            # Geoapify answers 401 for satellite with no key. Saying so here
            # is far more useful than relaying an opaque 401 to the console.
            raise TileError(
                "MAP_PROVIDER is geoapify but GEOAPIFY_API_KEY is empty. "
                "Add a free key from https://myprojects.geoapify.com/ to .env, "
                "or set MAP_PROVIDER=osm."
            )
        return (f"https://maps.geoapify.com/v1/tile/{style()}/{z}/{x}/{y}.png"
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
            f"{provider()} rejected the key for style '{style()}'. Satellite "
            "requires a valid GEOAPIFY_API_KEY."
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
