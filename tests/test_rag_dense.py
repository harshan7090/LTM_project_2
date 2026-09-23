"""
Dense (embedding) retrieval.

Split from the rest of the suite because these are the only tests that need
Ollama. They skip cleanly when it is absent, so the offline guarantee in
tests/conftest.py still holds — but when the model IS present they measure the
actual retrieval win rather than asserting that a code path exists.

The bug these exist to prevent is the one that was found here: dense retrieval
was fully implemented, built its index, ran on every query, and contributed
*nothing*, because the final filter in `search()` only admitted chunks a
LEXICAL view had already scored. Enabling it changed no result and raised no
error. `test_dense_can_introduce_a_chunk_lexical_missed` is the direct guard.
"""
import pytest

from src.integrity.rag import DENSE_MODEL, DENSE_RELEVANCE, KnowledgeBase

pytestmark = pytest.mark.filterwarnings("ignore")


def _ollama_ready() -> bool:
    try:
        from backend.llm import embedding_model_available
        return embedding_model_available(DENSE_MODEL)
    except Exception:  # noqa: BLE001
        return False


requires_ollama = pytest.mark.skipif(
    not _ollama_ready(),
    reason=f"needs Ollama with '{DENSE_MODEL}' pulled",
)


@pytest.fixture(scope="module")
def kb():
    base = KnowledgeBase()
    if not base.load_dense_index(DENSE_MODEL):
        pytest.skip("no cached dense index — run scripts/build_dense_index.py")
    return base


@pytest.fixture(scope="module")
def embed():
    from backend.llm import ollama_embed
    return lambda texts: ollama_embed(texts, DENSE_MODEL)


# Queries that share no vocabulary with the chunk that answers them. This is
# the entire case for dense retrieval — TF-IDF cannot bridge it however many
# character n-grams it has.
PARAPHRASE = [
    ("how do I stop rust on buried steel",
     {"cathodic_protection", "coatings", "external_corrosion"}),
    ("what eats metal underground",
     {"corrosion_mechanisms", "external_corrosion"}),
    ("is the paint on the pipe failing", {"coatings"}),
    ("checking for leaks without digging", {"inspection_methods"}),
    ("electrical way of protecting pipe", {"cathodic_protection"}),
]

# Queries dense in exact technical tokens. Lexical is already strong here and
# dense must not make it worse.
JARGON = [
    ("what is DCVG", {"inspection_methods"}),
    ("-850 mV CSE criterion", {"cathodic_protection"}),
    ("MIC microbiologically influenced corrosion", {"corrosion_mechanisms"}),
    ("ILI MFL tool", {"inspection_methods"}),
    ("FBE fusion bonded epoxy", {"coatings"}),
]

OFF_TOPIC = ["cheap flights to paris", "best pizza recipe", "who won the world cup"]


def _recall(kb, cases, embed_fn, k=3):
    hits = 0
    for query, expected in cases:
        docs = {h.chunk.doc_id for h in kb.search(query, top_k=k, embed_fn=embed_fn)}
        if docs & expected:
            hits += 1
    return hits


# ------------------------------------------------------------- the index ---

@requires_ollama
def test_cached_index_loads(kb):
    assert kb.stats["dense_enabled"] is True
    assert kb.stats["dense_model"] == DENSE_MODEL


@requires_ollama
def test_index_has_one_vector_per_chunk(kb):
    assert kb._dense.shape[0] == len(kb.chunks)


@requires_ollama
def test_vectors_are_normalised(kb):
    import numpy as np
    norms = np.linalg.norm(kb._dense, axis=1)
    assert np.allclose(norms, 1.0, atol=1e-4)


def test_cache_key_covers_both_corpus_and_model():
    """Either changing must invalidate the cache. Stale vectors would retrieve
    the old text, and mixing two models' vector spaces produces cosines that
    mean nothing — neither would raise."""
    base = KnowledgeBase()
    a = base._dense_cache_path("model-a")
    b = base._dense_cache_path("model-b")
    assert a != b

    original = base.chunks[0].text
    try:
        base.chunks[0].text = original + " an added sentence"
        c = base._dense_cache_path("model-a")
    finally:
        base.chunks[0].text = original
    assert c != a


def test_missing_cache_is_a_false_not_a_crash():
    assert KnowledgeBase().load_dense_index("model-that-was-never-built") is False


# ------------------------------------------------------------- the win -----

@requires_ollama
def test_dense_improves_paraphrase_recall(kb, embed):
    """The measured justification. Lexical alone scored 1/8 on paraphrases."""
    lexical = _recall(kb, PARAPHRASE, None)
    fused = _recall(kb, PARAPHRASE, embed)
    assert fused > lexical, f"dense added nothing: {lexical} -> {fused}"


@requires_ollama
def test_dense_can_introduce_a_chunk_lexical_missed(kb, embed):
    """Direct guard on the bug that was found.

    The filter in `search()` originally admitted a fused hit only if a LEXICAL
    view had scored it, so a chunk only the embedding view found was discarded
    before it could be returned. Dense could reorder, never introduce — which
    meant enabling it produced byte-identical results.
    """
    introduced = False
    for query, _ in PARAPHRASE:
        def ids(fn):
            return {(h.chunk.doc_id, h.chunk.section, h.chunk.text[:40])
                    for h in kb.search(query, top_k=3, embed_fn=fn)}
        lex, fused = ids(None), ids(embed)
        if fused - lex:
            introduced = True
            break
    assert introduced, "no query returned a chunk that lexical had not already found"


@requires_ollama
def test_dense_does_not_degrade_jargon_recall(kb, embed):
    """Lexical is genuinely better on exact technical tokens. Adding dense
    must not cost anything there."""
    assert _recall(kb, JARGON, embed) >= _recall(kb, JARGON, None)


@requires_ollama
def test_off_topic_queries_return_nothing_with_dense_on(kb, embed):
    """The dense admission threshold must not become a back door for noise."""
    for query in OFF_TOPIC:
        assert kb.search(query, embed_fn=embed) == [], f"admitted: {query}"


@requires_ollama
def test_dense_threshold_separates_in_domain_from_out(kb, embed):
    """Measured separation the DENSE_RELEVANCE constant is derived from:
    relevant chunks averaged 0.560, off-topic queries topped out at 0.396."""
    on_topic = max(s for _, s in kb._dense_ranking("cathodic protection rectifier", embed))
    off_topic = max(s for _, s in kb._dense_ranking("best pizza recipe", embed))
    assert on_topic > DENSE_RELEVANCE > off_topic


# ---------------------------------------------------------- degradation ----

def test_search_works_with_no_embed_function(kb_or_skip=None):
    """Lexical-only must remain a fully working state, not a fallback that
    half-works."""
    base = KnowledgeBase()
    hits = base.search("cathodic protection", top_k=3, embed_fn=None)
    assert hits and all(h.chunk.text for h in hits)


@requires_ollama
def test_a_failing_embed_function_degrades_to_lexical(kb):
    """An Ollama timeout mid-request must not take retrieval down with it."""
    def broken(_texts):
        raise RuntimeError("ollama is gone")

    hits = kb.search("cathodic protection", top_k=3, embed_fn=broken)
    assert hits, "retrieval should still return lexical results"
