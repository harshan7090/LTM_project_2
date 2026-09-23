"""
Preprocessing for the pipeline corrosion dataset — shared by training and
inference so encoding is guaranteed consistent between the two.
"""
import pandas as pd
from sklearn.preprocessing import OrdinalEncoder

from src.data.cleaning import clean_dataset, missing_indicator_columns

CATEGORICAL_COLS = ["material", "coating_type", "soil_type", "product_type", "region"]
BOOLEAN_COLS = ["cathodic_protection"]
NUMERIC_COLS = [
    "pipe_age_years",
    "diameter_inches",
    "wall_thickness_mm",
    "soil_resistivity_ohm_cm",
    "operating_pressure_psi",
    "operating_temperature_c",
    "last_inspection_years_ago",
    "historical_repair_count",
]

# Missingness indicators are FEATURES, not bookkeeping.
#
# Records are worse for old, neglected assets — which are also the ones most
# likely to be corroding. That correlation is real signal, and imputing the
# gap away throws it out: the model would be told an unsurveyed 1974 line has
# median soil resistivity, which is false in the dangerous direction. With the
# indicator the model can learn "nobody has surveyed this" as its own
# evidence. See src/data/cleaning.py for why the flags are recorded before
# imputation rather than after.
MISSING_INDICATOR_COLS = missing_indicator_columns()

FEATURE_COLS = NUMERIC_COLS + BOOLEAN_COLS + CATEGORICAL_COLS + MISSING_INDICATOR_COLS
TARGET_COL = "corrosion_rate_mpy"
PRIORITY_LABEL_COL = "needs_priority_inspection"


def load_dataset(path, clean: bool = True) -> pd.DataFrame:
    """Read the dataset and, by default, clean it.

    keep_default_na=False: pandas otherwise silently reads category strings
    like "None" or "NA" as missing values instead of literal text — bit us
    once already with a coating-type category named "None". Cheap insurance.
    Genuinely blank cells still become NaN via na_values.

    `clean=False` returns the raw frame, which is what the data-quality tests
    use to prove the cleaner is doing something.
    """
    df = pd.read_csv(path, keep_default_na=False, na_values=[""])
    if not clean:
        return df
    cleaned, _report = clean_dataset(df)
    return cleaned


def load_dataset_with_report(path) -> tuple[pd.DataFrame, dict]:
    """Same as load_dataset but also returns what the cleaner had to fix."""
    df = pd.read_csv(path, keep_default_na=False, na_values=[""])
    return clean_dataset(df, verbose=True)


def preprocess_features(df: pd.DataFrame, encoder: OrdinalEncoder = None) -> tuple[pd.DataFrame, OrdinalEncoder]:
    """
    Encodes categorical columns to integers (tree models don't need one-hot,
    and this keeps SHAP feature names clean and 1:1 with original columns).
    Pass a fitted `encoder` at inference time to reuse the same mapping.
    """
    # An indicator column is absent if the frame was never cleaned. Treated as
    # "nothing was missing" rather than raising, so a caller holding a
    # pre-cleaning frame still gets a usable matrix.
    for col in MISSING_INDICATOR_COLS:
        if col not in df.columns:
            df = df.copy()
            df[col] = 0

    X = df[FEATURE_COLS].copy()
    X["cathodic_protection"] = X["cathodic_protection"].astype(int)

    if encoder is None:
        encoder = OrdinalEncoder(handle_unknown="use_encoded_value", unknown_value=-1)
        X[CATEGORICAL_COLS] = encoder.fit_transform(X[CATEGORICAL_COLS])
    else:
        X[CATEGORICAL_COLS] = encoder.transform(X[CATEGORICAL_COLS])

    return X, encoder
