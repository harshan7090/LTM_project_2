"""
Tests for the OpenRouter provider's model discovery.

The catalogue is stubbed rather than fetched, so these run offline and do not
depend on whatever OpenRouter happens to be listing today. The payload shapes
are taken from the real /models response.

That is deliberate even though the live API IS reachable. The free roster
turns over constantly - checked once against the live catalogue, exactly 1 of
14 free vision models matched the preference list this provider shipped with -
so a test asserting on real model names would fail for reasons that have
nothing to do with the code.

The filtering is worth testing carefully because both failure directions are
expensive. Missing a free vision model means falling back to a 1.8B local
model unnecessarily. Selecting a PAID model means an unexpected bill.
"""
import pytest

from backend.openrouter import OpenRouterProvider

FREE = {"prompt": "0", "completion": "0"}
PAID = {"prompt": "0.000003", "completion": "0.000015"}


def entry(ident, pricing, modalities=("text",)):
    return {
        "id": ident,
        "pricing": dict(pricing),
        "architecture": {"input_modalities": list(modalities)},
    }


CATALOGUE = [
    entry("qwen/qwen2.5-vl-72b-instruct:free", FREE, ("text", "image")),
    entry("meta-llama/llama-3.2-11b-vision-instruct:free", FREE, ("text", "image")),
    entry("google/gemma-3-27b-it:free", FREE, ("text", "image")),
    entry("deepseek/deepseek-r1:free", FREE, ("text",)),
    entry("meta-llama/llama-3.3-70b-instruct:free", FREE, ("text",)),
    entry("anthropic/claude-opus-4", PAID, ("text", "image")),
    entry("openai/gpt-4o", PAID, ("text", "image")),
]


@pytest.fixture
def provider(monkeypatch):
    p = OpenRouterProvider("test-key", None, None)
    monkeypatch.setattr(p, "_catalogue", lambda: CATALOGUE)
    return p


# ------------------------------------------------------------- pricing ----

def test_free_is_decided_on_price_not_on_the_name_suffix():
    """':free' is a naming convention; pricing is what bills. A model priced
    above zero must be rejected however it is named."""
    assert OpenRouterProvider.is_free(entry("x:free", FREE))
    assert not OpenRouterProvider.is_free(entry("y:free", PAID))
    assert OpenRouterProvider.is_free(entry("z-no-suffix", FREE))


def test_missing_or_malformed_pricing_is_treated_as_paid():
    """Fail closed. An unparseable price must never be assumed free."""
    assert not OpenRouterProvider.is_free({"id": "a"})
    assert not OpenRouterProvider.is_free({"id": "b", "pricing": {}})
    assert not OpenRouterProvider.is_free(
        {"id": "c", "pricing": {"prompt": "n/a", "completion": "n/a"}})


def test_no_paid_model_is_ever_selected(provider):
    st = provider.status()
    paid = {e["id"] for e in CATALOGUE if not OpenRouterProvider.is_free(e)}
    assert st.model not in paid
    assert st.vision_model not in paid


# ------------------------------------------------------------ vision ------

def test_vision_detected_from_declared_modalities():
    assert OpenRouterProvider.sees_images(entry("a", FREE, ("text", "image")))
    assert not OpenRouterProvider.sees_images(entry("b", FREE, ("text",)))


def test_vision_falls_back_to_the_name_only_when_modalities_are_absent():
    """A name hint is a reasonable guess and a poor contract, so it is the
    fallback rather than the primary test."""
    assert OpenRouterProvider.sees_images({"id": "qwen/qwen2.5-vl-7b"})
    assert OpenRouterProvider.sees_images({"id": "meta/llama-3.2-vision"})
    assert not OpenRouterProvider.sees_images({"id": "deepseek/deepseek-r1"})


def test_declared_modalities_override_a_misleading_name():
    """A text-only model whose id happens to contain 'vision' must not be
    offered for image work — that fails at call time, which is the worst
    place to find out."""
    misleading = entry("someone/vision-tuned-text-model", FREE, ("text",))
    assert not OpenRouterProvider.sees_images(misleading)


def test_free_vision_list_excludes_paid_and_text_only(provider):
    vision = set(provider.free_vision_models())
    assert "qwen/qwen2.5-vl-72b-instruct:free" in vision
    assert "deepseek/deepseek-r1:free" not in vision      # free but text-only
    assert "openai/gpt-4o" not in vision                   # vision but paid


# ---------------------------------------------------------- preference ----

def test_the_largest_vision_model_is_preferred(provider):
    """Ordering is the whole value of the preference list — 72B reads a
    photograph far better than 11B."""
    assert provider.status().vision_model == "qwen/qwen2.5-vl-72b-instruct:free"


def test_a_configured_vision_model_is_honoured_when_free(monkeypatch):
    p = OpenRouterProvider("k", None, "google/gemma-3-27b-it:free")
    monkeypatch.setattr(p, "_catalogue", lambda: CATALOGUE)
    assert p.status().vision_model == "google/gemma-3-27b-it:free"


def test_a_configured_model_that_is_paid_is_ignored(monkeypatch):
    """Silently spending money because a name was configured would be the
    worst possible behaviour here."""
    p = OpenRouterProvider("k", None, "openai/gpt-4o")
    monkeypatch.setattr(p, "_catalogue", lambda: CATALOGUE)
    assert p.status().vision_model != "openai/gpt-4o"


def test_a_configured_chat_model_that_does_not_exist_falls_back_and_says_so(monkeypatch):
    """The Groq scar: a decommissioned hardcoded model 404s on every request
    and looks like a broken integration."""
    p = OpenRouterProvider("k", "vendor/retired-model", None)
    monkeypatch.setattr(p, "_catalogue", lambda: CATALOGUE)
    st = p.status()
    assert st.available
    assert st.model != "vendor/retired-model"
    assert "falling back" in st.detail


# -------------------------------------------------------------- status ----

def test_no_key_is_unavailable_with_actionable_guidance():
    st = OpenRouterProvider("", None, None).status()
    assert not st.available
    assert "openrouter.ai/keys" in st.detail


def test_unreachable_catalogue_is_unavailable_not_a_crash(monkeypatch):
    p = OpenRouterProvider("k", None, None)
    monkeypatch.setattr(p, "_catalogue", lambda: [])
    st = p.status()
    assert not st.available
    assert "could not be fetched" in st.detail


def test_catalogue_with_no_free_models_is_reported_clearly(monkeypatch):
    p = OpenRouterProvider("k", None, None)
    monkeypatch.setattr(p, "_catalogue", lambda: [entry("x/paid", PAID)])
    st = p.status()
    assert not st.available
    assert "No free-tier model" in st.detail


def test_free_text_but_no_free_vision_still_works_for_chat(monkeypatch):
    """Photo analysis should degrade to local Ollama, not take chat down."""
    p = OpenRouterProvider("k", None, None)
    monkeypatch.setattr(p, "_catalogue", lambda: [entry("d/r1:free", FREE, ("text",))])
    st = p.status()
    assert st.available
    assert st.supports_vision is False
    assert "falls back to local Ollama" in st.detail


def test_image_call_raises_rather_than_sending_to_a_blind_model(monkeypatch):
    p = OpenRouterProvider("k", None, None)
    monkeypatch.setattr(p, "_catalogue", lambda: [entry("d/r1:free", FREE, ("text",))])
    from backend.llm import LLMError
    with pytest.raises(LLMError):
        p.chat_with_image([{"role": "user", "content": "x"}], "aGk=", "image/png")


def test_catalogue_is_cached_per_instance_not_per_class(monkeypatch):
    """A class-level cache would leak one account's catalogue into another
    provider instance in the same process."""
    a = OpenRouterProvider("k1", None, None)
    b = OpenRouterProvider("k2", None, None)
    monkeypatch.setattr(a, "_catalogue", lambda: CATALOGUE)
    a.status()
    assert b._cached is None


# ------------------------------------------------------------ wiring ------

def test_provider_is_selectable_by_name():
    from backend.llm import build_provider

    class Cfg:
        OPENROUTER_API_KEY = "k"
        LLM_MODEL = None
        LLM_VISION_MODEL = None

    assert build_provider("openrouter", Cfg()).name == "openrouter"


def test_openrouter_is_preferred_over_groq_when_both_keys_exist():
    """Vision quality is the weakest link, and OpenRouter is the only free
    route to a 70B-class vision model."""
    from backend.llm import auto_select

    class Cfg:
        LLM_PROVIDER = ""
        OPENROUTER_API_KEY = "k"
        GROQ_API_KEY = "g"
        HUGGINGFACE_API_KEY = ""
        OLLAMA_HOST = "http://localhost:11434"
        LLM_MODEL = None
        LLM_VISION_MODEL = None

    assert auto_select(Cfg()).name == "openrouter"


def test_explicit_provider_choice_still_wins():
    """Silently using a different backend than the one configured makes
    misconfiguration impossible to debug."""
    from backend.llm import auto_select

    class Cfg:
        LLM_PROVIDER = "mock"
        OPENROUTER_API_KEY = "k"
        GROQ_API_KEY = "g"
        HUGGINGFACE_API_KEY = ""
        OLLAMA_HOST = "http://localhost:11434"
        LLM_MODEL = None
        LLM_VISION_MODEL = None

    assert auto_select(Cfg()).name == "mock"


# ================================================== purpose filtering ======
# Added after checking the provider against the LIVE catalogue for the first
# time. Two things only showed up there: the free roster had turned over so
# completely that 1 of 14 free vision models matched the old preference list,
# and several zero-priced models accept images without being able to describe
# one.

MUSIC = {
    "id": "google/lyria-3-pro-preview",
    "name": "Google: Lyria 3 Pro",
    "description": "Music generation model.",
    "pricing": dict(FREE),
    "context_length": 1048576,
    "architecture": {"input_modalities": ["text", "image"]},
}
SAFETY = {
    "id": "nvidia/nemotron-3.5-content-safety:free",
    "name": "NVIDIA: Nemotron Content Safety",
    "description": "Content safety classifier.",
    "pricing": dict(FREE),
    "context_length": 128000,
    "architecture": {"input_modalities": ["text", "image"]},
}
ROUTER = {
    "id": "openrouter/free",
    "name": "OpenRouter: Auto",
    "description": "Routes to whichever free model is available.",
    "pricing": dict(FREE),
    "context_length": 200000,
    "architecture": {"input_modalities": ["text", "image"]},
}
REAL_VL = {
    "id": "inclusionai/ling-3.0-flash-vl:free",
    "name": "inclusionAI: Ling 3.0 Flash VL (free)",
    "description": "Adds native visual perception and advanced visual reasoning.",
    "pricing": dict(FREE),
    "context_length": 262144,
    "top_provider": {"max_completion_tokens": 32768},
    "architecture": {"input_modalities": ["text", "image", "video"]},
}
SMALL_VL = {
    "id": "vendor/small-vision:free",
    "name": "Small Vision",
    "description": "A compact multimodal model.",
    "pricing": dict(FREE),
    "context_length": 8192,
    "top_provider": {"max_completion_tokens": 2048},
    "architecture": {"input_modalities": ["text", "image"]},
}

LIVE_SHAPED = [MUSIC, SAFETY, ROUTER, REAL_VL, SMALL_VL]


@pytest.fixture
def live_like(monkeypatch):
    p = OpenRouterProvider("k", None, None)
    monkeypatch.setattr(p, "_catalogue", lambda: LIVE_SHAPED)
    return p


def test_a_music_model_that_accepts_images_is_not_a_vision_model():
    """google/lyria-3-pro-preview is priced at zero and declares
    input_modalities ['text','image']. It generates music. Every
    modality-based check passes it, and it would have been selected as the
    best free vision model because it has the largest context window."""
    assert OpenRouterProvider.is_excluded_purpose(MUSIC)


def test_a_safety_classifier_is_not_a_describer():
    assert OpenRouterProvider.is_excluded_purpose(SAFETY)


def test_a_meta_router_is_not_a_model():
    assert OpenRouterProvider.is_excluded_purpose(ROUTER)


def test_a_genuine_vl_model_is_not_excluded():
    assert not OpenRouterProvider.is_excluded_purpose(REAL_VL)


def test_excluded_purposes_never_reach_the_candidate_list(live_like):
    vision = live_like.free_vision_models()
    assert "google/lyria-3-pro-preview" not in vision
    assert "nvidia/nemotron-3.5-content-safety:free" not in vision
    assert "openrouter/free" not in vision
    assert "inclusionai/ling-3.0-flash-vl:free" in vision


def test_excluded_purposes_are_kept_out_of_chat_too(live_like):
    """A music model is no more useful for text than for vision."""
    assert "google/lyria-3-pro-preview" not in live_like.free_chat_models()


# ------------------------------------------------- metadata-driven rank ----

def test_ranking_prefers_an_explicit_vision_signal_over_raw_context():
    """A purpose-built VL model beats one that merely accepts an image, even
    when the latter has a bigger window."""
    incidental = {
        "id": "vendor/big-context:free", "name": "Big Context",
        "description": "A large language model.",
        "pricing": dict(FREE), "context_length": 2_000_000,
        "architecture": {"input_modalities": ["text", "image"]},
    }
    assert OpenRouterProvider.vision_rank(REAL_VL) < OpenRouterProvider.vision_rank(incidental)


def test_ranking_prefers_more_context_among_equals():
    assert OpenRouterProvider.vision_rank(REAL_VL) < OpenRouterProvider.vision_rank(SMALL_VL)


def test_ranked_list_is_ordered_best_first(live_like):
    vision = live_like.free_vision_models()
    assert vision[0] == "inclusionai/ling-3.0-flash-vl:free"


def test_selection_survives_a_catalogue_matching_no_preference_name(monkeypatch):
    """The failure the live check exposed: the old code ranked ONLY by a
    hardcoded name list, and the real free roster matched 1 of 14. Selection
    must still work when it matches none."""
    unfamiliar = [{
        "id": "brandnew/unheard-of-model:free",
        "name": "Unheard Of",
        "description": "A multimodal model with visual perception.",
        "pricing": dict(FREE), "context_length": 131072,
        "architecture": {"input_modalities": ["text", "image"]},
    }]
    p = OpenRouterProvider("k", None, None)
    monkeypatch.setattr(p, "_catalogue", lambda: unfamiliar)
    st = p.status()
    assert st.supports_vision
    assert st.vision_model == "brandnew/unheard-of-model:free"


def test_ranking_tolerates_missing_metadata():
    """Catalogue entries are not guaranteed to carry every field."""
    sparse = {"id": "x/y:free", "pricing": dict(FREE),
              "architecture": {"input_modalities": ["text", "image"]}}
    rank = OpenRouterProvider.vision_rank(sparse)
    assert isinstance(rank, tuple) and len(rank) == 3


# ============================================ live failure modes ==========
# Every test below pins a bug found by making a real call. None of them were
# visible in the catalogue, and none would have been found by static
# inspection.

class _Resp:
    def __init__(self, payload): self._p = payload
    def json(self): return self._p


def test_null_content_does_not_raise():
    """`message.content` is not reliably a string. Reasoning models with
    reasoning enabled by default return content: null, and the old code did
    ["content"].strip() directly - an AttributeError several frames from the
    cause."""
    from backend.llm import OpenAICompatProvider
    payload = {"choices": [{"message": {"content": None, "reasoning": "thinking"}}]}
    assert OpenAICompatProvider._extract_text(payload) == "thinking"


def test_content_part_lists_are_joined():
    from backend.llm import OpenAICompatProvider
    payload = {"choices": [{"message": {"content": [
        {"type": "text", "text": "a "}, {"type": "text", "text": "b"}]}}]}
    assert OpenAICompatProvider._extract_text(payload) == "a b"


def test_malformed_response_yields_empty_not_an_exception():
    from backend.llm import OpenAICompatProvider
    for bad in ({}, {"choices": []}, {"choices": [{}]}, None):
        assert OpenAICompatProvider._extract_text(bad or {}) == ""


def test_reasoning_is_disabled_in_the_request():
    """Leaving it on returns the model's internal monologue instead of its
    answer - 'We need answer only describe visible... Let's inspect
    mentally.' Feeding that to stage two is a thinking trace being parsed as
    observations."""
    p = OpenRouterProvider("k", "some/model", None)
    body = p._payload([{"role": "user", "content": "x"}], 0.2, 100,
                      model="some/model")
    assert body.get("reasoning") == {"enabled": False}


def test_gated_model_fails_over_to_the_next_candidate(monkeypatch):
    """thinkingmachines/inkling-small:free ranks first on every published
    field and returns 403 'only available on agentic harnesses'. Nothing in
    its catalogue entry says so, so no pre-filter avoids it."""
    from backend.llm import LLMError
    p = OpenRouterProvider("k", None, None)
    monkeypatch.setattr(p, "_catalogue", lambda: LIVE_SHAPED)
    monkeypatch.setattr(p, "free_vision_models",
                        lambda: ["gated/model:free", "working/model:free"])
    monkeypatch.setattr(p, "status", lambda: type("S", (), {
        "supports_vision": True, "vision_model": "gated/model:free",
        "detail": ""})())

    tried = []

    def fake(self, messages, image_b64, media_type, **kw):
        tried.append(self.vision_model)
        if self.vision_model == "gated/model:free":
            raise LLMError("openrouter vision returned 403: only available on "
                           "agentic harnesses")
        return "a description"

    monkeypatch.setattr(
        "backend.llm.OpenAICompatProvider.chat_with_image", fake)
    out = p.chat_with_image([{"role": "user", "content": "x"}], "aGk=", "image/png")
    assert out == "a description"
    assert tried == ["gated/model:free", "working/model:free"]


def test_a_downstream_400_fails_over_but_a_real_400_does_not(monkeypatch):
    """OpenRouter returns 400 both for a malformed request AND for a provider
    rejecting the payload. Retrying the first against every model just fails
    more slowly; not retrying the second gives up too early."""
    from backend.llm import LLMError
    p = OpenRouterProvider("k", None, None)
    monkeypatch.setattr(p, "free_vision_models", lambda: ["a:free", "b:free"])
    monkeypatch.setattr(p, "status", lambda: type("S", (), {
        "supports_vision": True, "vision_model": "a:free", "detail": ""})())

    def downstream(self, *a, **kw):
        if self.vision_model == "a:free":
            raise LLMError('openrouter vision returned 400: {"error":'
                           '{"message":"Provider returned error",'
                           '"metadata":{"provider_name":"Nex AGI"}}}')
        return "ok"

    monkeypatch.setattr("backend.llm.OpenAICompatProvider.chat_with_image", downstream)
    assert p.chat_with_image([{"role": "user", "content": "x"}], "aGk=", "image/png") == "ok"

    def malformed(self, *a, **kw):
        raise LLMError("openrouter vision returned 400: image too large")

    p2 = OpenRouterProvider("k", None, None)
    monkeypatch.setattr(p2, "free_vision_models", lambda: ["a:free", "b:free"])
    monkeypatch.setattr(p2, "status", lambda: type("S", (), {
        "supports_vision": True, "vision_model": "a:free", "detail": ""})())
    monkeypatch.setattr("backend.llm.OpenAICompatProvider.chat_with_image", malformed)
    with pytest.raises(LLMError):
        p2.chat_with_image([{"role": "user", "content": "x"}], "aGk=", "image/png")


def test_an_empty_response_counts_as_a_failure(monkeypatch):
    """Passing an empty observation to stage two makes it write a corrosion
    assessment from nothing - the same class of bug as the local model
    returning 'irt.' and being treated as a real description."""
    p = OpenRouterProvider("k", None, None)
    monkeypatch.setattr(p, "free_vision_models", lambda: ["empty:free", "good:free"])
    monkeypatch.setattr(p, "status", lambda: type("S", (), {
        "supports_vision": True, "vision_model": "empty:free", "detail": ""})())

    def fake(self, *a, **kw):
        return "" if self.vision_model == "empty:free" else "real description"

    monkeypatch.setattr("backend.llm.OpenAICompatProvider.chat_with_image", fake)
    assert p.chat_with_image([{"role": "user", "content": "x"}], "aGk=", "image/png") \
        == "real description"


def test_a_working_model_is_remembered_for_the_session(monkeypatch):
    """Re-probing a gated model on every photograph adds a wasted round trip
    to each one."""
    from backend.llm import LLMError
    p = OpenRouterProvider("k", None, None)
    monkeypatch.setattr(p, "free_vision_models", lambda: ["gated:free", "works:free"])
    monkeypatch.setattr(p, "status", lambda: type("S", (), {
        "supports_vision": True, "vision_model": "gated:free", "detail": ""})())

    calls = []

    def fake(self, *a, **kw):
        calls.append(self.vision_model)
        if self.vision_model == "gated:free":
            raise LLMError("openrouter vision returned 403: gated")
        return "ok"

    monkeypatch.setattr("backend.llm.OpenAICompatProvider.chat_with_image", fake)
    p.chat_with_image([{"role": "user", "content": "x"}], "aGk=", "image/png")
    calls.clear()
    p.chat_with_image([{"role": "user", "content": "x"}], "aGk=", "image/png")
    assert calls == ["works:free"], "gated model was probed again"


def test_all_candidates_failing_reports_what_was_tried(monkeypatch):
    from backend.llm import LLMError
    p = OpenRouterProvider("k", None, None)
    monkeypatch.setattr(p, "free_vision_models", lambda: ["a:free", "b:free"])
    monkeypatch.setattr(p, "status", lambda: type("S", (), {
        "supports_vision": True, "vision_model": "a:free", "detail": ""})())
    monkeypatch.setattr("backend.llm.OpenAICompatProvider.chat_with_image",
                        lambda self, *a, **kw: (_ for _ in ()).throw(
                            LLMError("openrouter vision returned 403: gated")))
    with pytest.raises(LLMError) as exc:
        p.chat_with_image([{"role": "user", "content": "x"}], "aGk=", "image/png")
    assert "a:free" in str(exc.value) and "b:free" in str(exc.value)
    assert "local Ollama" in str(exc.value)
