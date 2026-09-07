"""
Database layer for IntegrityAI. Backed by SQLAlchemy so the exact same code
works against SQLite (zero setup — open the .db file directly in DB Browser
for SQLite) or PostgreSQL (point pgAdmin at it instead) — whichever
DATABASE_URL in .env says to use.

Two tables:
  pipeline_segments  — one row per segment, mirrors the synthetic/real dataset
  acknowledgements    — one row per acknowledged alert (segment_id, by, at)

Usage:
    python scripts/load_to_database.py        # (re)builds the database
Then open data/processed/integrityai.db in DB Browser for SQLite, or point
pgAdmin at your Postgres DATABASE_URL — either way you'll see these two
tables with real columns and rows.
"""
import sys
from pathlib import Path

import pandas as pd
from sqlalchemy import create_engine, text

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
from config.settings import settings  # noqa: E402

SEGMENTS_TABLE = "pipeline_segments"
ACK_TABLE = "acknowledgements"

_engine = None


def get_engine():
    global _engine
    if _engine is None:
        _engine = create_engine(settings.DATABASE_URL)
    return _engine


def load_segments_into_db(df: pd.DataFrame, engine=None) -> int:
    """Writes the full segments dataframe into the database, replacing any
    existing table. Returns the number of rows written."""
    engine = engine or get_engine()
    df.to_sql(SEGMENTS_TABLE, engine, if_exists="replace", index=False)
    return len(df)


def read_segments_from_db(engine=None) -> pd.DataFrame:
    engine = engine or get_engine()
    return pd.read_sql_table(SEGMENTS_TABLE, engine)


def ensure_acknowledgements_table(engine=None) -> None:
    engine = engine or get_engine()
    with engine.begin() as conn:
        conn.execute(text(f"""
            CREATE TABLE IF NOT EXISTS {ACK_TABLE} (
                segment_id TEXT PRIMARY KEY,
                acknowledged_by TEXT NOT NULL,
                acknowledged_at TEXT NOT NULL
            )
        """))


def insert_acknowledgement(segment_id: str, by: str, at: str, engine=None) -> None:
    engine = engine or get_engine()
    ensure_acknowledgements_table(engine)
    with engine.begin() as conn:
        # INSERT OR REPLACE is SQLite dialect; for Postgres this uses a
        # portable delete-then-insert instead so the same code works on both.
        if engine.dialect.name == "sqlite":
            conn.execute(
                text(f"INSERT OR REPLACE INTO {ACK_TABLE} (segment_id, acknowledged_by, acknowledged_at) "
                     f"VALUES (:sid, :by, :at)"),
                {"sid": segment_id, "by": by, "at": at},
            )
        else:
            conn.execute(text(f"DELETE FROM {ACK_TABLE} WHERE segment_id = :sid"), {"sid": segment_id})
            conn.execute(
                text(f"INSERT INTO {ACK_TABLE} (segment_id, acknowledged_by, acknowledged_at) "
                     f"VALUES (:sid, :by, :at)"),
                {"sid": segment_id, "by": by, "at": at},
            )


def get_all_acknowledgements(engine=None) -> dict:
    engine = engine or get_engine()
    ensure_acknowledgements_table(engine)
    with engine.begin() as conn:
        rows = conn.execute(text(f"SELECT segment_id, acknowledged_by, acknowledged_at FROM {ACK_TABLE}")).fetchall()
    return {r[0]: {"by": r[1], "at": r[2]} for r in rows}
