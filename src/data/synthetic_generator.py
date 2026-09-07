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

RNG = np.random.default_rng(settings.RANDOM_SEED)

MATERIALS = ["Carbon Steel", "Stainless Steel", "HDPE"]
COATINGS = ["FBE", "Coal Tar Enamel", "Polyethylene Tape", "Uncoated"]
SOIL_TYPES = ["Clay", "Sandy", "Loam", "Rocky"]
PRODUCTS = ["Crude Oil", "Natural Gas", "Refined Products", "Produced Water"]
REGIONS = ["Gulf Coast", "Midwest", "Northeast", "West Coast", "Southwest"]

# Coating quality affects how much external corrosion protection is provided
# (higher = better barrier against soil-side corrosion).
COATING_QUALITY = {"FBE": 0.9, "Coal Tar Enamel": 0.75, "Polyethylene Tape": 0.6, "Uncoated": 0.05}


def generate_pipeline_dataset(n_segments: int = 5000) -> pd.DataFrame:
    age = RNG.gamma(shape=2.0, scale=12, size=n_segments).clip(0, 65)
    diameter = RNG.choice([4, 6, 8, 10, 12, 16, 20, 24, 30, 36, 42, 48], size=n_segments)
    wall_thickness = RNG.uniform(5, 25, size=n_segments)
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

    coating_quality = np.array([COATING_QUALITY[c] for c in coating])
    cp_factor = np.where(cathodic_protection, 0.3, 1.0)  # CP cuts corrosion driving force
    soil_factor = 15000 / soil_resistivity  # more corrosive (lower resistivity) -> higher factor
    material_factor = np.where(material == "Stainless Steel", 0.2, np.where(material == "HDPE", 0.02, 1.0))

    # Simplified external corrosion rate model (mils per year), loosely inspired
    # by real pitting-corrosion-rate relationships used in the literature
    # (age-driven growth, moderated by coating/CP/soil, plus noise).
    base_rate = 0.8 * (1 - coating_quality) * cp_factor * soil_factor * material_factor
    corrosion_rate_mpy = (base_rate * np.sqrt(age + 1) + RNG.normal(0, 0.4, size=n_segments)).clip(0, None)
    corrosion_rate_mpy += 0.15 * historical_repair_count  # past repairs correlate with ongoing issues

    # Binary flag for inspection prioritization: top ~15% predicted rate = high priority
    high_priority_threshold = np.quantile(corrosion_rate_mpy, 0.85)
    needs_priority_inspection = (corrosion_rate_mpy >= high_priority_threshold).astype(int)

    df = pd.DataFrame(
        {
            "segment_id": [f"SEG-{i:05d}" for i in range(n_segments)],
            "pipe_age_years": age.round(1),
            "diameter_inches": diameter,
            "wall_thickness_mm": wall_thickness.round(2),
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
            "corrosion_rate_mpy": corrosion_rate_mpy.round(3),
            "needs_priority_inspection": needs_priority_inspection,
        }
    )
    return df


def main():
    df = generate_pipeline_dataset(n_segments=5000)
    out_path = settings.DATA_PROCESSED_DIR / "synthetic_pipeline_corrosion.csv"
    df.to_csv(out_path, index=False)
    print(f"Generated {len(df):,} synthetic pipeline segments -> {out_path}")
    print(f"\nCorrosion rate (mpy) stats:\n{df['corrosion_rate_mpy'].describe()}")
    print(f"\nHigh-priority inspection rate: {df['needs_priority_inspection'].mean():.1%}")


if __name__ == "__main__":
    main()
