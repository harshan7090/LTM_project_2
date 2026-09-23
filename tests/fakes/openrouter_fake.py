"""
A deliberately hostile fake of an OpenAI-compatible provider.

WHY THIS EXISTS

  Four bugs in backend/openrouter.py were found by making a real API call.
  Three of them would have been found here instead, in milliseconds, with no
  key and no network. The fourth would have been *survived* here even though
  its specifics were unknowable.

  The distinction worth internalising:

      You cannot predict WHICH model returns 403.
      You can predict THAT some model will.

  A client that selects a remote resource dynamically must assume any
  particular one can fail. That is a design property, testable offline.

WHAT EACH RESPONSE HERE CORRESPONDS TO

  NULL_CONTENT      The OpenAI schema marks `message.content` as NULLABLE.
                    This is in the published spec. The old parser did
                    `["content"].strip()` and raised AttributeError several
                    frames from the cause. FULLY PREVENTABLE - it required
                    reading the response schema rather than one happy-path
                    example.

  REASONING_ONLY    The catalogue reports `reasoning: {default_enabled: true}`
                    per model. That field was READ and not acted on. Such
                    models answer in `reasoning` with `content` null, so
                    reading it back yields internal monologue. FULLY
                    PREVENTABLE from metadata already in hand.

  GATED_403         "only available on agentic harnesses". Not in any
                    catalogue field. NOT PREDICTABLE - but a failover design
                    survives it, and that design is testable here.

  DOWNSTREAM_400    OpenRouter returns 400 both for a malformed request and
                    for a downstream provider rejecting the payload. Which
                    provider does that is unknowable; that the API overloads
                    400 is documented. PARTIALLY PREVENTABLE.

  The remaining entries cover the rest of the documented failure space, so a
  new provider can be held to the whole contract rather than to the four
  things that happened to break once.
"""
from __future__ import annotations

import json

# --------------------------------------------------------------- shapes ---

OK = {
    "choices": [{"message": {"role": "assistant", "content": "A rusted pipe."}}]
}

# `content` is nullable in the OpenAI schema. Published, not obscure.
NULL_CONTENT = {
    "choices": [{"message": {"role": "assistant", "content": None}}]
}

# Reasoning models with reasoning enabled by default.
REASONING_ONLY = {
    "choices": [{"message": {
        "role": "assistant",
        "content": None,
        "reasoning": "We need answer only describe visible. Let's inspect mentally.",
    }}]
}

# Some providers return content PARTS rather than a string.
CONTENT_PARTS = {
    "choices": [{"message": {
        "role": "assistant",
        "content": [{"type": "text", "text": "A rusted "},
                    {"type": "text", "text": "pipe."}],
    }}]
}

EMPTY_STRING = {"choices": [{"message": {"role": "assistant", "content": "   "}}]}
NO_CHOICES = {"choices": []}
MISSING_CHOICES = {"id": "gen-1", "object": "chat.completion"}
MALFORMED = {"unexpected": "shape"}

# ---------------------------------------------------------------- errors ---

GATED_403 = (403, {"error": {
    "message": ("thinkingmachines/inkling-small:free is only available on "
                "agentic harnesses. Try plugging it into a coding agent."),
    "code": 403}})

DOWNSTREAM_400 = (400, {"error": {
    "message": "Provider returned error",
    "code": 400,
    "metadata": {"raw": '{"error":{"message":"The request is invalid."}}',
                 "provider_name": "Nex AGI",
                 "provider_error_code": "invalid_request"}}})

# A 400 that is genuinely OUR fault. Must NOT trigger failover - retrying a
# malformed request against every model just fails more slowly.
OUR_400 = (400, {"error": {"message": "Image exceeds maximum size", "code": 400}})

RATE_LIMITED_429 = (429, {"error": {"message": "Rate limit exceeded", "code": 429}})
WITHDRAWN_404 = (404, {"error": {"message": "No endpoints found", "code": 404}})
UPSTREAM_502 = (502, {"error": {"message": "Provider unavailable", "code": 502}})
NO_CREDIT_402 = (402, {"error": {"message": "Insufficient credits", "code": 402}})

ALL_ERROR_SHAPES = {
    "gated_403": GATED_403,
    "downstream_400": DOWNSTREAM_400,
    "our_400": OUR_400,
    "rate_limited_429": RATE_LIMITED_429,
    "withdrawn_404": WITHDRAWN_404,
    "upstream_502": UPSTREAM_502,
    "no_credit_402": NO_CREDIT_402,
}

ALL_SUCCESS_SHAPES = {
    "ok": OK,
    "null_content": NULL_CONTENT,
    "reasoning_only": REASONING_ONLY,
    "content_parts": CONTENT_PARTS,
    "empty_string": EMPTY_STRING,
    "no_choices": NO_CHOICES,
    "missing_choices": MISSING_CHOICES,
    "malformed": MALFORMED,
}


# ------------------------------------------------------------- catalogue ---
# Shaped like the real /models response, including the three entries that are
# free and image-capable and useless for describing a photograph.

def _entry(ident, *, free=True, image=True, ctx=131072, name=None,
           description="", max_out=8192, reasoning_default=False):
    return {
        "id": ident,
        "name": name or ident,
        "description": description,
        "pricing": ({"prompt": "0", "completion": "0"} if free
                    else {"prompt": "0.000003", "completion": "0.000015"}),
        "context_length": ctx,
        "top_provider": {"max_completion_tokens": max_out},
        "architecture": {"input_modalities": (["text", "image"] if image
                                              else ["text"])},
        "reasoning": {"default_enabled": reasoning_default},
    }


HOSTILE_CATALOGUE = [
    # Ranks first on every published field. Gated. Nothing says so.
    _entry("thinkingmachines/inkling-small:free", ctx=1048576, max_out=262144,
           description="Open-weight multimodal mixture-of-experts model.",
           reasoning_default=True),
    # Free, image-capable, and generates music.
    _entry("google/lyria-3-pro-preview", ctx=1048576,
           name="Google: Lyria 3 Pro", description="Music generation model."),
    # Free, image-capable, and a safety classifier.
    _entry("nvidia/nemotron-3.5-content-safety:free", ctx=128000,
           description="Content safety classifier."),
    # Free, image-capable, and a meta-router.
    _entry("openrouter/free", ctx=200000, description="Routes to a free model."),
    # Genuine vision model, reasoning on by default.
    _entry("nex-agi/nex-n2.5-pro:free", ctx=262144,
           description="Multimodal model with visual perception.",
           reasoning_default=True),
    # Genuine vision model, smaller.
    _entry("vendor/small-vl:free", ctx=32768,
           description="Compact vision-language model."),
    # Free but text-only.
    _entry("deepseek/deepseek-r1:free", image=False, ctx=163840),
    # Vision but PAID.
    _entry("openai/gpt-4o", free=False, ctx=128000),
]


class FakeResponse:
    """Minimal httpx.Response stand-in."""

    def __init__(self, status_code: int, payload: dict):
        self.status_code = status_code
        self._payload = payload
        self.text = json.dumps(payload)

    def json(self):
        return self._payload

    def read(self):
        return self.text.encode()

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class HostileProvider:
    """Serves a scripted sequence of responses, keyed by model id.

    `script` maps a model id to either a (status, payload) error tuple or a
    success payload dict. Any model not in the script returns OK.
    """

    def __init__(self, script: dict | None = None):
        self.script = script or {}
        self.calls: list[str] = []

    def respond(self, model: str) -> FakeResponse:
        self.calls.append(model)
        entry = self.script.get(model, OK)
        if isinstance(entry, tuple):
            status, payload = entry
            return FakeResponse(status, payload)
        return FakeResponse(200, entry)
