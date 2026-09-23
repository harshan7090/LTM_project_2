"""
Provider-agnostic LLM layer for the IntegrityAI assistant.

Deliberately supports several *free* backends behind one interface, because
which one works depends on the machine and the network:

  ollama       — runs locally, no API key, no outbound network calls at all.
                 Best option on a restricted corporate network. Needs the
                 Ollama daemon running (it ships as a desktop app/service).
  groq         — free API tier, very fast, needs a key from console.groq.com.
                 OpenAI-compatible wire format.
  huggingface  — free inference tier, needs a token from huggingface.co.
                 Also OpenAI-compatible via their router endpoint.
  mock         — canned domain-appropriate responses. No key, no daemon, no
                 network. Exists so the console is fully demoable when nothing
                 else is configured, instead of the UI erroring out.

Everything here speaks HTTP via `httpx`, which was already a dependency —
no vendor SDKs to install. That matters on a network where pip installs
have already been shown to hit certificate problems (see README §3).

VISION IS NOT UNIVERSAL. A text-only model cannot look at a photo, and asking
it to will produce confident nonsense rather than an error. So each provider
reports `supports_vision()` honestly and the API refuses image analysis rather
than faking it. See `VISION_MODEL_HINTS` for what counts as a vision model.
"""
import base64
import json
import os
from dataclasses import dataclass, field
from typing import Iterator

import httpx

# Substrings that mark an Ollama model as multimodal. Ollama has no capability
# flag in its /api/tags response, so name matching is the practical check.
# If you pull a vision model whose name isn't here, add it — an unmatched name
# means the console will (safely) say vision is unavailable.
VISION_MODEL_HINTS = (
    "vision", "llava", "moondream", "bakllava",
    "minicpm-v", "qwen2-vl", "qwen2.5vl", "qwen3-vl", "gemma3", "granite3.2-vision",
)

# Groq models that accept images. Groq deprecates and renames models fairly
# often, so this is a hint list used for picking a sensible default — the
# actual model can always be forced with LLM_VISION_MODEL in .env.
GROQ_VISION_HINTS = ("scout", "maverick", "vision", "llama-4")

DEFAULT_TIMEOUT = 120.0  # local models on CPU are slow; don't cut them off mid-answer


class LLMError(RuntimeError):
    """Raised for provider failures we want surfaced to the user verbatim."""


@dataclass
class ProviderStatus:
    """What the frontend needs to know to render honest UI affordances."""
    name: str
    available: bool
    model: str | None = None
    vision_model: str | None = None
    supports_vision: bool = False
    detail: str = ""
    models: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "provider": self.name,
            "available": self.available,
            "model": self.model,
            "vision_model": self.vision_model,
            "supports_vision": self.supports_vision,
            "detail": self.detail,
            "models": self.models,
        }


# --------------------------------------------------------------- base ----

class BaseProvider:
    name = "base"

    def status(self) -> ProviderStatus:
        raise NotImplementedError

    def chat(self, messages: list[dict], *, temperature: float = 0.2,
             max_tokens: int = 1200) -> str:
        raise NotImplementedError

    def stream(self, messages: list[dict], *, temperature: float = 0.2,
               max_tokens: int = 1200) -> Iterator[str]:
        """Default: fall back to a single blocking call, yielded once.
        Providers that genuinely stream override this."""
        yield self.chat(messages, temperature=temperature, max_tokens=max_tokens)

    def chat_with_image(self, messages: list[dict], image_b64: str, media_type: str,
                        *, temperature: float = 0.2, max_tokens: int = 1400) -> str:
        raise LLMError(f"{self.name} is not configured for image analysis.")


# ------------------------------------------------------------- ollama ----

class OllamaProvider(BaseProvider):
    """Local Ollama daemon. No key, no outbound traffic."""

    name = "ollama"

    def __init__(self, host: str, model: str | None, vision_model: str | None):
        self.host = host.rstrip("/")
        self._configured_model = model
        self._configured_vision = vision_model

    def _list_models(self) -> list[str]:
        try:
            r = httpx.get(f"{self.host}/api/tags", timeout=5.0)
            r.raise_for_status()
            return [m["name"] for m in r.json().get("models", [])]
        except Exception:
            return []

    def _pick_vision_model(self, models: list[str]) -> str | None:
        if self._configured_vision:
            # Trust an explicit override even if we can't confirm it's pulled —
            # the user may know better than our hint list.
            return self._configured_vision
        for m in models:
            if any(h in m.lower() for h in VISION_MODEL_HINTS):
                return m
        return None

    def status(self) -> ProviderStatus:
        models = self._list_models()
        if not models:
            return ProviderStatus(
                name=self.name, available=False,
                detail=f"No Ollama daemon reachable at {self.host}. Start Ollama, "
                       f"or set LLM_PROVIDER=groq in .env.",
            )
        model = self._configured_model or models[0]
        vision = self._pick_vision_model(models)
        detail = f"Local Ollama, model '{model}'."
        if not vision:
            detail += (" No vision model installed — run `ollama pull llama3.2-vision` "
                       "to enable photo analysis, or use Groq.")
        return ProviderStatus(
            name=self.name, available=True, model=model, vision_model=vision,
            supports_vision=bool(vision), detail=detail, models=models,
        )

    def _post(self, payload: dict, stream: bool) -> httpx.Response:
        return httpx.post(f"{self.host}/api/chat", json=payload,
                          timeout=DEFAULT_TIMEOUT)

    def chat(self, messages, *, temperature=0.2, max_tokens=1200) -> str:
        st = self.status()
        if not st.available:
            raise LLMError(st.detail)
        payload = {
            "model": st.model, "messages": messages, "stream": False,
            "options": {"temperature": temperature, "num_predict": max_tokens},
        }
        try:
            r = self._post(payload, stream=False)
            r.raise_for_status()
        except httpx.HTTPError as e:
            raise LLMError(f"Ollama request failed: {e}") from e
        return r.json().get("message", {}).get("content", "").strip()

    def stream(self, messages, *, temperature=0.2, max_tokens=1200):
        st = self.status()
        if not st.available:
            raise LLMError(st.detail)
        payload = {
            "model": st.model, "messages": messages, "stream": True,
            "options": {"temperature": temperature, "num_predict": max_tokens},
        }
        try:
            with httpx.stream("POST", f"{self.host}/api/chat", json=payload,
                              timeout=DEFAULT_TIMEOUT) as r:
                r.raise_for_status()
                for line in r.iter_lines():
                    if not line:
                        continue
                    try:
                        chunk = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    piece = chunk.get("message", {}).get("content", "")
                    if piece:
                        yield piece
                    if chunk.get("done"):
                        break
        except httpx.HTTPError as e:
            raise LLMError(f"Ollama stream failed: {e}") from e

    def chat_with_image(self, messages, image_b64, media_type,
                        *, temperature=0.2, max_tokens=1400) -> str:
        st = self.status()
        if not st.supports_vision:
            raise LLMError(st.detail or "No local vision model installed.")
        # Ollama takes images as bare base64 on the message, not a data URI.
        msgs = [dict(m) for m in messages]
        msgs[-1]["images"] = [image_b64]
        payload = {
            "model": st.vision_model, "messages": msgs, "stream": False,
            "options": {
                "temperature": temperature,
                "num_predict": max_tokens,
                # Small vision models degenerate into repetition loops — observed
                # on moondream, which repeated one sentence ten times until it hit
                # the token cap. A repeat penalty suppresses that at the decoding
                # level; the caller also de-duplicates as a belt-and-braces guard.
                "repeat_penalty": 1.18,
                "repeat_last_n": 128,
            },
        }
        try:
            r = httpx.post(f"{self.host}/api/chat", json=payload, timeout=DEFAULT_TIMEOUT * 2)
            r.raise_for_status()
        except httpx.HTTPError as e:
            raise LLMError(f"Ollama vision request failed: {e}") from e
        return r.json().get("message", {}).get("content", "").strip()


# ------------------------------------------- OpenAI-compatible providers ----

class OpenAICompatProvider(BaseProvider):
    """Shared implementation for Groq and HuggingFace, which both expose an
    OpenAI-shaped /chat/completions endpoint."""

    name = "openai-compat"
    base_url = ""
    default_model = ""
    default_vision_model = ""

    def __init__(self, api_key: str | None, model: str | None, vision_model: str | None):
        self.api_key = api_key
        self.model = model or self.default_model
        self.vision_model = vision_model or self.default_vision_model

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}

    def status(self) -> ProviderStatus:
        if not self.api_key:
            return ProviderStatus(
                name=self.name, available=False,
                detail=f"No API key set. Add {self.name.upper()}_API_KEY to .env.",
            )
        return ProviderStatus(
            name=self.name, available=True, model=self.model,
            vision_model=self.vision_model, supports_vision=bool(self.vision_model),
            detail=f"{self.name} API, model '{self.model}'.",
        )

    @staticmethod
    def _extract_text(payload: dict) -> str:
        """Pull the assistant text out of an OpenAI-shaped response.

        `message.content` is not reliably a string:

          - Reasoning models with reasoning enabled by default can return
            `content: null` and put everything in `reasoning`.
          - Some providers return a content-part LIST rather than a string.

        The previous code did `["content"].strip()` directly, so a null
        content raised AttributeError several frames away from the cause,
        which is a confusing way to learn that a model answered in a field
        you were not reading.

        Returns "" rather than raising when there is genuinely nothing. The
        caller decides what an empty answer means - for vision it is a
        failover trigger, because handing stage two an empty observation
        makes it write an assessment from nothing.
        """
        try:
            message = payload["choices"][0]["message"]
        except (KeyError, IndexError, TypeError):
            return ""

        content = message.get("content")
        if content is None:
            content = message.get("reasoning")
        if isinstance(content, list):
            content = "".join(
                part.get("text", "") for part in content
                if isinstance(part, dict)
            )
        return (content or "").strip()

    def _payload(self, messages, temperature, max_tokens, model=None, stream=False) -> dict:
        return {
            "model": model or self.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": stream,
        }

    def chat(self, messages, *, temperature=0.2, max_tokens=1200) -> str:
        if not self.api_key:
            raise LLMError(self.status().detail)
        try:
            r = httpx.post(f"{self.base_url}/chat/completions",
                           headers=self._headers(),
                           json=self._payload(messages, temperature, max_tokens),
                           timeout=DEFAULT_TIMEOUT)
            r.raise_for_status()
        except httpx.HTTPStatusError as e:
            raise LLMError(f"{self.name} returned {e.response.status_code}: "
                           f"{e.response.text[:300]}") from e
        except httpx.HTTPError as e:
            raise LLMError(f"{self.name} request failed: {e}") from e
        return self._extract_text(r.json())

    def stream(self, messages, *, temperature=0.2, max_tokens=1200):
        if not self.api_key:
            raise LLMError(self.status().detail)
        payload = self._payload(messages, temperature, max_tokens, stream=True)
        try:
            with httpx.stream("POST", f"{self.base_url}/chat/completions",
                              headers=self._headers(), json=payload,
                              timeout=DEFAULT_TIMEOUT) as r:
                if r.status_code >= 400:
                    # On a streaming response the body has not been fetched, so
                    # `.text` raises ResponseNotRead and the real API error is
                    # lost behind a confusing httpx exception. Read it first.
                    r.read()
                    raise LLMError(
                        f"{self.name} returned {r.status_code}: {r.text[:400]}"
                    )
                for line in r.iter_lines():
                    if not line or not line.startswith("data:"):
                        continue
                    data = line[len("data:"):].strip()
                    if data == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    delta = chunk.get("choices", [{}])[0].get("delta", {})
                    piece = delta.get("content")
                    if piece:
                        yield piece
        except httpx.HTTPError as e:
            raise LLMError(f"{self.name} stream failed: {e}") from e

    def chat_with_image(self, messages, image_b64, media_type,
                        *, temperature=0.2, max_tokens=1400) -> str:
        if not self.api_key:
            raise LLMError(self.status().detail)
        if not self.vision_model:
            raise LLMError(f"No vision model configured for {self.name}. "
                           f"Set LLM_VISION_MODEL in .env.")
        # OpenAI-compatible vision takes a data URI in a content part list.
        msgs = [dict(m) for m in messages]
        last = msgs[-1]
        msgs[-1] = {
            "role": last["role"],
            "content": [
                {"type": "text", "text": last["content"]},
                {"type": "image_url",
                 "image_url": {"url": f"data:{media_type};base64,{image_b64}"}},
            ],
        }
        try:
            r = httpx.post(f"{self.base_url}/chat/completions",
                           headers=self._headers(),
                           json=self._payload(msgs, temperature, max_tokens,
                                              model=self.vision_model),
                           timeout=DEFAULT_TIMEOUT)
            r.raise_for_status()
        except httpx.HTTPStatusError as e:
            raise LLMError(f"{self.name} vision returned {e.response.status_code}: "
                           f"{e.response.text[:300]}") from e
        except httpx.HTTPError as e:
            raise LLMError(f"{self.name} vision request failed: {e}") from e
        return self._extract_text(r.json())


class GroqProvider(OpenAICompatProvider):
    """Groq, with runtime model discovery.

    Groq retires models frequently and without much warning — a hardcoded name
    that worked last month returns a 404 `model_not_found` today, and the
    failure looks like a broken integration rather than a decommissioned model.
    So instead of trusting a constant, this asks /v1/models what the account
    can actually use and picks from that.

    The preference lists below are ordered by capability, but ANY name in them
    is only used if the API confirms it exists.
    """

    name = "groq"
    base_url = "https://api.groq.com/openai/v1"

    # Substrings matched against live model IDs, best first.
    CHAT_PREFERENCE = (
        "gpt-oss-120b", "llama-3.3-70b", "llama-3.1-70b",
        "qwen3.8", "qwen3.6", "gpt-oss-20b", "compound",
    )
    # Models that can accept an image. Kept separate from CHAT_PREFERENCE
    # because most Groq text models cannot, and guessing wrong means the photo
    # feature fails at call time instead of being reported as unavailable.
    VISION_PREFERENCE = ("scout", "maverick", "llama-4", "vision", "-vl")

    _cached_models: list[str] | None = None

    def _available_models(self) -> list[str]:
        if self._cached_models is not None:
            return self._cached_models
        try:
            r = httpx.get(f"{self.base_url}/models", headers=self._headers(), timeout=15.0)
            r.raise_for_status()
            ids = sorted(m["id"] for m in r.json().get("data", []))
        except Exception:
            ids = []
        self._cached_models = ids
        return ids

    @staticmethod
    def _first_match(models: list[str], preferences: tuple[str, ...]) -> str | None:
        for pref in preferences:
            for m in models:
                if pref in m.lower():
                    return m
        return None

    def status(self) -> ProviderStatus:
        if not self.api_key:
            return ProviderStatus(
                name=self.name, available=False,
                detail="No Groq API key. Get a free one at console.groq.com, "
                       "then set GROQ_API_KEY in .env.",
            )

        models = self._available_models()
        if not models:
            return ProviderStatus(
                name=self.name, available=False,
                detail="Groq API key is set but the model list could not be "
                       "fetched — check the key and network access.",
            )

        # An explicitly configured model is honoured only if it really exists;
        # otherwise fall back and say so, rather than 404 on every request.
        chat = None
        note = ""
        if self.model and self.model in models:
            chat = self.model
        elif self.model:
            note = (f" Configured LLM_MODEL '{self.model}' is not available on "
                    f"this account — using '{{picked}}' instead.")
        if chat is None:
            chat = self._first_match(models, self.CHAT_PREFERENCE) or models[0]
            note = note.replace("{picked}", chat)

        vision = None
        if self.vision_model and self.vision_model in models:
            vision = self.vision_model
        else:
            vision = self._first_match(models, self.VISION_PREFERENCE)

        detail = f"Groq API, model '{chat}'."
        if vision:
            detail += f" Vision: '{vision}'."
        else:
            detail += (" This Groq account has no vision-capable model, so photo "
                       "analysis is unavailable here — run `ollama pull moondream` "
                       "for local image analysis instead.")
        detail += note

        return ProviderStatus(
            name=self.name, available=True, model=chat,
            vision_model=vision, supports_vision=bool(vision),
            detail=detail, models=models,
        )

    # Requests must use the resolved model, not the possibly-stale configured one.
    def _payload(self, messages, temperature, max_tokens, model=None, stream=False) -> dict:
        return super()._payload(
            messages, temperature, max_tokens,
            model=model or self.status().model, stream=stream,
        )

    def chat_with_image(self, messages, image_b64, media_type,
                        *, temperature=0.2, max_tokens=1400) -> str:
        st = self.status()
        if not st.supports_vision:
            raise LLMError(st.detail)
        self.vision_model = st.vision_model
        return super().chat_with_image(messages, image_b64, media_type,
                                       temperature=temperature, max_tokens=max_tokens)


class HuggingFaceProvider(OpenAICompatProvider):
    name = "huggingface"
    base_url = "https://router.huggingface.co/v1"
    default_model = "meta-llama/Llama-3.3-70B-Instruct"
    default_vision_model = "Qwen/Qwen2.5-VL-7B-Instruct"

    def status(self) -> ProviderStatus:
        st = super().status()
        if not st.available:
            st.detail = ("No HuggingFace token. Create one at "
                         "huggingface.co/settings/tokens, then set "
                         "HUGGINGFACE_API_KEY in .env.")
        return st


# --------------------------------------------------------------- mock ----

class MockProvider(BaseProvider):
    """Canned responses so the console demos without any LLM configured.

    This is NOT a fallback that silently pretends to be a real model — every
    response it produces is prefixed so nobody mistakes it for genuine model
    output, and the status endpoint reports provider='mock' so the UI can
    label it clearly.
    """

    name = "mock"

    PREFIX = "*(Demo mode — no LLM is configured, this is a canned response.)*\n\n"

    def status(self) -> ProviderStatus:
        return ProviderStatus(
            name=self.name, available=True, model="canned-responses",
            vision_model="canned-responses", supports_vision=True,
            detail="No LLM configured — running canned demo responses. "
                   "Start Ollama or set GROQ_API_KEY in .env for real answers.",
        )

    def chat(self, messages, *, temperature=0.2, max_tokens=1200) -> str:
        user = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")
        text = user if isinstance(user, str) else ""
        return self.PREFIX + (
            "Based on the segment data provided, the dominant corrosion driver is "
            "typically the combination of absent cathodic protection and degraded "
            "coating in low-resistivity soil. Under NACE SP0169, a pipe-to-soil "
            "potential more positive than −850 mV (CSE) indicates inadequate "
            "protection and warrants a close-interval potential survey.\n\n"
            "Recommended sequence:\n"
            "1. Verify CP rectifier output and confirm with a CIPS run.\n"
            "2. Schedule UT wall-thickness readings at the lowest-resistivity spans.\n"
            "3. Re-evaluate against API 570 inspection intervals once thickness data exists.\n\n"
            f"(Your question was: “{text[:160]}”)"
        )

    def chat_with_image(self, messages, image_b64, media_type,
                        *, temperature=0.2, max_tokens=1400) -> str:
        return self.PREFIX + (
            "**Visual observations**\n"
            "- Coating disbondment visible along the longitudinal weld seam, with "
            "red-oxide staining consistent with active soil-side attack.\n"
            "- Localised pitting morphology rather than uniform metal loss.\n"
            "- Surface moisture and vegetation contact at the soil-to-air interface.\n\n"
            "**Consistency with the model**\n"
            "These observations are consistent with the elevated predicted rate and "
            "with absent cathodic protection as the leading SHAP driver.\n\n"
            "**Recommended actions**\n"
            "1. Close-interval potential survey to confirm the CP deficiency.\n"
            "2. UT wall-thickness readings at the visibly pitted region.\n"
            "3. Coating repair scoped after thickness results are known.\n\n"
            "**Limitations**\n"
            "Wall loss and pit depth cannot be measured from a photograph. No scale "
            "reference is present in frame. This is qualitative triage only, not a "
            "fitness-for-service assessment under API 579-1."
        )


# ------------------------------------------------------------ factory ----

_PROVIDERS = {
    "openrouter": "backend.openrouter:OpenRouterProvider",  # lazy, see _openrouter()
    "ollama": OllamaProvider,
    "groq": GroqProvider,
    "huggingface": HuggingFaceProvider,
    "mock": MockProvider,
}


def _openrouter():
    """Imported lazily: backend/openrouter.py subclasses OpenAICompatProvider
    from this module, so a top-level import here would be circular."""
    from backend.openrouter import OpenRouterProvider
    return OpenRouterProvider


def build_provider(name: str, cfg) -> BaseProvider:
    name = (name or "").lower()
    if name == "openrouter":
        return _openrouter()(getattr(cfg, "OPENROUTER_API_KEY", ""),
                             cfg.LLM_MODEL, cfg.LLM_VISION_MODEL)
    if name == "ollama":
        return OllamaProvider(cfg.OLLAMA_HOST, cfg.LLM_MODEL, cfg.LLM_VISION_MODEL)
    if name == "groq":
        return GroqProvider(cfg.GROQ_API_KEY, cfg.LLM_MODEL, cfg.LLM_VISION_MODEL)
    if name == "huggingface":
        return HuggingFaceProvider(cfg.HUGGINGFACE_API_KEY, cfg.LLM_MODEL, cfg.LLM_VISION_MODEL)
    return MockProvider()


def auto_select(cfg) -> BaseProvider:
    """Pick the best provider actually available, in preference order.

    Explicit LLM_PROVIDER in .env always wins — including when it's broken,
    because silently falling back to a different backend than the one the user
    configured makes misconfiguration impossible to debug.
    """
    if cfg.LLM_PROVIDER:
        return build_provider(cfg.LLM_PROVIDER, cfg)

    # OpenRouter first when a key exists: it is the only option here that
    # reaches a 70B-class VISION model on a free tier, and photo quality is
    # the weakest link in the two-stage pipeline.
    if getattr(cfg, "OPENROUTER_API_KEY", ""):
        return _openrouter()(cfg.OPENROUTER_API_KEY, cfg.LLM_MODEL,
                             cfg.LLM_VISION_MODEL)
    # Groq next: much faster than local CPU inference for text.
    if cfg.GROQ_API_KEY:
        return GroqProvider(cfg.GROQ_API_KEY, cfg.LLM_MODEL, cfg.LLM_VISION_MODEL)
    if cfg.HUGGINGFACE_API_KEY:
        return HuggingFaceProvider(cfg.HUGGINGFACE_API_KEY, cfg.LLM_MODEL, cfg.LLM_VISION_MODEL)

    ollama = OllamaProvider(cfg.OLLAMA_HOST, cfg.LLM_MODEL, cfg.LLM_VISION_MODEL)
    if ollama.status().available:
        return ollama

    return MockProvider()


def ollama_embed(texts: list[str], model: str = "nomic-embed-text",
                 host: str | None = None, timeout: float = 120.0) -> list[list[float]]:
    """Embed texts with a local Ollama model.

    One request per text rather than a batch: Ollama's /api/embed accepts a
    list, but a single oversized batch on CPU can exceed the timeout and lose
    the whole run, whereas per-text failures are isolated and retryable.
    """
    import httpx

    base = (host or os.getenv("OLLAMA_HOST", "http://localhost:11434")).rstrip("/")
    out: list[list[float]] = []
    with httpx.Client(timeout=timeout) as client:
        for text in texts:
            r = client.post(f"{base}/api/embed", json={"model": model, "input": text})
            if r.status_code >= 400:
                raise LLMError(f"Ollama embed returned {r.status_code}: {r.text[:200]}")
            data = r.json()
            vectors = data.get("embeddings") or ([data["embedding"]] if "embedding" in data else [])
            if not vectors:
                raise LLMError(f"Ollama embed returned no vector for model '{model}'")
            out.append(vectors[0])
    return out


def embedding_model_available(model: str = "nomic-embed-text",
                              host: str | None = None) -> bool:
    """Whether Ollama is up and holds the embedding model. Never raises."""
    import httpx

    base = (host or os.getenv("OLLAMA_HOST", "http://localhost:11434")).rstrip("/")
    try:
        with httpx.Client(timeout=3.0) as client:
            r = client.get(f"{base}/api/tags")
            r.raise_for_status()
            names = [m["name"] for m in r.json().get("models", [])]
    except Exception:  # noqa: BLE001
        return False
    want = model.split(":")[0]
    return any(n.split(":")[0] == want for n in names)


def select_vision_provider(cfg, text_provider: BaseProvider) -> BaseProvider | None:
    """Finds a provider that can actually look at an image.

    Vision and text do NOT have to come from the same backend, and on a typical
    setup they can't be: Groq's free tier serves the strongest text model but no
    vision model, while a local Ollama install can see images but reasons
    slowly. Pairing them gives local sight with fast reasoning.

    Order:
      1. The text provider itself, if it supports vision — one backend is
         simpler and avoids a second round trip.
      2. OpenRouter, if a key is present. This sits ABOVE local Ollama
         because it is the only route here to a large vision model: local
         moondream is 1.8B and describes a corrosion photograph in a
         sentence, while the free models OpenRouter lists run to tens of
         billions of parameters.
      3. Local Ollama, if a vision model is installed. Still the fallback
         that needs no key and no network.
      4. The mock provider, only when the text provider is already mock —
         otherwise returning canned image analysis alongside real chat answers
         would be actively misleading.
      5. None — the API then reports honestly that vision is unavailable.

    WHY LLM_PROVIDER DOES NOT GOVERN THIS

      Setting LLM_PROVIDER pins the TEXT backend, deliberately and
      absolutely, so a misconfiguration is debuggable rather than silently
      routed around. Vision is a separate capability and is selected on its
      own merits: with LLM_PROVIDER=groq the console gets Groq's fast text
      model, which cannot see, paired with the best vision model available.
      Forcing both onto one backend would mean choosing between fast chat and
      usable photo analysis for no reason.
    """
    if text_provider.status().supports_vision:
        return text_provider

    if getattr(cfg, "OPENROUTER_API_KEY", ""):
        from backend.openrouter import OpenRouterProvider
        router = OpenRouterProvider(cfg.OPENROUTER_API_KEY, None,
                                    cfg.LLM_VISION_MODEL)
        if router.status().supports_vision:
            return router

    ollama = OllamaProvider(cfg.OLLAMA_HOST, None, cfg.LLM_VISION_MODEL)
    if ollama.status().supports_vision:
        return ollama

    if isinstance(text_provider, MockProvider):
        return text_provider

    return None


def encode_image(raw: bytes) -> str:
    return base64.standard_b64encode(raw).decode("utf-8")
