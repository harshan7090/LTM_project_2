"""
Loads the trained model + dataset once at startup, scores every segment,
and provides per-segment SHAP explanations on demand for the dashboard.

Deliberately reuses the exact model/encoder/preprocessing already built in
src/ — this is NOT a separate ML pipeline, it's the same one wired into an
API. If you retrain with a new model (e.g. swap in FT-Transformer), nothing
here needs to change as long as it still saves to models/corrosion_model.joblib.
"""
import sys
from pathlib import Path

import numpy as np
import shap

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data.database import (  # noqa: E402
    get_engine,
    get_all_acknowledgements,
    insert_acknowledgement,
    read_segments_from_db,
)
from src.data.preprocessing import FEATURE_COLS, preprocess_features  # noqa: E402
from src.models.train import load_trained_model  # noqa: E402

# Risk bands are defined by percentile of PREDICTED rate, not the synthetic
# ground-truth label — in a real deployment you never have ground truth
# ahead of failure, so the dashboard only ever shows what the model predicts.
CRITICAL_PCTL = 0.90
ELEVATED_PCTL = 0.70


class ScoringService:
    def __init__(self):
        self.model, self.encoder = load_trained_model()
        self.engine = get_engine()
        # Segments come from the database (run scripts/load_to_database.py
        # to (re)populate it) — not a direct CSV read. This is what makes it
        # a real database-backed service, browsable in DB Browser for SQLite
        # or pgAdmin, rather than a one-off export nothing actually reads.
        self.df = read_segments_from_db(self.engine)
        self.X, _ = preprocess_features(self.df, encoder=self.encoder)
        self.predicted = self.model.predict(self.X)
        self.df["predicted_rate_mpy"] = self.predicted.round(3)

        self._critical_cutoff = np.quantile(self.predicted, CRITICAL_PCTL)
        self._elevated_cutoff = np.quantile(self.predicted, ELEVATED_PCTL)
        self.df["risk_band"] = self.df["predicted_rate_mpy"].apply(self._band_for)

        self._explainer = shap.TreeExplainer(self.model)
        self._acknowledged: dict[str, dict] = get_all_acknowledgements(self.engine)

    def _band_for(self, rate: float) -> str:
        if rate >= self._critical_cutoff:
            return "critical"
        if rate >= self._elevated_cutoff:
            return "elevated"
        return "normal"

    # ---- Queries -------------------------------------------------------

    def list_segments(self, region: str | None = None, risk_band: str | None = None) -> list[dict]:
        df = self.df
        if region:
            df = df[df["region"] == region]
        if risk_band:
            df = df[df["risk_band"] == risk_band]
        df = df.sort_values("predicted_rate_mpy", ascending=False)
        return [self._row_summary(row) for _, row in df.iterrows()]

    def get_segment(self, segment_id: str) -> dict | None:
        matches = self.df[self.df["segment_id"] == segment_id]
        if matches.empty:
            return None
        row = matches.iloc[0]
        idx = matches.index[0]
        detail = self._row_summary(row)
        detail["attributes"] = {col: self._serialize(row[col]) for col in FEATURE_COLS}
        detail["explanation"] = self._explain_row(idx)
        detail["acknowledged"] = self._acknowledged.get(segment_id)
        return detail

    def acknowledge(self, segment_id: str, by: str) -> bool:
        if segment_id not in set(self.df["segment_id"]):
            return False
        import datetime

        at = datetime.datetime.now().isoformat(timespec="seconds")
        insert_acknowledgement(segment_id, by, at, self.engine)
        self._acknowledged[segment_id] = {"by": by, "at": at}
        return True

    def fleet_stats(self) -> dict:
        band_counts = self.df["risk_band"].value_counts().to_dict()
        region_counts = (
            self.df.groupby("region")["predicted_rate_mpy"].mean().round(2).sort_values(ascending=False).to_dict()
        )
        histogram_counts, histogram_edges = np.histogram(self.predicted, bins=12)
        return {
            "total_segments": len(self.df),
            "risk_band_counts": {b: int(band_counts.get(b, 0)) for b in ("critical", "elevated", "normal")},
            "avg_predicted_rate_by_region": region_counts,
            "histogram": {
                "counts": histogram_counts.tolist(),
                "bin_edges": [round(float(e), 2) for e in histogram_edges],
            },
        }

    def export_at_risk_csv(self) -> str:
        at_risk = self.df[self.df["risk_band"].isin(["critical", "elevated"])].sort_values(
            "predicted_rate_mpy", ascending=False
        )
        cols = ["segment_id", "risk_band", "predicted_rate_mpy"] + FEATURE_COLS
        return at_risk[cols].to_csv(index=False)

    # ---- Internals -------------------------------------------------------

    def _row_summary(self, row) -> dict:
        return {
            "segment_id": row["segment_id"],
            "region": row["region"],
            "predicted_rate_mpy": float(row["predicted_rate_mpy"]),
            "risk_band": row["risk_band"],
            "last_inspection_years_ago": float(row["last_inspection_years_ago"]),
            "acknowledged": self._acknowledged.get(row["segment_id"]) is not None,
        }

    def _explain_row(self, idx: int, top_n: int = 6) -> dict:
        row_X = self.X.loc[[idx]]
        shap_values = self._explainer(row_X)
        row = shap_values[0]
        contributions = sorted(zip(self.X.columns, row.values), key=lambda kv: abs(kv[1]), reverse=True)[:top_n]
        return {
            "base_value": round(float(row.base_values), 3),
            "contributions": [
                {"feature": feat, "impact_mpy": round(float(val), 3)} for feat, val in contributions
            ],
        }

    @staticmethod
    def _serialize(value):
        if isinstance(value, (np.bool_, bool)):
            return bool(value)
        if isinstance(value, (np.integer,)):
            return int(value)
        if isinstance(value, (np.floating,)):
            return round(float(value), 3)
        return value


_service: ScoringService | None = None


def get_service() -> ScoringService:
    global _service
    if _service is None:
        _service = ScoringService()
    return _service
