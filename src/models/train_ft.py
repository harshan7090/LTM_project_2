"""
Training for the FT-Transformer, and the head-to-head against XGBoost.

WHAT MATTERS HERE, BEYOND THE ARCHITECTURE

  Normalisation statistics travel WITH the model. A transformer over
  standardised inputs that is later fed raw ones does not raise — it returns
  confident nonsense. The saved artifact therefore carries the means, standard
  deviations and category cardinalities it was fitted with, and inference
  reuses them rather than recomputing from whatever data it happens to see.

  The target is trained in log1p space. Corrosion rate is right-skewed even
  after the physical ceiling, and squared error on the raw scale lets a
  handful of high-rate segments dominate the gradient. Predictions are
  expm1'd back before any metric is computed, so the reported MAE and R^2 are
  on the real mils-per-year scale and are directly comparable with XGBoost.
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass

import numpy as np
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.model_selection import train_test_split

from config.settings import settings
from src.data.preprocessing import (
    BOOLEAN_COLS, CATEGORICAL_COLS, MISSING_INDICATOR_COLS, NUMERIC_COLS,
    TARGET_COL, load_dataset,
)
from src.models.ft_transformer import FTConfig, FTTransformer, torch_is_available

# Numeric side of the token sequence: the continuous features plus the
# booleans and missingness flags, which are 0/1 numerics rather than
# categories with their own embedding tables.
FT_NUMERIC_COLS = NUMERIC_COLS + BOOLEAN_COLS + list(MISSING_INDICATOR_COLS)
FT_CATEGORICAL_COLS = CATEGORICAL_COLS


@dataclass
class FTArtifact:
    """Everything inference needs. Kept together so normalisation cannot
    drift away from the weights that were trained against it."""
    state_dict: dict
    config: dict
    numeric_cols: list
    categorical_cols: list
    num_mean: np.ndarray
    num_std: np.ndarray
    cat_maps: list          # one {value: index} per categorical column
    log_target: bool


def _encode(df, cat_maps=None):
    """Numeric matrix + integer categorical matrix.

    Unseen categories map to the reserved index 0 — the embedding tables are
    sized cardinality+1 for exactly that. Without it a category that appears
    only at inference time indexes out of bounds.
    """
    x_num = df[FT_NUMERIC_COLS].to_numpy(dtype=np.float32)

    if cat_maps is None:
        cat_maps = []
        for col in FT_CATEGORICAL_COLS:
            values = sorted(df[col].astype(str).unique())
            cat_maps.append({v: i + 1 for i, v in enumerate(values)})

    x_cat = np.zeros((len(df), len(FT_CATEGORICAL_COLS)), dtype=np.int64)
    for j, col in enumerate(FT_CATEGORICAL_COLS):
        mapping = cat_maps[j]
        x_cat[:, j] = [mapping.get(str(v), 0) for v in df[col]]

    return x_num, x_cat, cat_maps


def train_ft_transformer(data_path=None, config: FTConfig | None = None,
                         verbose: bool = True):
    """Train and return (artifact, metrics). Raises if torch is absent."""
    if not torch_is_available():
        raise RuntimeError(
            "PyTorch is not installed. Run: pip install torch\n"
            "The XGBoost path in src/models/train.py needs no extra packages."
        )

    import torch
    from torch.utils.data import DataLoader, TensorDataset

    cfg = config or FTConfig()
    torch.manual_seed(cfg.seed)
    np.random.seed(cfg.seed)

    path = data_path or (settings.DATA_PROCESSED_DIR / "synthetic_pipeline_corrosion.csv")
    df = load_dataset(path)

    x_num, x_cat, cat_maps = _encode(df)
    y = df[TARGET_COL].to_numpy(dtype=np.float32)

    # Same split seed as the XGBoost path, so the comparison is on identical
    # rows rather than on a different draw.
    idx = np.arange(len(df))
    tr_idx, te_idx = train_test_split(idx, test_size=0.2,
                                      random_state=settings.RANDOM_SEED)
    tr_idx, va_idx = train_test_split(tr_idx, test_size=0.15,
                                      random_state=settings.RANDOM_SEED)

    # Statistics from TRAIN only. Fitting them on the full set leaks test
    # distribution into training and quietly inflates the score.
    mean = x_num[tr_idx].mean(axis=0)
    std = x_num[tr_idx].std(axis=0)
    std[std < 1e-6] = 1.0

    def prep(i):
        return (torch.tensor((x_num[i] - mean) / std, dtype=torch.float32),
                torch.tensor(x_cat[i], dtype=torch.long),
                torch.tensor(np.log1p(y[i]), dtype=torch.float32))

    train_ds = TensorDataset(*prep(tr_idx))
    val_ds = TensorDataset(*prep(va_idx))
    train_dl = DataLoader(train_ds, batch_size=cfg.batch_size, shuffle=True)
    val_dl = DataLoader(val_ds, batch_size=512)

    cardinalities = [len(m) for m in cat_maps]
    model = FTTransformer(len(FT_NUMERIC_COLS), cardinalities, cfg)
    optimiser = torch.optim.AdamW(model.parameters(), lr=cfg.lr,
                                  weight_decay=cfg.weight_decay)
    scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(
        optimiser, mode="min", factor=0.5, patience=5)
    loss_fn = torch.nn.MSELoss()

    best_val, best_state, bad_epochs = float("inf"), None, 0
    started = time.time()

    for epoch in range(cfg.max_epochs):
        model.train()
        for xb_num, xb_cat, yb in train_dl:
            optimiser.zero_grad()
            loss = loss_fn(model(xb_num, xb_cat), yb)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimiser.step()

        model.eval()
        with torch.no_grad():
            val_loss = float(np.mean([
                loss_fn(model(a, b), c).item() for a, b, c in val_dl
            ]))
        scheduler.step(val_loss)

        if val_loss < best_val - 1e-5:
            best_val, bad_epochs = val_loss, 0
            best_state = {k: v.clone() for k, v in model.state_dict().items()}
        else:
            bad_epochs += 1
            if bad_epochs >= cfg.patience:
                if verbose:
                    print(f"  early stop at epoch {epoch + 1} "
                          f"(no improvement for {cfg.patience})")
                break

        if verbose and (epoch + 1) % 10 == 0:
            print(f"  epoch {epoch + 1:3}  val_loss {val_loss:.4f}")

    if best_state is not None:
        model.load_state_dict(best_state)

    # --- test metrics, on the real mpy scale --------------------------------
    model.eval()
    with torch.no_grad():
        preds_log = model(
            torch.tensor((x_num[te_idx] - mean) / std, dtype=torch.float32),
            torch.tensor(x_cat[te_idx], dtype=torch.long),
        ).numpy()
    preds = np.expm1(preds_log).clip(0, None)
    truth = y[te_idx]

    metrics = {
        "model": "ft_transformer",
        "test_r2": float(r2_score(truth, preds)),
        "test_mae": float(mean_absolute_error(truth, preds)),
        "train_seconds": round(time.time() - started, 1),
        "parameters": int(sum(p.numel() for p in model.parameters())),
        "epochs_trained": epoch + 1,
    }

    artifact = FTArtifact(
        state_dict={k: v.numpy() for k, v in model.state_dict().items()},
        config=cfg.to_dict(),
        numeric_cols=list(FT_NUMERIC_COLS),
        categorical_cols=list(FT_CATEGORICAL_COLS),
        num_mean=mean, num_std=std, cat_maps=cat_maps, log_target=True,
    )

    if verbose:
        print(f"\n  Test R^2 : {metrics['test_r2']:.3f}")
        print(f"  Test MAE : {metrics['test_mae']:.3f} mils/year")
        print(f"  Params   : {metrics['parameters']:,}")
        print(f"  Trained  : {metrics['train_seconds']}s, "
              f"{metrics['epochs_trained']} epochs")

    return artifact, metrics


def save_ft_artifact(artifact: FTArtifact, path=None):
    import torch
    path = path or (settings.MODELS_DIR / "ft_transformer.pt")
    torch.save({
        "state_dict": {k: torch.tensor(v) for k, v in artifact.state_dict.items()},
        "config": artifact.config,
        "numeric_cols": artifact.numeric_cols,
        "categorical_cols": artifact.categorical_cols,
        "num_mean": artifact.num_mean,
        "num_std": artifact.num_std,
        "cat_maps": artifact.cat_maps,
        "log_target": artifact.log_target,
    }, path)
    return path


def compare_with_xgboost(data_path=None, verbose: bool = True) -> dict:
    """Train both on the same split and report the comparison.

    The point of this function is that the answer is measured rather than
    assumed in either direction. A transformer is not automatically better
    because it is newer, and gradient boosting is not automatically better
    because the data is tabular.
    """
    from xgboost import XGBRegressor

    from src.data.preprocessing import preprocess_features

    path = data_path or (settings.DATA_PROCESSED_DIR / "synthetic_pipeline_corrosion.csv")
    df = load_dataset(path)

    X, _ = preprocess_features(df)
    y = df[TARGET_COL]
    X_tr, X_te, y_tr, y_te = train_test_split(
        X, y, test_size=0.2, random_state=settings.RANDOM_SEED)

    started = time.time()
    xgb = XGBRegressor(n_estimators=300, max_depth=5, learning_rate=0.05,
                       subsample=0.8, colsample_bytree=0.8,
                       random_state=settings.RANDOM_SEED)
    xgb.fit(X_tr, y_tr)
    xgb_preds = xgb.predict(X_te)
    xgb_metrics = {
        "model": "xgboost",
        "test_r2": float(r2_score(y_te, xgb_preds)),
        "test_mae": float(mean_absolute_error(y_te, xgb_preds)),
        "train_seconds": round(time.time() - started, 1),
        "parameters": int(xgb.get_booster().num_boosted_rounds()),
    }

    if verbose:
        print("=== XGBoost ===")
        print(f"  Test R^2 : {xgb_metrics['test_r2']:.3f}")
        print(f"  Test MAE : {xgb_metrics['test_mae']:.3f} mils/year")
        print(f"  Trained  : {xgb_metrics['train_seconds']}s")
        print("\n=== FT-Transformer ===")

    _artifact, ft_metrics = train_ft_transformer(path, verbose=verbose)

    result = {"xgboost": xgb_metrics, "ft_transformer": ft_metrics}
    result["winner"] = ("ft_transformer"
                        if ft_metrics["test_r2"] > xgb_metrics["test_r2"]
                        else "xgboost")
    result["r2_delta"] = round(ft_metrics["test_r2"] - xgb_metrics["test_r2"], 4)

    out = settings.MODELS_DIR / "model_comparison.json"
    out.write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result
