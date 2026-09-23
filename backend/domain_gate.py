"""
Domain gate: is this question about oil and gas pipeline integrity?

WHAT WAS WRONG WITH THE OLD ONE

  `backend/assistant.py` gates on keyword lists: a question is refused only
  when it contains no in-domain vocabulary AND an explicit off-domain marker.
  That is deliberately biased toward answering, because falsely refusing a
  real engineering question is worse than answering a borderline one.

  But it is a word filter, not a classifier. It cannot recognise an in-domain
  question phrased without jargon ("is the metal getting thinner?"), and it
  cannot recognise an off-domain question that happens to contain a domain
  word ("write me a poem about a pipeline"). Both failures are invisible.

WHAT THIS DOES INSTEAD

  Embeds the question and compares it against two sets of anchor phrases -
  one describing the domain, one describing what the assistant should refuse.
  The decision is the margin between the best in-domain and best out-of-domain
  similarity, not an absolute threshold, because absolute cosine values drift
  with phrasing length while the margin is stable.

  Anchors rather than a trained classifier because there is no labelled
  corpus of in/out-of-domain pipeline questions to train on. Anchor
  similarity needs no training data, is inspectable (you can read why a
  question was refused), and is trivially extended by adding a phrase.

DEGRADATION

  If Ollama or the embedding model is missing, this reports `available=False`
  and the caller keeps using the keyword heuristic. The gate never becomes
  MORE permissive because embeddings are down, and never blocks the console
  from starting.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

import numpy as np

# Phrases describing what the assistant is for. Spread across sub-topics on
# purpose: a single centroid would sit between them and match none well.
IN_DOMAIN_ANCHORS = (
    "external corrosion of a buried steel pipeline",
    "cathodic protection potential and rectifier output",
    "pipeline coating condition and disbondment",
    "in-line inspection tool run and anomaly tally",
    "remaining wall thickness and fitness for service",
    "pipeline integrity management and reassessment interval",
    "soil resistivity and corrosion rate of buried metal",
    "hydrostatic pressure test of a pipeline segment",
    "weld defect and girth weld inspection",
    "high consequence area and class location",
    "pipe repair sleeve and recoating a dig site",
    "microbiologically influenced corrosion in pipelines",
    "stress corrosion cracking on a transmission line",
    "internal corrosion from produced water and CO2",
    "leak detection and pipeline right of way survey",
    "is the metal getting thinner over time",
    "how long before this pipe needs replacing",
    "what does this rust on the pipe mean",
    "which inspection method should we use here",
    "how do we stop this from corroding",
)

# Phrases describing what to refuse. Chosen to cover the categories people
# actually wander into, including ones that borrow domain words.
OUT_DOMAIN_ANCHORS = (
    "book a flight and find a cheap hotel",
    "recipe for dinner and cooking instructions",
    "football match result and league table",
    "write a poem or a short story",
    "medical symptoms and health diagnosis",
    "stock market investment advice",
    "help me debug this javascript function",
    "translate this sentence into french",
    "what is the weather forecast tomorrow",
    "movie recommendations for the weekend",
    "history of the roman empire",
    "how do I lose weight",
    "write a poem about an oil pipeline",
    "tell me a joke about engineers",
    "who should I vote for in the election",
    "explain quantum computing",
    "plan my wedding",
    "what is the capital of france",
)

# Decision margin, in cosine points, between the best in-domain and best
# out-of-domain anchor. Derived from the probe run in tests/test_domain_gate.py
# rather than guessed; see that file for the measured separation.
MARGIN_REFUSE = -0.02   # clearly closer to an off-domain anchor
MARGIN_ACCEPT = 0.02    # clearly closer to an in-domain anchor


@dataclass
class GateDecision:
    in_domain: bool
    confidence: str          # high | low
    margin: float
    best_in: str
    best_out: str
    method: str              # embedding | unavailable

    def to_dict(self) -> dict:
        return {
            "in_domain": self.in_domain,
            "confidence": self.confidence,
            "margin": round(self.margin, 4),
            "closest_in_domain": self.best_in,
            "closest_out_of_domain": self.best_out,
            "method": self.method,
        }


class EmbeddingDomainGate:
    """Anchor-similarity domain classifier over a pluggable embedder."""

    def __init__(self, embed_fn=None, cache_dir: Path | None = None):
        self._embed_fn = embed_fn
        self._anchors: np.ndarray | None = None
        self._cache_dir = cache_dir

    # ------------------------------------------------------------ anchors --
    def _cache_path(self) -> Path | None:
        if self._cache_dir is None:
            return None
        h = hashlib.sha256()
        for phrase in IN_DOMAIN_ANCHORS + OUT_DOMAIN_ANCHORS:
            h.update(phrase.encode("utf-8"))
        self._cache_dir.mkdir(parents=True, exist_ok=True)
        return self._cache_dir / f"domain_anchors_{h.hexdigest()[:16]}.npy"

    def prepare(self) -> bool:
        """Embed (or load) the anchors. Returns whether the gate is usable."""
        if self._anchors is not None:
            return True

        path = self._cache_path()
        if path is not None and path.exists():
            try:
                arr = np.load(path)
                if arr.shape[0] == len(IN_DOMAIN_ANCHORS) + len(OUT_DOMAIN_ANCHORS):
                    self._anchors = arr
                    return True
            except Exception:  # noqa: BLE001
                pass

        if self._embed_fn is None:
            return False

        try:
            vectors = self._embed_fn(list(IN_DOMAIN_ANCHORS + OUT_DOMAIN_ANCHORS))
            arr = np.asarray(vectors, dtype=np.float32)
            norms = np.linalg.norm(arr, axis=1, keepdims=True)
            self._anchors = arr / np.clip(norms, 1e-9, None)
        except Exception:  # noqa: BLE001
            return False

        if path is not None:
            try:
                np.save(path, self._anchors)
            except Exception:  # noqa: BLE001
                pass
        return True

    @property
    def available(self) -> bool:
        return self._anchors is not None

    # ------------------------------------------------------------ decide ---
    def classify(self, question: str) -> GateDecision:
        if not self.prepare() or self._embed_fn is None:
            return GateDecision(True, "low", 0.0, "", "", "unavailable")

        try:
            vec = np.asarray(self._embed_fn([question])[0], dtype=np.float32)
            vec /= max(float(np.linalg.norm(vec)), 1e-9)
        except Exception:  # noqa: BLE001
            return GateDecision(True, "low", 0.0, "", "", "unavailable")

        scores = self._anchors @ vec
        n_in = len(IN_DOMAIN_ANCHORS)
        in_scores, out_scores = scores[:n_in], scores[n_in:]

        best_in_i = int(np.argmax(in_scores))
        best_out_i = int(np.argmax(out_scores))
        margin = float(in_scores[best_in_i] - out_scores[best_out_i])

        # Three-way, not two. The middle band is genuinely ambiguous, and
        # resolving it toward ANSWERING preserves the existing bias: falsely
        # refusing a real engineering question is the worse error.
        if margin >= MARGIN_ACCEPT:
            in_domain, confidence = True, "high"
        elif margin <= MARGIN_REFUSE:
            in_domain, confidence = False, "high"
        else:
            in_domain, confidence = True, "low"

        return GateDecision(
            in_domain=in_domain, confidence=confidence, margin=margin,
            best_in=IN_DOMAIN_ANCHORS[best_in_i],
            best_out=OUT_DOMAIN_ANCHORS[best_out_i],
            method="embedding",
        )


_gate: EmbeddingDomainGate | None = None


def get_domain_gate() -> EmbeddingDomainGate:
    """Shared gate, wired to Ollama embeddings when they are available."""
    global _gate
    if _gate is not None:
        return _gate

    from config.settings import settings

    embed_fn = None
    try:
        from backend.llm import embedding_model_available, ollama_embed
        if embedding_model_available():
            embed_fn = lambda texts: ollama_embed(texts)  # noqa: E731
    except Exception:  # noqa: BLE001
        embed_fn = None

    _gate = EmbeddingDomainGate(
        embed_fn=embed_fn,
        cache_dir=settings.DATA_PROCESSED_DIR / "dense_cache",
    )
    return _gate


def is_in_domain_embedding(question: str) -> tuple[bool, GateDecision]:
    """Convenience wrapper. Returns (allow, decision).

    On `method == "unavailable"` the caller must fall back to the keyword
    heuristic rather than treating the permissive default as a real verdict.
    """
    decision = get_domain_gate().classify(question)
    return decision.in_domain, decision
