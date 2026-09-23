"""
Contract tests: hold the provider to the whole documented failure space,
offline.

The point of this file is the counterfactual. Four bugs in the OpenRouter
provider were found by making a real API call. Run against the hostile fake,
three of them fail here in milliseconds with no key and no network, and the
fourth is survived by design even though its specifics were unknowable.

`test_the_old_parser_fails_this_contract` is the proof: it runs the PREVIOUS
implementation against the same fixtures and asserts that it breaks. If the
harness could not catch the bug that actually happened, it is decoration.

The general lesson, which is the transferable part:

    You cannot predict WHICH model returns 403.
    You can predict THAT some model will.

Specifics are unknowable; the failure CLASS is enumerable from the API
documentation. A client that picks a remote resource dynamically has to
assume any particular one can fail, and that is a design property you can
test without ever leaving the machine.
"""
import pytest

from backend.llm import LLMError, OpenAICompatProvider
from backend.openrouter import OpenRouterProvider
from tests.fakes.openrouter_fake import (
    ALL_SUCCESS_SHAPES, CONTENT_PARTS, DOWNSTREAM_400, EMPTY_STRING,
    GATED_403, HOSTILE_CATALOGUE, MALFORMED, MISSING_CHOICES, NO_CHOICES,
    NULL_CONTENT, OK, OUR_400, REASONING_ONLY,
)


# ===================================================== the parser contract ==
# Preventable bug #1. `content` is nullable in the published OpenAI schema.
# Catching this needed the schema, not a live call.

@pytest.mark.parametrize("name,payload", sorted(ALL_SUCCESS_SHAPES.items()))
def test_parser_never_raises_on_any_documented_shape(name, payload):
    """Whatever comes back, the parser returns a string. A response shape is
    untrusted input in exactly the way a form field is."""
    out = OpenAICompatProvider._extract_text(payload)
    assert isinstance(out, str), f"{name} produced {type(out)}"


def test_null_content_is_not_an_attribute_error():
    assert OpenAICompatProvider._extract_text(NULL_CONTENT) == ""


def test_content_parts_are_joined():
    assert OpenAICompatProvider._extract_text(CONTENT_PARTS) == "A rusted pipe."


def test_reasoning_is_read_only_when_content_is_absent():
    assert OpenAICompatProvider._extract_text(REASONING_ONLY).startswith("We need")
    assert OpenAICompatProvider._extract_text(OK) == "A rusted pipe."


@pytest.mark.parametrize("payload", [NO_CHOICES, MISSING_CHOICES, MALFORMED, {}])
def test_structurally_broken_responses_yield_empty(payload):
    assert OpenAICompatProvider._extract_text(payload) == ""


def test_the_old_parser_fails_this_contract():
    """The counterfactual, and the reason to trust the harness.

    This is the line the provider used to run:

        r.json()["choices"][0]["message"]["content"].strip()

    Against the fixtures above it raises on three of them. Had this file
    existed first, the bug would have been a red test rather than a stack
    trace from a live call.
    """
    def old_parser(payload):
        return payload["choices"][0]["message"]["content"].strip()

    broken = []
    for name, payload in ALL_SUCCESS_SHAPES.items():
        try:
            old_parser(payload)
        except Exception as exc:
            broken.append((name, type(exc).__name__))

    names = {n for n, _ in broken}
    assert "null_content" in names
    assert "reasoning_only" in names
    assert len(broken) >= 3, f"expected the old parser to fail; got {broken}"


# =================================================== the reasoning contract ==
# Preventable bug #2. The catalogue publishes
# `reasoning: {default_enabled: true}` per model. That field was read and not
# acted on - the information was already in hand.

def test_reasoning_is_disabled_on_every_request():
    p = OpenRouterProvider("k", "m", None)
    body = p._payload([{"role": "user", "content": "x"}], 0.2, 100, model="m")
    assert body.get("reasoning") == {"enabled": False}


def test_catalogue_flags_which_models_reason_by_default():
    """Proof the signal was available before any call was made."""
    defaulted = [e["id"] for e in HOSTILE_CATALOGUE
                 if (e.get("reasoning") or {}).get("default_enabled")]
    assert defaulted, "the fixture should carry the field the real API does"


# ==================================================== the failover contract ==
# Unpredictable specifics, testable design. You cannot know WHICH model is
# gated; you can require that the client survives one being gated.

def _provider(monkeypatch, script, candidates):
    p = OpenRouterProvider("k", None, None)
    monkeypatch.setattr(p, "_catalogue", lambda: HOSTILE_CATALOGUE)
    monkeypatch.setattr(p, "free_vision_models", lambda: list(candidates))
    monkeypatch.setattr(p, "status", lambda: type("S", (), {
        "supports_vision": True, "vision_model": candidates[0], "detail": ""})())

    tried: list[str] = []

    def fake(self, messages, image_b64, media_type, **kw):
        tried.append(self.vision_model)
        entry = script.get(self.vision_model, OK)
        if isinstance(entry, tuple):
            status, payload = entry
            raise LLMError(f"openrouter vision returned {status}: {payload}")
        return OpenAICompatProvider._extract_text(entry)

    monkeypatch.setattr("backend.llm.OpenAICompatProvider.chat_with_image", fake)
    return p, tried


def _call(p):
    return p.chat_with_image([{"role": "user", "content": "x"}], "aGk=", "image/png")


def test_a_gated_model_does_not_take_the_feature_down(monkeypatch):
    p, tried = _provider(monkeypatch, {"a:free": GATED_403}, ["a:free", "b:free"])
    assert _call(p) == "A rusted pipe."
    assert tried == ["a:free", "b:free"]


@pytest.mark.parametrize("failure", ["gated_403", "rate_limited_429",
                                     "withdrawn_404", "upstream_502"])
def test_every_per_model_failure_class_fails_over(monkeypatch, failure):
    """Enumerated from the API's documented status codes, not from what
    happened to break."""
    from tests.fakes.openrouter_fake import ALL_ERROR_SHAPES
    p, tried = _provider(monkeypatch, {"a:free": ALL_ERROR_SHAPES[failure]},
                         ["a:free", "b:free"])
    assert _call(p) == "A rusted pipe."
    assert len(tried) == 2


def test_a_downstream_400_fails_over(monkeypatch):
    p, tried = _provider(monkeypatch, {"a:free": DOWNSTREAM_400},
                         ["a:free", "b:free"])
    assert _call(p) == "A rusted pipe."


def test_our_own_400_does_not_fail_over(monkeypatch):
    """The discrimination that matters. Retrying a malformed request against
    every model in the catalogue just fails five times more slowly."""
    p, tried = _provider(monkeypatch, {"a:free": OUR_400}, ["a:free", "b:free"])
    with pytest.raises(LLMError):
        _call(p)
    assert tried == ["a:free"], "a malformed request should not be retried"


def test_an_empty_answer_is_a_failure_not_a_result(monkeypatch):
    """Stage two given an empty observation writes an assessment from
    nothing. Same class as the local model returning 'irt.'"""
    p, tried = _provider(monkeypatch, {"a:free": EMPTY_STRING},
                         ["a:free", "b:free"])
    assert _call(p) == "A rusted pipe."
    assert len(tried) == 2


def test_a_null_content_answer_is_also_a_failure(monkeypatch):
    p, tried = _provider(monkeypatch, {"a:free": NULL_CONTENT},
                         ["a:free", "b:free"])
    assert _call(p) == "A rusted pipe."


def test_the_working_model_is_remembered(monkeypatch):
    p, tried = _provider(monkeypatch, {"a:free": GATED_403}, ["a:free", "b:free"])
    _call(p)
    tried.clear()
    _call(p)
    assert tried == ["b:free"], "the gated model was probed twice"


def test_exhausting_every_candidate_names_what_was_tried(monkeypatch):
    p, _ = _provider(monkeypatch, {"a:free": GATED_403, "b:free": GATED_403},
                     ["a:free", "b:free"])
    with pytest.raises(LLMError) as exc:
        _call(p)
    assert "a:free" in str(exc.value) and "b:free" in str(exc.value)


# ================================================== the selection contract ==
# The purpose filter, held against a catalogue built to defeat it.

def test_the_hostile_catalogue_is_filtered_correctly(monkeypatch):
    p = OpenRouterProvider("k", None, None)
    monkeypatch.setattr(p, "_catalogue", lambda: HOSTILE_CATALOGUE)
    vision = p.free_vision_models()

    for useless in ("google/lyria-3-pro-preview",
                    "nvidia/nemotron-3.5-content-safety:free",
                    "openrouter/free"):
        assert useless not in vision, f"{useless} should be excluded by purpose"
    assert "deepseek/deepseek-r1:free" not in vision      # free but text-only
    assert "openai/gpt-4o" not in vision                   # vision but paid
    assert "nex-agi/nex-n2.5-pro:free" in vision


def test_a_music_model_never_outranks_a_vision_model(monkeypatch):
    """Lyria has the largest context window of anything free and image-capable,
    so every purely metadata-driven ranking promotes it to first place."""
    p = OpenRouterProvider("k", None, None)
    monkeypatch.setattr(p, "_catalogue", lambda: HOSTILE_CATALOGUE)
    assert "lyria" not in p.free_vision_models()[0].lower()
