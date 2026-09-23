"""
Pipeline corridors — where the segments actually lie.

WHAT WAS WRONG BEFORE

  Every segment's position was `centroid + normal(0, 1.6 degrees)`. Five
  regions, five Gaussian clouds. On the map that reads as five shotgun
  blasts, because that is precisely what it is, and no amount of basemap
  underneath it would have helped: the geometry itself was wrong.

  Pipelines are not clouds. A transmission system is a small number of long
  linear corridors joining real places — a terminal to a hub, a hub to a
  refinery, a refinery to a port — with laterals hanging off them. Segments
  are consecutive stretches of those corridors, identified by milepost.

WHAT THIS DOES INSTEAD

  Each zone gets three corridors traced along real Indian trunk lines: the
  HVJ, the Jamnagar–Loni LPG line, Dahej–Vijaipur, Paradip–Haldia,
  Kochi–Koottanad–Mangalore, Numaligarh–Siliguri. Waypoints are the towns
  those lines actually run through. A segment is placed by picking a
  corridor, picking a distance along it, and interpolating — so segments
  fall ON the line, in milepost order, the way a real register is
  organised.

  A small perpendicular offset is added. Not noise for its own sake: a real
  corridor carries parallel loops and a right-of-way is a few hundred
  metres wide, so a corridor drawn as a mathematical hairline looks more
  fake than one with some width to it.

  The corridors are also served to the console so the map can draw the
  routes themselves underneath the segments. One definition, both uses —
  the alternative is a frontend copy that silently drifts out of step.

ZONES

  Five, named the way Indian network operators name them, and positionally
  matched to the five the dataset already had so that renaming them could
  not disturb the random stream that draws every other column.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

from src.integrity.geo import haversine_km

# Half-width of a corridor in degrees of latitude. ~0.02 deg is about 2 km,
# which is the right order for a right-of-way carrying parallel loops.
CORRIDOR_HALF_WIDTH_DEG = 0.02


@dataclass(frozen=True)
class Route:
    name: str
    region: str
    # (latitude, longitude), in flow order.
    waypoints: tuple[tuple[float, float], ...]
    # Relative share of the zone's segments. A trunk line carries more than
    # a lateral, so it gets more of them.
    weight: float

    def leg_lengths_km(self) -> list[float]:
        return [
            haversine_km(
                self.waypoints[i][0], self.waypoints[i][1],
                self.waypoints[i + 1][0], self.waypoints[i + 1][1],
            )
            for i in range(len(self.waypoints) - 1)
        ]

    def length_km(self) -> float:
        return sum(self.leg_lengths_km())

    def point_at(self, fraction: float) -> tuple[float, float, float]:
        """Interpolate along the route.

        Returns (latitude, longitude, bearing_rad). The fraction is of total
        LENGTH, not of waypoint count — otherwise a route with one short leg
        and one long leg would bunch half its segments into the short one.
        """
        legs = self.leg_lengths_km()
        total = sum(legs) or 1.0
        want = max(0.0, min(1.0, fraction)) * total

        travelled = 0.0
        for i, leg in enumerate(legs):
            if travelled + leg >= want or i == len(legs) - 1:
                t = (want - travelled) / leg if leg > 0 else 0.0
                t = max(0.0, min(1.0, t))
                (lat0, lon0) = self.waypoints[i]
                (lat1, lon1) = self.waypoints[i + 1]
                lat = lat0 + (lat1 - lat0) * t
                lon = lon0 + (lon1 - lon0) * t
                # Bearing in a locally flat frame: longitude degrees are
                # shorter than latitude degrees away from the equator, so
                # they are scaled before the angle is taken.
                k = math.cos(math.radians(lat)) or 1.0
                bearing = math.atan2((lon1 - lon0) * k, lat1 - lat0)
                return lat, lon, bearing
            travelled += leg

        lat, lon = self.waypoints[-1]
        return lat, lon, 0.0


# --------------------------------------------------------------- corridors --
# Trunk first, then laterals. Every waypoint is a real place on or near the
# line it belongs to.

ROUTES: tuple[Route, ...] = (
    # ---- Western: Gujarat terminals into the interior ----------------------
    Route("HVJ West Leg", "Western", (
        (21.12, 72.64),   # Hazira
        (21.63, 73.00),   # Ankleshwar
        (22.31, 73.18),   # Vadodara
        (22.78, 73.61),   # Godhra
        (23.33, 75.04),   # Ratlam
        (24.51, 77.80),   # Vijaipur
    ), 1.0),
    Route("Dahej–Vadodara (DVPL)", "Western", (
        (21.70, 72.58),   # Dahej
        (21.71, 72.99),   # Bharuch
        (22.31, 73.18),   # Vadodara
    ), 0.5),
    Route("Mumbai–Pune–Solapur", "Western", (
        (19.08, 72.88),   # Mumbai
        (18.99, 73.12),   # Panvel
        (18.52, 73.86),   # Pune
        (17.66, 75.91),   # Solapur
    ), 0.6),

    # ---- Northern: Rajasthan, NCR and Punjab -------------------------------
    Route("Jamnagar–Loni LPG", "Northern", (
        (24.58, 73.68),   # Udaipur
        (26.45, 74.64),   # Ajmer
        (26.91, 75.79),   # Jaipur
        (27.55, 76.63),   # Alwar
        (28.75, 77.29),   # Loni
    ), 1.0),
    Route("HVJ East Leg", "Northern", (
        (24.51, 77.80),   # Vijaipur
        (26.22, 78.18),   # Gwalior
        (26.47, 79.51),   # Auraiya
        (26.45, 80.33),   # Kanpur
        (26.07, 81.52),   # Jagdishpur
    ), 0.8),
    Route("Panipat–Jammu", "Northern", (
        (29.39, 76.97),   # Panipat
        (30.38, 76.78),   # Ambala
        (30.90, 75.86),   # Ludhiana
        (31.33, 75.58),   # Jalandhar
        (32.73, 74.87),   # Jammu
    ), 0.5),

    # ---- Eastern: Odisha coast into the Gangetic plain ---------------------
    Route("Paradip–Haldia", "Eastern", (
        (20.32, 86.61),   # Paradip
        (20.46, 85.88),   # Cuttack
        (21.49, 86.93),   # Balasore
        (22.35, 87.32),   # Kharagpur
        (22.03, 88.09),   # Haldia
    ), 1.0),
    Route("Haldia–Barauni", "Eastern", (
        (22.03, 88.09),   # Haldia
        (22.57, 88.36),   # Kolkata
        (23.52, 87.31),   # Durgapur
        (24.63, 86.99),   # Deoghar
        (25.47, 85.97),   # Barauni
    ), 0.7),
    Route("Dhamra–Jharsuguda", "Eastern", (
        (20.79, 86.98),   # Dhamra
        (21.06, 86.51),   # Bhadrak
        (20.84, 85.10),   # Angul
        (21.86, 84.01),   # Jharsuguda
    ), 0.45),

    # ---- Southern: the Kerala line and the Deccan --------------------------
    Route("Kochi–Mangalore (KKBMPL)", "Southern", (
        (9.93, 76.27),    # Kochi
        (10.53, 76.21),   # Thrissur
        (10.74, 76.25),   # Koottanad
        (11.26, 75.78),   # Kozhikode
        (11.87, 75.37),   # Kannur
        (12.91, 74.86),   # Mangalore
    ), 1.0),
    Route("Chennai–Madurai", "Southern", (
        (13.08, 80.27),   # Chennai
        (11.94, 79.49),   # Villupuram
        (10.79, 78.70),   # Tiruchirappalli
        (9.93, 78.12),    # Madurai
    ), 0.7),
    Route("Visakhapatnam–Hyderabad", "Southern", (
        (17.69, 83.22),   # Visakhapatnam
        (17.00, 81.80),   # Rajahmundry
        (16.51, 80.65),   # Vijayawada
        (17.39, 78.49),   # Hyderabad
    ), 0.6),

    # ---- North Eastern: the Assam trunk ------------------------------------
    Route("Numaligarh–Siliguri", "North Eastern", (
        (26.62, 93.74),   # Numaligarh
        (26.63, 92.80),   # Tezpur
        (26.14, 91.74),   # Guwahati
        (26.48, 90.55),   # Bongaigaon
        (26.72, 88.43),   # Siliguri
    ), 1.0),
    Route("Digboi–Numaligarh", "North Eastern", (
        (27.39, 95.62),   # Digboi
        (27.47, 94.91),   # Dibrugarh
        (26.98, 94.64),   # Sivasagar
        (26.62, 93.74),   # Numaligarh
    ), 0.55),
    Route("Guwahati–Silchar", "North Eastern", (
        (26.14, 91.74),   # Guwahati
        (26.35, 92.68),   # Nagaon
        (25.57, 92.80),   # Jowai
        (24.83, 92.78),   # Silchar
    ), 0.45),
)

# The zones, in the positional order the dataset's five regions were drawn
# in. Renaming is positional so the random stream is untouched.
REGION_NAMES: tuple[str, ...] = (
    "Western", "Northern", "Eastern", "Southern", "North Eastern",
)


def routes_for(region: str) -> list[Route]:
    return [r for r in ROUTES if r.region == region]


def place_on_corridor(region: str, rng) -> tuple[float, float, str, float]:
    """Put one segment on one of the zone's corridors.

    Returns (latitude, longitude, route_name, milepost_km).
    """
    options = routes_for(region)
    if not options:
        # Roughly the geographic centre of India.
        return 22.5, 79.0, "", 0.0

    weights = [r.weight for r in options]
    total_w = sum(weights)
    pick = rng.random() * total_w
    route = options[-1]
    running = 0.0
    for r, w in zip(options, weights):
        running += w
        if pick <= running:
            route = r
            break

    frac = rng.random()
    lat, lon, bearing = route.point_at(frac)

    # Perpendicular to the direction of flow, so the offset widens the
    # right-of-way rather than smearing segments along it (which would undo
    # the milepost ordering the corridor exists to give).
    off = rng.normal(0.0, CORRIDOR_HALF_WIDTH_DEG)
    perp = bearing + math.pi / 2
    k = max(math.cos(math.radians(lat)), 0.2)
    lat += off * math.cos(perp)
    lon += off * math.sin(perp) / k

    return (
        round(float(lat), 5),
        round(float(lon), 5),
        route.name,
        round(frac * route.length_km(), 1),
    )


def routes_payload() -> list[dict]:
    """The corridors, for the console to draw underneath the segments.

    Served rather than duplicated in the frontend: a second copy of these
    coordinates would drift out of step with the one the data was generated
    from, and the symptom would be segments floating beside their own route.
    """
    return [
        {
            "name": r.name,
            "region": r.region,
            "weight": r.weight,
            "length_km": round(r.length_km(), 1),
            # [[lat, lon], ...] in flow order.
            "path": [[lat, lon] for lat, lon in r.waypoints],
        }
        for r in ROUTES
    ]
