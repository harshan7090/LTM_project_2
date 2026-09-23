"""
OpenRouter provider — runtime discovery of FREE vision-capable models.

WHY THIS EXISTS

  The local vision model is moondream: 1.8B parameters, chosen because the
  target machine has no discrete GPU. It can report "brown discolouration and
  surface pitting on a metal pipe" and not much beyond that. A 70B-class
  vision model reads the same photograph far better — weld seams, coating
  disbondment at a given clock position, standing water, and the difference
  between surface staining and actual section loss.

ON "A MODEL TRAINED ON OIL AND GAS PIPELINES" — IT DOES NOT EXIST

  There is no publicly available vision model fine-tuned on pipeline
  corrosion imagery, on a free tier or otherwise. Anything carrying that
  label would be a general VLM behind a domain prompt. So this module does
  not pretend to find one.

  What actually improves domain quality, in order of effect:

    1. A much larger general VLM. 1.8B -> 70B+ is the single biggest
       improvement available, and it is what this provider is for.
    2. Domain grounding in the prompt — the two-stage pipeline in
       backend/assistant.py already reasons over the observations together
       with the segment's numbers and the retrieved standards.
    3. Retrieving the relevant standard alongside the image, also already
       done.

  Calling that "domain-trained" when the mechanism is (1) plus a good prompt
  would be marketing rather than engineering.

FREE TIER, AND WHY DISCOVERY IS AT RUNTIME

  OpenRouter marks free models with a ":free" suffix and zero prompt and
  completion pricing. Both are checked here, because the suffix is a naming
  convention while pricing is the thing that actually bills.

  The free roster changes constantly. This project already has a scar from
  that class of bug: the Groq provider hardcoded `llama-3.3-70b-versatile`,
  the model was decommissioned, and every request started returning a 404
  that looked like a broken integration rather than a retired model. Same
  fix applied here — ask the API what exists, then pick.
"""
from __future__ import annotations

import httpx

from backend.llm import LLMError, OpenAICompatProvider, ProviderStatus


class OpenRouterProvider(OpenAICompatProvider):
    name = "openrouter"
    base_url = "https://openrouter.ai/api/v1"

    # Purposes that ACCEPT an image without being able to usefully describe
    # one. This list is the important half of the selection, and it exists
    # because the live catalogue contains counter-examples that no modality
    # check can filter:
    #
    #   google/lyria-3-pro-preview   music generation, input_modalities
    #                                 ['text','image'], priced at zero
    #   nvidia/...-content-safety     a safety classifier, not a describer
    #   openrouter/free               a meta-router, not a model
    #
    # Each would have been selected as "the best free vision model" and
    # returned something useless for a corrosion photograph.
    EXCLUDED_PURPOSES = (
        "lyria", "music", "audio-only", "tts", "speech", "whisper",
        "safety", "moderation", "guard", "shield", "classifier",
        "embed", "rerank", "diffusion", "image-gen", "imagen", "flux",
        "openrouter/free", "auto-router", "/router",
    )

    # Words in the name or description that indicate genuine visual
    # UNDERSTANDING rather than incidental image input.
    VISION_SIGNALS = (
        "vision", "visual", "-vl", " vl", "multimodal", "image understanding",
        "ocr", "document understanding", "perception",
    )

    # Kept only as a final tiebreak between otherwise equal candidates. The
    # previous version relied on this list ALONE, and when checked against the
    # live catalogue exactly 1 of 14 free vision models matched any entry -
    # the free roster had turned over completely. Ranking now comes from
    # metadata the catalogue actually publishes, which does not go stale.
    VISION_PREFERENCE = (
        "qwen", "gemma", "llama", "internvl", "mistral", "-vl", "vision",
    )
    CHAT_PREFERENCE = (
        "deepseek", "qwen", "llama", "gemma", "mistral", "nemotron",
    )

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # Per-instance, not class-level: a class attribute would leak one
        # account's catalogue into another provider instance in the same
        # process, which is the kind of thing that only shows up in tests.
        self._cached: list[dict] | None = None
        # Remembered across calls so a gated model is probed once, not once
        # per photograph.
        self._working_vision_model: str | None = None

    def _headers(self) -> dict:
        h = super()._headers()
        # Optional, but this is how an app appears on OpenRouter's rankings
        # rather than as anonymous traffic.
        h.setdefault("HTTP-Referer", "https://github.com/local/milepost")
        h.setdefault("X-Title", "Milepost Pipeline Integrity Console")
        return h

    # ------------------------------------------------------- catalogue ----

    def _catalogue(self) -> list[dict]:
        """Live model list, cached per instance. Large response, and it does
        not change within a run."""
        if self._cached is not None:
            return self._cached
        try:
            r = httpx.get(f"{self.base_url}/models", timeout=20.0)
            r.raise_for_status()
            self._cached = r.json().get("data", [])
        except Exception:  # noqa: BLE001
            self._cached = []
        return self._cached

    @staticmethod
    def is_free(entry: dict) -> bool:
        """Zero prompt AND completion price.

        Checked numerically rather than by trusting the ':free' suffix — the
        suffix is a convention, the pricing is what bills.
        """
        pricing = entry.get("pricing") or {}
        try:
            return (float(pricing.get("prompt", 1)) == 0.0
                    and float(pricing.get("completion", 1)) == 0.0)
        except (TypeError, ValueError):
            return False

    @staticmethod
    def sees_images(entry: dict) -> bool:
        """Whether the model accepts image input, from its declared modalities.

        Falls back to a name check only when the field is missing. An id
        containing 'vl' or 'vision' is a reasonable hint and a poor contract,
        and guessing wrong means the photo endpoint fails at call time instead
        of reporting itself unavailable up front.
        """
        arch = entry.get("architecture") or {}
        modalities = arch.get("input_modalities") or arch.get("modality") or ""
        if isinstance(modalities, (list, tuple)):
            return "image" in [str(m).lower() for m in modalities]
        if isinstance(modalities, str) and modalities:
            return "image" in modalities.lower()
        ident = str(entry.get("id", "")).lower()
        return any(h in ident for h in ("-vl", "vision", "llava", "gemma-3"))

    @classmethod
    def is_excluded_purpose(cls, entry: dict) -> bool:
        """Whether the model accepts images for some purpose other than
        describing them."""
        blob = f"{entry.get('id', '')} {entry.get('name', '')}".lower()
        return any(bad in blob for bad in cls.EXCLUDED_PURPOSES)

    @classmethod
    def vision_rank(cls, entry: dict) -> tuple:
        """Sort key for free vision models, best first.

        Built from metadata the catalogue publishes rather than from a list
        of model names, because names go stale within weeks. In order:

          1. explicit vision signal in the name or description - separates a
             purpose-built VL model from one that merely accepts an image
          2. context length - the stage-two prompt carries the observations,
             the segment's numbers and the retrieved standards, so headroom
             is real capability here and not a spec-sheet number
          3. max completion tokens - a truncated limitations section is a
             bug this project has already hit once
        """
        blob = f"{entry.get('id', '')} {entry.get('name', '')} " \
               f"{entry.get('description', '')}".lower()
        has_signal = any(sig in blob for sig in cls.VISION_SIGNALS)
        ctx = entry.get("context_length") or 0
        top = entry.get("top_provider") or {}
        max_out = top.get("max_completion_tokens") or 0
        return (0 if has_signal else 1, -ctx, -max_out)

    def free_vision_models(self) -> list[str]:
        """Free, image-capable, purpose-appropriate models, best first."""
        candidates = [
            e for e in self._catalogue()
            if self.is_free(e) and self.sees_images(e)
            and not self.is_excluded_purpose(e)
        ]
        return [e["id"] for e in sorted(candidates, key=self.vision_rank)]

    def free_chat_models(self) -> list[str]:
        candidates = [e for e in self._catalogue()
                      if self.is_free(e) and not self.is_excluded_purpose(e)]
        candidates.sort(key=lambda e: -(e.get("context_length") or 0))
        return [e["id"] for e in candidates]

    @staticmethod
    def _first_match(models: list[str], preferences: tuple[str, ...]) -> str | None:
        for pref in preferences:
            for m in models:
                if pref in m.lower():
                    return m
        return None

    # ---------------------------------------------------------- status ----

    def status(self) -> ProviderStatus:
        if not self.api_key:
            return ProviderStatus(
                name=self.name, available=False,
                detail="No OpenRouter API key. Get a free one at "
                       "openrouter.ai/keys, then set OPENROUTER_API_KEY in .env.",
            )

        if not self._catalogue():
            return ProviderStatus(
                name=self.name, available=False,
                detail="OpenRouter key is set but the model list could not be "
                       "fetched - check network access to openrouter.ai.",
            )

        free_chat = self.free_chat_models()
        free_vision = self.free_vision_models()
        ids = {e.get("id") for e in self._catalogue()}

        chat, note = None, ""
        if self.model and self.model in ids:
            chat = self.model
        elif self.model:
            note = (f" Configured LLM_MODEL '{self.model}' is not on OpenRouter "
                    f"- falling back.")
        if chat is None:
            chat = (self._first_match(free_chat, self.CHAT_PREFERENCE)
                    or (free_chat[0] if free_chat else None))

        if chat is None:
            return ProviderStatus(
                name=self.name, available=False,
                detail="No free-tier model is currently listed for this account.",
            )

        if self.vision_model and self.vision_model in free_vision:
            vision = self.vision_model
        else:
            # free_vision is already ranked by metadata. The name list only
            # breaks ties among the top group, and never overrides the
            # ranking wholesale the way it used to.
            top_group = free_vision[:3]
            vision = (self._first_match(top_group, self.VISION_PREFERENCE)
                      or (free_vision[0] if free_vision else None))

        detail = (f"OpenRouter free tier, model '{chat}' "
                  f"({len(free_chat)} free models listed).")
        if vision:
            detail += (f" Vision: '{vision}' - substantially better at reading a "
                       f"photograph than the local 1.8B model.")
        else:
            detail += (" No free vision model is listed right now; photo analysis "
                       "falls back to local Ollama.")
        detail += note

        return ProviderStatus(
            name=self.name, available=True, model=chat,
            vision_model=vision, supports_vision=bool(vision),
            detail=detail, models=free_chat,
        )

    # --------------------------------------------------------- requests ----

    def _payload(self, messages, temperature, max_tokens, model=None, stream=False) -> dict:
        # Always send the RESOLVED model, never the possibly-stale configured
        # one - that is the whole point of discovering at runtime.
        body = super()._payload(
            messages, temperature, max_tokens,
            model=model or self.status().model, stream=stream,
        )
        # Reasoning OFF.
        #
        # Several free models here are reasoning models with reasoning
        # enabled BY DEFAULT (the catalogue reports
        # `reasoning: {default_enabled: true}`). Those return `content: null`
        # and put everything in `reasoning`, so reading the reasoning field
        # yields the model's internal monologue rather than its answer:
        #
        #   "We need answer only describe visible. Need mention colors...
        #    Let's inspect mentally."
        #
        # Handing that to stage two is worse than useless - it is a thinking
        # trace being parsed as observations. Disabling reasoning puts the
        # answer back in `content` where it belongs, and this task does not
        # need chain-of-thought: stage one only describes what is in frame.
        body["reasoning"] = {"enabled": False}
        return body

    # Status codes that mean "not this model" rather than "not this request".
    # 403 covers access gating, 404 a withdrawn model, 429 a per-model quota.
    MODEL_UNAVAILABLE_CODES = (403, 404, 429, 500, 502, 503)

    # A 400 is ambiguous and needs the body to disambiguate. OpenRouter
    # returns 400 both for a genuinely malformed request AND for a downstream
    # provider rejecting a payload it does not like - the second wraps the
    # upstream error and names the provider:
    #
    #   400 {"error":{"message":"Provider returned error",
    #                 "metadata":{"provider_name":"Nex AGI", ...}}}
    #
    # The first must raise, because retrying a malformed request against
    # every model just fails five times more slowly. The second must fail
    # over, because another provider will accept the same payload.
    DOWNSTREAM_400_MARKERS = (
        "provider returned error", "provider_error_code", "provider_name",
    )

    # How many ranked candidates to try before giving up. Each failure costs a
    # round trip, so this is a bound on latency as much as on attempts.
    MAX_VISION_ATTEMPTS = 6

    def chat_with_image(self, messages, image_b64, media_type,
                        *, temperature=0.2, max_tokens=1400) -> str:
        """Try ranked vision candidates until one answers.

        WHY FAILOVER IS NECESSARY AND STATIC FILTERING IS NOT ENOUGH

          The catalogue is a hint, not a contract. `thinkingmachines/inkling-
          small:free` ranks first on every published field - free, image
          input, a 1M context window - and returns:

              403: only available on agentic harnesses

          Nothing in its catalogue entry indicates that restriction. There is
          no field to filter on, so no amount of pre-filtering avoids it. The
          only ground truth is whether a call succeeds.

          So the ranking decides the ORDER to try, and the first model that
          actually answers wins. The working model is then remembered for the
          process, because re-probing a gated model on every photograph would
          add a wasted round trip to each one.
        """
        st = self.status()
        if not st.supports_vision:
            raise LLMError(st.detail)

        # A model already proven to work this session goes first.
        candidates = self.free_vision_models()
        if self._working_vision_model in candidates:
            candidates.remove(self._working_vision_model)
            candidates.insert(0, self._working_vision_model)
        elif st.vision_model in candidates:
            candidates.remove(st.vision_model)
            candidates.insert(0, st.vision_model)

        attempts: list[str] = []
        for model in candidates[:self.MAX_VISION_ATTEMPTS]:
            self.vision_model = model
            try:
                answer = super().chat_with_image(
                    messages, image_b64, media_type,
                    temperature=temperature, max_tokens=max_tokens)
            except LLMError as exc:
                text = str(exc)
                lowered = text.lower()
                per_model = any(f" {code}" in text
                                for code in self.MODEL_UNAVAILABLE_CODES)
                # A 400 counts as per-model only when the body shows it came
                # from the downstream provider rather than from our request.
                if not per_model and " 400" in text:
                    per_model = any(m in lowered
                                    for m in self.DOWNSTREAM_400_MARKERS)
                if per_model:
                    code = next((c for c in (400,) + self.MODEL_UNAVAILABLE_CODES
                                 if f" {c}" in text), "?")
                    attempts.append(f"{model} ({code})")
                    continue
                raise
            # An empty response is a FAILURE, not a success.
            #
            # Several free models here are reasoning models with reasoning
            # enabled by default, and they return their thinking in a
            # `reasoning` field with `content` null. Passing that straight
            # through hands stage two an empty observation string, and stage
            # two then writes a corrosion assessment from nothing at all -
            # the same class of bug as the local model returning "irt." and
            # being treated as a real description.
            if not answer or not str(answer).strip():
                attempts.append(f"{model} (empty response)")
                continue

            self._working_vision_model = model
            return answer

        raise LLMError(
            "No free OpenRouter vision model accepted the request. Tried: "
            + "; ".join(attempts)
            + ". Photo analysis will fall back to local Ollama if a vision "
              "model is installed."
        )
