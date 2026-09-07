"""
SHAP explainability for the corrosion model — both global (which features
drive corrosion risk overall) and per-segment (why THIS pipe segment was
flagged), which is the "explainability" half of IntegrityAI's scope.
"""
import matplotlib

matplotlib.use("Agg")  # headless-safe: never opens a GUI window
import matplotlib.pyplot as plt
import shap

from config.settings import settings


def explain_global(model, X, out_path=None):
    """Global feature importance — which factors matter most across all segments."""
    explainer = shap.TreeExplainer(model)
    shap_values = explainer(X)

    plt.figure()
    shap.summary_plot(shap_values, X, show=False)
    out_path = out_path or (settings.MODELS_DIR / "shap_summary.png")
    plt.tight_layout()
    plt.savefig(out_path, dpi=120)
    plt.close()
    print(f"Saved global SHAP summary plot to {out_path}")
    return shap_values


def explain_segment(model, X, segment_index: int, segment_id: str = "") -> dict:
    """
    Per-segment explanation: which features pushed THIS segment's predicted
    corrosion rate up or down, and by how much — this is what a maintenance
    engineer would actually want to see for a flagged pipe.
    """
    explainer = shap.TreeExplainer(model)
    shap_values = explainer(X)

    row = shap_values[segment_index]
    contributions = sorted(
        zip(X.columns, row.values), key=lambda kv: abs(kv[1]), reverse=True
    )

    print(f"\nExplanation for segment {segment_id or segment_index}:")
    print(f"  Base rate (average across all segments): {row.base_values:.3f} mpy")
    for feature, contribution in contributions[:5]:
        direction = "increases" if contribution > 0 else "decreases"
        print(f"  {feature:28s} {direction} predicted rate by {abs(contribution):.3f} mpy")

    return {"base_value": float(row.base_values), "contributions": contributions}
