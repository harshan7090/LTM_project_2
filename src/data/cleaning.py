"""
Data cleaning — the counterpart to src/data/data_quality.py.

Order matters and is not arbitrary:

  1. deduplicate      — before anything computes a statistic, so a duplicated
                        row cannot vote twice in a median
  2. canonicalise     — categorical text, before encoders see it
  3. repair units     — before outlier rules, or a unit error looks like an
                        outlier and gets clipped to a wrong-but-plausible value
  4. flag implausible — domain limits, not statistical ones
  5. missing flags    — recorded BEFORE imputation, or the information is gone
  6. impute           — last

Step 5 is the one that is easy to get wrong. Missingness here is MNAR: old,
neglected assets have worse records, and those are the ones most likely to be
corroding. Impute first and you have told the model an unsurveyed 1974 line
has median soil resistivity, which is both false and biased in the dangerous
direction. Recording `*_was_missing` first lets the model use "we don't know"
as its own evidence.

WHAT IS NOT FIXABLE, AND WHY THAT IS SAID OUT LOUD:

  A pressure recorded as 85 psi when it should be 850 is indistinguishable
  from a genuine low-pressure line without a second source. The high-side
  version (8500 psi) is catchable because it exceeds what the pipe could hold.
  So the cleaner catches roughly half of the decimal errors and reports the
  fact rather than implying the data is now correct.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

# --- canonical vocabularies -------------------------------------------------
# Maps every observed spelling onto one canonical value. Built by lowercasing
# and stripping first, so only genuine synonyms need listing.
COATING_CANONICAL = {
    "fbe": "FBE",
    "fusion bonded epoxy": "FBE",
    "coal tar enamel": "Coal Tar Enamel",
    "coal tar": "Coal Tar Enamel",
    "cte": "Coal Tar Enamel",
    "polyethylene tape": "Polyethylene Tape",
    "pe tape": "Polyethylene Tape",
    "poly tape": "Polyethylene Tape",
    "tape": "Polyethylene Tape",
    "uncoated": "Uncoated",
    "none": "Uncoated",
    "bare": "Uncoated",
}
SOIL_CANONICAL = {
    "clay": "Clay",
    "sandy": "Sandy",
    "sand": "Sandy",
    "loam": "Loam",
    "loamy": "Loam",
    "rocky": "Rocky",
    "rock": "Rocky",
}
UNKNOWN = "Unknown"

# --- domain limits ----------------------------------------------------------
# These are physical/engineering bounds, not percentiles. A statistical
# outlier rule would also remove the genuinely extreme segments, which are
# exactly the ones this application exists to find.
MIN_PLAUSIBLE_WALL_MM = 1.5      # no transmission pipe has a 1 mm wall
MAX_PLAUSIBLE_WALL_MM = 60.0
MAX_PLAUSIBLE_PRESSURE_PSI = 2500.0
MIN_PLAUSIBLE_RESISTIVITY = 50.0
MAX_PLAUSIBLE_RESISTIVITY = 200_000.0

# Fields whose absence is itself informative, so they get an indicator column.
MISSING_INDICATOR_FIELDS = (
    "soil_resistivity_ohm_cm",
    "wall_thickness_mm",
    "coating_type",
    "cathodic_protection",
    "last_inspection_years_ago",
    "operating_temperature_c",
)

MISSING_SUFFIX = "_was_missing"


def missing_indicator_columns() -> list[str]:
    return [f"{c}{MISSING_SUFFIX}" for c in MISSING_INDICATOR_FIELDS]


def _canonicalise(series: pd.Series, mapping: dict) -> pd.Series:
    def fix(v):
        if v is None or (isinstance(v, float) and np.isnan(v)):
            return None
        key = str(v).strip().lower()
        if not key or key in ("nan", "none_", "null"):
            return None
        return mapping.get(key, str(v).strip())
    return series.map(fix)


def clean_dataset(df: pd.DataFrame, verbose: bool = False) -> tuple[pd.DataFrame, dict]:
    """Return (clean_frame, report). Input is not modified."""
    out = df.copy()
    report: dict = {"rows_in": len(df)}

    # --- 1. duplicates -------------------------------------------------------
    # Keyed on segment_id, not on the whole row: two entries for the same
    # segment are duplicates even when a typo makes the rows differ, and that
    # is the common case after a system migration.
    if "segment_id" in out.columns:
        before = len(out)
        out = out.drop_duplicates(subset=["segment_id"], keep="first").reset_index(drop=True)
        report["duplicates_removed"] = before - len(out)
    else:
        report["duplicates_removed"] = 0

    # --- 2. categorical canonicalisation -------------------------------------
    variants_before = {}
    if "coating_type" in out.columns:
        variants_before["coating_type"] = out["coating_type"].astype(str).nunique()
        out["coating_type"] = _canonicalise(out["coating_type"], COATING_CANONICAL)
    if "soil_type" in out.columns:
        variants_before["soil_type"] = out["soil_type"].astype(str).nunique()
        out["soil_type"] = _canonicalise(out["soil_type"], SOIL_CANONICAL)
    report["categorical_variants_before"] = variants_before
    report["categorical_variants_after"] = {
        c: int(out[c].dropna().nunique())
        for c in ("coating_type", "soil_type") if c in out.columns
    }

    # --- 3. unit repair ------------------------------------------------------
    # A wall thickness below the physical minimum is almost certainly inches
    # in a millimetre column. Repaired rather than dropped: the row is
    # otherwise fine and discarding it would bias the sample.
    if "wall_thickness_mm" in out.columns:
        wall = pd.to_numeric(out["wall_thickness_mm"], errors="coerce")
        suspect = wall.notna() & (wall < MIN_PLAUSIBLE_WALL_MM) & (wall > 0)
        out.loc[suspect, "wall_thickness_mm"] = wall[suspect] * 25.4
        report["unit_errors_repaired"] = int(suspect.sum())

    # --- 4. implausible values -> missing ------------------------------------
    # Blanked rather than clipped. Clipping invents a value; blanking says
    # "this reading is not usable", which is true, and step 5 then records it.
    implausible = {}

    def blank_outside(col, lo, hi):
        if col not in out.columns:
            return 0
        values = pd.to_numeric(out[col], errors="coerce")
        bad = values.notna() & ((values < lo) | (values > hi))
        out.loc[bad, col] = np.nan
        return int(bad.sum())

    implausible["wall_thickness_mm"] = blank_outside(
        "wall_thickness_mm", MIN_PLAUSIBLE_WALL_MM, MAX_PLAUSIBLE_WALL_MM)
    implausible["operating_pressure_psi"] = blank_outside(
        "operating_pressure_psi", 0.0, MAX_PLAUSIBLE_PRESSURE_PSI)
    implausible["soil_resistivity_ohm_cm"] = blank_outside(
        "soil_resistivity_ohm_cm", MIN_PLAUSIBLE_RESISTIVITY, MAX_PLAUSIBLE_RESISTIVITY)
    report["implausible_blanked"] = implausible

    # --- 5. missingness indicators (BEFORE imputation) -----------------------
    indicator_rates = {}
    for col in MISSING_INDICATOR_FIELDS:
        if col not in out.columns:
            continue
        flag = out[col].isna()
        if out[col].dtype == object:
            flag = flag | out[col].isnull()
        out[f"{col}{MISSING_SUFFIX}"] = flag.astype(int)
        indicator_rates[col] = round(float(flag.mean()), 4)
    report["missing_rate"] = indicator_rates

    # --- 6. imputation -------------------------------------------------------
    # Median for numerics (robust to the skew this data has), explicit
    # "Unknown" for categoricals so the encoder gets a real level rather than
    # a silent mode-fill that pretends the value was observed.
    imputed = {}
    numeric_cols = [
        "wall_thickness_mm", "soil_resistivity_ohm_cm", "operating_pressure_psi",
        "operating_temperature_c", "last_inspection_years_ago", "pipe_age_years",
        "diameter_inches", "historical_repair_count",
    ]
    for col in numeric_cols:
        if col not in out.columns:
            continue
        values = pd.to_numeric(out[col], errors="coerce")
        n_missing = int(values.isna().sum())
        if n_missing:
            out[col] = values.fillna(values.median())
            imputed[col] = n_missing
        else:
            out[col] = values

    for col in ("coating_type", "soil_type", "material", "product_type", "region"):
        if col not in out.columns:
            continue
        n_missing = int(out[col].isna().sum())
        if n_missing:
            out[col] = out[col].fillna(UNKNOWN)
            imputed[col] = n_missing
        out[col] = out[col].astype(str)

    if "cathodic_protection" in out.columns:
        cp = out["cathodic_protection"]
        n_missing = int(cp.isna().sum())
        if n_missing:
            # Conservative default: an unrecorded CP system is treated as
            # absent. Assuming protection we cannot evidence is the error that
            # actually hurts someone.
            cp = cp.fillna(False)
            imputed["cathodic_protection"] = n_missing
        out["cathodic_protection"] = cp.astype(bool)

    report["imputed_counts"] = imputed
    report["rows_out"] = len(out)

    if verbose:
        print(f"[cleaning] {report['rows_in']:,} -> {report['rows_out']:,} rows")
        print(f"  duplicates removed  : {report['duplicates_removed']}")
        print(f"  unit errors repaired: {report.get('unit_errors_repaired', 0)}")
        print(f"  implausible blanked : {sum(implausible.values())}")
        print(f"  categorical variants: {variants_before} -> "
              f"{report['categorical_variants_after']}")
        print(f"  imputed cells       : {sum(imputed.values()):,}")

    return out, report
