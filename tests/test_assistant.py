"""
Tests for the AI assistant: the domain restriction, the role checks on the new
endpoints, and the image-upload guards.

Nothing here calls a real LLM. That's deliberate — these tests must pass on a
machine with no Ollama daemon, no API key, and no internet, and an LLM call
would make them slow and non-deterministic. What IS tested is everything
around the model: the gate that decides whether to call it at all, the access
control, and the upload validation.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend import assistant  # noqa: E402
from backend.main import app  # noqa: E402

client = TestClient(app)


def _login(username, password):
    resp = client.post("/api/login", json={"username": username, "password": password})
    assert resp.status_code == 200
    return resp.json()["token"]


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


# ------------------------------------------------------- the domain gate ----

@pytest.mark.parametrize("question", [
    "Why is SEG-00042 rated critical?",
    "What does low soil resistivity do to external corrosion rate?",
    "Explain cathodic protection requirements under NACE SP0169",
    "How should I prioritise inspection for uncoated pipe?",
    "What is pitting corrosion?",
    "When should I run an ILI tool?",
])
def test_in_domain_questions_are_allowed(question):
    assert assistant.is_in_domain(question) is True


@pytest.mark.parametrize("question", [
    "give me a pasta recipe",
    "write a react component for a login page",
    "who won the football match last night",
    "help me with my homework essay",
    "should I buy bitcoin",
])
def test_out_of_domain_questions_are_rejected(question):
    assert assistant.is_in_domain(question) is False


def test_domain_gate_prefers_false_negatives_over_false_positives():
    """A question mixing an off-domain word with real domain vocabulary must
    still be allowed — wrongly refusing a genuine engineering question is
    worse than letting a borderline one reach the system prompt."""
    assert assistant.is_in_domain("write a python script to compute corrosion rate") is True
    assert assistant.is_in_domain("explain the movie-like pattern of pipeline pitting") is True


def test_ambiguous_followup_is_allowed_through():
    """Follow-ups carry no domain vocabulary of their own; conversation context
    makes them in-domain, so the cheap gate must not block them."""
    assert assistant.is_in_domain("what about the third one?") is True


def test_refusal_message_redirects_rather_than_just_saying_no():
    assert "pipeline integrity" in assistant.REFUSAL
    assert "SEG-" in assistant.REFUSAL  # offers a concrete example to try


# -------------------------------------------------- endpoint access control --

def test_assistant_status_requires_auth():
    assert client.get("/api/assistant/status").status_code == 401


def test_assistant_chat_requires_auth():
    resp = client.post("/api/assistant/chat", json={"question": "corrosion?"})
    assert resp.status_code == 401


def test_image_analysis_requires_auth():
    resp = client.post(
        "/api/assistant/analyze-image",
        files={"file": ("t.jpg", b"x", "image/jpeg")},
    )
    assert resp.status_code == 401


def test_off_topic_question_is_refused_without_calling_the_model():
    """The refusal must come back even with no LLM configured, which proves it
    short-circuits before any provider call."""
    token = _login("supervisor1", "supervise123")
    resp = client.post(
        "/api/assistant/chat",
        headers=_auth(token),
        json={"question": "give me a pasta recipe", "history": []},
    )
    assert resp.status_code == 200
    assert "pipeline integrity" in resp.text


def test_empty_question_is_rejected():
    token = _login("supervisor1", "supervise123")
    resp = client.post("/api/assistant/chat", headers=_auth(token),
                       json={"question": "   ", "history": []})
    assert resp.status_code == 400


def test_overlong_question_is_rejected():
    token = _login("supervisor1", "supervise123")
    resp = client.post("/api/assistant/chat", headers=_auth(token),
                       json={"question": "x" * 2500, "history": []})
    assert resp.status_code == 400


def test_inspector_cannot_ground_assistant_on_another_region():
    """The region scoping that protects /api/segments/{id} must also protect
    the assistant — otherwise the LLM becomes a way to read data the user is
    not allowed to see."""
    sup = _login("supervisor1", "supervise123")
    segments = client.get("/api/segments", headers=_auth(sup)).json()["segments"]
    outside = next(s for s in segments if s["region"] != "Western")

    inspector = _login("inspector1", "inspect123")
    resp = client.post(
        "/api/assistant/chat",
        headers=_auth(inspector),
        json={"question": "why is this corroding?",
              "segment_id": outside["segment_id"], "history": []},
    )
    assert resp.status_code == 403


def test_unknown_segment_returns_404():
    token = _login("supervisor1", "supervise123")
    resp = client.post("/api/assistant/chat", headers=_auth(token),
                       json={"question": "why is this corroding?",
                             "segment_id": "SEG-NOPE", "history": []})
    assert resp.status_code == 404


# ------------------------------------------------------- upload validation --

def test_non_image_upload_is_rejected():
    token = _login("supervisor1", "supervise123")
    resp = client.post(
        "/api/assistant/analyze-image",
        headers=_auth(token),
        files={"file": ("payload.txt", b"not an image", "text/plain")},
    )
    # 400 when a vision model is available, 503 when none is configured —
    # either way the file is never handed to a model.
    assert resp.status_code in (400, 503)


def test_oversized_image_is_rejected():
    token = _login("supervisor1", "supervise123")
    big = b"\xff\xd8\xff" + b"0" * (9 * 1024 * 1024)   # 9 MB, over the 8 MB cap
    resp = client.post(
        "/api/assistant/analyze-image",
        headers=_auth(token),
        files={"file": ("big.jpg", big, "image/jpeg")},
    )
    assert resp.status_code in (413, 503)


# ----------------------------------------------------------- grounding ------

def test_segment_context_includes_prediction_and_shap_drivers():
    """The grounding context is what makes answers specific to one pipe rather
    than generic corrosion theory — if it loses the SHAP drivers or the
    prediction, the assistant silently degrades to a generic chatbot."""
    from backend.ml import get_service

    svc = get_service()
    sid = svc.list_segments(risk_band="critical")[0]["segment_id"]
    context = assistant.build_segment_context(svc.get_segment(sid))

    assert sid in context
    assert "mils/year" in context
    assert "SHAP drivers" in context
    assert "cathodic protection" in context
    assert "coating type" in context


def test_fleet_context_is_scoped_to_one_region_when_asked():
    from backend.ml import get_service

    svc = get_service()
    scoped = assistant.build_fleet_context(svc, "Western")
    assert "Western region" in scoped

    # And the whole fleet is larger than any single region's slice.
    everything = assistant.build_fleet_context(svc, None)
    assert "all regions" in everything


def test_fleet_context_labels_the_data_as_synthetic():
    """The assistant must never present synthetic model output as measured
    fact, so the warning has to be in the context it actually receives."""
    from backend.ml import get_service

    context = assistant.build_fleet_context(get_service(), None)
    assert "SYNTHETIC" in context


# --------------------------------------------------------- system prompts ---

def test_vision_prompt_forbids_quantitative_claims():
    """The single most important guard rail: a photo cannot yield a wall-loss
    number, and a confident fake one would discredit the whole tool."""
    p = assistant.VISION_SYSTEM_PROMPT
    assert "NEVER estimate wall thickness" in p
    assert "ultrasonic" in p.lower()
    assert "Limitations" in p


def test_vision_prompt_treats_image_text_as_untrusted():
    """Text inside an uploaded photo is a prompt-injection vector."""
    assert "untrusted" in assistant.VISION_SYSTEM_PROMPT.lower()


def test_system_prompt_declares_the_scope_and_the_standards():
    p = assistant.SYSTEM_PROMPT
    assert "ONLY" in p
    for standard in ("SP0169", "API 570", "API 579-1", "B31.4"):
        assert standard in p


# ------------------------------------------------ two-stage vision pipeline --

def test_observe_prompt_asks_only_for_description():
    """Stage 1 runs on a small local vision model. It must ask for plain
    description only — the structured engineering verdict is stage 2's job on a
    capable text model."""
    p = assistant.VISION_OBSERVE_PROMPT
    assert "Only describe what is visible" in p
    assert "Do not guess causes" in p
    # It must NOT ask the small model for the structured engineering verdict.
    for stage2_only in ("Consistency with the model", "API 579", "Limitations",
                        "SHAP", "fitness-for-service"):
        assert stage2_only not in p


def test_observe_messages_withhold_segment_context():
    """Critical: telling the vision model the pipe is predicted to corrode fast
    biases it toward reporting corrosion it cannot see, which destroys the
    photo's value as independent evidence."""
    messages = assistant.build_observe_messages(note=None)
    blob = " ".join(m["content"] for m in messages)
    for leak in ("mils/year", "SHAP", "predicted", "risk band", "cathodic"):
        assert leak not in blob, f"segment context leaked into stage 1: {leak!r}"


def test_observe_messages_pass_the_inspector_note_as_orientation_only():
    """The note reaches the model, and the describe-only constraint is carried
    by the (short) system prompt rather than bloating the user turn."""
    messages = assistant.build_observe_messages(note="taken at the soil-to-air interface")
    user = messages[-1]["content"]
    system = messages[0]["content"]
    assert "soil-to-air interface" in user
    assert "Only describe what is visible" in system
    # The note must stay a short clause, not become an instruction block.
    assert len(user) - len(assistant.VISION_OBSERVE_QUESTIONS) < 200


def test_assessment_messages_carry_observations_and_segment_context():
    """Stage 2 gets the visual description plus the numbers, and must be told
    it cannot see the image itself — otherwise it embellishes."""
    messages = assistant.build_assessment_messages(
        observations="Orange staining along the weld seam with several dark cavities.",
        context="SEGMENT SEG-00001 — predicted 7.20 mils/year",
        note=None,
    )
    assert messages[0]["content"] == assistant.VISION_SYSTEM_PROMPT
    user = messages[-1]["content"]
    assert "Orange staining along the weld seam" in user
    assert "SEG-00001" in user
    assert "you cannot see the image yourself" in user
    assert "corroborate or contradict" in user


def test_assessment_stage_still_carries_the_no_wall_loss_rule():
    """The prohibition moved to stage 2, where a capable text model actually
    follows it. It must not have been lost in the move."""
    messages = assistant.build_assessment_messages("some observations", "some context", None)
    system = messages[0]["content"]
    assert "NEVER estimate wall thickness" in system
    assert "Limitations" in system


def test_observe_prompt_stays_short_enough_for_a_small_model():
    """Measured on moondream (1.8B): a 1064-char system prompt produced the
    4-character output "irt."; a 124-char one produced a usable description.
    Small vision models don't partially comply with long instructions — they
    collapse. Keep this prompt short."""
    assert len(assistant.VISION_OBSERVE_PROMPT) < 250, (
        "The stage-1 system prompt has grown. Small vision models break on long "
        "prompts — move detail into VISION_OBSERVE_QUESTIONS instead."
    )


def test_dedupe_collapses_a_repetition_loop():
    """moondream repeated one sentence ten times until it hit the token cap.
    Passing that to stage 2 wastes context and makes one shaky observation look
    corroborated by repetition."""
    looped = " ".join(["The pipe has a hole in the middle."] * 10)
    out = assistant.dedupe_observations(looped)
    assert out == "The pipe has a hole in the middle."


def test_dedupe_preserves_distinct_sentences_in_order():
    text = ("The pipe is rusty. Orange staining is visible. "
            "The pipe is rusty. The surface is rough.")
    out = assistant.dedupe_observations(text)
    assert out == "The pipe is rusty. Orange staining is visible. The surface is rough."


def test_dedupe_ignores_punctuation_and_case_when_matching():
    text = "The pipe is rusty. the pipe is rusty! THE PIPE IS RUSTY."
    assert assistant.dedupe_observations(text) == "The pipe is rusty."


def test_dedupe_handles_empty_input():
    assert assistant.dedupe_observations("") == ""
    assert assistant.dedupe_observations("   ") == ""


def test_assessment_prompt_forbids_escalating_a_hole_to_a_breach():
    """The specific hallucination-amplification risk of this architecture: a
    1.8B model says "hole", and a capable text model confidently escalates it
    to a through-wall breach warranting depressurisation. Observed in testing."""
    messages = assistant.build_assessment_messages("There is a hole.", "ctx", None)
    user = messages[-1]["content"]
    assert "through-wall" in user
    assert "NOT conclude" in user or "must NOT" in user


def test_assessment_prompt_warns_that_observations_may_be_unreliable():
    messages = assistant.build_assessment_messages("obs", "ctx", None)
    user = messages[-1]["content"]
    assert "small local vision model" in user
    assert "suspicion" in user or "unreliable" in user


def test_vision_provider_selection_prefers_a_capable_text_provider():
    """If the text provider can already see, use it — one backend is simpler
    than two and avoids a second round trip."""
    from backend.llm import MockProvider, select_vision_provider
    from config.settings import settings

    mock = MockProvider()          # mock reports supports_vision=True
    assert select_vision_provider(settings, mock) is mock


def test_analyze_image_reports_vision_unavailable_rather_than_faking_it():
    """With no vision model the endpoint must 503 with actionable guidance,
    never return invented image findings."""
    from backend import main

    token = _login("supervisor1", "supervise123")
    resp = client.post(
        "/api/assistant/analyze-image",
        headers=_auth(token),
        files={"file": ("t.jpg", b"\xff\xd8\xffnotreallyajpeg", "image/jpeg")},
    )
    if main.get_vision_provider() is None:
        assert resp.status_code == 503
        assert "ollama pull" in resp.json()["detail"]
    else:
        # A vision model is installed; the call may succeed or fail upstream,
        # but it must never be a silent 200 with empty analysis.
        assert resp.status_code != 503
        if resp.status_code == 200:
            assert resp.json()["analysis"].strip()
