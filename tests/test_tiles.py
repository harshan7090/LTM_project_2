"""
Map tile relay.

The upstream is replaced with a fake session throughout: these tests are about
what the relay does with a response — validation, caching, error mapping — not
about whether Esri is up today. No network.
"""
import pytest

from backend import tiles


class FakeResponse:
    def __init__(self, status=200, body=b"\xff\xd8\xff\xe0jpeg", ctype="image/jpeg"):
        self.status_code = status
        self.content = body
        self.headers = {"content-type": ctype}


class FakeSession:
    def __init__(self, response=None, exc=None):
        self.response = response or FakeResponse()
        self.exc = exc
        self.urls: list[str] = []

    def get(self, url, timeout=None):
        self.urls.append(url)
        if self.exc:
            raise self.exc
        return self.response


@pytest.fixture
def upstream(monkeypatch):
    """Satellite provider, empty cache, and a fake pooled session."""
    monkeypatch.setattr(tiles.settings, "MAP_PROVIDER", "satellite", raising=False)
    monkeypatch.setattr(tiles, "_cache", tiles.collections.OrderedDict())
    fake = FakeSession()
    monkeypatch.setattr(tiles, "_session", fake)
    return fake


# ------------------------------------------------------------ validation ---

@pytest.mark.parametrize("z", [tiles.MIN_ZOOM - 1, tiles.MAX_ZOOM + 1])
def test_zoom_outside_the_pyramid_is_refused_before_any_request(upstream, z):
    with pytest.raises(tiles.TileError):
        tiles.fetch(z, 0, 0)
    assert upstream.urls == []


@pytest.mark.parametrize("x,y", [(-1, 0), (0, -1), (16, 0), (0, 16)])
def test_tile_outside_the_grid_is_refused_before_any_request(upstream, x, y):
    """At zoom 4 the grid is 16 x 16. Out-of-range numbers come from the
    client and must never reach the upstream URL."""
    with pytest.raises(tiles.TileError):
        tiles.fetch(4, x, y)
    assert upstream.urls == []


def test_esri_path_puts_row_before_column(upstream):
    """Esri's path is /{z}/{row}/{col}. Swapped axes return a real tile from
    the wrong place, so nothing errors — this is the only guard."""
    tiles.fetch(5, 22, 13)
    assert upstream.urls[0].endswith("/tile/5/13/22")


# ---------------------------------------------------------------- caching ---

def test_second_fetch_of_the_same_tile_is_served_from_cache(upstream):
    first = tiles.fetch(5, 22, 13)
    second = tiles.fetch(5, 22, 13)
    assert first == second
    assert len(upstream.urls) == 1


def test_cache_is_bounded(upstream, monkeypatch):
    monkeypatch.setattr(tiles, "CACHE_MAX_TILES", 3)
    for x in range(6):
        tiles.fetch(5, x, 13)
    assert len(tiles._cache) == 3


def test_failures_are_not_cached(upstream):
    """A transient upstream failure must not be remembered as the tile."""
    upstream.response = FakeResponse(status=503)
    with pytest.raises(tiles.TileError):
        tiles.fetch(5, 22, 13)
    upstream.response = FakeResponse()
    payload, ctype = tiles.fetch(5, 22, 13)
    assert ctype == "image/jpeg" and payload
    assert len(upstream.urls) == 2


# ---------------------------------------------------------- error mapping ---

def test_non_200_becomes_a_tile_error(upstream):
    upstream.response = FakeResponse(status=500)
    with pytest.raises(tiles.TileError, match="500"):
        tiles.fetch(5, 22, 13)


def test_a_401_names_the_credential(upstream):
    upstream.response = FakeResponse(status=401)
    with pytest.raises(tiles.TileError, match="credential"):
        tiles.fetch(5, 22, 13)


def test_an_html_error_page_is_not_passed_off_as_an_image(upstream):
    """Some hosts answer 200 with an HTML error page. Relayed into an <img>
    that is a broken icon with no explanation."""
    upstream.response = FakeResponse(body=b"<html>quota</html>", ctype="text/html")
    with pytest.raises(tiles.TileError, match="not an image"):
        tiles.fetch(5, 22, 13)


def test_network_failure_becomes_a_tile_error(upstream):
    upstream.exc = tiles.requests.ConnectionError("proxy said no")
    with pytest.raises(tiles.TileError, match="unreachable"):
        tiles.fetch(5, 22, 13)


# ------------------------------------------------------------- transport ---

def test_upstream_goes_through_the_pooled_session(monkeypatch):
    """Measured: 1,443 ms per uncached tile through requests.get against
    191 ms through a reused connection. A regression to per-call requests
    would make the satellite layer visibly slow without failing anything,
    so it is pinned here."""
    monkeypatch.setattr(tiles.settings, "MAP_PROVIDER", "satellite", raising=False)
    monkeypatch.setattr(tiles, "_cache", tiles.collections.OrderedDict())

    def forbidden(*_a, **_k):
        raise AssertionError("tile fetched with a bare requests.get")

    monkeypatch.setattr(tiles.requests, "get", forbidden)
    fake = FakeSession()
    monkeypatch.setattr(tiles, "_session", fake)
    tiles.fetch(5, 22, 13)
    assert len(fake.urls) == 1


def test_the_real_session_carries_the_identifying_user_agent():
    assert tiles._session.headers["User-Agent"] == tiles._HEADERS["User-Agent"]
