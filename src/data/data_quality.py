"""
Degrades the clean synthetic dataset into something that looks like a real
operator's records.

WHY THIS EXISTS:

  The generator produces physics. Real pipeline data is physics plus fifty
  years of people writing things down, and the second part is most of the
  work. A model that scores R^2 0.72 on pristine columns has not been tested
  against the thing it will actually meet:

    - A 1974 line whose soil survey was never digitised.
    - Wall thickness recorded in inches in one region and millimetres in
      another, in the same column.
    - "FBE", "fbe", "Fusion Bonded Epoxy" and " FBE " as four coatings.
    - A corrosion rate derived from two ILI runs, each with tool tolerance.
    - The same segment entered twice after a merger.

  Every one of these is ordinary. None of them raise an exception. They just
  quietly make a model worse, and the only honest way to know whether the
  pipeline handles them is to put them in on purpose.

MISSINGNESS IS NOT RANDOM:

  The important design choice here. Records are worse for OLD assets and for
  assets that have not been inspected recently — exactly the segments most
  likely to be corroding. That is MNAR (missing not at random), and it is the
  hard case: mean-imputing it biases the model toward thinking old pipe is
  average. The preprocessing answers this with missingness INDICATORS, so the
  model can learn "we don't know" as its own signal rather than having it
  silently replaced with a median.

  Making missingness uniformly random instead would have been easier and
  would have taught the pipeline nothing.

Everything here is seeded and reproducible. `inject_data_quality_issues`
returns the damaged frame plus a report of exactly what was done, so the
README numbers are generated rather than claimed.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

# --- rates ------------------------------------------------------------------
# Tuned to be a nuisance rather than a catastrophe. Real datasets are often
# worse than this; a student project that cannot train at all teaches less
# than one that has to work for it.

# Base probability a field is blank, before the age/inspection weighting.
MISSING_BASE = {
    "soil_resistivity_ohm_cm": 0.10,   # needs a soil survey somebody paid for
    "operating_temperature_c": 0.06,
    "wall_thickness_mm": 0.04,         # from construction records or UT
    "coating_type": 0.05,              # frequently unknown on pre-1970 pipe
    "cathodic_protection": 0.03,
    "last_inspection_years_ago": 0.07,
}
# Multiplier applied to the oldest pipe. Records degrade going back.
MISSING_AGE_MULTIPLIER = 3.0

# Relative measurement error (1 sigma) on fields that are measured, not looked
# up. Soil resistivity genuinely varies this much seasonally.
MEASUREMENT_NOISE = {
    "wall_thickness_mm": 0.03,          # UT repeatability
    "soil_resistivity_ohm_cm": 0.25,    # seasonal moisture
    "operating_pressure_psi": 0.02,
    "operating_temperature_c": 0.05,
}

# Fraction of rows carrying each recording defect.
UNIT_ERROR_RATE = 0.015        # wall thickness written in inches, not mm
DECIMAL_ERROR_RATE = 0.004     # 10x transcription slip
DUPLICATE_RATE = 0.012         # same segment entered twice
CATEGORICAL_MESS_RATE = 0.18   # case/whitespace/synonym drift

# ILI tool tolerance on the depth measurements the rate is derived from.
# Vendors typically quote +/-10% of wall at 80% confidence; two runs
# differenced makes it worse.
LABEL_NOISE_SIGMA = 0.12
LABEL_NOISE_FLOOR_MPY = 0.15   # absolute component, matters at low rates

# Synonyms a real coating column accumulates.
COATING_SYNONYMS = {
    "FBE": ["FBE", "fbe", " FBE", "Fusion Bonded Epoxy", "FBE "],
    "Coal Tar Enamel": ["Coal Tar Enamel", "coal tar enamel", "CTE", "Coal Tar"],
    "Polyethylene Tape": ["Polyethylene Tape", "PE Tape", "poly tape", "Tape"],
    "Uncoated": ["Uncoated", "uncoated", "NONE", "Bare"],
}
SOIL_SYNONYMS = {
    "Clay": ["Clay", "clay", "CLAY"],
    "Sandy": ["Sandy", "sandy", "Sand"],
    "Loam": ["Loam", "loam", "Loamy"],
    "Rocky": ["Rocky", "rocky", "Rock"],
}


def _missing_probability(df: pd.DataFrame, base: float) -> np.ndarray:
    """Per-row blank probability, weighted by age and inspection recency.

    This is what makes the missingness MNAR. A flat `base` everywhere would be
    MCAR, which median imputation handles almost perfectly and which therefore
    proves nothing.
    """
    age = df["pipe_age_years"].to_numpy(dtype=float)
    age_factor = 1.0 + (MISSING_AGE_MULTIPLIER - 1.0) * np.clip(age / 65.0, 0, 1)

    since = df["last_inspection_years_ago"].to_numpy(dtype=float)
    neglect_factor = 1.0 + 0.5 * np.clip(np.nan_to_num(since) / 10.0, 0, 1)

    return np.clip(base * age_factor * neglect_factor, 0.0, 0.85)


def inject_data_quality_issues(df: pd.DataFrame, seed: int = 42,
                               verbose: bool = False) -> tuple[pd.DataFrame, dict]:
    """Return (degraded_frame, report). The input frame is not modified."""
    rng = np.random.default_rng(seed)
    out = df.copy()
    report: dict = {"rows_in": len(df)}

    # --- 1. Measurement error ------------------------------------------------
    # Applied before missingness so a blanked field does not get noise added
    # and then reappear.
    for col, sigma in MEASUREMENT_NOISE.items():
        if col not in out.columns:
            continue
        factor = rng.normal(1.0, sigma, size=len(out))
        out[col] = (out[col].astype(float) * factor).clip(lower=0)
    report["measurement_noise_fields"] = list(MEASUREMENT_NOISE)

    # --- 2. Unit confusion ---------------------------------------------------
    # Wall thickness entered in inches into a millimetre column. The value is
    # ~25x too small but still positive and still plausible-looking, which is
    # precisely why it survives into production databases.
    n_unit = int(len(out) * UNIT_ERROR_RATE)
    unit_idx = rng.choice(len(out), size=n_unit, replace=False)
    out.loc[out.index[unit_idx], "wall_thickness_mm"] = (
        out.loc[out.index[unit_idx], "wall_thickness_mm"] / 25.4
    )
    report["unit_errors"] = n_unit

    # --- 3. Decimal slips ----------------------------------------------------
    n_dec = int(len(out) * DECIMAL_ERROR_RATE)
    dec_idx = rng.choice(len(out), size=n_dec, replace=False)
    scale = rng.choice([10.0, 0.1], size=n_dec)
    out.loc[out.index[dec_idx], "operating_pressure_psi"] = (
        out.loc[out.index[dec_idx], "operating_pressure_psi"].to_numpy() * scale
    )
    report["decimal_errors"] = n_dec

    # --- 4. Categorical drift ------------------------------------------------
    def mess(col: str, synonyms: dict) -> int:
        if col not in out.columns:
            return 0
        mask = rng.random(len(out)) < CATEGORICAL_MESS_RATE
        count = 0
        values = out[col].astype(str).tolist()
        for i, flag in enumerate(mask):
            if not flag:
                continue
            options = synonyms.get(values[i])
            if options:
                values[i] = str(rng.choice(options))
                count += 1
        out[col] = values
        return count

    report["categorical_variants_coating"] = mess("coating_type", COATING_SYNONYMS)
    report["categorical_variants_soil"] = mess("soil_type", SOIL_SYNONYMS)

    # --- 5. Missingness (MNAR) -----------------------------------------------
    missing_counts = {}
    for col, base in MISSING_BASE.items():
        if col not in out.columns:
            continue
        prob = _missing_probability(out, base)
        mask = rng.random(len(out)) < prob
        # Object columns need None; numeric columns need NaN.
        if out[col].dtype == object or out[col].dtype == bool:
            out[col] = out[col].astype(object)
            out.loc[mask, col] = None
        else:
            out.loc[mask, col] = np.nan
        missing_counts[col] = int(mask.sum())
    report["missing_counts"] = missing_counts

    # --- 6. Label noise ------------------------------------------------------
    # The target is not ground truth either. A corrosion rate inferred from two
    # ILI runs inherits both tools' tolerance, and the absolute floor matters
    # because a 0.3 mpy rate is well inside the noise band.
    if "corrosion_rate_mpy" in out.columns:
        true_rate = out["corrosion_rate_mpy"].astype(float).to_numpy()
        relative = rng.normal(1.0, LABEL_NOISE_SIGMA, size=len(out))
        absolute = rng.normal(0.0, LABEL_NOISE_FLOOR_MPY, size=len(out))
        out["corrosion_rate_mpy"] = np.clip(true_rate * relative + absolute, 0, None).round(3)
        report["label_noise_sigma"] = LABEL_NOISE_SIGMA

    # --- 7. Duplicates -------------------------------------------------------
    # Appended last so a duplicate carries its row's damage with it, which is
    # what a genuine double-entry looks like.
    n_dup = int(len(out) * DUPLICATE_RATE)
    dup_idx = rng.choice(len(out), size=n_dup, replace=False)
    duplicates = out.iloc[dup_idx].copy()
    out = pd.concat([out, duplicates], ignore_index=True)
    report["duplicate_rows"] = n_dup
    report["rows_out"] = len(out)

    if verbose:
        print(f"[data quality] {report['rows_in']:,} -> {report['rows_out']:,} rows")
        print(f"  unit errors        : {report['unit_errors']}")
        print(f"  decimal errors     : {report['decimal_errors']}")
        print(f"  duplicates         : {report['duplicate_rows']}")
        print(f"  coating variants   : {report['categorical_variants_coating']}")
        total_missing = sum(missing_counts.values())
        print(f"  missing cells      : {total_missing:,} across {len(missing_counts)} fields")
        for col, n in sorted(missing_counts.items(), key=lambda kv: -kv[1]):
            print(f"      {col:28} {n:5,}  ({100*n/report['rows_in']:.1f}%)")

    return out, report
