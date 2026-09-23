"""
Retrieval-augmented generation over a corrosion-engineering knowledge base.

WHY TF-IDF AND NOT A VECTOR DATABASE:

  The corpus here is a curated set of corrosion engineering notes — on the
  order of a hundred chunks, not a million. At that scale a vector database is
  pure overhead: it adds a service to run, a model to download, and a new
  failure mode, in exchange for nothing measurable.

  There is also a specific reason lexical retrieval is a good fit for THIS
  domain: the queries are dense with exact technical jargon — "DCVG", "SP0169",
  "MIC", "−850 mV", "ECDA". Those are precisely the terms TF-IDF matches best
  and that dense embeddings are most likely to blur together. Sparse retrieval
  is not the compromise choice here; for jargon-heavy technical lookup it is
  frequently the better one.

  scikit-learn is already a dependency (it trains the corrosion model), so this
  adds no new packages and works completely offline.

TWO LEXICAL VIEWS, NOT ONE:

  Word-level TF-IDF alone has a specific and damaging blind spot here: it does
  no stemming, so a query for "how often should I inspect" scores exactly zero
  against a corpus that says "inspection". That is a legitimate engineering
  question returning no reference material at all — a far worse failure than
  returning a mediocre passage.

  Rather than bolt on a stemmer (and a dependency), the index carries a second
  character-n-gram view. Character n-grams match "inspect" inside "inspection",
  "corrod" inside "corroding", and "resistiv" inside "resistivity" without
  needing any linguistic rules, and they degrade gracefully on the technical
  tokens a stemmer would mangle. The two rankings are fused with RRF.

  Measured on a 23-query probe set, this took worst-case recall on relevant
  queries from 0.000 to a usable score while leaving the ranking of already-
  good queries essentially unchanged.

OPTIONAL DENSE RETRIEVAL:

  If an embedding model is available through Ollama (nothing is downloaded
  automatically — the user has to `ollama pull nomic-embed-text`), the
  retriever fuses lexical and dense rankings with Reciprocal Rank Fusion. RRF
  is used rather than score averaging because TF-IDF cosine scores and
  embedding cosine scores are not on a comparable scale, so averaging them
  silently lets one dominate. RRF only uses rank position, which sidesteps that.

  Dense retrieval is strictly an enhancement: if the model is missing or the
  call fails, retrieval falls back to lexical with no error.
"""
import re
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from sklearn.feature_extraction.text import TfidfVectorizer  # noqa: E402
from sklearn.metrics.pairwise import cosine_similarity  # noqa: E402

from config.settings import settings  # noqa: E402

KNOWLEDGE_DIR = settings.ROOT_DIR / "data" / "knowledge"

# Chunks shorter than this are merged into the next one — a heading with two
# lines under it retrieves badly on its own.
MIN_CHUNK_CHARS = 260

# RRF constant. 60 is the value from the original Cormack et al. paper and
# works well without tuning.
RRF_K = 60

# How far down each ranking RRF looks. Beyond this the contributions are tiny
# and it only adds noise to the fused set.
RRF_DEPTH = 25

# Character n-grams score nonzero against almost any text, so a floor is
# needed before the ranking is meaningful at all.
CHAR_FLOOR = 0.02

# Relevance floors used to trim the fused result.
#
# Tuned against a 25-query probe set (17 on-topic, 8 off-topic). Worth
# recording what that measurement actually showed, because it is the reason
# these are floors and not a gate:
#
#   NO threshold on any measured signal separates on-topic from off-topic
#   queries. Not word cosine, not char cosine, not the peakedness ratio of top
#   score to median. They all overlap. "chocolate cake baking temperature"
#   scores 0.221 on char cosine — higher than several genuine engineering
#   questions — because "temperature" really is all over a corrosion corpus.
#   The best combined rule found was 16/17 recall at 5/8 false positives,
#   which is not a usable gate.
#
#   That is a property of lexical retrieval over a small corpus, not a tuning
#   failure. A retriever returns its best match for whatever it is asked; it
#   has no concept of "this question isn't about my subject."
#
# So the topic boundary is the domain gate in backend/assistant.py, which runs
# BEFORE retrieval. These floors only trim the obvious tail. At these values
# the probe set gives full recall on on-topic queries with the worst of the
# off-topic noise removed.
MIN_RELEVANCE = 0.11
CHAR_RELEVANCE = 0.12

# Admission threshold for the dense view, on embedding cosine — a different
# scale from the TF-IDF floors above, which is exactly why it needs its own
# constant rather than reusing MIN_RELEVANCE.
#
# Measured against nomic-embed-text on a 5-query paraphrase probe and 3
# deliberately off-topic queries: relevant chunks averaged 0.560, off-topic
# queries topped out at 0.396. At 0.45 the gate admits 44/45 relevant chunks
# and 0/93 off-topic ones.
#
# Worth noting what this does NOT do: dense cosine barely separates the
# CORRECT document from a wrong one within the domain (0.560 vs 0.527). It
# separates in-domain from out-of-domain. So it is an admission gate, not a
# ranking signal — RRF still decides the order.
DENSE_RELEVANCE = 0.45

# The embedding model the cached dense index is built with. Named here rather
# than passed around so the build script and the console cannot disagree about
# which vector space the cache holds.
DENSE_MODEL = "nomic-embed-text"


@dataclass
class Chunk:
    doc_id: str
    doc_title: str
    section: str
    text: str

    @property
    def citation(self) -> str:
        return f"{self.doc_title} — {self.section}" if self.section else self.doc_title


@dataclass
class Hit:
    chunk: Chunk
    score: float

    def to_dict(self) -> dict:
        return {
            "citation": self.chunk.citation,
            "doc_id": self.chunk.doc_id,
            "section": self.chunk.section,
            "text": self.chunk.text,
            "score": round(float(self.score), 4),
        }


# ------------------------------------------------------------- chunking ----

def _split_markdown(path: Path) -> list[Chunk]:
    """Splits a markdown file on its headings. Heading-based chunking beats
    fixed-size windows here because the corpus is written with one topic per
    heading, so the natural boundaries are already the right ones."""
    raw = path.read_text(encoding="utf-8")
    lines = raw.splitlines()

    doc_title = path.stem.replace("_", " ").title()
    for line in lines:
        if line.startswith("# "):
            doc_title = line[2:].strip()
            break

    chunks: list[Chunk] = []
    section = ""
    buf: list[str] = []

    def flush():
        text = "\n".join(buf).strip()
        if text:
            chunks.append(Chunk(path.stem, doc_title, section, text))

    for line in lines:
        heading = re.match(r"^(#{2,4})\s+(.*)$", line)
        if heading:
            flush()
            buf = []
            section = heading.group(2).strip()
        elif line.startswith("# "):
            continue  # document title, already captured
        else:
            buf.append(line)
    flush()

    # Merge chunks that are too small to retrieve well.
    merged: list[Chunk] = []
    for c in chunks:
        if merged and len(c.text) < MIN_CHUNK_CHARS:
            prev = merged[-1]
            merged[-1] = Chunk(
                prev.doc_id, prev.doc_title,
                f"{prev.section} / {c.section}".strip(" /"),
                f"{prev.text}\n\n{c.text}",
            )
        else:
            merged.append(c)
    return merged


# ------------------------------------------------------------ retriever ----

class KnowledgeBase:
    """Loads the corpus once and answers similarity queries against it."""

    def __init__(self, directory: Path | None = None):
        self.directory = Path(directory or KNOWLEDGE_DIR)
        self.chunks: list[Chunk] = []
        self._vectorizer: TfidfVectorizer | None = None
        self._matrix = None
        self._char_vectorizer: TfidfVectorizer | None = None
        self._char_matrix = None
        self._dense: np.ndarray | None = None
        self._dense_model: str | None = None
        self._load()

    # -- loading
    def _load(self) -> None:
        if not self.directory.exists():
            return
        for path in sorted(self.directory.glob("*.md")):
            self.chunks.extend(_split_markdown(path))

        if not self.chunks:
            return

        # sublinear_tf dampens the effect of a term repeating many times in one
        # chunk, which matters when a section says "coating" fifteen times.
        self._vectorizer = TfidfVectorizer(
            stop_words="english",
            ngram_range=(1, 2),
            sublinear_tf=True,
            min_df=1,
            # Keep tokens like "sp0169", "b31.8", "h2s" and "-850" intact rather
            # than letting the default pattern shred them.
            token_pattern=r"(?u)\b[\w\-\.]{2,}\b",
        )
        corpus = [f"{c.doc_title} {c.section} {c.text}" for c in self.chunks]
        self._matrix = self._vectorizer.fit_transform(corpus)

        # Character n-grams: the morphology safety net described in the module
        # docstring. `char_wb` keeps n-grams inside word boundaries, so it
        # matches word fragments rather than spanning unrelated words.
        self._char_vectorizer = TfidfVectorizer(
            analyzer="char_wb",
            ngram_range=(4, 5),
            sublinear_tf=True,
            min_df=2,          # a 4-gram appearing once is noise, not signal
            max_features=60000,
        )
        self._char_matrix = self._char_vectorizer.fit_transform(corpus)

    # -- optional dense index
    def _dense_cache_path(self, model_name: str) -> Path:
        """Cache keyed on BOTH the corpus and the model.

        Either changing invalidates the vectors: re-embedding a rewritten
        knowledge base with stale vectors would retrieve the old text, and
        mixing two models' vector spaces produces cosines that mean nothing.
        Neither would raise.
        """
        import hashlib
        h = hashlib.sha256()
        h.update(model_name.encode("utf-8"))
        for c in self.chunks:
            h.update(c.text.encode("utf-8"))
        cache_dir = settings.ROOT_DIR / "data" / "processed" / "dense_cache"
        cache_dir.mkdir(parents=True, exist_ok=True)
        return cache_dir / f"{h.hexdigest()[:16]}.npy"

    def load_dense_index(self, model_name: str) -> bool:
        """Reload a cached dense index. Embedding 31 chunks on CPU takes about
        76 seconds, which is far too slow to pay on every server start."""
        path = self._dense_cache_path(model_name)
        if not path.exists():
            return False
        try:
            arr = np.load(path)
            if arr.shape[0] != len(self.chunks):
                return False
            self._dense = arr
            self._dense_model = model_name
            return True
        except Exception:  # noqa: BLE001
            return False

    def build_dense_index(self, embed_fn, model_name: str) -> bool:
        """Builds the dense half of the index. `embed_fn` takes a list of
        strings and returns a matching list of vectors. Returns False (without
        raising) if embedding fails — dense retrieval is optional."""
        if not self.chunks:
            return False
        try:
            vectors = embed_fn([f"{c.section}. {c.text}" for c in self.chunks])
            arr = np.asarray(vectors, dtype=np.float32)
            if arr.ndim != 2 or arr.shape[0] != len(self.chunks):
                return False
            norms = np.linalg.norm(arr, axis=1, keepdims=True)
            self._dense = arr / np.clip(norms, 1e-9, None)
            self._dense_model = model_name
            try:
                np.save(self._dense_cache_path(model_name), self._dense)
            except Exception:  # noqa: BLE001
                pass  # a cache that cannot be written is not a failure
            return True
        except Exception:
            self._dense = None
            self._dense_model = None
            return False

    @property
    def ready(self) -> bool:
        return bool(self.chunks) and self._matrix is not None

    @property
    def stats(self) -> dict:
        docs = {c.doc_id for c in self.chunks}
        return {
            "documents": len(docs),
            "chunks": len(self.chunks),
            "dense_enabled": self._dense is not None,
            "dense_model": self._dense_model,
            "directory": str(self.directory),
        }

    # -- search
    def _lexical_ranking(self, query: str) -> list[tuple[int, float]]:
        q = self._vectorizer.transform([query])
        scores = cosine_similarity(q, self._matrix).ravel()
        order = np.argsort(-scores)
        return [(int(i), float(scores[i])) for i in order if scores[i] > 0]

    def _char_ranking(self, query: str) -> list[tuple[int, float]]:
        if self._char_matrix is None:
            return []
        q = self._char_vectorizer.transform([query])
        scores = cosine_similarity(q, self._char_matrix).ravel()
        order = np.argsort(-scores)
        # Character n-grams produce a nonzero score against almost anything, so
        # a floor is required here or the ranking is mostly noise.
        return [(int(i), float(scores[i])) for i in order if scores[i] > CHAR_FLOOR]

    def _dense_ranking(self, query: str, embed_fn) -> list[tuple[int, float]]:
        try:
            vec = np.asarray(embed_fn([query])[0], dtype=np.float32)
            vec /= max(float(np.linalg.norm(vec)), 1e-9)
            scores = self._dense @ vec
            order = np.argsort(-scores)
            return [(int(i), float(scores[i])) for i in order]
        except Exception:
            return []

    def search(self, query: str, top_k: int = 4, embed_fn=None,
               min_score: float = MIN_RELEVANCE) -> list[Hit]:
        """Returns the best-matching chunks.

        Fuses a word-level and a character-level lexical ranking (plus a dense
        ranking when one is available) with RRF.

        On `min_score` — be honest about what it can and cannot do. It is a
        weak secondary filter, not a topic gate. Measured on a probe set, no
        single cosine threshold cleanly separates on-topic from off-topic
        queries: "cheap flights to paris" scored higher than several genuine
        engineering questions. The real topic boundary is the domain gate in
        backend/assistant.py, which runs BEFORE retrieval. This floor only
        trims obvious noise from the tail.
        """
        if not self.ready or not query.strip():
            return []

        lexical = self._lexical_ranking(query)
        char = self._char_ranking(query)

        rankings = [r for r in (lexical, char) if r]
        if not rankings:
            return []

        dense: list[tuple[int, float]] = []
        if self._dense is not None and embed_fn is not None:
            dense = self._dense_ranking(query, embed_fn)
            if dense:
                rankings.append(dense)

        # A single ranking needs no fusion, and fusing would discard the real
        # cosine score that `min_score` is expressed in.
        if len(rankings) == 1 and rankings[0] is lexical:
            return [Hit(self.chunks[i], s) for i, s in lexical[:top_k] if s >= min_score]

        # Keep a fused hit only if at least one view found it genuinely
        # relevant — RRF alone would happily surface a chunk that every ranking
        # placed near the bottom.
        best_word = dict(lexical)
        best_char = dict(char)
        best_dense = dict(dense)
        # A chunk survives if ANY view found it genuinely relevant.
        #
        # The dense clause is load-bearing and was missing. Without it a chunk
        # that only the embedding view found — which is precisely the
        # paraphrase case dense exists to solve — was filtered out before it
        # could be returned. Dense could reorder chunks lexical had already
        # found, but could never introduce one, so enabling it changed nothing
        # at all: same hits, same order, no error. Measured before the fix,
        # paraphrase recall@3 was 1/8 with dense on and 1/8 with it off.
        return [
            Hit(self.chunks[idx], score)
            for idx, score in self._fuse(rankings, top_k)
            if best_word.get(idx, 0.0) >= min_score
            or best_char.get(idx, 0.0) >= CHAR_RELEVANCE
            or best_dense.get(idx, 0.0) >= DENSE_RELEVANCE
        ]

    @staticmethod
    def _fuse(rankings: list[list[tuple[int, float]]], top_k: int) -> list[tuple[int, float]]:
        """Reciprocal Rank Fusion: score = sum over rankings of 1/(k + rank).

        Uses rank position only, so the rankings' incomparable score scales
        (word TF-IDF cosine, char TF-IDF cosine, embedding cosine) don't need
        to be normalised against each other — averaging them would silently let
        whichever has the widest range dominate.

        Returns (chunk_index, fused_score) so the caller can cross-reference
        the original per-view scores without an O(n) lookup.
        """
        fused: dict[int, float] = {}
        for ranking in rankings:
            for rank, (idx, _) in enumerate(ranking[:RRF_DEPTH]):
                fused[idx] = fused.get(idx, 0.0) + 1.0 / (RRF_K + rank + 1)
        return sorted(fused.items(), key=lambda kv: -kv[1])[:top_k]


# ------------------------------------------------------------ singleton ----

_kb: KnowledgeBase | None = None


def get_knowledge_base() -> KnowledgeBase:
    """The shared knowledge base, with a cached dense index if one exists.

    Loading the cache costs about 3 ms, so it is done eagerly. BUILDING it
    costs about 160 s, so it is never done here — `scripts/build_dense_index.py`
    does that, and until it has been run retrieval is lexical-only and
    /api/assistant/status says so. Degrading quietly to lexical is correct;
    blocking a server start for two and a half minutes is not.
    """
    global _kb
    if _kb is None:
        _kb = KnowledgeBase()
        try:
            _kb.load_dense_index(DENSE_MODEL)
        except Exception:  # noqa: BLE001
            pass  # lexical-only is a working state, not an error
    return _kb


def format_context(hits: list[Hit]) -> str:
    """Renders retrieved chunks for the prompt, with citations the model is
    instructed to reuse so answers are traceable back to the source."""
    if not hits:
        return ""
    parts = ["REFERENCE MATERIAL retrieved from the engineering knowledge base.",
             "Cite these by their [n] marker when you use them.", ""]
    for n, hit in enumerate(hits, start=1):
        parts.append(f"[{n}] {hit.chunk.citation}\n{hit.chunk.text}\n")
    return "\n".join(parts)
