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
from src.integrity.consequence import (  # noqa: E402
    assess_consequence, consequence_inputs_from_row, risk_band as band_for_risk,
    risk_score,
)
from src.integrity.remaining_life import assess_from_row  # noqa: E402
from src.integrity.risk_matrix import build_matrix  # noqa: E402
from src.integrity.repair import recommend_repair  # noqa: E402
from src.models.train import load_trained_model  # noqa: E402

# LIKELIHOOD bands are percentiles of the PREDICTED rate, not the synthetic
# ground-truth label — in a real deployment you never have ground truth ahead
# of failure, so the dashboard only ever shows what the model predicts.
#
# These are no longer the primary ranking. `risk_band` is now derived from
# likelihood x consequence (see src/integrity/consequence.py), because a
# corrosion rate on its own cannot prioritise work: a fast-corroding segment
# under farmland is not more urgent than a slower one under a school. The
# likelihood band is retained and exposed alongside it so the two halves of
# the risk product stay separately visible.
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
        self.df["likelihood_band"] = self.df["predicted_rate_mpy"].apply(self._band_for)

        self._score_consequence_and_risk()

        self._explainer = shap.TreeExplainer(self.model)
        self._acknowledged: dict[str, dict] = get_all_acknowledgements(self.engine)

    def _band_for(self, rate: float) -> str:
        if rate >= self._critical_cutoff:
            return "critical"
        if rate >= self._elevated_cutoff:
            return "elevated"
        return "normal"

    def _score_consequence_and_risk(self) -> None:
        """Compute consequence, then risk = likelihood x consequence.

        Likelihood is the PERCENTILE RANK of the predicted rate across the
        fleet, not the raw mpy. Two reasons. A 0-100 consequence multiplied by
        a raw rate produces a number in no interpretable unit; and the rate
        distribution has a long unphysical tail (see README), so normalising
        by the maximum would compress almost every real segment into the
        bottom few percent and make consequence irrelevant. Percentile rank is
        robust to that tail.
        """
        self.df["likelihood_pct"] = (
            self.df["predicted_rate_mpy"].rank(pct=True).astype(float)
        )

        scores, bands, hca, basis, pir = [], [], [], [], []
        for _, row in self.df.iterrows():
            assessment = assess_consequence(consequence_inputs_from_row(row))
            scores.append(assessment.consequence_score)
            bands.append(assessment.consequence_band)
            hca.append(assessment.is_hca)
            basis.append("; ".join(assessment.hca_basis))
            pir.append(assessment.potential_impact_radius_ft)

        self.df["consequence_score"] = scores
        self.df["consequence_band"] = bands
        self.df["is_hca"] = hca
        self.df["hca_basis"] = basis
        self.df["potential_impact_radius_ft"] = pir

        self.df["risk_score"] = [
            risk_score(lp, cs, h) for lp, cs, h
            in zip(self.df["likelihood_pct"], self.df["consequence_score"],
                   self.df["is_hca"])
        ]
        # This is the headline band the console ranks and colours on. It is
        # now RISK, not likelihood.
        self.df["risk_band"] = self.df["risk_score"].apply(band_for_risk)

    # ---- Queries -------------------------------------------------------

    def list_segments(self, region: str | None = None, risk_band: str | None = None) -> list[dict]:
        df = self.df
        if region:
            df = df[df["region"] == region]
        if risk_band:
            df = df[df["risk_band"] == risk_band]
        # Ranked by RISK, not corrosion rate. This is the behavioural change
        # that consequence modelling buys: the top of this list is now the
        # work that most reduces risk, not merely the fastest corrosion.
        df = df.sort_values(["risk_score", "predicted_rate_mpy"], ascending=False)
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
        detail["consequence"] = assess_consequence(
            consequence_inputs_from_row(row)).to_dict()
        detail["remaining_life"] = assess_from_row(
            row, float(row["predicted_rate_mpy"])).to_dict()
        # Repair depends on consequence and remaining life, so it is built
        # last and handed both rather than recomputing them.
        detail["repair"] = recommend_repair(detail).to_dict()
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
        conseq_counts = self.df["consequence_band"].value_counts().to_dict()
        likelihood_counts = self.df["likelihood_band"].value_counts().to_dict()
        hca_total = int(self.df["is_hca"].sum())
        return {
            "total_segments": len(self.df),
            "risk_band_counts": {b: int(band_counts.get(b, 0)) for b in ("critical", "elevated", "normal")},
            "likelihood_band_counts": {
                b: int(likelihood_counts.get(b, 0)) for b in ("critical", "elevated", "normal")
            },
            "consequence_band_counts": {
                b: int(conseq_counts.get(b, 0)) for b in ("high", "medium", "low")
            },
            "hca_segments": hca_total,
            "hca_pct": round(100.0 * hca_total / max(len(self.df), 1), 1),
            "avg_predicted_rate_by_region": region_counts,
            "histogram": {
                "counts": histogram_counts.tolist(),
                "bin_edges": [round(float(e), 2) for e in histogram_edges],
            },
        }

    def risk_matrix(self, region: str | None = None) -> dict:
        """The 5x5, populated from the scored fleet."""
        df = self.df if region is None else self.df[self.df["region"] == region]
        return build_matrix(
            {
                "segment_id": r.segment_id,
                "likelihood_pct": r.likelihood_pct,
                "consequence_score": r.consequence_score,
                "is_hca": r.is_hca,
            }
            for r in df.itertuples()
        )

    def rate_history(self, segment_id: str, years: int = 10) -> list[float]:
        """Back-cast corrosion rate for a sparkline.

        RECONSTRUCTED, NOT RECORDED - and the distinction matters.

        There is no time series in this dataset; there is one predicted rate
        per segment today. The generator's own relationship makes rate grow
        with sqrt(age), so the rate at age a is the current rate scaled by
        sqrt(a / age_now). That is a back-cast under the model's own
        assumption, not measurement, and the UI labels it as such.

        It is deterministic per segment - the same jitter every call - so a
        sparkline does not wobble between renders.
        """
        import numpy as np

        row = self.df[self.df["segment_id"] == segment_id]
        if row.empty:
            return []
        rate = float(row.iloc[0]["predicted_rate_mpy"])
        age = max(float(row.iloc[0]["pipe_age_years"]), 1.0)

        rng = np.random.default_rng(abs(hash(segment_id)) % (2**32))
        out = []
        for k in range(years, 0, -1):
            then = max(age - k, 0.5)
            out.append(round(max(rate * (then / age) ** 0.5
                                 * (1 + rng.normal(0, 0.05)), 0.0), 3))
        out.append(round(rate, 3))
        return out

    def export_at_risk_csv(self) -> str:
        at_risk = self.df[self.df["risk_band"].isin(["critical", "elevated"])].sort_values(
            ["risk_score", "predicted_rate_mpy"], ascending=False
        )
        cols = (["segment_id", "risk_band", "risk_score", "likelihood_band",
                 "predicted_rate_mpy", "consequence_score", "consequence_band",
                 "is_hca", "hca_basis"] + list(FEATURE_COLS))
        cols = [c for c in cols if c in at_risk.columns]
        return at_risk[cols].to_csv(index=False)

    # ---- Internals -------------------------------------------------------

    def _row_summary(self, row) -> dict:
        return {
            "segment_id": row["segment_id"],
            "region": row["region"],
            "predicted_rate_mpy": float(row["predicted_rate_mpy"]),
            # risk_band is likelihood x consequence; likelihood_band is the
            # corrosion rate alone. Both are exposed so the console can show
            # WHY something outranks a faster-corroding segment.
            "risk_band": row["risk_band"],
            "risk_score": round(float(row["risk_score"]), 1),
            "likelihood_band": row["likelihood_band"],
            "consequence_score": round(float(row["consequence_score"]), 1),
            "likelihood_pct": round(float(row["likelihood_pct"]), 4),
            "consequence_band": row["consequence_band"],
            "is_hca": bool(row["is_hca"]),
            # Carried on the summary, not just the detail, because work-order
            # assignment optimises over the whole candidate pool and fetching
            # each segment's detail to learn where it is would be N round trips.
            "latitude": float(row["latitude"]) if "latitude" in row and row["latitude"] is not None else None,
            "longitude": float(row["longitude"]) if "longitude" in row and row["longitude"] is not None else None,
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
