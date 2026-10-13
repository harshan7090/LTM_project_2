# Milepost — how to run it

Copy-paste commands for the VS Code terminal, in order, with what each one
should print. Windows PowerShell throughout.

> **Open the terminal:** `` Ctrl+` `` in VS Code.
> **Working directory:** everything below assumes you are in
> `C:\Users\T9990\Desktop\integrityai_v2\integrityai`.

```powershell
cd C:\Users\T9990\Desktop\integrityai_v2\integrityai
```

---

## 0. The short version

Already set up and just want it running?

```powershell
.\run.ps1
```

Then open **http://localhost:8010** (landing page) or
**http://localhost:8010/console** (the application).

`run.ps1` calls the venv interpreter by full path, so you do not have to
activate anything, and it names the process holding the port instead of
failing with a WinSock number. `-Port 8011` moves it, `-NoReload` turns off
the auto-restart watcher.

### If you run uvicorn by hand instead

Two things bite on a stock Windows box, and neither error says what is
actually wrong.

**`python` is probably not Python.** On most Windows installs
`C:\Users\<you>\AppData\Local\Microsoft\WindowsApps\python.exe` comes first on
PATH. It is a Microsoft Store stub, not an interpreter — it prints *"Python
was not found; run without arguments to install from the Microsoft Store"* and
exits, and it wins over the venv unless the venv is activated first. So either
activate it:

```powershell
.\venv\Scripts\Activate.ps1          # prompt gains a (venv) prefix
python -m uvicorn backend.main:app --reload --port 8010
```

or skip activation and name the interpreter outright:

```powershell
.\venv\Scripts\python.exe -m uvicorn backend.main:app --reload --port 8010
```

**A port already in use reads like a crash.** uvicorn prints
`Application startup complete` and *then*
`[Errno 10048] ... only one usage of each socket address`. The app did not
start and then crash — it never bound at all. Find what is holding the port:

```powershell
Get-NetTCPConnection -LocalPort 8010 -State Listen |
  Select-Object OwningProcess, @{n='Name';e={(Get-Process -Id $_.OwningProcess).ProcessName}}
```

Everything below is the long version.

---

## 1. Activate the virtual environment

```powershell
.\venv\Scripts\Activate.ps1
```

Your prompt gains a `(venv)` prefix. If PowerShell refuses with
*"running scripts is disabled on this system"*:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\venv\Scripts\Activate.ps1
```

`-Scope Process` applies to this terminal only and is forgotten when you
close it — it does not change machine policy.

**If there is no `venv` folder yet:**

```powershell
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

---

## 2. Check the install

```powershell
python -c "import fastapi, xgboost, shap, ortools, sklearn, torch, truststore; print('all imports OK')"
```

Expected:

```
all imports OK
```

`torch` is only needed for the FT-Transformer comparison (§9) and
`truststore` only on a network with an intercepting proxy (§3). Neither is
needed to run the console.

---

## 3. Network check (corporate networks only)

Skip this unless something later fails with `CERTIFICATE_VERIFY_FAILED`.

```powershell
python -c "from src.net_trust import enable, status; enable(); print(status())"
```

Expected:

```
{'os_trust_store': True, 'detail': 'using the operating system certificate store'}
```

**Why this exists.** On a network that intercepts TLS, a proxy re-signs
certificates with an internal root CA that lives in the Windows certificate
store. Your browser reads that store; Python ships its own CA list and does
not. The failure looks *exactly* like the host being unreachable — that is
how it was misdiagnosed here. `src/net_trust.py` routes verification through
the OS store, keeping full verification.

Test it against real hosts:

```powershell
python -c "from src.net_trust import enable; enable(); import requests; print(requests.get('https://openrouter.ai', timeout=15).status_code)"
```

Expected: `200`

---

## 4. Build the data and train the model

Three commands, in this order. Total about 90 seconds.

```powershell
python -m src.data.synthetic_generator
```

Generates 5,000 segments, then **deliberately degrades them** with realistic
data-quality problems. Expected (numbers vary slightly):

```
[data quality] 5,000 -> 5,060 rows
  unit errors        : 75
  decimal errors     : 20
  duplicates         : 60
  coating variants   : 922
  missing cells      : 3,852 across 6 fields
Corrosion rate (mpy) stats:
  mean  1.06   max  19.38
```

The max should be **under 40 mpy**. Anything in the hundreds means the
physical ceiling is not applying.

```powershell
python scripts/run_pipeline.py
```

Trains XGBoost and writes the SHAP summary. Expected:

```
Test MAE:  0.483 mils/year
Test R^2:  0.682
Saved model to ...\models
```

```powershell
python scripts/load_to_database.py
```

Cleans the data and loads it. Expected:

```
[cleaning] 5,060 -> 5,000 rows
  duplicates removed  : 60
  unit errors repaired: 68
  imputed cells       : 3,863
Loaded 5,000 rows into table 'pipeline_segments'
```

The CSV keeps the raw, as-received data; the **database** holds the cleaned
analytical dataset.

---

## 5. Build the frontend

Only needed the first time, or after changing anything under `web/src`.

```powershell
cd web
npm install
npm run build
cd ..
```

Expected to end with:

```
✓ built in ~8s
```

No Node installed? The server falls back to the dependency-free console in
`frontend/`. `GET /api/meta` reports which one is live.

---

## 6. Run the console

```powershell
python -m uvicorn backend.main:app --reload --port 8010
```

Expected:

```
INFO:     Uvicorn running on http://127.0.0.1:8010
INFO:     Application startup complete.
```

| URL | What it is |
|---|---|
| **http://localhost:8010** | Landing page |
| **http://localhost:8010/console** | The application |
| http://localhost:8010/docs | API docs (development only) |

**Sign in:**

| Username | Password | Sees |
|---|---|---|
| `inspector1` | `inspect123` | Gulf Coast only |
| `supervisor1` | `supervise123` | All regions + Schedule, Dispatch, Fleet |
| `admin` | `admin123` | Everything |

Stop the server with **Ctrl+C**.

### If port 8010 is already in use

```powershell
Get-NetTCPConnection -LocalPort 8010 -State Listen | Select-Object OwningProcess
Stop-Process -Id <the OwningProcess number> -Force
```

Or just use another port: `--port 8011`.

`[WinError 10013]` is usually a leftover server from a previous run, not a
permissions problem — the commands above clear it.

---

## 7. What to click

1. **Dashboard** — the segment register, ranked by **risk**, not corrosion
   rate. Look for a low-mpy segment near the top with an amber `HCA` tag:
   that is consequence modelling doing its job.
2. Click any row → the drawer opens with three tabs:
   - **Risk & drivers** — likelihood × consequence, SHAP tornado plot,
     remaining life, ERF
   - **Inspection** — which NDT technique and why, with the statutory cap
   - **Repair** — what to actually do, split into fixing the defect and
     fixing the cause
3. **Schedule** (supervisor) — run the optimiser. Travel is charged against
   the crew-day budget.
4. **Dispatch** (supervisor) — build work orders and assign them to the
   nearest qualified technician.
5. **AI Assistant** — ask a corrosion question, or upload a pipe photo.

---

## 8. Tests

```powershell
python -m pytest -q
```

Expected:

```
375 passed in ~170s
```

Faster targeted runs while working:

```powershell
python -m pytest tests/test_provider_contract.py -q    # ~0.3s, no network
python -m pytest tests/test_limitations_fixed.py -q    # ~1s
python -m pytest tests/test_consequence.py tests/test_remaining_life.py -q
python -m pytest -q -k "not assistant and not rag"     # skips the slow ones
```

The suite passes with **no Ollama, no API key and no internet**. Tests that
genuinely need Ollama live in `tests/test_rag_dense.py` and skip themselves
when it is absent.

---

## 9. Optional extras

Everything above works without any of these.

### Better photo analysis (OpenRouter free tier)

```powershell
notepad .env
```

Set `OPENROUTER_API_KEY=` to a key from **https://openrouter.ai/keys**, save,
restart the server. Verify:

```powershell
python -c "from src.net_trust import enable; enable(); from config.settings import settings; from backend.llm import auto_select, select_vision_provider; t=auto_select(settings); v=select_vision_provider(settings,t); print('text  :', t.name, t.status().model); print('vision:', v.name, v.status().vision_model)"
```

Expected something like:

```
text  : groq openai/gpt-oss-120b
vision: openrouter nex-agi/nex-n2.5-pro:free
```

The vision model is **discovered at runtime** from OpenRouter's live
catalogue — never hardcoded, because the free roster turns over constantly.

### Local models (no key needed)

```powershell
ollama pull llama3            # text
ollama pull moondream         # vision, 1.7 GB
ollama pull nomic-embed-text  # embeddings, 274 MB
```

### Semantic search over the knowledge base

```powershell
python scripts/build_dense_index.py
```

About 160 seconds once, then ~3 ms at startup. Takes paraphrase recall from
1/8 to 6/8. Query-time embedding costs ~6 s per question on CPU — set
`RAG_DENSE_QUERIES=0` in `.env` to keep the index but skip it.

### FT-Transformer comparison

```powershell
python -c "from src.models.train_ft import compare_with_xgboost; compare_with_xgboost()"
```

Takes about 4 minutes. Expected: **XGBoost wins** (R² 0.682 vs 0.637) while
training 580× faster.

### Browse the database

```powershell
start data\processed\integrityai.db
```

Opens in DB Browser for SQLite if installed. Table: `pipeline_segments`.

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `running scripts is disabled` | PowerShell execution policy | `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` |
| `[WinError 10013]` | Leftover server on the port | See §6, or use `--port 8011` |
| `CERTIFICATE_VERIFY_FAILED` | TLS-intercepting proxy | See §3. **Never** use `verify=False` |
| `No module named 'torch'` | Optional dependency | `pip install torch` — only needed for §9 |
| Console shows the old design | Stale React build | `cd web; npm run build; cd ..` |
| `No document_chunks found` | Database not loaded | Re-run §4 |
| Assistant answers slowly | Local LLM on CPU (~2 tok/s) | Set a Groq or OpenRouter key |
| Photo analysis unavailable | No vision model | `ollama pull moondream`, or set `OPENROUTER_API_KEY` |
| Tests suddenly take 10+ min | Dense retrieval hitting Ollama | `tests/conftest.py` should force `RAG_DENSE_QUERIES=0` |

**Where things live:**

```
.env                 secrets — gitignored, never commit
.env.example         template — placeholders only
data/processed/      the database and the generated CSVs
models/              trained model, encoder, SHAP plot
landing/index.html   the landing page
web/dist/            built React console
```

---

## 11. Starting completely fresh

```powershell
Remove-Item -Recurse -Force data\processed\*, models\*.joblib -ErrorAction SilentlyContinue
python -m src.data.synthetic_generator
python scripts/run_pipeline.py
python scripts/load_to_database.py
python -m uvicorn backend.main:app --reload --port 8010
```

---

Longer explanations of each subsystem are in **[README.md](README.md)**;
the end-to-end walkthrough is in **[BRIEF.md](BRIEF.md)**.
