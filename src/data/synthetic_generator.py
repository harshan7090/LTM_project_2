"""
Generates a SYNTHETIC pipeline corrosion dataset — but not random noise.
The corrosion rate label is computed from a simplified version of real
corrosion engineering relationships (age, coating, cathodic protection,
soil resistivity, historical repairs), so a model trained on this actually
learns something physically sensible, and SHAP explanations will point to
the right features. This is a stand-in for real inline-inspection (ILI) or
PHMSA incident data until that's acquired and its schema is known —
labeled synthetic throughout, same approach used for DealSense AI's demo
documents.
"""
import numpy as np
import pandas as pd

from config.settings import settings
from src.data.data_quality import inject_data_quality_issues
from src.integrity.geo import generate_region_coordinates
from src.integrity.remaining_life import (
    SMYS_PSI, design_factor, min_required_wall_in,
)

RNG = np.random.default_rng(settings.RANDOM_SEED)

# A SEPARATE stream for pipe design (grade, wall) and wall history. Drawing
# these from RNG would shift every draw after them, and with it every other
# column and the corrosion label. On its own stream, making the walls
# realistic changes the walls and nothing else. Same technique as the map
# coordinates in src/integrity/geo.py.
DESIGN_RNG = np.random.default_rng(settings.RANDOM_SEED + 51_831)

# --- Pipe design ------------------------------------------------------------
# Standard API 5L / ASME B36.10 nominal wall thicknesses, inches. A designer
# rounds the calculated wall UP to one of these; nobody orders 0.4137".
STANDARD_WALLS_IN = np.array([
    0.188, 0.203, 0.219, 0.250, 0.281, 0.312, 0.344, 0.375, 0.406, 0.438,
    0.469, 0.500, 0.562, 0.625, 0.688, 0.750, 0.812, 0.875, 0.938, 1.000,
    1.062, 1.125, 1.250, 1.375, 1.500,
])

# Grade follows diameter in real networks: small gathering and distribution
# lines are Grade B to X52, large-diameter trunk lines are X60 to X70 because
# at that size a low grade would need an impractically heavy wall.
GRADES_BY_SIZE = [
    # (max diameter in, grades, probabilities)
    (8,  ["Grade B", "X42", "X52"],        [0.30, 0.35, 0.35]),
    (16, ["X42", "X52", "X60", "X65"],     [0.20, 0.45, 0.25, 0.10]),
    (30, ["X52", "X60", "X65", "X70"],     [0.25, 0.35, 0.30, 0.10]),
    (48, ["X60", "X65", "X70"],            [0.20, 0.40, 0.40]),
]

# Lines operate below their maximum allowable operating pressure; the wall is
# designed for the MAOP, not for the pressure on a given day.
MAOP_OVER_OPERATING = (1.05, 1.25)

# Share of segments built one standard size heavier than the calculation
# requires: road and river crossings, spec margin, bulk-purchase rounding.
HEAVY_WALL_SHARE = 0.20

# Handling and construction floor: thinner than this, pipe dents and ovalises
# in the ditch regardless of pressure. D/t of about 96 is the usual limit.
MIN_WALL_IN = 0.188
MAX_D_OVER_T = 96.0

# HDPE is specified by Standard Dimension Ratio, not by Barlow. SDR 11 is the
# common rating for gas distribution.
HDPE_SDR = 11.0

# Ultrasonic thickness readings scatter by roughly this much, mm.
UT_SCATTER_MM = 0.15

# Share of the corrosion allowance a segment's history may consume before we
# take it as having been repaired. Without this, the worst segments would
# "measure" below zero wall; real ones leaked and were sleeved or replaced
# long before, and come back to service near the limit, not past it.
SURVIVOR_ALLOWANCE_USE = (0.60, 1.06)


def design_pipe(diameter, material, product, class_location, operating_pressure):
    """Grade, nominal wall (mm) and MAOP for each segment, designed the way a
    pipeline engineer would: Barlow for the MAOP at the location's design
    factor, then rounded UP to a standard wall, never below the handling floor.
    """
    n = len(diameter)
    grade = np.empty(n, dtype=object)
    for i, d in enumerate(diameter):
        for max_d, names, p in GRADES_BY_SIZE:
            if d <= max_d:
                grade[i] = DESIGN_RNG.choice(names, p=p)
                break
    grade = np.where(material == "HDPE", "", grade)

    maop = operating_pressure * DESIGN_RNG.uniform(*MAOP_OVER_OPERATING, size=n)
    heavier = DESIGN_RNG.random(n) < HEAVY_WALL_SHARE

    wall_mm = np.empty(n)
    for i in range(n):
        d = float(diameter[i])
        if material[i] == "HDPE":
            wall_mm[i] = d / HDPE_SDR * 25.4
            continue
        smys = SMYS_PSI[grade[i]]
        f = design_factor(product[i], int(class_location[i]))
        needed = max(min_required_wall_in(maop[i], d, smys, f), MIN_WALL_IN, d / MAX_D_OVER_T)
        k = int(np.searchsorted(STANDARD_WALLS_IN, needed - 1e-9))
        k = min(k + (1 if heavier[i] else 0), len(STANDARD_WALLS_IN) - 1)
        wall_mm[i] = STANDARD_WALLS_IN[k] * 25.4
    return grade, wall_mm, maop


def measured_wall(nominal_mm, corrosion_rate_mpy, age, material, diameter,
                  product, class_location, operating_pressure, grade):
    """Today's wall: nominal minus the metal lost over the pipe's life.

    Loss is consistent with the segment's own corrosion model. The rate grows
    with sqrt(age), so the metal lost by now is the integral of that curve,
    about two thirds of (current rate x age). Segments whose history would
    have consumed more than their corrosion allowance are taken as repaired
    and returned to service near the limit (see SURVIVOR_ALLOWANCE_USE).
    """
    n = len(nominal_mm)
    loss_mm = (2.0 / 3.0) * corrosion_rate_mpy * age / 1000.0 * 25.4
    cap_use = DESIGN_RNG.uniform(*SURVIVOR_ALLOWANCE_USE, size=n)
    scatter = DESIGN_RNG.normal(0.0, UT_SCATTER_MM, size=n)

    out = nominal_mm.copy()
    for i in range(n):
        if material[i] == "HDPE":
            continue                       # no electrochemical wall loss
        smys = SMYS_PSI[grade[i]]
        f = design_factor(product[i], int(class_location[i]))
        t_min_mm = min_required_wall_in(operating_pressure[i], float(diameter[i]), smys, f) * 25.4
        allowance = max(nominal_mm[i] - t_min_mm, 0.0)
        out[i] = nominal_mm[i] - min(loss_mm[i], allowance * cap_use[i]) + scatter[i]
    return np.minimum(out, nominal_mm).clip(0.5, None)

MATERIALS = ["Carbon Steel", "Stainless Steel", "HDPE"]
COATINGS = ["FBE", "Coal Tar Enamel", "Polyethylene Tape", "Uncoated"]
SOIL_TYPES = ["Clay", "Sandy", "Loam", "Rocky"]
PRODUCTS = ["Crude Oil", "Natural Gas", "Refined Products", "Produced Water"]
# Operating zones, named the way Indian network operators name them.
# ORDER IS LOAD-BEARING: RNG.choice picks an index, so these five must
# stay five and stay in this order or every downstream column shifts.
REGIONS = ["Western", "Northern", "Eastern", "Southern", "North Eastern"]

# Coating quality affects how much external corrosion protection is provided
# (higher = better barrier against soil-side corrosion).
COATING_QUALITY = {"FBE": 0.9, "Coal Tar Enamel": 0.75, "Polyethylene Tape": 0.6, "Uncoated": 0.05}

# --- Consequence attributes -------------------------------------------------
# These describe WHERE the pipe is and what is near it. They are deliberately
# NOT features of the corrosion model: consequence must not predict likelihood,
# or the two halves of risk stop being independent and the product becomes
# circular. They are consumed only by src/integrity/consequence.py.
#
# Class locations follow 49 CFR 192.5. Most transmission mileage is rural
# Class 1, so the distribution is weighted accordingly.
CLASS_LOCATIONS = [1, 2, 3, 4]
CLASS_LOCATION_P = [0.60, 0.22, 0.14, 0.04]

# API 5L line pipe grades, weighted toward the mid grades that dominate
# transmission construction.
PIPE_GRADES = ["Grade B", "X42", "X52", "X60", "X65", "X70"]
PIPE_GRADE_P = [0.08, 0.15, 0.32, 0.22, 0.15, 0.08]

# --- Corrosion kinetics -----------------------------------------------------
# Largest soil-corrosivity multiplier, reached as resistivity approaches zero.
# Bounded because oxygen reduction becomes mass-transport limited - a more
# conductive electrolyte cannot supply oxygen faster than it can diffuse.
SOIL_FACTOR_MAX = 4.0
# Half-saturation resistivity, at the "corrosive / moderately corrosive"
# boundary of the standard soil classification.
SOIL_HALF_SATURATION_OHM_CM = 3000.0
# Upper bound on localised pitting rate for unprotected buried carbon steel.
# The generous end of the plausible range, not the typical one.
MAX_PITTING_RATE_MPY = 40.0


def generate_pipeline_dataset(n_segments: int = 5000) -> pd.DataFrame:
    age = RNG.gamma(shape=2.0, scale=12, size=n_segments).clip(0, 65)
    diameter = RNG.choice([4, 6, 8, 10, 12, 16, 20, 24, 30, 36, 42, 48], size=n_segments)
    # NOT the wall. This draw used to be the wall thickness, uniform 5-25 mm
    # and unrelated to diameter or pressure, which gave 4-inch pipes 18 mm
    # walls and centuries of remaining life. The wall is now designed (see
    # design_pipe). The draw stays so that RNG is consumed exactly as before
    # and every other column, and the label, are unchanged.
    _legacy_wall_draw = RNG.uniform(5, 25, size=n_segments)  # noqa: F841
    material = RNG.choice(MATERIALS, size=n_segments, p=[0.75, 0.15, 0.10])
    coating = RNG.choice(COATINGS, size=n_segments, p=[0.35, 0.25, 0.25, 0.15])
    cathodic_protection = RNG.choice([True, False], size=n_segments, p=[0.7, 0.3])
    # Lower resistivity = more corrosive soil (real-world range ~500-50,000 ohm-cm)
    soil_resistivity = RNG.lognormal(mean=8.5, sigma=1.0, size=n_segments).clip(200, 60000)
    soil_type = RNG.choice(SOIL_TYPES, size=n_segments, p=[0.3, 0.25, 0.25, 0.2])
    operating_pressure = RNG.uniform(200, 1440, size=n_segments)
    operating_temperature = RNG.uniform(10, 80, size=n_segments)
    product = RNG.choice(PRODUCTS, size=n_segments)
    last_inspection_years_ago = RNG.uniform(0, 10, size=n_segments)
    historical_repair_count = RNG.poisson(lam=age / 20)
    region = RNG.choice(REGIONS, size=n_segments)

    # --- location ---------------------------------------------------------
    # Scattered around real basin/corridor centroids for each region, so
    # proximity-based crew assignment has something coherent to optimise.
    # Synthetic, but not random: a Permian segment lands in the Permian.
    latitude, longitude = generate_region_coordinates(region, RNG)

    # --- consequence attributes (independent of the corrosion process) ----
    class_location = RNG.choice(CLASS_LOCATIONS, size=n_segments, p=CLASS_LOCATION_P)
    drinking_water_source = RNG.choice([True, False], size=n_segments, p=[0.12, 0.88])
    environmentally_sensitive = RNG.choice([True, False], size=n_segments, p=[0.15, 0.85])
    navigable_waterway = RNG.choice([True, False], size=n_segments, p=[0.07, 0.93])
    # An identified site (school, hospital, care home) is far likelier where
    # people already are, so this is conditioned on class location rather than
    # drawn independently.
    site_prob = np.where(class_location >= 3, 0.45, np.where(class_location == 2, 0.18, 0.04))
    occupied_site_within_pir = RNG.random(n_segments) < site_prob

    # Kept only to consume RNG as before; the grade now follows diameter and
    # is chosen in design_pipe() on its own stream.
    _legacy_grade_draw = RNG.choice(PIPE_GRADES, size=n_segments, p=PIPE_GRADE_P)  # noqa: F841

    coating_quality = np.array([COATING_QUALITY[c] for c in coating])
    cp_factor = np.where(cathodic_protection, 0.3, 1.0)  # CP cuts corrosion driving force

    # --- Soil corrosivity: SATURATING, not hyperbolic ------------------------
    # This was `15000 / soil_resistivity`, an unbounded 1/x. With resistivity
    # floored at 200 ohm-cm that peaked at a 75x multiplier and produced rates
    # up to 232 mpy - roughly an inch of wall in four years, which does not
    # happen to buried carbon steel.
    #
    # The fix is physical rather than a clip. External corrosion in soil is
    # cathodically controlled by oxygen reduction, and oxygen arrives by
    # diffusion through the soil. Once the cathodic reaction is
    # mass-transport limited, making the electrolyte more conductive cannot
    # make it go faster - there is a limiting current density. So the
    # multiplier has to saturate.
    #
    # Hyperbolic (Michaelis-Menten) saturation gives exactly that shape:
    #
    #     factor = f_max * R_half / (R_half + resistivity)
    #
    # with the half-saturation constant placed at 3,000 ohm-cm, near the
    # boundary between "corrosive" and "moderately corrosive" in the standard
    # soil-resistivity classification that traces back to Romanoff's NBS
    # burial studies and is still used in AMPP/NACE practice:
    #
    #     < 1,000 ohm-cm   severely corrosive
    #     1,000 - 2,000    corrosive
    #     2,000 - 10,000   moderately corrosive
    #     > 10,000         mildly corrosive
    #
    # Resulting multipliers: 3.75x at 200 ohm-cm, 3.0x at 1,000, 2.0x at
    # 3,000, 0.9x at 10,000, 0.2x at 60,000. Monotonic, bounded, and it keeps
    # the ordering the model needs to learn.
    soil_factor = SOIL_FACTOR_MAX * SOIL_HALF_SATURATION_OHM_CM / (
        SOIL_HALF_SATURATION_OHM_CM + soil_resistivity)

    material_factor = np.where(material == "Stainless Steel", 0.2, np.where(material == "HDPE", 0.02, 1.0))

    # Simplified external corrosion rate model (mils per year), loosely
    # inspired by real pitting-corrosion-rate relationships used in the
    # literature (age-driven growth, moderated by coating/CP/soil, plus noise).
    base_rate = 0.8 * (1 - coating_quality) * cp_factor * soil_factor * material_factor
    corrosion_rate_mpy = (base_rate * np.sqrt(age + 1) + RNG.normal(0, 0.4, size=n_segments)).clip(0, None)
    corrosion_rate_mpy += 0.15 * historical_repair_count  # past repairs correlate with ongoing issues

    # --- Soft physical ceiling ----------------------------------------------
    # The saturating soil factor already caps the worst case near 25 mpy, but
    # the product of several independent extremes can still overshoot. This
    # compresses the top of the distribution toward MAX_PITTING_RATE_MPY
    # instead of truncating at it.
    #
    # A hard clip would pile probability mass exactly on the limit and create
    # a spike the model would learn as a real feature of the world. tanh
    # squashes smoothly, so the ordering of the worst segments survives and
    # the distribution stays continuous.
    #
    # 40 mpy is the ceiling because that is about the upper bound reported for
    # aggressive LOCALISED pitting on unprotected buried steel. Uniform
    # external corrosion sits far below it; this is deliberately the generous
    # end of the plausible range, not the typical one.
    knee = MAX_PITTING_RATE_MPY * 0.55
    over = corrosion_rate_mpy > knee
    corrosion_rate_mpy[over] = knee + (MAX_PITTING_RATE_MPY - knee) * np.tanh(
        (corrosion_rate_mpy[over] - knee) / (MAX_PITTING_RATE_MPY - knee))

    # --- pipe design and wall history ---------------------------------------
    # Grade and nominal wall are DESIGNED from diameter, MAOP and the design
    # factor for the location, as a real line is. The measured wall is that
    # nominal less the metal this segment's own corrosion has removed.
    # `measured_wall_mm` is NOT a model feature: it is derived from the
    # label, so letting the model see it would leak the answer.
    pipe_grade, wall_thickness, _maop = design_pipe(
        diameter, material, product, class_location, operating_pressure)
    wall_measured = measured_wall(
        wall_thickness, corrosion_rate_mpy, age, material, diameter,
        product, class_location, operating_pressure, pipe_grade)

    # Binary flag for inspection prioritization: top ~15% predicted rate = high priority
    high_priority_threshold = np.quantile(corrosion_rate_mpy, 0.85)
    needs_priority_inspection = (corrosion_rate_mpy >= high_priority_threshold).astype(int)

    df = pd.DataFrame(
        {
            "segment_id": [f"SEG-{i:05d}" for i in range(n_segments)],
            "pipe_age_years": age.round(1),
            "diameter_inches": diameter,
            "wall_thickness_mm": wall_thickness.round(2),      # nominal, as built
            "measured_wall_mm": wall_measured.round(2),        # today, after corrosion
            "material": material,
            "coating_type": coating,
            "cathodic_protection": cathodic_protection,
            "soil_resistivity_ohm_cm": soil_resistivity.round(0),
            "soil_type": soil_type,
            "operating_pressure_psi": operating_pressure.round(0),
            "operating_temperature_c": operating_temperature.round(1),
            "product_type": product,
            "last_inspection_years_ago": last_inspection_years_ago.round(1),
            "historical_repair_count": historical_repair_count,
            "region": region,
            "latitude": latitude,
            "longitude": longitude,
            "pipe_grade": pipe_grade,
            "class_location": class_location,
            "drinking_water_source": drinking_water_source,
            "environmentally_sensitive": environmentally_sensitive,
            "navigable_waterway": navigable_waterway,
            "occupied_site_within_pir": occupied_site_within_pir,
            "corrosion_rate_mpy": corrosion_rate_mpy.round(3),
            "needs_priority_inspection": needs_priority_inspection,
        }
    )
    return df


def main(clean: bool = False):
    """Generate the dataset.

    By default the clean physics is then degraded with realistic data-quality
    problems (see src/data/data_quality.py) — missing records weighted toward
    old assets, measurement error, unit confusion, categorical drift,
    duplicates and label noise. `clean=True` skips that, which is useful for
    isolating whether a change affected the model or the data handling.
    """
    df = generate_pipeline_dataset(n_segments=5000)
    out_path = settings.DATA_PROCESSED_DIR / "synthetic_pipeline_corrosion.csv"

    if not clean:
        # The ground truth is kept alongside, so the cost of the data-quality
        # problems can be measured rather than guessed.
        df.to_csv(settings.DATA_PROCESSED_DIR / "pipeline_ground_truth.csv", index=False)
        df, _report = inject_data_quality_issues(df, seed=settings.RANDOM_SEED, verbose=True)
        print()

    df.to_csv(out_path, index=False)
    print(f"Generated {len(df):,} synthetic pipeline segments -> {out_path}")
    print(f"\nCorrosion rate (mpy) stats:\n{df['corrosion_rate_mpy'].describe()}")
    print(f"\nHigh-priority inspection rate: {df['needs_priority_inspection'].mean():.1%}")


if __name__ == "__main__":
    main()
