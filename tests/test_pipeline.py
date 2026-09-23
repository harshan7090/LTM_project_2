import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.data.cleaning import clean_dataset  # noqa: E402
from src.data.synthetic_generator import generate_pipeline_dataset  # noqa: E402
from src.data.preprocessing import (  # noqa: E402
    BOOLEAN_COLS, CATEGORICAL_COLS, FEATURE_COLS, MISSING_INDICATOR_COLS,
    NUMERIC_COLS, TARGET_COL, preprocess_features,
)

# The generator emits raw observations. Missingness indicators are produced by
# the CLEANER, not the generator — they describe what was absent from the
# record, which is not a fact the physics knows. Splitting the assertion keeps
# that boundary explicit rather than letting the generator quietly acquire a
# responsibility that belongs to src/data/cleaning.py.
RAW_FEATURE_COLS = NUMERIC_COLS + BOOLEAN_COLS + CATEGORICAL_COLS


def test_generated_dataset_has_expected_raw_columns():
    df = generate_pipeline_dataset(n_segments=200)
    for col in RAW_FEATURE_COLS + [TARGET_COL]:
        assert col in df.columns


def test_cleaning_supplies_the_remaining_model_features():
    """Together, the generator and the cleaner must produce every column the
    model expects — this is the seam where a missing feature would otherwise
    only surface at training time."""
    df = generate_pipeline_dataset(n_segments=200)
    cleaned, _ = clean_dataset(df)
    for col in FEATURE_COLS + [TARGET_COL]:
        assert col in cleaned.columns, f"{col} missing after cleaning"


def test_preprocess_tolerates_a_frame_without_indicator_columns():
    """An older caller holding a pre-cleaning frame must still get a usable
    matrix rather than a KeyError."""
    df = generate_pipeline_dataset(n_segments=100)
    X, _ = preprocess_features(df)
    assert list(X.columns) == FEATURE_COLS
    assert X[MISSING_INDICATOR_COLS].sum().sum() == 0


def test_corrosion_rate_is_non_negative():
    df = generate_pipeline_dataset(n_segments=200)
    assert (df["corrosion_rate_mpy"] >= 0).all()


def test_no_cathodic_protection_increases_mean_corrosion_rate():
    """The core physical relationship the label is built on — if this fails,
    the synthetic data generator is broken."""
    df = generate_pipeline_dataset(n_segments=3000)
    with_cp = df[df["cathodic_protection"]]["corrosion_rate_mpy"].mean()
    without_cp = df[~df["cathodic_protection"]]["corrosion_rate_mpy"].mean()
    assert without_cp > with_cp


def test_preprocessing_encodes_categoricals_to_numeric():
    df = generate_pipeline_dataset(n_segments=200)
    X, encoder = preprocess_features(df)
    assert X.select_dtypes(include="object").shape[1] == 0  # nothing left as text
    assert X.shape[0] == 200
    assert X.shape[1] == len(FEATURE_COLS)


def test_preprocessing_encoder_is_reusable_for_new_data():
    df = generate_pipeline_dataset(n_segments=200)
    X_train, encoder = preprocess_features(df)

    df2 = generate_pipeline_dataset(n_segments=50)
    X_new, _ = preprocess_features(df2, encoder=encoder)
    assert list(X_new.columns) == list(X_train.columns)
