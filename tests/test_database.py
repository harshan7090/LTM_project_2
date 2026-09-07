import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import create_engine  # noqa: E402

from src.data import database  # noqa: E402
from src.data.synthetic_generator import generate_pipeline_dataset  # noqa: E402


def _fresh_test_engine():
    """In-memory SQLite — isolated from the real project database."""
    return create_engine("sqlite:///:memory:")


def test_load_and_read_round_trip():
    engine = _fresh_test_engine()
    df = generate_pipeline_dataset(n_segments=50)
    written = database.load_segments_into_db(df, engine=engine)
    assert written == 50

    read_back = database.read_segments_from_db(engine=engine)
    assert len(read_back) == 50
    assert set(read_back.columns) == set(df.columns)


def test_acknowledgements_start_empty():
    engine = _fresh_test_engine()
    assert database.get_all_acknowledgements(engine=engine) == {}


def test_insert_and_read_acknowledgement():
    engine = _fresh_test_engine()
    database.insert_acknowledgement("SEG-00001", "Test Engineer", "2026-01-01T00:00:00", engine=engine)

    acks = database.get_all_acknowledgements(engine=engine)
    assert "SEG-00001" in acks
    assert acks["SEG-00001"]["by"] == "Test Engineer"


def test_acknowledging_same_segment_twice_replaces_not_duplicates():
    engine = _fresh_test_engine()
    database.insert_acknowledgement("SEG-00001", "First Engineer", "2026-01-01T00:00:00", engine=engine)
    database.insert_acknowledgement("SEG-00001", "Second Engineer", "2026-01-02T00:00:00", engine=engine)

    acks = database.get_all_acknowledgements(engine=engine)
    assert len(acks) == 1
    assert acks["SEG-00001"]["by"] == "Second Engineer"


def test_coating_type_uncoated_survives_db_round_trip():
    """Regression test for the 'None' -> NaN bug: make sure a category value
    that could collide with a null-like string still comes back as text."""
    engine = _fresh_test_engine()
    df = generate_pipeline_dataset(n_segments=500)
    assert (df["coating_type"] == "Uncoated").any(), "test fixture should include at least one Uncoated segment"

    database.load_segments_into_db(df, engine=engine)
    read_back = database.read_segments_from_db(engine=engine)
    assert (read_back["coating_type"] == "Uncoated").sum() == (df["coating_type"] == "Uncoated").sum()
    assert read_back["coating_type"].isna().sum() == 0
