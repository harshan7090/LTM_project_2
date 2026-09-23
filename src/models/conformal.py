"""
Conformal prediction — calibrated uncertainty on the corrosion rate.

WHY A POINT ESTIMATE IS THE WRONG OUTPUT FOR THIS

  Everything downstream of the model is a decision under uncertainty.
  Remaining life divides by the rate; the scheduler ranks on it; the repair
  window is set by it. All of them currently consume a single number as
  though it were exact, and the model's R^2 is 0.68 - which means it is
  routinely wrong by a factor that matters.

  What an integrity engineer needs is not a better point estimate. It is a
  BOUND: "12 mpy, and with 90% confidence not worse than 19." Conservative
  planning uses the upper bound, and having it changes the remaining-life
  figure from a guess into a range you can defend.

WHY CONFORMAL AND NOT QUANTILE REGRESSION

  Quantile regression predicts the 5th and 95th percentiles directly. It is
  easy and it is uncalibrated: nothing forces the resulting interval to
  actually contain the truth 90% of the time, and on this data it does not.

  Split conformal prediction gives a FINITE-SAMPLE, DISTRIBUTION-FREE
  guarantee. Hold out a calibration set the model never saw, measure the
  residuals on it, and take the appropriate quantile as the interval width.
  The coverage guarantee

      P(y in [lower, upper]) >= 1 - alpha

  holds for ANY model, ANY data distribution, and any finite sample size.
  The only assumption is exchangeability between calibration and test data.
  It is not asymptotic and it does not assume normal errors - which matters
  here, where the residuals are right-skewed.

NORMALISED CONFORMAL, AND WHY IT IS THE DEFAULT

  Plain split conformal gives every segment the SAME interval width. That is
  valid but nearly useless here: a segment predicted at 0.3 mpy and one at
  14 mpy get the same +/- 1.4, which is meaningless on the first and far too
  tight on the second. Corrosion residuals are strongly heteroscedastic.

  The normalised variant scales each residual by a difficulty estimate - a
  second model trained to predict the absolute error - so the interval
  widens where the model is genuinely less certain. It keeps the coverage
  guarantee and makes the width informative.

  `evaluate_coverage` measures the empirical coverage on held-out data, so
  the guarantee is verified rather than cited.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from sklearn.model_selection import train_test_split


@dataclass
class Interval:
    lower: np.ndarray
    point: np.ndarray
    upper: np.ndarray
    alpha: float

    @property
    def width(self) -> np.ndarray:
        return self.upper - self.lower

    def covers(self, y_true: np.ndarray) -> np.ndarray:
        return (y_true >= self.lower) & (y_true <= self.upper)


class ConformalRegressor:
    """Split-conformal wrapper around any fitted-by-`fit`/`predict` model.

    Deliberately model-agnostic: it takes a factory rather than an instance,
    so the same wrapper works over XGBoost today and the FT-Transformer or
    anything else later without a line changing here.
    """

    def __init__(self, model_factory, difficulty_factory=None,
                 calibration_size: float = 0.25, random_state: int = 42,
                 normalized: bool = True):
        self.model_factory = model_factory
        # The difficulty model predicts |residual|. Defaults to the same
        # class as the main model, which is almost always the right choice -
        # error structure tends to look like the thing it is error on.
        self.difficulty_factory = difficulty_factory or model_factory
        self.calibration_size = calibration_size
        self.random_state = random_state
        self.normalized = normalized

        self.model = None
        self.difficulty = None
        self.scores_: np.ndarray | None = None
        self.n_calibration_: int = 0

    # Guards against division blowing the interval up where the difficulty
    # model predicts a near-zero error.
    MIN_DIFFICULTY = 0.05

    def fit(self, X, y):
        """Fit on a proper-training split, calibrate on the rest.

        The calibration set must be data the model has NEVER seen. Calibrating
        on training data collapses the residuals toward zero and produces
        intervals that are far too narrow while still looking rigorous -
        which is the one way to get this badly wrong.
        """
        X_prop, X_cal, y_prop, y_cal = train_test_split(
            X, y, test_size=self.calibration_size,
            random_state=self.random_state)

        self.model = self.model_factory()
        self.model.fit(X_prop, y_prop)

        residuals = np.abs(np.asarray(y_cal) - self.model.predict(X_cal))

        if self.normalized:
            # Trained on the PROPER-TRAINING residuals, not the calibration
            # ones - using the calibration residuals to build the scaler and
            # then to calibrate against it leaks and breaks the guarantee.
            prop_resid = np.abs(np.asarray(y_prop) - self.model.predict(X_prop))
            self.difficulty = self.difficulty_factory()
            self.difficulty.fit(X_prop, prop_resid)
            scale = np.maximum(self.difficulty.predict(X_cal), self.MIN_DIFFICULTY)
            self.scores_ = residuals / scale
        else:
            self.scores_ = residuals

        self.n_calibration_ = len(self.scores_)
        return self

    def _quantile(self, alpha: float) -> float:
        """The conformal quantile.

        The (n+1) correction is what makes the guarantee finite-sample rather
        than asymptotic. Dropping it - using a plain empirical quantile -
        under-covers slightly at every sample size, and the error is largest
        exactly when the calibration set is small.
        """
        n = self.n_calibration_
        level = min(1.0, np.ceil((n + 1) * (1 - alpha)) / n)
        return float(np.quantile(self.scores_, level, method="higher"))

    def predict_interval(self, X, alpha: float = 0.1) -> Interval:
        """Prediction interval with marginal coverage of at least 1 - alpha."""
        if self.scores_ is None:
            raise RuntimeError("Call fit() before predict_interval().")

        point = np.asarray(self.model.predict(X), dtype=float)
        q = self._quantile(alpha)

        if self.normalized:
            scale = np.maximum(self.difficulty.predict(X), self.MIN_DIFFICULTY)
            half = q * scale
        else:
            half = np.full_like(point, q)

        # A corrosion rate cannot be negative, so the lower bound is clipped.
        # This can only INCREASE coverage, never reduce it, so the guarantee
        # survives.
        return Interval(lower=np.maximum(point - half, 0.0),
                        point=point,
                        upper=point + half,
                        alpha=alpha)

    def evaluate_coverage(self, X_test, y_test, alpha: float = 0.1) -> dict:
        """Measure what the guarantee actually delivers on held-out data."""
        iv = self.predict_interval(X_test, alpha)
        y = np.asarray(y_test, dtype=float)
        covered = iv.covers(y)
        return {
            "nominal_coverage": round(1 - alpha, 3),
            "empirical_coverage": round(float(covered.mean()), 4),
            "mean_width": round(float(iv.width.mean()), 3),
            "median_width": round(float(np.median(iv.width)), 3),
            "n_test": int(len(y)),
            "n_calibration": self.n_calibration_,
            "normalized": self.normalized,
        }


def planning_rate(interval: Interval, index: int) -> float:
    """The rate a conservative plan should actually use: the upper bound.

    Remaining life divides by this, so taking the point estimate is
    optimistic in exactly the direction that hurts - it puts the repair date
    later than the evidence supports.
    """
    return float(interval.upper[index])
