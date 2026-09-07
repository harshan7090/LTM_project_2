# IntegrityAI — Pipeline Corrosion Risk Assessment

Predicts external corrosion rate for pipeline segments, explains *why* via
SHAP, and flags the highest-risk segments for inspection priority.

## 1. Setup

```bash
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

In VS Code: **Cmd/Ctrl+Shift+P → "Python: Select Interpreter" → `./venv/bin/python`**

## 2. Run the full pipeline (generates data if needed, trains, explains)

```bash
python scripts/run_pipeline.py
```

Or press **F5** in VS Code → "Run Full Pipeline". This:
1. Generates a synthetic pipeline dataset (if one isn't already in `data/processed/`)
2. Trains an XGBoost model to predict corrosion rate (mils/year)
3. Produces a global SHAP summary plot (`models/shap_summary.png`)
4. Explains the single highest-risk segment in plain terms

## 3. About the dataset

**Currently synthetic, but not arbitrary.** `src/data/synthetic_generator.py`
builds pipe segments with realistic corrosion engineering relationships
baked in: no cathodic protection roughly triples the corrosion rate, coating
quality ranks correctly (FBE > coal tar > tape > none), corrosive soil
(low resistivity) increases risk, and repairs correlate with ongoing
issues. This is deliberately labeled synthetic — same approach used for
DealSense AI's demo documents — so the model, SHAP, and prioritization logic
can all be built and tested *today*, without waiting on a real dataset's
schema.

**A real dataset acquisition script is also included:**
`scripts/fetch_phmsa_data.py` downloads PHMSA's (U.S. DOT's pipeline safety
regulator) public "Pipeline Incident Flagged Files" — real incident reports
from every regulated U.S. pipeline operator, including corrosion-caused
failures. Run it locally (needs live internet access):

```bash
python scripts/fetch_phmsa_data.py
```

This downloads and unzips the file, then **prints the actual column
structure** of every sheet it finds, rather than guessing — PHMSA's schema
varies by pipeline type (gas distribution / transmission / hazardous
liquid) and has changed over the years. Once you see the real columns,
share them and the preprocessing in `src/data/preprocessing.py` can be
adapted to match exactly, replacing the synthetic generator.

**If this fails with `CERTIFICATE_VERIFY_FAILED`:** this is a corporate-network
issue, not a PHMSA problem — see the detailed fix printed by the script
itself. Short version: `pip install pip-system-certs` (makes Python trust
Windows' certificate store, which already trusts your corporate proxy),
then re-run. Full explanation and a documented `--insecure` last resort are
in the script's own error output.

## 4. Run tests

```bash
python -m pytest tests/ -v
```

15 tests total: 5 on the data/model pipeline (including one that
specifically checks the core physical relationship the synthetic labels
are built on — no cathodic protection → higher mean corrosion rate), plus
10 on the console's authentication and role-based access control (below).

## 5. IntegrityAI Console (web dashboard)

A full login-gated dashboard for pipeline engineers, built on the same
trained model — not a mockup, every button is wired to a real backend call.

```bash
uvicorn backend.main:app --reload --port 8010
```

Open **http://localhost:8010**. Demo accounts (all fictional):

| Username | Password | Role | Scope |
|---|---|---|---|
| `inspector1` | `inspect123` | Inspector | Gulf Coast region only |
| `supervisor1` | `supervise123` | Supervisor | All regions + Fleet Overview |
| `admin` | `admin123` | Admin | Full access |

**What's real, not cosmetic:**
- Role checks happen **on the server**, not just hidden UI — an inspector
  hitting `/api/stats` or another region's segment directly gets a real
  HTTP 403, verified by `tests/test_backend_auth.py`, not just "the button
  isn't shown."
- Every segment's SHAP explanation is computed **live** from the actual
  trained model when you open it — nothing is precomputed or faked.
- Acknowledging an alert actually persists (in-memory) and is reflected
  back in the detail panel and dashboard status column.
- The CSV export on Fleet Overview streams real filtered data.

**What's demo-grade, on purpose, and documented as such in `backend/auth.py`:**
tokens live in memory (wiped on restart), passwords are hashed but with a
static salt, there's no HTTPS enforcement. A real deployment needs a proper
identity provider, not a hand-rolled token store — the point here is
demonstrating role-based access *actually being enforced*, not building
production auth infrastructure.

Chart.js is vendored locally in `frontend/vendor/` rather than loaded from
a CDN, specifically because a blocked CDN domain would silently leave the
Fleet Overview histogram blank — one less thing that can fail on a
restrictive network.

## 6. Viewing the data as a database (DB Browser for SQLite / pgAdmin)

```bash
python scripts/load_to_database.py
```

This loads the dataset into a real database — two tables, `pipeline_segments`
(5000 rows, 17 columns) and `acknowledgements` (starts empty, fills up as you
acknowledge alerts in the console). By default it's a local SQLite file at
`data/processed/integrityai.db`, requiring no server setup at all.

**To view it in DB Browser for SQLite:**
1. Download DB Browser for SQLite (free): https://sqlitebrowser.org/dl/
2. Open it → **File → Open Database** → select `data/processed/integrityai.db`
3. Click the **Browse Data** tab → pick `pipeline_segments` from the dropdown

You'll see all 5000 rows with columns like `segment_id`, `pipe_age_years`,
`coating_type`, `corrosion_rate_mpy`, etc. — sortable and filterable right
in the GUI.

**To use PostgreSQL + pgAdmin instead:**
1. Install PostgreSQL and create a database (e.g. `integrityai`) and a user
2. In `.env` (copy from `.env.example` if you don't have one), set:
   ```
   DATABASE_URL=postgresql+psycopg2://<user>:<password>@localhost:5432/integrityai
   ```
3. Re-run `python scripts/load_to_database.py` — same script, same tables,
   now written to Postgres instead of SQLite
4. In pgAdmin, connect to that database, then expand
   **Databases → integrityai → Schemas → public → Tables → pipeline_segments**
   → right-click → **View/Edit Data → All Rows**

**The console (backend/ml.py) reads from this database, not the CSV
directly** — so this isn't just an export for viewing, it's the actual data
source the app uses. Acknowledging an alert in the console writes a real row
into the `acknowledgements` table, which you can watch appear in DB
Browser/pgAdmin if you refresh after acknowledging one. Re-run
`load_to_database.py` any time the underlying CSV changes (e.g. after
regenerating the synthetic dataset) — it replaces `pipeline_segments`
rather than appending, so you won't get duplicates.

## 7. Where this stands (~20% milestone) vs. what's next

**Done and verified working end-to-end:**
- Data generation (physically-informed synthetic) or real PHMSA acquisition
- Preprocessing with a reusable categorical encoder
- Model training (XGBoost baseline) — Test R² ≈ 0.67, MAE ≈ 0.83 mils/year
- Global SHAP explainability (feature importance matches known corrosion
  engineering relationships)
- Per-segment explanation (why *this* pipe was flagged)
- Basic inspection-priority flagging (top 10% predicted rate = critical,
  next 20% = elevated)
- A working, role-gated web console for engineers with real backend
  enforcement — see above

**Deliberately deferred, and why:**
- **FT-Transformer** (specified in the original project scope) — using
  XGBoost as the baseline first because it trains in seconds, needs no GPU,
  and has first-class SHAP support, which let the *rest* of the pipeline
  (data → model → explainability → prioritization → console) get built and
  proven today. Swapping in an FT-Transformer later only touches
  `src/models/train.py` — everything else, including the console, is
  model-agnostic.
- **Real PHMSA data wired into preprocessing** — the download script is
  ready, but the exact column schema needs to be seen before hardcoding
  feature engineering against it, rather than guessing and shipping
  something wrong.
- **OR-Tools inspection scheduling** — not started; natural next step once
  risk scores exist for a real (not just synthetic) set of segments.
- **Real authentication** (SSO/OAuth, hashed+salted passwords in a real
  database, HTTPS) — the current login demonstrates the access-control
  *pattern* the console needs, not a production-ready auth system.

## Note on the synthetic dataset

One coating category was originally named `"None"`. Pandas silently reads
that back as a missing value on CSV load (not on generation — only when the
file is re-read), which crashed the console's segment-detail endpoint with
a JSON serialization error. Renamed to `"Uncoated"` and hardened the CSV
reads elsewhere against the same class of bug. If you regenerate the
dataset from an older copy of this repo, delete
`data/processed/synthetic_pipeline_corrosion.csv` and `models/` first so
they rebuild with the fix.
