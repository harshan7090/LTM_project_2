# Milepost — Technical Brief

*Pipeline corrosion risk assessment, from raw data to dispatched crew.*

Written for an engineer or mentor reading this cold. It walks the pipeline
end to end: where the data comes from, what is in it, what preprocessing it
needs and why, what models run, what each stage decides, and what the whole
thing cannot do.

Everything quoted here was measured on the current build, not estimated.

---

## 0. The one-paragraph version

Milepost predicts how fast each pipeline segment is corroding, explains the
prediction feature by feature, multiplies it by what a failure there would
actually cost to get **real risk**, converts the corrosion rate into a
**date** the pipe reaches its minimum allowable wall, selects the **inspection
technique** and the **repair method**, schedules the inspections against crew
capacity and statutory deadlines, then splits the repairs by trade and
**dispatches each to the nearest qualified technician**. Every decision a
regulator could question is deterministic tested code; the language model only
explains.

---

## 1. Why the name

`Milepost`. Pipelines are indexed by milepost — it is the address system of a
transmission system, and every anomaly in every ILI report is located by one.
It is a real operational term rather than a coined one, and it does not end in
"AI", which felt worth avoiding for a tool whose central claim is that the
important decisions are *not* made by a model.

---

## 2. Data collection

### 2.1 What ships today

The dataset is **synthetic and labelled as such everywhere**. This is a
deliberate, documented choice, not a gap nobody noticed.

`src/data/synthetic_generator.py` builds 5,000 segments whose corrosion rate
is computed from simplified but real corrosion-engineering relationships:

```python
base_rate       = 0.8 * (1 - coating_quality) * cp_factor * soil_factor * material_factor
corrosion_mpy   = base_rate * sqrt(age + 1) + noise
corrosion_mpy  += 0.15 * historical_repair_count
```

- absent cathodic protection roughly **triples** the driving force (`cp_factor` 0.3 → 1.0)
- coating quality ranks correctly: FBE 0.9 > coal tar 0.75 > tape 0.6 > bare 0.05
- corrosive (low-resistivity) soil raises the rate — `soil_factor = 15000 / resistivity`
- stainless corrodes at 0.2× carbon steel, HDPE at 0.02×
- the `sqrt(age)` term reflects that corrosion products partially passivate

Because the label is generated from those relationships, a model trained on it
learns something physically sensible and **SHAP points at the right features**
— which is what lets the explainability, prioritisation, scheduling and
dispatch layers be built and tested today rather than waiting on a real
dataset's schema.

### 2.2 The real-data path, already written

`scripts/fetch_phmsa_data.py` downloads PHMSA's public *Pipeline Incident
Flagged Files* — genuine incident reports from every regulated US operator,
including corrosion-caused failures. It prints the **actual column structure**
of every sheet rather than assuming one, because PHMSA's schema differs by
pipeline type and has changed over the years.

### 2.3 What real adoption would need

| Source | What it gives | Status |
|---|---|---|
| **ILI tally** (Rosen / Baker Hughes / TDW) | Per-anomaly depth, length, orientation, log distance | Not ingested. This is the single highest-value addition. |
| **Repeat ILI runs** | True corrosion rate by matching anomalies between runs — the industry-standard method | Not ingested |
| **CIPS / DCVG surveys** | CP potential as a time series against the −850 mV criterion | Modelled as a boolean today |
| **GIS layers** | Population, drinking water, ecological — for real HCA determination | Synthetic today |
| **PHMSA incidents** | Consequence calibration: spill volumes, costs, injuries | Script written, not wired in |

---

## 3. What is in the data

31 columns after cleaning. They fall into four groups that are **kept
deliberately separate**.

### 3.1 Model features (14)

These, and only these, predict the corrosion rate.

| Feature | Type | Range / values |
|---|---|---|
| `pipe_age_years` | numeric | 0–65, gamma-distributed |
| `diameter_inches` | numeric | 4–48 |
| `wall_thickness_mm` | numeric | 5–25 |
| `soil_resistivity_ohm_cm` | numeric | 200–60,000, log-normal |
| `operating_pressure_psi` | numeric | 200–1,440 |
| `operating_temperature_c` | numeric | 10–80 |
| `last_inspection_years_ago` | numeric | 0–10 |
| `historical_repair_count` | numeric | Poisson(age/20) |
| `cathodic_protection` | boolean | 70% present |
| `material` | categorical | Carbon Steel / Stainless / HDPE |
| `coating_type` | categorical | FBE / Coal Tar / PE Tape / Uncoated |
| `soil_type` | categorical | Clay / Sandy / Loam / Rocky |
| `product_type` | categorical | Crude / Gas / Refined / Produced Water |
| `region` | categorical | five US regions |

Plus **6 missingness indicators** added by cleaning (§4.5) — so the model
input is 20 columns.

### 3.2 Consequence attributes (5) — *not* model features

| Column | Meaning |
|---|---|
| `class_location` | 1–4, per 49 CFR 192.5 population density |
| `drinking_water_source` | source-water protection area |
| `environmentally_sensitive` | unusually sensitive ecological area |
| `navigable_waterway` | commercially navigable crossing |
| `occupied_site_within_pir` | school / hospital inside the impact radius |

**Why they are excluded from the model.** If *where* the pipe is became a
predictor of *how fast* it corrodes, the two halves of `risk = likelihood ×
consequence` would stop being independent and the product would be circular.
`test_consequence_columns_are_not_model_features` fails the build if they ever
leak in.

### 3.3 Engineering attributes (3)

`pipe_grade` (API 5L: Grade B → X70, giving SMYS), `latitude`, `longitude`.

### 3.4 Targets (2)

`corrosion_rate_mpy` (regression target) and `needs_priority_inspection`
(top-15% flag, retained but unused by the console).

---

## 4. Preprocessing

This is the part that does the most work, and the part most likely to be
skipped in a student project.

### 4.1 The data is degraded on purpose first

`src/data/data_quality.py` runs **after** the generator. The generator
produces physics; real pipeline records are physics plus fifty years of people
writing things down, and the second part is most of the difficulty.

| Defect injected | Amount | Why it is realistic |
|---|---|---|
| Missing values | 3,852 cells | A 1974 line whose soil survey was never digitised |
| Measurement error | 2–25% by field | UT repeatability; soil resistivity varies seasonally |
| Unit confusion | 75 rows | Wall thickness entered in **inches** into a millimetre column |
| Decimal slips | 20 rows | 850 psi recorded as 85 or 8500 |
| Categorical drift | 922 rows | `FBE`, `fbe`, `Fusion Bonded Epoxy`, `" FBE "` |
| Duplicate rows | 60 | The same segment entered twice after a merger |
| Label noise | σ 12% + 0.15 mpy floor | The rate comes from two ILI runs, each with tool tolerance |

**Missingness is MNAR** — missing *not* at random. Records are worse for old
assets and for assets not inspected recently:

```python
age_factor      = 1 + 2.0 * clip(age / 65, 0, 1)      # 3x worse on the oldest pipe
neglect_factor  = 1 + 0.5 * clip(years_since_inspection / 10, 0, 1)
p(missing)      = base * age_factor * neglect_factor
```

Those are exactly the segments most likely to be corroding. Mean-imputing them
tells the model an unsurveyed 1974 line is average — false, and false in the
dangerous direction. Uniform random missingness would have been easier to
write and would have taught the pipeline nothing.

### 4.2 Cleaning order, which is not arbitrary

```
1. deduplicate      before any statistic, so a duplicate cannot vote twice in a median
2. canonicalise     categorical text, before encoders see it
3. repair units     before outlier rules, or a unit error looks like an outlier
                    and gets clipped to a wrong-but-plausible value
4. flag implausible domain limits, not statistical ones
5. missing flags    RECORDED BEFORE IMPUTATION
6. impute           last
```

### 4.3 Unit repair

A wall thickness below **1.5 mm** is almost certainly inches in a millimetre
column — no transmission pipe has a 1 mm wall. Repaired by ×25.4 rather than
dropped, because the row is otherwise fine and discarding it would bias the
sample.

### 4.4 Implausible values are blanked, not clipped

Clipping invents a value. Blanking says *this reading is not usable*, which is
true, and step 5 then records that fact. Bounds are physical, not percentile —
a statistical outlier rule would also remove the genuinely extreme segments,
which are the ones the application exists to find.

### 4.5 Missingness indicators

Six `*_was_missing` columns, written **before** imputation and used as model
features. Impute first and every indicator is zero, the column still exists,
and the information is gone — silently. `test_indicators_are_recorded_before_imputation`
guards it.

### 4.6 Imputation

Median for numerics (robust to this data's skew), explicit `"Unknown"` for
categoricals so the encoder gets a real level. **Unrecorded cathodic
protection is imputed as absent** — assuming protection that cannot be
evidenced is the error that actually hurts someone.

### 4.7 Encoding

Ordinal, not one-hot. Tree models do not need one-hot, and it keeps SHAP
feature names 1:1 with the original columns, which is what makes the
explanations readable.

### 4.8 Measured results

```
duplicates removed   : 60 / 60
unit errors repaired : 68 / 75      (7 had already been blanked by missingness)
categorical variants : 17 -> 4 coatings, 12 -> 4 soils
implausible blanked  : 11
imputed cells        : 3,863
```

| | R² | MAE (mpy) |
|---|---|---|
| clean physics — unattainable ceiling | 0.722 | 0.756 |
| degraded, naive fill | 0.515 | 1.622 |
| degraded, **full cleaning pipeline** | **0.541** | 1.735 |

Realistic data quality costs about **0.18 R²** and cleaning recovers only part
of it. No preprocessing recovers information that was never recorded, and the
label noise alone puts a ceiling on what any model can score.

> **A finding worth keeping.** The first version of the cleaning-benefit test
> compared each pipeline on its *own* train/test split, and naive fill came out
> **ahead**. The reason is that it keeps the duplicates, so a duplicated segment
> can land in train and test at once and the model scores partly on rows it
> memorised. Both are now evaluated against the same never-degraded holdout.
> `test_duplicates_leak_between_train_and_test_if_not_removed` pins it.

---

## 5. The model

### 5.1 XGBoost regression

```python
XGBRegressor(n_estimators=300, max_depth=5, learning_rate=0.05,
             subsample=0.8, colsample_bytree=0.8, random_state=42)
```

80/20 split. **Test R² 0.565, MAE 1.693 mpy** on the degraded data.

**Why XGBoost and not a neural network.** It trains in seconds, needs no GPU,
handles mixed numeric/categorical natively, tolerates NaN, and — the deciding
factor — SHAP for trees is *exact* rather than approximated. The project scope
originally called for an FT-Transformer; swapping it in touches only
`src/models/train.py`, because preprocessing, SHAP and every downstream stage
are model-agnostic.

### 5.2 SHAP explainability

`TreeExplainer` computes exact Shapley values per prediction. They **sum to
the prediction** — an additive decomposition, not a correlation heuristic.

This matters because "SEG-04412 is high risk" is not actionable, whereas
"high risk *because* it is uncoated, has no CP, and sits in 900 ohm-cm soil"
tells the crew what to fix. The UI draws it as a diverging tornado plot, which
is how sensitivity is conventionally shown in engineering.

### 5.3 Everything else is deterministic

| Decision | Made by | Why not a model |
|---|---|---|
| Consequence & HCA | `consequence.py` | Regulatory definition, not a prediction |
| Remaining life | `remaining_life.py` | Closed-form Barlow / API 570 |
| Inspection method | `inspection.py` | Must be justified to a regulator |
| Repair method | `repair.py` | 49 CFR 192.713 / 195.422 constrain what is permissible |
| Schedule | `scheduler.py` | CP-SAT proves optimality |
| Crew assignment | `workorders.py` | CP-SAT, travel-aware |

**The organising principle:** an engineer must justify why a segment got a
DCVG survey and not an in-line run. A model that answers differently on
Tuesday than Monday cannot be defended. So the LLM explains; it never decides.

---

## 6. The pipeline, stage by stage

```
  synthetic_generator.py ──► 5,000 segments, clean physics
             │
  data_quality.py ────────► degraded: missing, unit errors, duplicates, noise
             │
  cleaning.py ────────────► dedupe → canonicalise → repair → flag → impute
             │
  preprocessing.py ───────► ordinal encoding, 20 model features
             │
  train.py (XGBoost) ─────► corrosion_rate_mpy        R² 0.565
             │
      ┌──────┼───────────────┬──────────────────┐
      ▼      ▼               ▼                  ▼
   SHAP   consequence.py  remaining_life.py   (stored in SQLite/Postgres)
    why    C score 0-100   t_min, ERF, years
      │      │               │
      └──────┴──► risk = likelihood_pct × consequence × HCA_multiplier
                       │
             ┌─────────┼──────────┐
             ▼                    ▼
       inspection.py          repair.py
       which technique        which intervention
       + statutory cap        + reinforcement vs mitigation
             │                    │
             ▼                    ▼
       scheduler.py          workorders.py
       CP-SAT: which         split by trade, then
       segments, when,       CP-SAT: nearest qualified
       which crew            technician, travel-aware
             │                    │
             └────────┬───────────┘
                      ▼
              FastAPI (22 endpoints, RBAC)
                      │
          ┌───────────┴───────────┐
          ▼                       ▼
    React console            LLM assistant
    Milepost                 (RAG + two-stage vision)
```

### 6.1 Consequence → real risk

```python
risk = clip(likelihood_percentile, 0, 1) * consequence_score  # 0-100
if is_hca: risk *= 1.25
```

Likelihood is the **percentile rank** across the fleet, not raw mpy — a 0–100
consequence multiplied by a raw rate is in no interpretable unit, and the rate
distribution has a long unphysical tail that would compress every real segment
into the bottom few percent.

Consequence is a weighted composite: population exposure by class location
(40), drinking water (20), ecological (12), navigable water (8), product
hazard (12), release volume (8). **Potential Impact Radius** is the published
49 CFR 192.903 formula, implemented as written:

```
r = 0.69 * sqrt(p * d²)     feet, for natural gas only
```

It returns `None` for liquids — PIR is a thermal-radiation concept for ignited
gas, and a crude oil spill has no impact radius.

HCA is determined by **two different rules** because the regimes genuinely
differ: gas keys off class location and sites inside the PIR (192.903); liquid
keys off populated areas, drinking water, ecology and navigable waterways
(195.450). A Class 1 liquid line crossing a drinking-water source **is** an
HCA, which the gas test would miss.

**What this changes:** `SEG-04574` corrodes at 3.20 mpy — merely "elevated" —
but scores consequence 87.0 and ranks **first of 5,000**.

| | critical | elevated | normal |
|---|---|---|---|
| by risk | 103 | 631 | 4,266 |
| by likelihood alone | 501 | 1,000 | 3,499 |

### 6.2 Remaining life

```
t_min          = P·D / (2·S·F·E·T)           ASME B31.8 / B31.4, Barlow
remaining_life = (t_actual − t_min) / rate   API 570
ERF            = operating pressure / safe pressure
```

Design factor `F` follows the B31.8 class-location table (0.72 / 0.60 / 0.50 /
0.40); liquid uses a single 0.72 per B31.4. **ERF ≥ 1.0** means the pipe is
operating at or above what its present wall safely supports — an
industry-standard repair trigger.

**Units are the hazard.** The dataset mixes millimetres, inches, psi and mils
per year. A wrong conversion does not raise; it produces a confident number
off by 25.4. Every function works internally in inches and psi, conversion
happens once at the boundary, and parameter names carry their unit.

**ASME B31G / Modified B31G** is implemented and tested, including the Folias
bulging factor with its two-branch definition (the quadratic goes negative
past z = 50, so applying it beyond that is a domain error, not a conservative
answer). It is **not reachable from the UI** because it needs per-anomaly
depth and length from an ILI tally.

`HDPE` is refused rather than given a number — not a yield-strength-governed
material under B31.8, and it does not corrode electrochemically.

### 6.3 Inspection method

Nine techniques: `CIPS`, `DCVG`, `UT`, `ILI-MFL`, `ILI-UT`, `ECDA`, `DIG`,
`CUI`, `COAT`. Standards cited: NACE/AMPP SP0169, SP0502, API 570, API 579-1,
API 1160, ASME B31.4/B31.8.

**Statutory caps** are applied last and only ever downward:

- **84 months** gas transmission in an HCA — 49 CFR 192.939
- **60 months** hazardous liquid in an HCA — 49 CFR 195.452(j)(3)

A risk-based interval shorter than the cap governs. An engine that stretched a
6-month interval to 60 "because the law permits it" would be actively unsafe;
`test_the_cap_only_ever_shortens_the_interval` prevents it.

### 6.4 Repair selection

Seven actions across four categories:

| Code | Action | Category |
|---|---|---|
| `DERATE` | Interim pressure reduction | operational |
| `GRIND` | Grind out shallow loss | reinforcement |
| `SLV-A` | Composite sleeve (Type A) | reinforcement |
| `SLV-B` | Welded steel sleeve (Type B) | reinforcement |
| `CUTOUT` | Cut out and replace joint | replacement |
| `CP-UP` | Cathodic protection upgrade | mitigation |
| `RECOAT` | Excavate, blast, recoat | mitigation |

**The design point is the reinforcement/mitigation split.** The commonest
mistake in a corrosion repair plan is treating the symptom: a composite sleeve
over wall loss on a line with a failed rectifier is a patch on a pipe that
will keep corroding either side of it. Every plan separates fixing the
**defect** from fixing the **cause**.

Selection is driven by ERF and remaining life, leak risk (Type A cannot
contain pressure, so deep loss needs Type B), repair history (four repairs on
one joint is a replacement case), diameter (below 4 in, sleeve hardware is
impractical), and HCA status, which compresses the repair window by 40%.

### 6.5 Inspection scheduling — CP-SAT

```
maximise   Σ risk_score × urgency_weight  over selected segments
s.t.       each segment inspected at most once
           crew-days per period ≤ capacity
           region locking (optional)
           statutory deadline: no variable exists past it
```

The deadline is a **hard constraint, not a weight** — no CP-SAT variable
exists past it, so the solver cannot buy a better objective by running a
compliance date late. Segments whose deadline cannot be met are reported as
`missed_deadlines`; otherwise they simply fail to appear and nothing says why.

Current run: **OPTIMAL, 96.2% utilisation, 241 ms, 0 missed deadlines.**

### 6.6 Work orders and dispatch — CP-SAT again

```
maximise   Σ (risk × urgency_weight − travel_penalty × travel_days)
s.t.       each order to at most one technician
           work_days + travel_days ≤ technician capacity
           skills are hard constraints
           immediate work must be covered
```

**Travel is charged to the same crew-day budget as the work**, so "nearest
competent" falls out of the optimiser instead of being hard-coded. Houston to
Midland is a **3.6 crew-day round trip** before anyone picks up a tool.

Geography was added for this: `geo.py` scatters coordinates around real basin
centroids (Permian, Marcellus, Gulf Coast ship channel), with haversine
distance, a 1.35 road factor and travel time at 65 km/h.

> **A bug worth recording.** The first version emitted one work order per
> segment carrying every skill the plan needed, and the model then demanded one
> technician holding all of them. On the real roster that is nobody, so **27 of
> 39 orders came back "blocked by skill gap"** — a staffing conclusion produced
> entirely by a modelling mistake. Field work is not dispatched that way: a
> coatings crew and a CP crew are different trucks. Orders are now split by
> trade, with actions sharing a trade kept together.
>
> ```
>                     before      after
> work orders             39          81
> skill-gap blocked       27           0
> urgent unassigned        9           0
> utilisation          15-78%      90-99%
> ```

Current run: **OPTIMAL in 232 ms, 48/81 assigned, 59.6% of risk covered,
18,625 km, 0 skill gaps, 0 urgent uncovered.**

### 6.7 RAG and the assistant

Six curated documents, 31 chunks. Retrieval is **three-view** — word-level
TF-IDF fused with character n-grams (`char_wb`, 4–5) via **Reciprocal Rank
Fusion** (k=60).

> The character view exists because of a measured failure: *"how often should I
> inspect"* scored **0.000** against a corpus that says "inspection interval" —
> TF-IDF has no stemming, so *inspect* ≠ *inspection*. The assistant answered
> without citations and looked fine. Fusing the two views took recall from
> **14/17 to 17/17**.

A domain gate keeps the assistant on oil-and-gas topics, deliberately biased
toward answering: it refuses only when a question has **no** in-domain
vocabulary **and** an explicit off-domain marker.

**Two-stage photo analysis.** A local 1.8B vision model (`moondream`) describes
what it sees — forbidden from guessing causes — and a strong remote text model
reasons over those observations plus the segment's numbers and retrieved
standards. *Local model sees, remote model thinks.* The split exists because
the target machine has no discrete GPU.

Guardrails, all added because they were needed: wall-loss estimation from a
photo is forbidden; vague words ("hole", "gap") must **not** be escalated into
a through-wall breach; text inside an image is untrusted data, never
instructions.

---

## 7. The stack

| Layer | Tool | Role |
|---|---|---|
| Language | **Python 3.11** | Everything server-side |
| API | **FastAPI** + Uvicorn | 22 endpoints, async streaming |
| Validation | **Pydantic 2** | Rejects malformed input at the boundary |
| ML | **XGBoost 2.1** | Corrosion rate regression |
| Explainability | **SHAP 0.46** | Exact TreeExplainer attribution |
| Optimisation | **OR-Tools CP-SAT** | Scheduling and dispatch |
| Data | **pandas / numpy** | Generation, cleaning, features |
| Persistence | **SQLAlchemy 2** | SQLite ↔ PostgreSQL |
| LLM transport | **httpx** | No vendor SDK — provider is a config change |
| Tests | **pytest** | 259, all passing |
| Frontend | **React 18 + TypeScript** | Strict mode |
| Build | **Vite 6** | ~7 s production build |
| Styling | **Tailwind v4** | `@theme` design tokens |
| State | **TanStack** Query / Table / Virtual | Caching, sorting, 5,000-row virtualisation |
| Charts | **Recharts** | Distributions |
| Markdown | react-markdown + remark-gfm | Model output is **never** HTML |
| Landing page | **CSS 3D + canvas** | No 3D library — CSP blocks CDNs and the GPU is integrated |

LLM providers, all free tier: **Groq** (`gpt-oss-120b`), **Ollama** local
(`moondream` vision, `llama3` text), **HuggingFace**, and a deterministic mock
so all 259 tests run with no credentials and no network.

---

## 8. Security

Six real issues were found and patched, each with a regression test.

| Issue | Severity | Fix |
|---|---|---|
| SHA-256 with one shared salt | High | PBKDF2-HMAC-SHA256, 600k iterations, per-user salt |
| Tokens never expired | High | 12 h absolute + 1 h idle, with a sweep |
| No login rate limiting | High | 5 failures per (user, IP) → 15 min lockout |
| Password compared with `!=` | Medium | `hmac.compare_digest` |
| User enumeration by timing | Medium | Dummy PBKDF2 on the miss path |
| `CORS allow_origins=["*"]` | Medium | Explicit allowlist |

Plus: chunked upload with early abort (the old code buffered the whole body
*then* checked size), magic-byte sniffing (`content_type` is attacker-
controlled), sanitised error text, CSP with `script-src 'self'`, `/docs` gated
behind `INTEGRITYAI_ENV=production`, and `X-Forwarded-For` trusted only behind
a declared proxy.

RBAC is enforced server-side on every route including the LLM endpoints —
verified live: inspector → `/api/workorders/assign` **403**, unauthenticated
**401**.

---

## 9. Project scale

| Metric | Value |
|---|---|
| Python (src + backend + scripts) | 6,712 lines across 31 modules |
| TypeScript / CSS | 3,728 lines across 14 files |
| Landing page | 819 lines, no dependencies |
| Test code | 2,539 lines |
| Tests | **375, all passing** (~165 s) |
| API endpoints | 22 |
| Dataset | 5,000 segments × 31 columns |
| Model features | 20 (14 raw + 6 missingness indicators) |
| Knowledge base | 6 documents / 31 chunks |
| Inspection methods | 9 · Repair actions | 7 |
| Standards cited | 10 |

---

## 10. Advantages

- **Decision-complete.** Prediction → explanation → consequence → remaining
  life → method → repair → schedule → dispatch. Most projects stop at the
  first arrow.
- **Auditable by construction.** Every regulator-facing decision is
  deterministic and unit-tested.
- **Explainable per segment**, not just globally.
- **Respects real constraints** — crew-days, regions, skills, travel,
  statutory deadlines.
- **Honest about failure.** The scheduler reports when it cannot fit work;
  retrieval reports when it found nothing; dispatch distinguishes a staffing
  gap from a scheduling choice.
- **Tested against realistic data**, not pristine columns.
- **Costs nothing to run** — free-tier LLMs, local option, deterministic mock.
- **Grounded in real standards**, with judgement thresholds labelled as
  judgement.

## 11. Limitations

1. **The dataset is synthetic.** R² 0.565 measures fit to a generator. The
   pipeline is validated end to end; the *model* is not validated against
   field data.
2. **The corrosion-rate tail is unphysical** — up to ~215 mpy, well above what
   carbon steel in soil does. Documented rather than quietly clipped.
3. **Consequence attributes are synthetic**, and 52.7% HCA is at the top of
   the plausible range.
4. **No per-anomaly assessment.** B31G is implemented but needs an ILI tally.
5. **Travel is straight-line × 1.35, not routed.** Real crews chain jobs; that
   is a VRP needing a road network.
6. **Round-trip-per-job overstates travel** for clustered work — deliberately,
   since the opposite error makes distant work look free.
7. **The domain gate is heuristic**, not a classifier.
8. **Photo analysis is qualitative only** — no scale reference, no wall-loss
   estimate.
9. **Retrieval is lexical**, not semantic — a paraphrase with no shared
   vocabulary still misses.
10. **Half the decimal errors are undetectable.** 85 psi where 850 was meant is
    indistinguishable from a genuine low-pressure line without a second source.
11. **Demo-grade identity.** No SSO/MFA; tokens are in-process memory.
12. **Single-machine deployment.** No containerisation, no CI, no migrations.

## 12. What I would do next, in order

1. **Ingest a real ILI tally.** Unlocks per-anomaly B31G, dig sheets, and
   corrosion growth from repeat runs — the highest-value change by a distance.
2. **Real HCA polygons** from public population and drinking-water layers.
3. **Prediction intervals** instead of point estimates — the *upper* bound is
   what drives conservative planning. XGBoost supports a quantile objective
   natively.
4. **Route the dispatch** with a real road network, turning per-job round
   trips into a VRP.
5. ~~Embedding-based retrieval~~ — **done**, fused with the two lexical views rather than replacing them (paraphrase recall@3 1/8 — 6/8; jargon unchanged at 9/10).
6. **FT-Transformer** in place of XGBoost — **blocked**: PyTorch is not installed and there is no network here to install it. Still a one-file change, and still not obviously right — on 5,000 noisy tabular rows gradient boosting is hard to beat, and leaving trees costs the exact SHAP the explainability rests on.
7. Real authentication, containerisation, CI.

---

## 13. Running it

```bash
python -m venv venv && venv\Scripts\activate
pip install -r requirements.txt

python -m src.data.synthetic_generator     # generate + degrade
python scripts/run_pipeline.py             # train + SHAP
python scripts/load_to_database.py         # clean + load

cd web && npm install && npm run build && cd ..
uvicorn backend.main:app --reload --port 8010
```

- **http://localhost:8010** — landing page
- **http://localhost:8010/console** — the console

| Username | Password | Role |
|---|---|---|
| `inspector1` | `inspect123` | Gulf Coast only |
| `supervisor1` | `supervise123` | All regions + Schedule, Dispatch, Fleet |
| `admin` | `admin123` | Full |

```bash
python -m pytest -q                        # 259 tests
```

See **[RUN.md](RUN.md)** for per-feature commands and **[README.md](README.md)**
for the long-form documentation of each subsystem.
