"""
Tests for realistic data degradation and the cleaning that answers it.

The pairing is the point: each defect the injector creates has a test that it
was created, and a test that the cleaner handles it. A cleaner tested only
against data it was written for proves nothing.
"""
import numpy as np
import pandas as pd
import pytest

from src.data.cleaning import (
    MIN_PLAUSIBLE_WALL_MM, MISSING_SUFFIX, UNKNOWN, clean_dataset,
    missing_indicator_columns,
)
from src.data.data_quality import inject_data_quality_issues
from src.data.synthetic_generator import generate_pipeline_dataset


@pytest.fixture(scope="module")
def clean_df():
    return generate_pipeline_dataset(n_segments=600)


@pytest.fixture(scope="module")
def dirty(clean_df):
    return inject_data_quality_issues(clean_df, seed=7)


# ------------------------------------------------------------- injection ---

def test_injection_does_not_mutate_the_input(clean_df):
    before = clean_df.copy()
    inject_data_quality_issues(clean_df, seed=1)
    pd.testing.assert_frame_equal(clean_df, before)


def test_injection_is_reproducible(clean_df):
    a, _ = inject_data_quality_issues(clean_df, seed=11)
    b, _ = inject_data_quality_issues(clean_df, seed=11)
    pd.testing.assert_frame_equal(a, b)


def test_different_seeds_give_different_damage(clean_df):
    a, ra = inject_data_quality_issues(clean_df, seed=1)
    b, rb = inject_data_quality_issues(clean_df, seed=2)
    assert ra["missing_counts"] != rb["missing_counts"]


def test_missingness_is_introduced(dirty):
    df, report = dirty
    assert sum(report["missing_counts"].values()) > 0
    assert df["soil_resistivity_ohm_cm"].isna().sum() > 0


def test_missingness_is_mnar_not_random(dirty):
    """The design claim: records are worse for OLD assets. If missingness were
    uniform, median imputation would handle it and the indicator columns would
    be pointless — so this asserts the property the rest of the pipeline is
    built around."""
    df, _ = dirty
    missing = df["soil_resistivity_ohm_cm"].isna()
    age_when_missing = df.loc[missing, "pipe_age_years"].mean()
    age_when_present = df.loc[~missing, "pipe_age_years"].mean()
    assert age_when_missing > age_when_present * 1.15


def test_duplicates_are_added(dirty):
    df, report = dirty
    assert report["duplicate_rows"] > 0
    assert len(df) == report["rows_in"] + report["duplicate_rows"]
    assert df["segment_id"].duplicated().sum() == report["duplicate_rows"]


def test_categorical_variants_appear(dirty):
    df, _ = dirty
    assert df["coating_type"].nunique() > 4


def test_unit_errors_produce_impossibly_thin_walls(dirty):
    df, report = dirty
    assert report["unit_errors"] > 0
    thin = df["wall_thickness_mm"].dropna() < MIN_PLAUSIBLE_WALL_MM
    assert thin.sum() > 0


def test_label_noise_changes_the_target_without_shifting_it(clean_df):
    """Tool tolerance is noise, not bias. If the mean moved materially the
    injector would be teaching the model a wrong average."""
    dirty_df, _ = inject_data_quality_issues(clean_df, seed=3)
    original = clean_df["corrosion_rate_mpy"]
    noisy = dirty_df["corrosion_rate_mpy"].iloc[:len(original)]
    assert not np.allclose(original, noisy)
    assert noisy.mean() == pytest.approx(original.mean(), rel=0.10)


def test_target_never_goes_negative(dirty):
    df, _ = dirty
    assert (df["corrosion_rate_mpy"].dropna() >= 0).all()


# -------------------------------------------------------------- cleaning ---

def test_cleaning_does_not_mutate_the_input(dirty):
    df, _ = dirty
    before = df.copy()
    clean_dataset(df)
    pd.testing.assert_frame_equal(df, before)


def test_duplicates_are_removed_exactly(dirty):
    df, inject_report = dirty
    cleaned, report = clean_dataset(df)
    assert report["duplicates_removed"] == inject_report["duplicate_rows"]
    assert cleaned["segment_id"].duplicated().sum() == 0


def test_categorical_variants_collapse_to_canonical(dirty):
    df, _ = dirty
    cleaned, _ = clean_dataset(df)
    coatings = set(cleaned["coating_type"].unique()) - {UNKNOWN}
    assert coatings <= {"FBE", "Coal Tar Enamel", "Polyethylene Tape", "Uncoated"}
    soils = set(cleaned["soil_type"].unique()) - {UNKNOWN}
    assert soils <= {"Clay", "Sandy", "Loam", "Rocky"}


def test_unit_errors_are_repaired_to_plausible_values(dirty):
    df, _ = dirty
    cleaned, report = clean_dataset(df)
    assert report["unit_errors_repaired"] > 0
    assert (cleaned["wall_thickness_mm"] >= MIN_PLAUSIBLE_WALL_MM).all()


def test_no_nulls_survive_cleaning(dirty):
    df, _ = dirty
    cleaned, _ = clean_dataset(df)
    for col in ("wall_thickness_mm", "soil_resistivity_ohm_cm", "coating_type",
                "cathodic_protection", "last_inspection_years_ago"):
        assert cleaned[col].isna().sum() == 0, f"{col} still has nulls"


def test_missing_indicators_are_created_for_every_flagged_field(dirty):
    df, _ = dirty
    cleaned, _ = clean_dataset(df)
    for col in missing_indicator_columns():
        assert col in cleaned.columns
        assert set(cleaned[col].unique()) <= {0, 1}


def test_indicators_are_recorded_before_imputation(dirty):
    """The ordering bug this guards against is silent: impute first and every
    indicator is zero, the column still exists, and the information is gone."""
    df, _ = dirty
    cleaned, _ = clean_dataset(df)
    flagged = cleaned[f"soil_resistivity_ohm_cm{MISSING_SUFFIX}"].sum()
    assert flagged > 0, "indicator is all-zero — it was written after imputation"


def test_indicator_marks_the_same_rows_that_were_blank(dirty):
    df, _ = dirty
    deduped = df.drop_duplicates(subset=["segment_id"], keep="first").reset_index(drop=True)
    was_blank = deduped["operating_temperature_c"].isna()
    cleaned, _ = clean_dataset(df)
    flag = cleaned[f"operating_temperature_c{MISSING_SUFFIX}"].astype(bool)
    assert (flag.to_numpy() == was_blank.to_numpy()).all()


def test_unrecorded_cp_is_treated_as_absent_not_present(dirty):
    """Conservative default. Assuming protection that cannot be evidenced is
    the error that actually hurts someone."""
    df, _ = dirty
    cleaned, _ = clean_dataset(df)
    imputed = cleaned[cleaned[f"cathodic_protection{MISSING_SUFFIX}"] == 1]
    assert len(imputed) > 0
    assert not imputed["cathodic_protection"].any()


def test_implausible_pressure_is_blanked_then_imputed(dirty):
    df, _ = dirty
    cleaned, report = clean_dataset(df)
    assert cleaned["operating_pressure_psi"].max() <= 2500.0
    assert cleaned["operating_pressure_psi"].isna().sum() == 0


def test_cleaning_is_idempotent(dirty):
    """Running it twice must not change anything the second time — otherwise
    a re-ingest slowly mutates the corpus."""
    df, _ = dirty
    once, _ = clean_dataset(df)
    twice, report = clean_dataset(once)
    assert report["duplicates_removed"] == 0
    assert report.get("unit_errors_repaired", 0) == 0
    assert len(once) == len(twice)


def test_cleaning_handles_an_already_clean_frame(clean_df):
    cleaned, report = clean_dataset(clean_df)
    assert report["duplicates_removed"] == 0
    assert len(cleaned) == len(clean_df)


def test_cleaning_survives_a_frame_missing_optional_columns():
    """A pre-existing dataset has no consequence or coordinate columns."""
    minimal = pd.DataFrame({
        "segment_id": ["A", "B"],
        "pipe_age_years": [10.0, 20.0],
        "last_inspection_years_ago": [1.0, 2.0],
        "wall_thickness_mm": [10.0, 12.0],
    })
    cleaned, report = clean_dataset(minimal)
    assert len(cleaned) == 2
    assert report["duplicates_removed"] == 0


# ------------------------------------------------------ end-to-end value ---

def test_cleaning_measurably_helps_a_model(clean_df):
    """The whole justification for the cleaning pipeline.

    EXPERIMENTAL DESIGN MATTERS HERE, and the first version of this test got
    it wrong. Comparing "naive fill" against "cleaned" on their own held-out
    splits made the naive pipeline look BETTER — because it keeps the
    duplicate rows, and a duplicated segment can land in train and test at
    once. The naive model was partly scoring on rows it had memorised.

    That is not a quirk of the test; it is the actual reason deduplication
    matters, and measuring it wrongly would have hidden it.

    So both pipelines are evaluated against the SAME clean, never-degraded
    holdout, which is the only comparison that answers the real question:
    which preprocessing produces a model that generalises to reality.
    """
    from sklearn.metrics import r2_score
    from xgboost import XGBRegressor

    from src.data.preprocessing import TARGET_COL, preprocess_features

    # Hold out whole segments, before any degradation, as ground truth.
    holdout_ids = set(clean_df["segment_id"].iloc[::4])
    truth_test = clean_df[clean_df["segment_id"].isin(holdout_ids)].copy()
    train_clean = clean_df[~clean_df["segment_id"].isin(holdout_ids)].copy()

    dirty_train, _ = inject_data_quality_issues(train_clean, seed=5)

    naive = dirty_train.copy()
    for c in ("coating_type", "soil_type", "material", "product_type", "region"):
        naive[c] = naive[c].fillna(UNKNOWN).astype(str)
    for c in naive.select_dtypes(include=[np.number]).columns:
        naive[c] = naive[c].fillna(naive[c].median())
    naive["cathodic_protection"] = naive["cathodic_protection"].fillna(False).astype(bool)

    cleaned, _ = clean_dataset(dirty_train)

    X_test, _ = preprocess_features(truth_test)
    y_test = truth_test[TARGET_COL]

    def score(train_df):
        X, _ = preprocess_features(train_df)
        m = XGBRegressor(n_estimators=200, max_depth=4, random_state=42)
        m.fit(X, train_df[TARGET_COL])
        return r2_score(y_test, m.predict(X_test[X.columns]))

    assert score(cleaned) > score(naive)


def test_duplicates_leak_between_train_and_test_if_not_removed(clean_df):
    """Why deduplication has to happen FIRST, demonstrated rather than argued.

    A duplicated segment present in both train and test lets the model score
    on a row it memorised, which inflates the apparent performance of any
    pipeline that leaves duplicates in.
    """
    from sklearn.model_selection import train_test_split

    dirty_df, report = inject_data_quality_issues(clean_df, seed=5)
    assert report["duplicate_rows"] > 0

    train, test = train_test_split(dirty_df, test_size=0.25, random_state=42)
    overlap = set(train["segment_id"]) & set(test["segment_id"])
    assert len(overlap) > 0, "expected duplicated segments to straddle the split"

    cleaned, _ = clean_dataset(dirty_df)
    ctrain, ctest = train_test_split(cleaned, test_size=0.25, random_state=42)
    assert not (set(ctrain["segment_id"]) & set(ctest["segment_id"]))
