# CORVEX — Project & Technology Overview

> **Purpose of this file.** A single, self-contained description of the Corvex
> project: what it does, how it works end to end, and every technology used.
> Written to be pasted into an LLM as context for generating slides, reports,
> interview answers or documentation.
>
> All figures here are **measured from the running system**, not estimated.
> Where something is unverified or incomplete, it says so.
>
> Last verified: 23 September 2026.

---

## 1. What Corvex is

**Corvex** is a pipeline integrity and corrosion-risk console for the oil and
gas industry.

- **Tagline:** Predict. Protect. Prevent.
- **Positioning:** AI-Powered Pipeline Integrity & Corrosion Intelligence
- **Form:** a Python/FastAPI backend, a React/TypeScript operator console, and
  a public landing page, served from one process.

It takes a fleet of buried pipeline segments and answers four questions in
order:

1. **How fast is each segment corroding?** (regression + calibrated uncertainty)
2. **What would a failure there actually cost?** (consequence scoring under US
   pipeline regulation)
3. **What should be done about it, and in what order?** (inspection method and
   repair action ranked by value per crew-day)
4. **Who does it, and when?** (constraint-solved crew scheduling and
   proximity-based dispatch)

The demonstration fleet is **5,000 synthetic segments placed along 15 real
Indian pipeline corridors** (HVJ, Jamnagar–Loni, Paradip–Haldia,
Kochi–Mangalore, Numaligarh–Siliguri and others).

---

## 2. The governing design principle

> **Every auditable decision is deterministic, tested code. The language model
> only explains.**

This is the single most important thing about the project and the thing worth
leading with.

An integrity engineer must justify to a regulator why a segment received a
DCVG survey rather than an in-line inspection run. A model that answers
differently on Tuesday cannot be defended. So:

- Corrosion rate, consequence score, HCA determination, remaining life,
  inspection interval, repair ranking, crew assignment — **all deterministic
  code with unit tests**.
- The LLM reads those outputs and explains them in prose, with citations to
  the standard it is drawing on.
- **The LLM never produces a number that reaches a decision.** Vision output
  is explicitly labelled an *indication* and never feeds the maths.

This is also the answer to "why not just prompt GPT with the asset data" — the
output would be unauditable and non-reproducible.

---

## 3. Domain grounding (the standards actually implemented)

| Standard | What it governs | Where it is implemented |
|---|---|---|
| 49 CFR 192.903 | HCA determination, gas | `src/integrity/consequence.py` |
| 49 CFR 195.450 | HCA determination, hazardous liquid | `src/integrity/consequence.py` |
| 49 CFR 192.5 | Class location (population density) | `src/integrity/consequence.py` |
| 49 CFR 192.939 | Max reassessment interval, gas HCA — 84 months | `src/integrity/inspection.py` |
| 49 CFR 195.452(j)(3) | Max reassessment interval, liquid HCA — 60 months | `src/integrity/inspection.py` |
| 49 CFR 192.713 / 195.422 | Repair schedule and permanent repair | `src/integrity/repair.py` |
| ASME B31.4 / B31.8 | Pressure design, Barlow formula | `src/integrity/remaining_life.py` |
| ASME B31G (Modified) | Remaining strength of corroded pipe, Folias factor | `src/integrity/remaining_life.py` |
| API 570 | Remaining life from wall loss rate | `src/integrity/remaining_life.py` |
| API 579-1 / API 1160 | Fitness-for-service, risk management framing | design basis |
| NACE/AMPP SP0169, SP0502 | Cathodic protection, ECDA | knowledge base |

**Key formulas implemented:**

- **Barlow:** `t_min = P·D / (2·S·F·E·T)`
- **Potential Impact Radius (gas only):** `r = 0.69·√(p·d²)`
  PIR is a thermal-radiation concept for ignited gas; the code **returns
  `None` for liquids** rather than producing a meaningless number.
- **Modified B31G** with a two-branch Folias factor
  (`z ≤ 50` → quadratic, else `0.032z + 3.3`)
- **ERF** (Estimated Repair Factor) and safe operating pressure
- HDPE is **refused** by the Barlow path — it carries no SMYS.

---

## 4. End-to-end pipeline

### Stage 1 — Data generation and degradation

Synthetic, but deliberately **not easy**:

- 5,000 segments, 25 base attributes (age, diameter, wall thickness, material,
  coating, cathodic protection, soil resistivity, soil type, pressure,
  temperature, product, inspection history, class location, environmental
  flags…).
- **Michaelis–Menten saturation** for soil corrosivity, replacing an unbounded
  hyperbola — oxygen-diffusion-limited corrosion physically *saturates*:
  `soil_factor = 4.0 · 3000 / (3000 + resistivity)`, plus a `tanh` ceiling.
- **MNAR missingness** (Missing Not At Random) injected deliberately: older and
  more-neglected assets are *more* likely to have missing records, which is how
  real inspection data actually fails.
  `p(missing) = base · age_factor · neglect_factor`
- Duplicate records, unit errors (inches recorded as mm), implausible values.

### Stage 2 — Cleaning

Strict ordering, and the order is load-bearing:

```
dedupe → canonicalise → repair unit errors → flag implausible
       → RECORD MISSINGNESS INDICATORS → impute
```

Missingness indicators are recorded **before** imputation, so "this record was
missing" survives as a feature rather than being erased. `MIN_PLAUSIBLE_WALL_MM
= 1.5` catches inch-values recorded in a millimetre column.

### Stage 3 — Prediction

- **XGBoost** gradient-boosted regression on corrosion rate (mpy).
- **SHAP `TreeExplainer`** — exact, not sampled — for per-segment attribution.
- **Split conformal prediction** for calibrated intervals.

### Stage 4 — Risk

`risk = likelihood × consequence`. Consequence columns are **deliberately
excluded from the feature set** so the model cannot learn to predict
consequence from itself.

### Stage 5 — Action and dispatch

Inspection method, repair action, crew schedule, work-order assignment.

---

## 5. Models

### 5.1 XGBoost vs FT-Transformer — a measured comparison

The project originally scoped a **PyTorch FT-Transformer** (feature tokenizer +
`[CLS]` token + pre-norm encoder). It was built and benchmarked honestly:

| Model | Test R² | Test MAE (mpy) | Train time | Parameters |
|---|---|---|---|---|
| **XGBoost** | **0.682** | **0.483** | **0.4 s** | 300 trees |
| FT-Transformer | 0.637 | 0.497 | 233.2 s | 87,616 |

**XGBoost wins**, by ΔR² = 0.044, while training ~580× faster. This is the
expected result for 5,000 rows of heterogeneous tabular data, and it is
reported rather than hidden — deep learning is not automatically better on
tabular problems at this scale.

### 5.2 Conformal prediction

Split conformal with a normalised (difficulty-weighted) variant:

- The difficulty model is trained on **proper-training residuals, not
  calibration residuals** — calibrating on data the model has seen collapses
  residuals toward zero and yields intervals that are far too narrow while
  still looking rigorous. That is the one way to get this badly wrong.
- Finite-sample correction: `level = ⌈(n+1)(1-α)⌉ / n`

**Measured empirical coverage** (1,250 held-out segments, 938 calibration):

| Target | Empirical | Mean interval width |
|---|---|---|
| 95% | **93.9%** | 2.61 mpy |
| 90% | **89.8%** | 2.02 mpy |
| 80% | **80.3%** | 1.45 mpy |

Conservative remaining-life uses the **upper bound** of the interval.

> ⚠️ **Honest caveat:** `src/models/conformal.py` is a complete, working module
> but is **not yet wired into the console UI or the training script**. The
> numbers above were measured directly. Treat it as implemented-but-not-yet-
> integrated.

---

## 6. Decision engines

### 6.1 Consequence (`consequence.py`)

Dual regulatory regimes:
- **Gas (192.903):** keys off class location + potential impact radius
- **Liquid (195.450):** keys off populated area / drinking water / ecological /
  navigable waterway

Outputs a 0–100 consequence score, HCA flag, HCA basis, and PIR.

### 6.2 Inspection (`inspection.py`)

Nine methods, ranked by **efficiency = diagnostic value ÷ total burden**:

```
DIG 1.00 · ILI-MFL 0.95 · ILI-UT 0.95 · UT 0.90 · CIPS 0.85
DCVG 0.80 · ECDA 0.75 · CUI 0.70 · COAT 0.50
```

Top 3 returned. **Statutory interval caps are applied last and only
downward** — a model that wants a longer interval than regulation allows is
overruled; one that wants a shorter interval is never stretched to the cap.

### 6.3 Repair (`repair.py`)

Seven actions with value weights:

```
CUTOUT 1.00 · SLV-B 0.85 · SLV-A 0.75 · RECOAT 0.70
CP-UP 0.65 · GRIND 0.45 · DERATE 0.30 · MON 0.05
```

```
total_burden = est_days + cost/25,000 + (3 if shutdown required)
efficiency   = value / total_burden
```

Ranked by **pure efficiency** (best-first, so the order reads straight off the
numbers), with priority-0 items pinned to the top. `USD_PER_CREW_DAY = 25,000`.

### 6.4 Risk matrix (`risk_matrix.py`)

The canonical **5×5 likelihood × consequence** grid that every integrity
department already uses.

- Likelihood bins: `0.50 / 0.75 / 0.90 / 0.97 / 1.01` fleet percentile
- Consequence bins: `20 / 35 / 55 / 75` absolute score
- Bands by product L×C: `≤4 low · ≤9 moderate · ≤14 high · else severe`

**Bins are deliberately not quintiles.** Quintiles would force 20% of the fleet
into the top row by construction, so the matrix could never show a healthy
fleet. Returns a dense 25-cell grid — an empty cell is information.

### 6.5 Optimisation — two CP-SAT solvers (`ortools`)

**Inspection scheduler** (`scheduler.py`)
- Travel time charged against the *same* crew-day budget as the work, so a
  plan cannot look affordable by pretending crews teleport.
- Statutory deadline is a **hard constraint** (no decision variable exists past
  it).

**Work-order dispatch** (`workorders.py`)
- Orders split **by trade** — an order carrying every skill blocks on whichever
  skill is scarcest. (This fix took blocked orders 27 → 0, urgent 9 → 0, and
  crew utilisation from 15–78% to 90–99%.)
- `diagnose_capacity()` reports the shortfall per (zone, skill) instead of
  returning a bare "INFEASIBLE".
- Auto-retry when `require_immediate` makes the model infeasible.

---

## 7. Geography and the fleet map

### Corridors (`routes.py`)

Segments are placed **along 15 real Indian pipeline corridors**, not scattered:

| Zone | Corridors |
|---|---|
| Western | HVJ West Leg, Dahej–Vadodara (DVPL), Mumbai–Pune–Solapur |
| Northern | Jamnagar–Loni LPG, HVJ East Leg, Panipat–Jammu |
| Eastern | Paradip–Haldia, Haldia–Barauni, Dhamra–Jharsuguda |
| Southern | Kochi–Mangalore (KKBMPL), Chennai–Madurai, Visakhapatnam–Hyderabad |
| North Eastern | Numaligarh–Siliguri, Digboi–Numaligarh, Guwahati–Silchar |

6,414 km total. Placement picks a corridor (weighted — a trunk carries more than
a lateral), picks a distance along it by **length** (not waypoint index), and
interpolates, with a ~2 km perpendicular offset representing right-of-way width.

**Measured: segments sit a mean 2.28 km from their corridor** (previously
~180 km of Gaussian scatter around a zone centroid).

### The map (`PipelineMap.tsx`)

- **Web Mercator** projection with fractional zoom (tiles fetched at the
  nearest integer level, drawn scaled) — because raster tiles are cut in
  Mercator and anything else slides off the coastline.
- **Raster tiles relayed by the backend** (`/api/map/tile/{z}/{x}/{y}.png`) via
  Geoapify (satellite; needs a key) or OpenStreetMap (no key). The key stays
  server-side so the CSP remains `img-src 'self'`.
- **Two-canvas rendering, zero per-segment DOM.** Base layer (tiles, corridors,
  5,000 points) repaints only on data/size change; a thin overlay handles
  hover and selection. Hit-testing uses a 24 px bucket grid.
- Vector fallback (India + neighbours, Natural Earth 110 m, 8.7 KB embedded)
  when tiles cannot be fetched.

### Routing (`geo.py`)

Haversine great-circle distance (clamped before `asin` — floating-point error
can push the argument above 1 for antipodal points), `ROAD_FACTOR = 1.35`,
`AVERAGE_SPEED_KMH = 65`.

---

## 8. The LLM layer

### Retrieval (`rag.py`)

**Hybrid retrieval fused by Reciprocal Rank Fusion (RRF)** over three views:
- word-level TF-IDF
- character n-gram TF-IDF (robust to typos and morphology)
- dense embeddings

A `DENSE_RELEVANCE = 0.45` clause lets the dense view *introduce* chunks, not
merely reorder lexical ones. (Before this, dense retrieval contributed nothing
because the final filter only admitted chunks a lexical view had already
scored — paraphrase recall went 1/8 → 6/8 when fixed.)

Knowledge base: 6 curated domain documents (corrosion mechanisms, external
corrosion, cathodic protection, coatings, inspection methods, standards).

### Domain gate (`domain_gate.py`)

An embedding anchor-similarity classifier refuses out-of-domain questions
**before** any model call. Margin-based: `MARGIN_REFUSE = -0.02`,
`MARGIN_ACCEPT = 0.02`.

A second keyword layer has an **anaphora carve-out** so follow-ups like
"why that one?" are not refused:
- terms ≤ 4 chars must match whole words (so `ut` doesn't match `about`)
- tokenised with `re.findall(r"[a-z0-9]+")`, not `str.split()` — punctuation
  used to break `"why?"`

### Vision and provider selection (`openrouter.py`, `llm.py`)

- **Runtime discovery of free vision models** from OpenRouter's live `/models`
  response — the free roster turns over constantly, so nothing is hardcoded.
- Excludes non-vision and non-chat models by purpose (`lyria`, `tts`, `whisper`,
  `guard`, `embed`, `rerank`, `image-gen`, routers…). *A music model would
  otherwise have ranked first: it was free, accepted images, and had the
  largest context window.*
- `reasoning: {enabled: false}` to stop reasoning monologue leaking into output.
- Defensive `_extract_text()` handles `content: null` and content-part lists.
- Local **Ollama** fallback for vision and embeddings.

### Assistant behaviour

Answers cite the standard behind every claim; citations stream ahead of the
answer via a NUL-delimited marker so sources appear before a slow local model
finishes generating.

---

## 9. Application architecture

### Backend — FastAPI

**25 `/api` routes**, plus `/` (landing) and `/console` (SPA). Selected:

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/login`, `/api/logout` | PBKDF2 auth, bearer token |
| GET | `/api/me` | Identity + role + zone |
| GET | `/api/segments` | Scored register (zone-scoped by role) |
| GET | `/api/segments/{id}` | Detail + SHAP + consequence + remaining life |
| GET | `/api/segments/{id}/inspection` | Ranked inspection plan |
| GET | `/api/segments/{id}/repair` | Ranked repair options |
| GET | `/api/segments/{id}/history` | Back-cast rate series |
| POST | `/api/history` | Bulk back-cast (capped at 120 ids) |
| GET | `/api/risk-matrix` | 5×5 grid |
| GET | `/api/map/config` | Tile provider metadata (**no key**) |
| GET | `/api/map/tile/{z}/{x}/{y}.png` | Relayed raster tile |
| GET | `/api/map/routes` | Pipeline corridors |
| POST | `/api/schedule` | CP-SAT inspection schedule |
| POST | `/api/workorders/assign` | CP-SAT dispatch |
| POST | `/api/assistant/chat` | Streaming RAG answer + citations |
| POST | `/api/assistant/analyze-image` | Vision analysis |
| GET | `/api/export.csv` | At-risk export |

### Frontend — React console

Five views: **Dashboard**, **AI Assistant**, **Schedule**, **Dispatch**,
**Fleet Overview**.

Dashboard layout (map-first, because a pipeline is a geographic object):
1. **Fleet Position** map + **Risk Matrix** (5×5, clickable to filter)
2. **Segment Register** — virtualised table, 27 px rows, inline rate bars,
   10-year sparklines
3. **Detail pane** — a split pane beside the register, not an overlay, so
   comparing segments is one click each rather than close–scroll–reopen

Keyboard: `/` focuses the filter, `Esc` unwinds one level at a time (pane →
matrix cell → filter → band).

### Landing page

Vanilla HTML/CSS/JS, no framework:
- **Hand-written WebGL** 3D pipeline hero (~330 lines, no library — a CDN is
  unreachable and `script-src 'self'` forbids one anyway). One cylinder drawn
  three times: cull-front for the bore, a displaced fluid surface, cull-back at
  30% alpha for the glassy near wall. Scroll drives a `uCorrosion` uniform so
  the wall visibly pits as you read about predicting corrosion.
- Sticky scroll sequence for the five stages.
- Damped scroll (lerp 0.075) — native scrolling is never hijacked.
- Graceful degradation: no WebGL → CSS pipe; no JS → all content visible.

---

## 10. Security

| Control | Implementation |
|---|---|
| Password storage | PBKDF2-HMAC-SHA256, per-user salt |
| Timing attacks | Dummy hash verified for unknown usernames (constant cost) |
| Authorisation | RBAC — inspector / supervisor / admin |
| Data scoping | Inspectors see only their zone, enforced per-route |
| CSP | `default-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'` |
| XSS | Model output rendered via `react-markdown`, never as HTML |
| Uploads | MIME + magic-byte validated, 8 MB cap, held in memory, never written to disk |
| Prompt injection | Uploaded images treated as untrusted input |
| Secrets | API keys server-side only; never sent to the browser |
| TLS | `truststore` injects the OS certificate store — **never** `verify=False` |
| Tile proxy | z/x/y validated against the tile pyramid before any URL is built |

---

## 11. Technology stack

### Backend / ML

| Technology | Version | Role |
|---|---|---|
| Python | 3.11.9 | Runtime |
| FastAPI | 0.141.1 | API framework |
| Pydantic | 2.13.5 | Validation, typed request models |
| Uvicorn | — | ASGI server |
| SQLAlchemy | 2.0.52 | ORM (SQLite ↔ Postgres) |
| pandas | 3.0.5 | Data manipulation |
| NumPy | 2.4.6 | Numerics |
| scikit-learn | 1.9.0 | Preprocessing, splits, metrics |
| XGBoost | 3.2.0 | Corrosion-rate regression (production model) |
| SHAP | 0.51.0 | Exact tree attribution |
| PyTorch | 2.14.0+cpu | FT-Transformer baseline |
| OR-Tools | 9.15.6755 | CP-SAT ×2 (scheduling, dispatch) |
| requests | 2.34.2 | HTTP |
| truststore | — | OS certificate store for TLS-intercepting proxies |
| pytest | — | 409 tests |

### Frontend

| Technology | Version | Role |
|---|---|---|
| React | 18.3.1 | UI |
| TypeScript | 5.7.2 | Types |
| Vite | 6.0.5 | Build |
| Tailwind CSS | 4.0 | Styling (token-driven) |
| TanStack Query | 5.62.7 | Server state, caching |
| TanStack Table | 8.20.6 | Register |
| TanStack Virtual | 3.11.2 | Row virtualisation (5,000 rows) |
| Recharts | 2.15.0 | Charts |
| react-markdown + remark-gfm | 9.0.1 / 4.0.0 | Safe model-output rendering |
| lucide-react | 0.468.0 | Icons |
| Canvas 2D | native | Fleet map rendering |
| WebGL 1 | native | Landing page 3D, hand-written |

### AI / external services

| Service | Role | Key required |
|---|---|---|
| OpenRouter | Vision + chat, runtime free-model discovery | Yes (free tier) |
| Ollama | Local vision + embeddings fallback | No |
| Geoapify | Satellite map tiles | Yes (free, 3k/day) |
| OpenStreetMap | Raster map tiles (default fallback) | No |
| Natural Earth | Vector basemap (embedded, public domain) | No |

---

## 12. Verified metrics

| Metric | Value |
|---|---|
| Segments | 5,000 |
| Attributes per segment | 41 (25 base + derived + missingness indicators) |
| Operating zones | 5 (Western, Northern, Eastern, Southern, North Eastern) |
| Pipeline corridors | 15 · 6,414 km |
| Segments in an HCA | 2,616 (52.3%) |
| Risk bands | normal 4,256 · elevated 624 · critical 120 |
| Risk matrix bands | low 3,896 · moderate 871 · high 167 · severe 66 |
| XGBoost test R² / MAE | 0.682 / 0.483 mpy |
| Conformal coverage @90% | 89.8% empirical |
| Mean distance to corridor | 2.28 km |
| Tests passing | **409** across 17 test files |
| API routes | 25 (+ `/` and `/console`) |
| Dispatch: blocked orders | 0 (was 27 before trade-splitting) |
| Crew utilisation | 90–99% |

---

## 13. Repository layout

```
corvex/
├── backend/
│   ├── main.py            25 API routes, CSP, security headers
│   ├── ml.py              model service, scoring, risk matrix, back-cast
│   ├── auth.py            PBKDF2, RBAC, timing-safe login
│   ├── assistant.py       RAG orchestration, two-layer domain gate
│   ├── domain_gate.py     embedding anchor-similarity classifier
│   ├── llm.py             provider abstraction, defensive text extraction
│   ├── openrouter.py      runtime free-vision-model discovery
│   └── tiles.py           map tile relay + bounded LRU cache
├── src/
│   ├── data/              generator, MNAR degradation, cleaning, DB
│   ├── models/            train, conformal, ft_transformer, train_ft
│   ├── explain/           SHAP
│   ├── integrity/         consequence, remaining_life, inspection, repair,
│   │                      risk_matrix, scheduler, workorders, geo, routes, rag
│   └── net_trust.py       OS trust store injection
├── web/src/
│   ├── views/             Dashboard, Assistant, Schedule, Maintenance, Fleet, Login
│   ├── components/        PipelineMap (canvas), SegmentDrawer, fleet, ui
│   └── lib/               api, types, basemap
├── landing/               index.html, app.css, app.js, pipe3d.js (WebGL)
├── tests/                 17 files, 409 tests
└── data/                  synthetic dataset, knowledge base, SQLite
```

---

## 14. Running it

```bash
python -m venv venv && venv\Scripts\activate      # Windows
pip install -r requirements.txt
python -m uvicorn backend.main:app --port 8011
```

- Landing page → `http://127.0.0.1:8011/`
- Console → `http://127.0.0.1:8011/console`

**Demo accounts**

| User | Password | Scope |
|---|---|---|
| `inspector1` | `inspect123` | Western zone only |
| `supervisor1` | `supervise123` | Full fleet, scheduler, dispatch |
| `admin` | `admin123` | Everything |

Optional in `.env`: `OPENROUTER_API_KEY` (assistant + vision),
`GEOAPIFY_API_KEY` (satellite tiles — OSM is used without it).

---

## 15. Engineering practices worth citing

**A recurring theme: the bugs that mattered all failed silently.**

- A proven-optimal schedule that assigned nothing
- Retrieval that returned results but never introduced a new document
- A vision model emitting `"irt."`
- A stale CSS rule colliding with a new one (full-width grey bar)
- A stale query cache serving an object without a field the UI then read
- A map rendering the country **upside down** — Albers returns y increasing
  northward, SVG's y increases downward. Nothing errored and it still looked
  like a map.

Each now has a regression test or a numeric check script
(`web/scripts/check-projection.mjs` asserts map orientation against city
positions, because eyes do not catch an inverted country).

**Reproducibility:** map coordinates draw from a **dedicated random stream**, so
changing where dots sit cannot perturb soil resistivity, class location,
corrosion rates or the trained model. Verified column-by-column: only
`latitude`, `longitude` and `region` changed when the fleet moved from the US
to India.

**Accessibility:** all text tokens verified ≥ 4.5:1 contrast in both light and
dark themes (a caption grey at 2.88:1 was found and fixed across 81 usages);
`prefers-reduced-motion` genuinely disables the animation loop rather than
shortening transitions.

---

## 16. Honest limitations

State these rather than let them be discovered:

1. **Data is synthetic.** Realistic in structure and failure modes, but not a
   real operator's records. No claim of real-world validated accuracy.
2. **Conformal prediction is not wired into the UI** or the training script.
   The module is complete and its coverage is measured, but the console does
   not yet display intervals.
3. **The FT-Transformer lost** to XGBoost. Reported, not hidden.
4. **Vision output is advisory only** — it never enters any calculation, and
   its accuracy on real corrosion photography is unvalidated.
5. **Geoapify satellite requires a key.** Without one the map falls back to
   OpenStreetMap raster tiles.
6. **Corridors are real; segment placement on them is synthetic.**
7. **Single-process deployment**, SQLite by default — not a production
   HA architecture.

---

## 17. One-paragraph summary

> Corvex is a pipeline corrosion-risk console that turns raw inspection records
> into dispatched work orders. It predicts corrosion rate with XGBoost and
> explains every prediction with exact SHAP attribution; converts rate into
> true risk by scoring consequence under 49 CFR 192/195, including HCA
> determination and potential impact radius; computes remaining life from ASME
> B31.8 and Modified B31G; ranks inspection methods and repair actions by
> diagnostic value per crew-day with statutory interval caps applied last and
> only downward; and assigns work to the nearest qualified crew using two
> OR-Tools CP-SAT solvers that charge travel against the same budget as the
> work. A retrieval-augmented language model explains those decisions with
> citations but never makes them — every auditable number is deterministic,
> tested code, verified by 409 passing tests.
