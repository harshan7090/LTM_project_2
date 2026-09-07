"""
Loads the synthetic pipeline dataset into a real database — SQLite by
default (open directly in DB Browser for SQLite, no server needed), or
Postgres if DATABASE_URL in .env is set to a postgresql:// connection
string (view in pgAdmin instead).

Usage:
    python scripts/load_to_database.py

Re-run any time the dataset changes (e.g. after regenerating synthetic
data) — it replaces the table rather than appending to it.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from config.settings import settings  # noqa: E402
from src.data.database import get_engine, load_segments_into_db, ensure_acknowledgements_table  # noqa: E402
from src.data.synthetic_generator import generate_pipeline_dataset  # noqa: E402


def main():
    data_path = settings.DATA_PROCESSED_DIR / "synthetic_pipeline_corrosion.csv"

    if data_path.exists():
        import pandas as pd
        print(f"Loading existing dataset from {data_path}")
        df = pd.read_csv(data_path, keep_default_na=False, na_values=[""])
    else:
        print("No CSV found — generating synthetic dataset first...")
        df = generate_pipeline_dataset(n_segments=5000)
        df.to_csv(data_path, index=False)
        print(f"Generated {len(df):,} segments -> {data_path}")

    engine = get_engine()
    print(f"\nTarget database: {settings.DATABASE_URL}")

    row_count = load_segments_into_db(df, engine)
    ensure_acknowledgements_table(engine)

    print(f"\nLoaded {row_count:,} rows into table 'pipeline_segments'")
    print(f"Columns ({len(df.columns)}): {list(df.columns)}")
    print("Created (empty) table 'acknowledgements' for alert acknowledgement history")

    if settings.DATABASE_URL.startswith("sqlite"):
        db_path = settings.DATABASE_URL.replace("sqlite:///", "")
        print(f"\nOpen this file in DB Browser for SQLite: {db_path}")
        print("  File -> Open Database -> select that file -> 'Browse Data' tab -> pick 'pipeline_segments'")
    else:
        print("\nConnect pgAdmin to this database, then expand:")
        print("  Databases -> (your db) -> Schemas -> public -> Tables -> pipeline_segments")


if __name__ == "__main__":
    main()
