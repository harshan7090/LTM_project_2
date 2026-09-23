import os
from pathlib import Path
from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parent.parent
load_dotenv(ROOT_DIR / ".env")


class Settings:
    ROOT_DIR = ROOT_DIR
    DATA_RAW_DIR = ROOT_DIR / "data" / "raw"
    DATA_PROCESSED_DIR = ROOT_DIR / "data" / "processed"
    MODELS_DIR = ROOT_DIR / "models"
    RANDOM_SEED = int(os.getenv("RANDOM_SEED", 42))

    # Defaults to a local SQLite file — zero setup, works directly with DB
    # Browser for SQLite. Point this at Postgres instead (for pgAdmin) by
    # setting DATABASE_URL in .env, e.g.:
    #   postgresql+psycopg2://user:password@localhost:5432/integrityai
    DATABASE_URL = os.getenv(
        "DATABASE_URL", f"sqlite:///{ROOT_DIR / 'data' / 'processed' / 'integrityai.db'}"
    )

    # ---- LLM assistant -------------------------------------------------
    # Leave LLM_PROVIDER unset to auto-detect in this order:
    #   groq (if key) -> huggingface (if key) -> ollama (if running) -> mock
    # Set it explicitly to pin one backend. An explicit choice is never
    # silently overridden, so a misconfiguration surfaces as an error rather
    # than as "it quietly used something else."
    LLM_PROVIDER = os.getenv("LLM_PROVIDER", "").strip().lower() or None
    LLM_MODEL = os.getenv("LLM_MODEL", "").strip() or None
    LLM_VISION_MODEL = os.getenv("LLM_VISION_MODEL", "").strip() or None

    OLLAMA_HOST = os.getenv("OLLAMA_HOST", "http://localhost:11434")
    # OpenRouter gives free-tier access to 70B-class VISION models, which is
    # the single biggest available improvement to photo analysis — the local
    # 1.8B model is the weakest link in the two-stage pipeline.
    OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")

    # Whether to embed the QUERY at request time for dense retrieval.
    #
    # Separate from whether a dense index exists, because the costs are very
    # different. Loading the cached index is ~3 ms; embedding one query on CPU
    # is ~6 s, which is added to every assistant question and is the entire
    # cost of a /api/knowledge/search call.
    #
    # Worth it for chat, where generation already takes 10-20 s on this
    # hardware and the retrieval win is real (paraphrase recall@3 went 1/8 to
    # 6/8). Set to 0 on a machine where the latency is not worth it — the
    # index stays loaded and lexical retrieval keeps working.
    RAG_DENSE_QUERIES = os.getenv("RAG_DENSE_QUERIES", "1").lower() not in ("0", "false", "no")
    # --- fleet map -------------------------------------------------------
    # Raster tiles are fetched by the SERVER and relayed to the browser, so
    # the key never reaches the client and the console's img-src can stay
    # 'self'. A third-party tile host in the CSP would be a real widening
    # of it for something the backend can just as easily fetch.
    #
    # Geoapify satellite needs a real key (it 401s without one); the OSM
    # fallback needs none, so the map works out of the box either way.
    MAP_PROVIDER = os.getenv("MAP_PROVIDER", "").strip().lower() or "auto"
    GEOAPIFY_API_KEY = os.getenv("GEOAPIFY_API_KEY", "").strip()
    MAP_STYLE = os.getenv("MAP_STYLE", "satellite").strip() or "satellite"

    GROQ_API_KEY = os.getenv("GROQ_API_KEY", "").strip() or None
    HUGGINGFACE_API_KEY = os.getenv("HUGGINGFACE_API_KEY", "").strip() or None

    # Upload guard rails for the photo-analysis endpoint. An image upload is a
    # new attack surface, so cap it rather than trusting the client.
    MAX_IMAGE_BYTES = int(os.getenv("MAX_IMAGE_BYTES", 8 * 1024 * 1024))  # 8 MB


settings = Settings()

for _dir in (settings.DATA_RAW_DIR, settings.DATA_PROCESSED_DIR, settings.MODELS_DIR):
    _dir.mkdir(parents=True, exist_ok=True)
