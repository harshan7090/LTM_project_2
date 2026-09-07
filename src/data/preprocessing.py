"""
Preprocessing for the pipeline corrosion dataset — shared by training and
inference so encoding is guaranteed consistent between the two.
"""
import pandas as pd
from sklearn.preprocessing import OrdinalEncoder

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
FEATURE_COLS = NUMERIC_COLS + BOOLEAN_COLS + CATEGORICAL_COLS
TARGET_COL = "corrosion_rate_mpy"
PRIORITY_LABEL_COL = "needs_priority_inspection"


def load_dataset(path) -> pd.DataFrame:
    # keep_default_na=False: pandas otherwise silently reads category strings like
    # "None" or "NA" as missing values (NaN) instead of literal text — bit us once
    # already with a coating-type category named "None". Cheap insurance.
    return pd.read_csv(path, keep_default_na=False, na_values=[""])


def preprocess_features(df: pd.DataFrame, encoder: OrdinalEncoder = None) -> tuple[pd.DataFrame, OrdinalEncoder]:
    """
    Encodes categorical columns to integers (tree models don't need one-hot,
    and this keeps SHAP feature names clean and 1:1 with original columns).
    Pass a fitted `encoder` at inference time to reuse the same mapping.
    """
    X = df[FEATURE_COLS].copy()
    X["cathodic_protection"] = X["cathodic_protection"].astype(int)

    if encoder is None:
        encoder = OrdinalEncoder(handle_unknown="use_encoded_value", unknown_value=-1)
        X[CATEGORICAL_COLS] = encoder.fit_transform(X[CATEGORICAL_COLS])
    else:
        X[CATEGORICAL_COLS] = encoder.transform(X[CATEGORICAL_COLS])

    return X, encoder
