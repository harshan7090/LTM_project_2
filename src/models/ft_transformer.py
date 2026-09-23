"""
FT-Transformer — the architecture the project scope originally called for.

WHAT IT IS

  Feature Tokenizer + Transformer (Gorishniy et al., 2021). Every feature,
  numeric or categorical, becomes a token embedding; a [CLS] token is
  prepended; a standard Transformer encoder attends over them; the [CLS]
  output is projected to a scalar. It is the adaptation of the Transformer to
  tabular data, and it lets the model learn feature *interactions* through
  attention rather than through axis-aligned splits.

  Numeric features get a learned per-feature weight and bias (x_i * W_i + b_i)
  rather than being binned. Categoricals get an embedding table. That is the
  "feature tokenizer" half, and it is why the same encoder can handle both.

WHY IT IS AN ALTERNATIVE AND NOT A REPLACEMENT

  Two honest reasons, both measured in tests/test_ft_transformer.py rather
  than asserted:

  1. On tabular data of this size (5,000 rows, 20 features, a deliberately
     noisy label), gradient boosting is a strong baseline that tabular
     transformers frequently fail to beat. The original paper's own result is
     that FT-Transformer is *competitive* with GBDT, not dominant.

  2. Moving off trees costs exact SHAP. `shap.TreeExplainer` computes exact
     Shapley values in polynomial time because it exploits tree structure.
     For a transformer you fall back to sampling-based explainers, which are
     approximate and orders of magnitude slower. The entire explainability
     story of this console — "SEG-04412 is high risk BECAUSE it is uncoated,
     has no CP, and sits in 900 ohm-cm soil" — rests on that exactness.

  So this ships as a selectable model, with the comparison script that shows
  which one actually wins on this data, rather than as a silent upgrade.

DESIGN NOTES

  - CPU-only by default. The target machine has integrated graphics, and a
    model this size trains in about a minute on four threads.
  - Early stopping on a validation split, because a transformer will happily
    memorise 5,000 rows.
  - The saved artifact carries its own preprocessing statistics, so inference
    cannot silently use different normalisation from training — which would
    not raise, it would just be wrong.
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass

import numpy as np

try:
    import torch
    import torch.nn as nn
    TORCH_AVAILABLE = True
except ImportError:  # pragma: no cover - exercised by the skip in the tests
    TORCH_AVAILABLE = False
    torch = None
    nn = object  # so the class body below still parses


@dataclass
class FTConfig:
    """Hyperparameters. Small on purpose — 5,000 rows does not support a big
    model, and the failure mode of over-parameterising here is memorisation
    that looks like a good training curve."""
    d_token: int = 64          # embedding width per feature token
    n_blocks: int = 3
    n_heads: int = 8
    attention_dropout: float = 0.2
    ffn_dropout: float = 0.1
    residual_dropout: float = 0.0
    ffn_factor: float = 1.33   # FFN hidden = d_token * factor
    lr: float = 1e-3
    weight_decay: float = 1e-5
    batch_size: int = 256
    max_epochs: int = 120
    patience: int = 15         # early-stopping patience, in epochs
    seed: int = 42

    def to_dict(self) -> dict:
        return asdict(self)


if TORCH_AVAILABLE:

    class FeatureTokenizer(nn.Module):
        """Turns a row into a sequence of feature tokens.

        Numeric feature i becomes x_i * W_i + b_i (a learned scaling, not a
        bin). Categorical feature j becomes an embedding lookup. Both land in
        the same d_token space so one encoder can attend across them, which is
        the whole point of the architecture.
        """

        def __init__(self, n_numeric: int, cat_cardinalities: list[int], d_token: int):
            super().__init__()
            self.n_numeric = n_numeric
            self.d_token = d_token

            if n_numeric:
                self.num_weight = nn.Parameter(torch.empty(n_numeric, d_token))
                self.num_bias = nn.Parameter(torch.empty(n_numeric, d_token))
                nn.init.uniform_(self.num_weight, -1 / math.sqrt(d_token), 1 / math.sqrt(d_token))
                nn.init.uniform_(self.num_bias, -1 / math.sqrt(d_token), 1 / math.sqrt(d_token))

            self.cat_embeddings = nn.ModuleList([
                nn.Embedding(card + 1, d_token) for card in cat_cardinalities
            ])
            for emb in self.cat_embeddings:
                nn.init.uniform_(emb.weight, -1 / math.sqrt(d_token), 1 / math.sqrt(d_token))

            # The [CLS] token. Its output is the prediction head's input, so
            # it is what the whole sequence gets summarised into.
            self.cls = nn.Parameter(torch.empty(1, 1, d_token))
            nn.init.uniform_(self.cls, -1 / math.sqrt(d_token), 1 / math.sqrt(d_token))

        def forward(self, x_num: torch.Tensor, x_cat: torch.Tensor) -> torch.Tensor:
            batch = x_num.shape[0] if self.n_numeric else x_cat.shape[0]
            tokens = [self.cls.expand(batch, -1, -1)]

            if self.n_numeric:
                # (B, F) -> (B, F, d): broadcast multiply by the per-feature vector
                tokens.append(x_num.unsqueeze(-1) * self.num_weight + self.num_bias)

            for j, emb in enumerate(self.cat_embeddings):
                tokens.append(emb(x_cat[:, j]).unsqueeze(1))

            return torch.cat(tokens, dim=1)

    class FTTransformer(nn.Module):
        def __init__(self, n_numeric: int, cat_cardinalities: list[int],
                     config: FTConfig | None = None):
            super().__init__()
            cfg = config or FTConfig()
            self.config = cfg

            self.tokenizer = FeatureTokenizer(n_numeric, cat_cardinalities, cfg.d_token)

            encoder_layer = nn.TransformerEncoderLayer(
                d_model=cfg.d_token,
                nhead=cfg.n_heads,
                dim_feedforward=int(cfg.d_token * cfg.ffn_factor),
                dropout=cfg.attention_dropout,
                activation="gelu",
                batch_first=True,
                norm_first=True,   # pre-norm: materially more stable at this depth
            )
            self.encoder = nn.TransformerEncoder(encoder_layer, num_layers=cfg.n_blocks)

            self.head = nn.Sequential(
                nn.LayerNorm(cfg.d_token),
                nn.ReLU(),
                nn.Linear(cfg.d_token, 1),
            )

        def forward(self, x_num: torch.Tensor, x_cat: torch.Tensor) -> torch.Tensor:
            tokens = self.tokenizer(x_num, x_cat)
            encoded = self.encoder(tokens)
            # Only the [CLS] position feeds the head.
            return self.head(encoded[:, 0]).squeeze(-1)

else:  # pragma: no cover
    FeatureTokenizer = None
    FTTransformer = None


def torch_is_available() -> bool:
    return TORCH_AVAILABLE
