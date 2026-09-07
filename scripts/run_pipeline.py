"""
Runs the full IntegrityAI pipeline end-to-end on the synthetic dataset:
generate data -> train model -> evaluate -> global SHAP explanation ->
per-segment explanation for the single highest-risk segment (a concrete
example of "inspection prioritization" with a reason attached).

Usage:
    python scripts/run_pipeline.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from config.settings import settings  # noqa: E402
from src.data.synthetic_generator import generate_pipeline_dataset  # noqa: E402
from src.data.preprocessing import preprocess_features, TARGET_COL  # noqa: E402
from src.models.train import train_model  # noqa: E402
from src.explain.shap_explain import explain_global, explain_segment  # noqa: E402


def main():
    data_path = settings.DATA_PROCESSED_DIR / "synthetic_pipeline_corrosion.csv"
    if not data_path.exists():
        print("No dataset found — generating synthetic pipeline data...")
        df = generate_pipeline_dataset(n_segments=5000)
        df.to_csv(data_path, index=False)
        print(f"Generated {len(df):,} segments -> {data_path}")

    print("\n--- Training model ---")
    model, encoder, X_train, X_test, y_train, y_test = train_model(data_path)

    print("\n--- Global SHAP explanation ---")
    explain_global(model, X_test)

    print("\n--- Highest-risk segment in the test set ---")
    highest_risk_idx = y_test.reset_index(drop=True).idxmax()
    explain_segment(model, X_test.reset_index(drop=True), highest_risk_idx)

    print("\nPipeline complete. Artifacts saved in models/:")
    for f in sorted(settings.MODELS_DIR.iterdir()):
        print(f"  {f.name}")


if __name__ == "__main__":
    main()
