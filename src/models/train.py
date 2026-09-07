"""
Baseline corrosion-rate prediction model.

Uses XGBoost rather than the FT-Transformer specified in the project scope
for now — it trains in seconds on this dataset size, needs no GPU, and SHAP
support is first-class, which makes it the right choice for proving the
pipeline (data -> model -> explainability -> prioritization) end-to-end
before investing in the transformer architecture. Swapping in an
FT-Transformer later only touches this file — preprocessing, SHAP, and the
prioritization script are all model-agnostic.
"""
import joblib
import numpy as np
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.model_selection import train_test_split
from xgboost import XGBRegressor

from config.settings import settings
from src.data.preprocessing import FEATURE_COLS, TARGET_COL, load_dataset, preprocess_features


def train_model(data_path):
    df = load_dataset(data_path)
    X, encoder = preprocess_features(df)
    y = df[TARGET_COL]

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=settings.RANDOM_SEED
    )

    model = XGBRegressor(
        n_estimators=300,
        max_depth=5,
        learning_rate=0.05,
        subsample=0.8,
        colsample_bytree=0.8,
        random_state=settings.RANDOM_SEED,
    )
    model.fit(X_train, y_train)

    preds = model.predict(X_test)
    mae = mean_absolute_error(y_test, preds)
    r2 = r2_score(y_test, preds)

    print(f"Test MAE:  {mae:.3f} mils/year")
    print(f"Test R^2:  {r2:.3f}")

    joblib.dump(model, settings.MODELS_DIR / "corrosion_model.joblib")
    joblib.dump(encoder, settings.MODELS_DIR / "categorical_encoder.joblib")
    print(f"Saved model to {settings.MODELS_DIR}")

    return model, encoder, X_train, X_test, y_train, y_test


def load_trained_model():
    model = joblib.load(settings.MODELS_DIR / "corrosion_model.joblib")
    encoder = joblib.load(settings.MODELS_DIR / "categorical_encoder.joblib")
    return model, encoder
