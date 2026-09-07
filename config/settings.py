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


settings = Settings()

for _dir in (settings.DATA_RAW_DIR, settings.DATA_PROCESSED_DIR, settings.MODELS_DIR):
    _dir.mkdir(parents=True, exist_ok=True)
