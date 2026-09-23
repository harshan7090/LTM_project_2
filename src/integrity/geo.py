"""
Geography: coordinates, distance, and travel time.

The project previously had no geometry at all — only a region label — which
is why the inspection scheduler could not consider travel and the README
listed "no geography" as a limitation. Crew assignment is where that stops
being acceptable: sending a technician 340 km past a nearer colleague is the
difference between a plan that looks optimal and one that is.

Coordinates here are SYNTHETIC but geographically coherent: segments scatter
around real basin/corridor centroids with a spread that reflects how far a
transmission system actually runs. Replacing them with a real centreline
shapefile changes this module and nothing downstream.

WHAT THIS DELIBERATELY DOES NOT DO:

  Great-circle distance is not driving distance. A segment across a river
  from a depot is 2 km away and a 40 km drive. Modelling that needs a road
  network and a routing engine, which this project does not have, so the
  travel figures are labelled as straight-line estimates everywhere they
  surface. A road factor is applied to make them less wrong, not correct.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

EARTH_RADIUS_KM = 6371.0

# Real approximate centroids for the dataset's five regions, chosen to match
# where that pipeline infrastructure actually is.
REGION_CENTROIDS = {
    "Western": (22.31, 73.18),        # Vadodara — HVJ / DVPL corridor
    "Northern": (26.91, 75.79),       # Jaipur — Jamnagar-Loni corridor
    "Eastern": (22.03, 88.09),        # Haldia — Paradip-Haldia corridor
    "Southern": (10.74, 76.25),       # Koottanad — KKBMPL corridor
    "North Eastern": (26.14, 91.74),  # Guwahati — Numaligarh-Siliguri
}
DEFAULT_CENTROID = (22.50, 79.00)     # geographic centre of India

# Degrees of scatter around a centroid. ~1.6 deg latitude is ~180 km, which is
# the right order for a regional transmission system.
REGION_SPREAD_DEG = 1.6

# Straight-line distance underestimates driving. 1.35 is a common planning
# multiplier for road networks in open country; it is an approximation, not a
# routing result.
ROAD_FACTOR = 1.35
# Average field-crew road speed including stops, in km/h.
AVERAGE_SPEED_KMH = 65.0
# A working day for travel purposes. Anything beyond this becomes an overnight.
WORKING_DAY_HOURS = 8.0


@dataclass(frozen=True)
class Location:
    latitude: float
    longitude: float

    def as_tuple(self) -> tuple[float, float]:
        return (self.latitude, self.longitude)


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in kilometres."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = (math.sin(dphi / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2)
    # Clamped before the square root: floating-point error can push `a` a
    # hair above 1 for antipodal points, and asin would then raise.
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(min(a, 1.0)))


def road_distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Straight-line distance inflated by a road factor.

    Explicitly an estimate. Named `road_distance_km` rather than
    `driving_distance_km` so nobody mistakes it for a routing result.
    """
    return haversine_km(lat1, lon1, lat2, lon2) * ROAD_FACTOR


def travel_hours(distance_km: float) -> float:
    return distance_km / AVERAGE_SPEED_KMH


def travel_days(distance_km: float, round_trip: bool = True) -> float:
    """Crew-days consumed by travel alone.

    Round trip by default: a technician dispatched from a depot has to get
    back. Ignoring the return leg halves the true cost of a distant job, which
    is exactly the error that makes a long-distance assignment look cheap.
    """
    hours = travel_hours(distance_km) * (2 if round_trip else 1)
    return hours / WORKING_DAY_HOURS


def region_centroid(region: str) -> tuple[float, float]:
    return REGION_CENTROIDS.get(region, DEFAULT_CENTROID)


# Coordinates get their own random stream, independent of the one that draws
# the physical attributes. See generate_region_coordinates for why.
GEO_SEED = 20260922


def generate_region_coordinates(regions, rng, spread: float = REGION_SPREAD_DEG):
    """Place each segment on one of its region's pipeline corridors.

    WHAT THIS REPLACED

      `centroid + normal(0, 1.6 deg)`, per segment. Five regions, five
      Gaussian clouds, and a fleet map that looked like five shotgun blasts
      because that is exactly what it was. Real transmission systems are
      long linear corridors between real places, so segments now fall ON
      those corridors, in milepost order.

    WHY THE SHARED STREAM IS STILL ADVANCED

      The old code drew two normals per segment from `rng`, the same
      generator that draws soil resistivity, class location and everything
      else downstream. Simply taking fewer draws would shift that entire
      stream and silently change every other column in the dataset -
      different corrosion rates, a different trained model, and every
      published figure invalidated by a change to where dots sit on a map.

      So the shared stream is advanced by exactly the count it used to
      consume, and the placement itself runs on a dedicated generator. The
      result is that every non-coordinate column is bit-identical to before.
      `tests/test_geo_routes.py` asserts that rather than trusting it.
    """
    import numpy as np

    from src.integrity.routes import place_on_corridor

    regions = list(regions)

    # Burn what the old centroid scatter took: two normals per segment.
    rng.normal(0.0, 1.0, size=2 * len(regions))

    geo_rng = np.random.default_rng(GEO_SEED)
    lats, lons = [], []
    for region in regions:
        lat, lon, _route, _mp = place_on_corridor(str(region), geo_rng)
        # Bounds of the Indian landmass. Without re-drawing these the old
        # US clamp would pin every coordinate to its own western edge.
        lats.append(round(float(np.clip(lat, 6.5, 35.7)), 5))
        lons.append(round(float(np.clip(lon, 68.1, 97.4)), 5))
    return lats, lons
