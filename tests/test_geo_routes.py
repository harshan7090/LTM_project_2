"""Pipeline corridors and the coordinates placed on them.

WHY THESE ASSERTIONS

  The fault this module was written to fix was invisible from the code: the
  coordinate generator was correct, tested, and produced five Gaussian
  clouds, because scattering around a centroid is exactly what it was asked
  to do. Nothing failed. It just did not look like a pipeline.

  So the tests here check the SHAPE of the result, not that the function
  returns floats: that points fall near their corridor rather than in a
  cloud around a point, that they stay inside the country, that a region's
  segments land in that region, and that the placement is reproducible.

  The last test is the load-bearing one. Coordinates are drawn from a
  dedicated stream so that changing the map cannot perturb the physical
  attributes, the trained model, or any published figure. That property is
  easy to break by accident and impossible to notice by eye.
"""
import math

import numpy as np
import pytest

from src.integrity.geo import GEO_SEED, generate_region_coordinates, haversine_km
from src.integrity.routes import (
    CORRIDOR_HALF_WIDTH_DEG, REGION_NAMES, ROUTES, place_on_corridor,
    routes_for, routes_payload,
)

REGIONS = ["Western", "Northern", "Eastern", "Southern", "North Eastern"]


# --------------------------------------------------------------- corridors --

def test_every_region_has_corridors():
    for region in REGIONS:
        assert routes_for(region), f"{region} has nowhere to put its segments"


def test_waypoints_are_inside_india():
    for route in ROUTES:
        for lat, lon in route.waypoints:
            assert 6.5 <= lat <= 35.7, f"{route.name}: latitude {lat}"
            assert 68.0 <= lon <= 97.5, f"{route.name}: longitude {lon}"


def test_routes_have_real_length_and_no_duplicate_waypoints():
    for route in ROUTES:
        assert len(route.waypoints) >= 3, f"{route.name} is barely a line"
        assert route.length_km() > 100, f"{route.name} is only {route.length_km():.0f} km"
        assert len(set(route.waypoints)) == len(route.waypoints), \
            f"{route.name} repeats a waypoint"


def test_point_at_interpolates_by_length_not_by_waypoint_index():
    """A route with one short leg and one long one must not bunch half its
    segments into the short leg."""
    route = max(ROUTES, key=lambda r: r.length_km())
    start_lat, start_lon, _ = route.point_at(0.0)
    end_lat, end_lon, _ = route.point_at(1.0)
    assert haversine_km(start_lat, start_lon, *route.waypoints[0]) < 1.0
    assert haversine_km(end_lat, end_lon, *route.waypoints[-1]) < 1.0

    # Distance travelled should track the fraction requested, linearly.
    total = route.length_km()
    prev = (start_lat, start_lon)
    walked = 0.0
    for k in range(1, 51):
        lat, lon, _ = route.point_at(k / 50)
        walked += haversine_km(prev[0], prev[1], lat, lon)
        prev = (lat, lon)
    # Chords under-measure a polyline slightly; 2% is ample.
    assert walked == pytest.approx(total, rel=0.02)


def test_point_at_clamps_out_of_range_fractions():
    route = ROUTES[0]
    assert route.point_at(-5.0)[:2] == pytest.approx(route.point_at(0.0)[:2])
    assert route.point_at(9.9)[:2] == pytest.approx(route.point_at(1.0)[:2])


# --------------------------------------------------------------- placement --

def _distance_to_route_km(lat, lon, route, samples=400):
    """Closest approach to a densely sampled polyline."""
    return min(
        haversine_km(lat, lon, *route.point_at(i / samples)[:2])
        for i in range(samples + 1)
    )


def test_segments_land_on_a_corridor_not_in_a_cloud():
    """THE regression test.

    The old generator scattered at sigma = 1.6 degrees, roughly 180 km, so
    a typical point sat over a hundred kilometres from anything linear. Now
    every point should be within a few km of the corridor it was placed on.
    """
    rng = np.random.default_rng(1)
    for region in REGIONS:
        worst = 0.0
        for _ in range(60):
            lat, lon, name, _mp = place_on_corridor(region, rng)
            route = next(r for r in ROUTES if r.name == name)
            worst = max(worst, _distance_to_route_km(lat, lon, route))
        # 4 sigma of the perpendicular offset, in km.
        limit = CORRIDOR_HALF_WIDTH_DEG * 111.0 * 4
        assert worst < limit, f"{region}: a segment sat {worst:.1f} km off its corridor"


def test_milepost_is_within_the_route_it_belongs_to():
    rng = np.random.default_rng(7)
    for region in REGIONS:
        for _ in range(40):
            _lat, _lon, name, milepost = place_on_corridor(region, rng)
            route = next(r for r in ROUTES if r.name == name)
            assert 0.0 <= milepost <= route.length_km() + 1.0


def test_placement_is_reproducible():
    """A map that moves between runs cannot be reasoned about."""
    a = generate_region_coordinates(REGIONS * 40, np.random.default_rng(3))
    b = generate_region_coordinates(REGIONS * 40, np.random.default_rng(99))
    # Different *shared* stream, same coordinates: placement uses its own.
    assert a == b


def test_coordinates_do_not_consume_the_shared_stream():
    """Load-bearing.

    Coordinates must not perturb the attribute stream, or moving a dot on
    the map silently changes soil resistivity, class location, every
    corrosion rate downstream and the trained model with them.

    The generator therefore advances the shared stream by exactly what the
    old centroid scatter used to take, and draws positions from a separate
    one. This checks the shared stream is left where it would have been.
    """
    n = 250
    expected = np.random.default_rng(42)
    expected.normal(0.0, 1.0, size=2 * n)
    after_expected = expected.random(5)

    actual = np.random.default_rng(42)
    generate_region_coordinates([REGIONS[i % 5] for i in range(n)], actual)
    after_actual = actual.random(5)

    np.testing.assert_array_equal(after_actual, after_expected)


def test_zones_stay_in_their_own_part_of_the_country():
    rng = np.random.default_rng(11)
    seen: dict[str, list[tuple[float, float]]] = {r: [] for r in REGIONS}
    for region in REGIONS:
        for _ in range(80):
            lat, lon, _n, _m = place_on_corridor(region, rng)
            seen[region].append((lat, lon))

    # Crude, but it catches a swapped or mislabelled corridor table.
    def mean_lon(r):
        return sum(p[1] for p in seen[r]) / len(seen[r])

    def mean_lat(r):
        return sum(p[0] for p in seen[r]) / len(seen[r])

    # West to east: Western (Gujarat) < Northern (Rajasthan/NCR)
    #               < Eastern (Odisha/WB) < North Eastern (Assam)
    assert mean_lon("Western") < mean_lon("Northern")
    assert mean_lon("Northern") < mean_lon("Eastern") < mean_lon("North Eastern")
    # South to north: Southern (Kerala/TN) is well below Northern (NCR).
    assert mean_lat("Southern") < mean_lat("Western") < mean_lat("Northern")


def test_unknown_region_falls_back_to_the_country_centre():
    lat, lon, name, mp = place_on_corridor("Atlantis", np.random.default_rng(0))
    assert name == "" and mp == 0.0
    assert 6.5 <= lat <= 35.7 and 68.0 <= lon <= 97.5


# ------------------------------------------------------------- the payload --

def test_payload_matches_the_routes_it_describes():
    payload = routes_payload()
    assert len(payload) == len(ROUTES)
    for entry, route in zip(payload, ROUTES):
        assert entry["name"] == route.name
        assert entry["region"] == route.region
        assert len(entry["path"]) == len(route.waypoints)
        # [lat, lon], the order the console projects from.
        for (plat, plon), (wlat, wlon) in zip(entry["path"], route.waypoints):
            assert (plat, plon) == (wlat, wlon)


def test_payload_is_json_safe():
    import json
    text = json.dumps(routes_payload())
    assert "NaN" not in text and "Infinity" not in text


def test_geo_seed_is_pinned():
    """If this changes, every segment moves. That should be deliberate."""
    assert GEO_SEED == 20260922


def test_zone_names_match_the_dataset():
    """The corridor table and the generator must agree on the five zones.

    They are renamed positionally, so a mismatch here means segments in a
    zone with no corridors — which falls back to the centre of India and
    puts a pile of dots in Madhya Pradesh with nothing to explain it.
    """
    from src.data.synthetic_generator import REGIONS as DATASET_REGIONS
    from src.integrity.routes import REGION_NAMES

    assert list(DATASET_REGIONS) == list(REGION_NAMES)
    for zone in DATASET_REGIONS:
        assert routes_for(zone), f"{zone} has no corridors"
