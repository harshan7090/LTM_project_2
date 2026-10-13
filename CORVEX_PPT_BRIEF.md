# CORVEX — Complete Project Brief for Presentation Generation

> **Instructions for the model reading this file**
>
> You are generating a PowerPoint deck about the project described below.
>
> - **Audience:** an engineering mentor reviewing a student project. Technical,
>   values honesty and engineering judgement over polish. Not customers or investors.
> - **Use only facts and figures from this file.** Each number here was measured
>   on the running system. Do not round them into stronger claims or invent new ones.
> - **Keep the caveats.** The data is synthetic. Present the limitations
>   (§19) as a slide; they strengthen the presentation.
> - **Lead with the design principle (§4):** *"AI explains. AI never decides."*
>   It is what separates this project from an "AI wrapper".
> - A suggested 18-slide outline is in **§22**, and visual/design guidance is in **§23**.
> - Diagrams in this file are ASCII. Redraw them as clean shapes on the slides.

---

## 1. Identity

| | |
|---|---|
| **Product name** | **CORVEX** |
| **Tagline** | *Predict. Protect. Prevent.* |
| **Positioning** | AI-powered pipeline integrity and corrosion intelligence |
| **Domain** | Oil & gas: buried transmission pipelines, external corrosion |
| **Form** | Python/FastAPI backend + React/TypeScript operator console + 3D landing page, all served from one process |
| **Project type** | Student project, reviewed by a mentor |
| **Earlier working names** | *IntegrityAI* (still the repo, package and API title) and *Milepost*. Use **CORVEX** on slides. |

**One-line pitch:** a pipeline corrosion-risk console that turns raw inspection
records into dispatched work orders. It predicts how fast each segment is
corroding, explains why, converts that into true regulatory risk, and decides
what to inspect, how to repair it, and which crew goes when.

**One-paragraph summary (good for a closing or abstract slide):**
> Corvex is a pipeline corrosion-risk console that turns raw inspection records
> into dispatched work orders. It predicts corrosion rate with XGBoost and
> explains every prediction with exact SHAP attribution. It converts rate into
> true risk by scoring consequence under 49 CFR 192/195, including High
> Consequence Area (HCA) determination and Potential Impact Radius. It computes
> remaining life from ASME B31.8 and Modified B31G. It ranks inspection methods
> and repair actions by value per crew-day, applying statutory interval caps
> last and only downward. It then assigns work to the nearest qualified crew
> with two OR-Tools CP-SAT solvers that charge travel against the same budget
> as the work. A retrieval-augmented language model explains those decisions
> with citations but never makes them: every auditable number is
> deterministic, tested code.

---

## 2. The problem

- An operator runs **thousands of buried pipeline segments** but has only a
  **handful of inspection crews**.
- Inspecting everything every year is impossible, and inspecting the wrong
  segments is how leaks happen.
- The real question is not *"is this pipe corroding?"* but:
  **"Given finite crew-days, which segments do we inspect, with which technique,
  in which month, and who goes?"**
- Corrosion rate alone cannot prioritise work. A fast-corroding segment under
  farmland is less urgent than a slower one under a school. Real priority is
  **likelihood × consequence**.
- The decisions must be **defensible to a regulator**. An engineer has to
  justify why a segment got a DCVG survey rather than an in-line inspection
  run. A black-box answer that changes from day to day cannot be defended.

Most tools, and most student ML projects, stop at predicting the rate.
Corvex goes all the way from prediction to dispatched work.

---

## 3. What Corvex does: four questions, in order

| # | Question | How it is answered |
|---|---|---|
| 1 | **How fast is each segment corroding?** | XGBoost regression + SHAP explanation + calibrated uncertainty (conformal prediction) |
| 2 | **What would a failure there actually cost?** | Consequence scoring under US pipeline regulation (49 CFR 192 / 195), HCA, Potential Impact Radius |
| 3 | **What should be done, in what order?** | Inspection method and repair action ranked by value per crew-day; remaining life from ASME/API formulas |
| 4 | **Who does it, and when?** | Constraint-solved crew scheduling + proximity-based dispatch (OR-Tools CP-SAT) |

**The decision chain (most projects stop after the first arrow):**

```
Prediction → Explanation → Consequence → Risk → Remaining life
          → Inspection method → Repair action → Schedule → Dispatch
```

**Demonstration fleet:** 5,000 synthetic pipeline segments placed along
**15 real Indian pipeline corridors** (6,414 km) in **5 operating zones**.

---

## 4. The governing design principle (the most important slide)

> **Every auditable decision is deterministic, tested code.
> The language model only explains. It never decides.**

- Corrosion rate, consequence score, HCA determination, remaining life,
  inspection interval, repair ranking and crew assignment are **all
  deterministic code with unit tests**. The same input always gives the same plan.
- The LLM reads those outputs and explains them in prose, citing the standard
  it draws on.
- **No number produced by the LLM ever reaches a decision.** Photo (vision)
  analysis is labelled an *indication* and never feeds the calculations.
- This answers *"why not just prompt GPT with the asset data?"*: the output
  would be unauditable and non-reproducible.

| Decision | Made by | Why not a model |
|---|---|---|
| Corrosion rate | XGBoost (trained ML) | The one genuinely predictive step, explained by exact SHAP |
| Consequence & HCA | `consequence.py` | A regulatory definition, not a prediction |
| Remaining life | `remaining_life.py` | Closed-form Barlow / API 570 |
| Inspection method | `inspection.py` | Must be justified to a regulator |
| Repair method | `repair.py` | 49 CFR 192.713 / 195.422 constrain what is permissible |
| Schedule | `scheduler.py` | CP-SAT proves optimality |
| Crew assignment | `workorders.py` | CP-SAT, travel-aware |
| Explanation / Q&A | LLM + RAG | Language is what an LLM is good at |

---

## 5. System architecture

```
 ┌─────────────────────────── DATA ───────────────────────────┐
 │ synthetic_generator → data_quality (degrade) → cleaning     │
 │ → preprocessing (20 features) → SQLite / PostgreSQL         │
 └──────────────────────────────┬──────────────────────────────┘
                                ▼
 ┌─────────────────────────── ML ─────────────────────────────┐
 │ XGBoost → corrosion rate (mpy)   SHAP → why                 │
 │ Conformal prediction → calibrated interval (module ready)   │
 └──────────────────────────────┬──────────────────────────────┘
                                ▼
 ┌──────────────────── DETERMINISTIC ENGINES ─────────────────┐
 │ consequence (HCA, PIR) → risk = likelihood × consequence    │
 │ risk matrix 5×5 · remaining life (Barlow, B31G, API 570)    │
 │ inspection method (+ statutory cap) · repair selection      │
 │ CP-SAT scheduler · CP-SAT work-order dispatch (travel-aware)│
 └──────────────────────────────┬──────────────────────────────┘
                                ▼
 ┌──────────────── FastAPI (25 /api routes, RBAC) ────────────┐
 └───────┬───────────────────────┬────────────────────┬───────┘
         ▼                       ▼                    ▼
  React operator console   AI assistant          3D landing page
  (map, register, drawer,  (RAG + domain gate    (React Three Fiber,
   schedule, dispatch)      + two-stage vision)   8-chapter journey)
```

**One request, end to end (example):** the operator clicks a segment → React
fires a cached TanStack Query → FastAPI checks the bearer token and the user's
zone permission → loads the row → XGBoost prediction → SHAP `TreeExplainer` on
that single row → consequence + remaining life → returns rate, risk band and
ranked SHAP drivers → the drawer draws a tornado plot. The *Inspection* tab
calls the rule engine, which returns ranked methods with standard citations.

---

## 6. Data

### 6.1 Source: synthetic, by design, and labelled as such everywhere

`src/data/synthetic_generator.py` builds **5,000 segments** whose corrosion rate
follows simplified but real corrosion-engineering relationships:

```
base_rate      = 0.8 × (1 − coating_quality) × cp_factor × soil_factor × material_factor
corrosion_mpy  = base_rate × √(age + 1) + noise  + 0.15 × historical_repair_count
```

- No cathodic protection (CP) roughly **triples** the rate (`cp_factor` 0.3 → 1.0).
- Coating quality ranks correctly: FBE 0.90 > coal tar 0.75 > PE tape 0.60 > uncoated 0.05.
- Stainless corrodes at 0.2× and HDPE at 0.02× the rate of carbon steel.
- The `√age` term reflects partial passivation by corrosion products.
- **Soil corrosivity uses Michaelis–Menten saturation**, because
  oxygen-diffusion-limited corrosion physically saturates:
  `soil_factor = 4.0 · 3000 / (3000 + resistivity)`.
- A **`tanh` ceiling at 40 mpy** (max pitting rate) replaced an earlier
  unbounded tail that reached ~230 mpy, which is unphysical.

**Why synthetic:** it lets the model, explainability, risk, scheduling and
dispatch layers all be built and tested now, without waiting on a real
operator's data. A real-data path exists: `scripts/fetch_phmsa_data.py`
downloads PHMSA's public U.S. pipeline incident files and prints their actual schema.

**Pipes are designed, not drawn at random.** Each segment's pipe is
engineered the way a real line is:

| Step | Rule |
|---|---|
| Steel grade | Follows diameter: small lines Grade B–X52, large trunk lines X60–X70 |
| MAOP | Operating pressure × 1.05–1.25 (lines run below their maximum allowable pressure) |
| Nominal wall | Barlow at the MAOP and the location's design factor, **rounded up to a standard API 5L wall**, never below the handling floor (0.188″, D/t ≤ 96). 20% are one size heavier (crossings, spec margin) |
| HDPE | SDR 11 (wall = diameter ÷ 11) |
| Measured wall | Nominal minus the metal this segment's own corrosion has removed over its life, ±0.15 mm UT scatter. Segments whose history would have consumed their whole corrosion allowance are treated as already repaired |

The result is realistic line pipe: 4″ → 4.8 mm, 24″ → 7.1 mm, 48″ → 14.3 mm
(median), D/t 21–96. `measured_wall_mm` is **deliberately not a model
feature**: it is derived from the corrosion label, so the model seeing it
would leak the answer. A test enforces this.

### 6.2 What is in each segment (43 columns)

Attributes are kept in **four deliberately separate groups**:

| Group | Count | Examples | Used by the model? |
|---|---|---|---|
| Model features | 14 raw + 6 missingness flags = **20** | age, diameter, wall thickness, soil resistivity, pressure, temperature, years since inspection, repair count, CP, material, coating, soil type, product, zone | **Yes** |
| Consequence attributes | 5 | class location (1–4), drinking-water source, environmentally sensitive, navigable waterway, occupied site within PIR | **No, deliberately** |
| Engineering attributes | 3 | pipe grade (API 5L Grade B → X70, gives SMYS), latitude, longitude | No |
| Targets | 2 | `corrosion_rate_mpy` (regression target), priority flag | Target |

**Why consequence columns are excluded from the model:** if *where* a pipe is
became a predictor of *how fast* it corrodes, the two halves of
`risk = likelihood × consequence` would no longer be independent and the
product would be circular. A unit test fails the build if they ever leak in.

### 6.3 The data is degraded on purpose, to look like real records

`src/data/data_quality.py` injects the problems real inspection records have:

| Defect injected | Amount | Real-world cause |
|---|---|---|
| Missing values | ~3,850 cells across 6 fields | A 1970s line whose soil survey was never digitised |
| Unit confusion | 75 rows | Wall thickness entered in **inches** into a mm column |
| Decimal slips | 20 rows | 850 psi recorded as 85 or 8,500 |
| Categorical drift | 922 rows | `FBE`, `fbe`, `Fusion Bonded Epoxy`, `" FBE "` |
| Duplicate rows | 60 | The same segment entered twice after a merger |
| Measurement noise | 2–25% by field | UT repeatability, seasonal soil resistivity |
| Label noise | σ 12% + 0.15 mpy floor | Rate derived from two ILI runs, each with tool tolerance |

**Missingness is MNAR (Missing Not At Random):** old and neglected assets are
*more* likely to have missing records, which is how real data fails:

```
p(missing) = base × age_factor × neglect_factor
age_factor     = 1 + 2.0 × clip(age / 65)          (3× worse on the oldest pipe)
neglect_factor = 1 + 0.5 × clip(years_since_inspection / 10)
```

These are exactly the segments most likely to be corroding. Mean-imputing
them would tell the model an unsurveyed 1974 line is average, which is wrong
in the dangerous direction.

### 6.4 Cleaning pipeline (the order matters)

```
1. deduplicate        before any statistic, so a duplicate can't vote twice
2. canonicalise text  before encoders see it
3. repair units       before outlier rules, or a unit error looks like an outlier
4. flag implausible   physical limits, not percentiles
5. RECORD MISSINGNESS INDICATORS   ← before imputation
6. impute             median for numbers, "Unknown" for categories
```

- A wall below **1.5 mm** must be inches in a mm column, so it is repaired ×25.4 rather than dropped.
- Implausible values are **blanked, not clipped**: clipping invents a value.
- Six `*_was_missing` indicator columns are recorded **before** imputation and
  used as model features. "Nobody surveyed this" becomes evidence.
- **Unrecorded cathodic protection is imputed as absent.** Assuming protection
  you cannot evidence is the error that hurts someone.
- **Ordinal encoding, not one-hot.** Trees don't need one-hot, and SHAP feature
  names stay 1:1 with the real columns.

**Measured cleaning results:** 5,060 → 5,000 rows · 60/60 duplicates removed ·
68/75 unit errors repaired (7 were already blank) · 17 coating variants → 4 ·
12 soil variants → 4 · 3,863 cells imputed.

**A finding worth a slide:** the first cleaning-benefit test made naive filling
look *better*. Naive filling kept the duplicates, so the same segment could
land in both train and test and the model scored on rows it had memorised.
Both pipelines are now evaluated on the same never-degraded holdout, and a
test pins the leak.

---

## 7. Machine learning

### 7.1 Production model: XGBoost regression

```python
XGBRegressor(n_estimators=300, max_depth=5, learning_rate=0.05,
             subsample=0.8, colsample_bytree=0.8, random_state=42)
```

- 80/20 train/test split (1,000 held-out segments); target = external
  corrosion rate in mils per year (mpy).
- **Deployed model: test R² = 0.673 · test MAE = 0.485 mpy** (retrained
  9 Oct 2026 after the realistic-wall fix; held-out synthetic data). The 21 Sep benchmark run of the same
  configuration scored R² 0.682 / MAE 0.483; that run is the one used in the
  model comparison (§7.2) and quoted on the landing page.
- Fleet mean rate ≈ 1.06 mpy (median predicted 0.66); the maximum recorded
  rate is 19.4 mpy, well under the 40 mpy physical ceiling.

**Why XGBoost:** it trains in under a second, needs no GPU, handles mixed
numeric/categorical data and NaN natively, and, decisively, **SHAP for trees
is exact** rather than approximated.

### 7.2 Measured comparison: XGBoost vs FT-Transformer

The project scope originally called for a **PyTorch FT-Transformer** (feature
tokenizer + `[CLS]` token + pre-norm transformer encoder). It was built and
benchmarked on the same split (benchmark run, 21 Sep 2026):

| Model | Test R² | Test MAE (mpy) | Train time | Size |
|---|---|---|---|---|
| **XGBoost** ✅ | **0.682** | **0.483** | **0.4 s** | 300 trees |
| FT-Transformer | 0.637 | 0.497 | 233.2 s | 87,616 parameters, 50 epochs |

**XGBoost wins** by ΔR² = 0.044 while training **~580× faster**. This is the
expected result for 5,000 rows of tabular data, and it is reported rather than
hidden. Deep learning is not automatically better on tabular problems at this
scale, and switching away from trees would cost the exact SHAP attribution.

### 7.3 Explainability: SHAP

- `shap.TreeExplainer` gives **exact Shapley values** per prediction.
- The values **sum to the prediction**. It is an additive decomposition, not a
  correlation heuristic.
- The UI shows a **diverging tornado plot** (left lowers the rate, right raises
  it), the conventional engineering sensitivity chart.
- Why it matters: *"SEG-04412 is high risk"* is not actionable. *"High risk
  because it is uncoated, has no CP and sits in 900 Ω·cm soil"* tells the crew
  what to fix.

### 7.4 Uncertainty: split conformal prediction

- Normalised (difficulty-weighted) split conformal; finite-sample correction
  `level = ⌈(n+1)(1−α)⌉ / n`.
- The difficulty model is trained on **proper-training residuals, not
  calibration residuals**. Calibrating on data the model has seen collapses
  residuals and gives intervals that are too narrow while looking rigorous.
- **Measured empirical coverage** (1,250 held-out segments, 938 calibration):

| Target coverage | Achieved | Mean interval width |
|---|---|---|
| 95% | **93.9%** | 2.61 mpy |
| 90% | **89.8%** | 2.02 mpy |
| 80% | **80.3%** | 1.45 mpy |

- Conservative remaining life uses the **upper** bound of the interval.
- ⚠️ **Status:** `src/models/conformal.py` is complete and measured, but **not
  yet wired into the console UI** or the training script.

---

## 8. Risk and integrity engines (deterministic)

### 8.1 Consequence: `consequence.py`

Weighted 0–100 composite score:

| Term | Weight |
|---|---|
| Population exposure (by class location: 0.10 / 0.40 / 0.80 / 1.00) | 40 |
| Drinking-water source | 20 |
| Ecological sensitivity | 12 |
| Product hazard | 12 |
| Navigable waterway | 8 |
| Release volume | 8 |

**Two regulatory regimes, implemented as written:**

- **Gas, 49 CFR 192.903:** HCA keys off class location and occupied sites
  inside the **Potential Impact Radius**: `r = 0.69 · √(p · d²)` (feet).
- **Hazardous liquid, 49 CFR 195.450:** HCA keys off populated areas,
  drinking water, ecology and navigable waterways.
- PIR is a thermal-radiation concept for ignited gas, so the code **returns
  `None` for liquids** rather than a meaningless number.
- A Class 1 liquid line crossing a drinking-water source **is** an HCA, which
  a gas-style test would miss.

### 8.2 Risk = likelihood × consequence

```
likelihood = percentile rank of predicted rate across the fleet   (0–1)
risk       = likelihood × consequence_score        (× 1.25 if in an HCA)
bands      : critical ≥ 55 · elevated ≥ 30 · else normal
```

Percentile rank rather than raw mpy keeps the product in an interpretable unit
and stops the rate distribution's long tail from making consequence irrelevant.

**What this changes (a strong slide, measured 9 Oct 2026):** the register is
ranked by **risk**, not rate.

| Segment | Predicted rate | Consequence | HCA | Risk rank |
|---|---|---|---|---|
| **SEG-04103** | only **1.18 mpy** (likelihood "elevated", not critical) | **88.2** | Yes | **#5 of 5,000** |
| **SEG-03880**, fastest-corroding in the fleet | **15.4 mpy** | 20.0 | Yes | only **#1,029** |

**The fastest-corroding pipe is not the most urgent one.** Where a pipe is
matters as much as how fast it corrodes. Ranking by rate alone would put the
wrong segments at the top.

**Rate severity and risk are shown as two separate judgements.** A corrosion
rate is wall lost per year, so **lower is better**. The console grades it on
its own absolute scale, NACE SP0775 for carbon steel (`corrosion_class.py`),
and grades the overall risk separately, with a one-line reason:

| NACE SP0775 class | Rate | Segments |
|---|---|---|
| Low | < 1 mpy | 3,363 |
| Moderate | 1–4.9 mpy | 1,545 |
| High | 5–10 mpy | 81 |
| Severe | > 10 mpy | 11 |

The two often disagree, by design: **46 of the 92 high/severe-rate segments
are normal overall risk** (fast, but a failure there would do little harm),
and **107 of the 121 critical-risk segments corrode at only a low or moderate
rate** (slow, but in a place where a failure would be serious). The panel
says so in words, e.g. *"Corrosion here is among the fastest in the fleet,
but a failure here would have limited impact (25/100), so overall risk is
normal."*

### 8.3 The 5×5 risk matrix: `risk_matrix.py`

The canonical likelihood × consequence grid every integrity department uses.

- Likelihood bins (fleet percentile): 0.50 / 0.75 / 0.90 / 0.97 →
  *Rare · Unlikely · Possible · Likely · Almost certain*
- Consequence bins (score): 20 / 35 / 55 / 75 →
  *Negligible · Minor · Moderate · Major · Severe*
- Band by product L×C: ≤4 low · ≤9 moderate · ≤14 high · else severe
- **Bins are deliberately not quintiles.** Quintiles would force 20% of the
  fleet into the top row by construction, so the matrix could never show a
  healthy fleet.
- The grid is always returned with all 25 cells. An empty cell is information.

**Fleet result (9 Oct 2026):** low **3,897** · moderate **875** · high **165** · severe **63**.

### 8.4 Remaining life: `remaining_life.py`

```
t_min          = P·D / (2·S·F·E·T)              Barlow, ASME B31.8 / B31.4
remaining_life = (t_measured − t_min) / rate    API 570
ERF            = operating pressure / safe pressure   (≥ 1.0 → repair trigger)
```

- **Counts down from the measured wall,** not the as-built wall, and the
  console shows nominal wall, measured wall and **metal loss %** side by side.
- **Derate** is flagged when ≥ 80% of the original corrosion allowance
  (nominal − t_min) has been consumed, the same 80% figure B31G uses as its
  metal-loss limit.
- **Planning horizon:** a projection beyond 50 years is shown as "**50+
  years · beyond planning horizon**". Coatings age, CP changes and regulation
  moves on, so a uniform-loss projection past half a century is arithmetic, not a forecast.
- Design factor F follows the B31.8 class-location table (0.72 / 0.60 /
  0.50 / 0.40); liquids use 0.72 per B31.4.

**Example, SEG-00660** (4″ Grade B, 45 years old, corroding at 6.5 mpy):
nominal 4.54 mm → measured 3.51 mm (**22.6% lost**), t_min 2.60 mm, ERF 0.74
→ reaches the minimum allowable wall in **5.5 years → plan repair**. Total
service life ≈ 50 years, typical for an older, poorly protected small line.

**Fleet (9 Oct 2026):** for segments projected to need action within the
horizon, median age + remaining life is **53 years** (p10 28, p90 77), in line
with real-world pipeline service lives. Verdicts: 3,786 monitor · 141 plan
repair · 73 repair now · 494 derate · 506 HDPE (not applicable).
- **Modified ASME B31G** with the two-branch Folias bulging factor
  (z ≤ 50 → quadratic, else 0.032z + 3.3) is implemented and tested. It needs
  per-anomaly depth and length from an ILI tally, so it is not yet reachable from the UI.
- **HDPE is refused** rather than given a number: it has no SMYS and does not
  corrode electrochemically.
- **Units are the hazard:** the data mixes mm, inches, psi and mpy. Everything
  converts once at the boundary, and parameter names carry their unit.

### 8.5 Inspection method selection: `inspection.py`

Nine techniques, ranked by **efficiency = diagnostic value ÷ total burden**;
the top 3 are returned:

| Code | Method | Value |
|---|---|---|
| DIG | Excavation & direct examination | 1.00 |
| ILI-MFL | In-line inspection, magnetic flux leakage | 0.95 |
| ILI-UT | In-line inspection, ultrasonic | 0.95 |
| UT | Ultrasonic thickness | 0.90 |
| CIPS | Close-interval potential survey | 0.85 |
| DCVG | Direct-current voltage gradient | 0.80 |
| ECDA | External corrosion direct assessment | 0.75 |
| CUI | Corrosion-under-insulation inspection | 0.70 |
| COAT | Coating survey | 0.50 |

- Tunable thresholds declared at the top of the file: corrosive soil
  < 2,000 Ω·cm · min piggable diameter 6″ · overdue at 5 years · old pipe at
  30 years · CUI window 10–60 °C · high pressure > 1,000 psi · repeat-repair trigger 3.
- **Statutory caps are applied last and only downward:** 84 months for a gas
  HCA (49 CFR 192.939) and 60 months for a liquid HCA (49 CFR 195.452(j)(3)).
  A longer risk-based interval is overruled; a shorter one is never stretched
  to the legal maximum. Stretching a 6-month interval to 60 "because the law
  permits it" would be unsafe, and a test prevents it.

### 8.6 Repair selection: `repair.py`

| Code | Action | Category | Value |
|---|---|---|---|
| CUTOUT | Cut out and replace joint | replacement | 1.00 |
| SLV-B | Welded steel sleeve (Type B, pressure-containing) | reinforcement | 0.85 |
| SLV-A | Composite sleeve (Type A) | reinforcement | 0.75 |
| RECOAT | Excavate, blast, recoat | mitigation | 0.70 |
| CP-UP | Cathodic protection upgrade | mitigation | 0.65 |
| GRIND | Grind out shallow loss | reinforcement | 0.45 |
| DERATE | Interim pressure reduction | operational | 0.30 |
| MON | Monitor only | — | 0.05 |

```
total_burden = est_days + cost / 25,000 + (3 if shutdown required)
efficiency   = value / total_burden          (USD 25,000 per crew-day)
```

- **The key design point is separating the defect from its cause.** A sleeve
  over wall loss on a line with a failed rectifier is a patch on a pipe that
  keeps corroding either side of it. Every plan separates fixing the
  **defect** (reinforcement) from fixing the **cause** (mitigation).
- Driven by ERF and remaining life (repair at ERF ≥ 1.0, watch at ≥ 0.90),
  leak risk (Type A can't contain pressure; max 60% wall loss), repair history
  (4 repairs → replacement), diameter (no sleeves below 4″) and HCA status,
  which compresses the repair window by 40%.

---

## 9. Optimisation: two Google OR-Tools CP-SAT solvers

### 9.1 Inspection scheduling: `scheduler.py`

```
maximise   Σ risk_score × urgency_weight − travel_penalty × travel_days
s.t.       each segment inspected at most once
           work days + travel days ≤ crew capacity per period
           optional zone locking
           statutory deadline: no decision variable exists past it
```

- Urgency weights: critical 3.0 · elevated 1.8 · normal 1.0. Default 4 monthly periods.
- **Travel is charged against the same crew-day budget as the work**, so a plan
  cannot look affordable by pretending crews teleport.
- **The deadline is a hard constraint, not a weight:** the solver cannot buy a
  better objective by running a compliance date late. Unmeetable deadlines are
  reported as `missed_deadlines`.
- Reports solver status (proven-OPTIMAL vs feasible), solve time, crew
  utilisation, risk covered, and `oversized` work packages that cannot fit one crew-period.
- **Who does the work:** one inspection crew per zone, based at the zone's depot
  (WES · Vadodara, NOR · Jaipur, EAS · Haldia, SOU · Koottanad, NE · Guwahati).
  Each selected segment is assigned to its zone's crew for a specific month.
- The solver stops once its plan is **proven within 1% of the best possible**
  (from the solver's own bound) and reports that gap rather than claiming optimality.
- Measured run (11 Oct 2026, 4 months × 20 crew-days, 120 candidates): **58 segments
  scheduled, proven within 0.25% of optimal, ~2 s solve**; every crew within budget
  once travel is counted (e.g. Eastern: 66 d work + 12.7 d travel = 78.7 of 80 d).

### 9.2 Work-order dispatch: `workorders.py`

```
maximise   Σ (risk × urgency_weight − travel_penalty × travel_days)
s.t.       each order to at most one technician
           work_days + travel_days ≤ technician capacity
           skills are hard constraints
           immediate work must be covered
```

- 7 skills: general, welding, coating, cathodic protection, composite repair,
  mechanical, operations. **Who does the work:** two crews per zone, based at the
  zone depot: *A: Coatings & mechanical* and *B: Welding & CP* (10 crews, 20
  crew-days each). Every work order is assigned to one named crew, e.g. NE-B, the
  North Eastern Welding & CP crew out of Guwahati.
- Measured run (11 Oct 2026): **proven optimal, 54 of 77 work orders assigned,
  71% of risk repaired, 0 urgent orders uncovered, under 1 s.**
- Urgency weights: immediate 3.0 · scheduled 1.8 · routine 1.0 · monitor 0.3.
- "Nearest qualified technician" **falls out of the optimiser** rather than being hard-coded.
- `diagnose_capacity()` reports the shortfall per (zone, skill) instead of a
  bare "INFEASIBLE", with an automatic retry when `require_immediate` makes the model infeasible.

**The best engineering story in this layer: orders split by trade.** The first
version emitted one work order per segment carrying *every* skill, so the
solver needed one technician holding all of them. On the real roster nobody
qualified, so most orders came back "blocked by skill gap": a staffing
conclusion produced entirely by a modelling mistake. Field work isn't
dispatched that way (a coatings crew and a CP crew are different trucks).

| | Before trade-split | After |
|---|---|---|
| Work orders | 39 | 81 |
| Blocked by skill gap | **27** | **0** |
| Urgent unassigned | 9 | **0** |
| Crew utilisation | 15–78% | **90–99%** |

---

## 10. Geography and the fleet map

### 10.1 Real Indian pipeline corridors: `routes.py`

| Zone | Corridors |
|---|---|
| Western | HVJ West Leg · Dahej–Vadodara (DVPL) · Mumbai–Pune–Solapur |
| Northern | Jamnagar–Loni LPG · HVJ East Leg · Panipat–Jammu |
| Eastern | Paradip–Haldia · Haldia–Barauni · Dhamra–Jharsuguda |
| Southern | Kochi–Mangalore (KKBMPL) · Chennai–Madurai · Visakhapatnam–Hyderabad |
| North Eastern | Numaligarh–Siliguri · Digboi–Numaligarh · Guwahati–Silchar |

- **15 corridors, 6,414 km in total.** Segments are placed *on* the line in
  milepost order: pick a corridor (weighted, so trunks carry more than
  laterals), pick a distance along it by length, interpolate, and add a ~2 km
  right-of-way offset.
- **Measured: segments sit a mean 2.28 km from their corridor**, down from
  ~180 km of Gaussian scatter around zone centroids in an earlier version.
- Coordinates use a **dedicated random stream**. Moving the fleet from the US
  to India changed only `latitude`, `longitude` and `region`, verified column
  by column; soil, class location, rates and the model were untouched.
- Travel (`geo.py`): haversine great-circle distance × 1.35 road factor at 65 km/h.

### 10.2 The map component (console)

- **Web Mercator** projection with fractional zoom and pan.
- **Satellite imagery (Esri World Imagery, keyless) by default**, with
  Geoapify styled basemaps (with a key) or OpenStreetMap as alternatives.
  Tiles are **relayed through the backend** (`/api/map/tile/{z}/{x}/{y}.png`),
  so API keys never reach the browser and the CSP stays `img-src 'self'`.
- Backend tile relay: z/x/y validated against the tile pyramid (zoom 3–10)
  before any URL is built; a bounded **LRU cache of 320 tiles**; a pooled HTTPS
  session cut uncached tile latency from **1,443 ms to 191 ms** behind the
  corporate TLS proxy.
- **Two-canvas rendering with zero per-segment DOM:** a base layer (tiles,
  corridors, 5,000 points) repaints only on data/size change, and a thin
  overlay handles hover and selection. Hit-testing uses a 24 px bucket grid.
  (The previous SVG version had ~7,700 nodes and lagged the whole dashboard.)
- **Offline vector fallback:** India and its neighbours from Natural Earth
  10 m, *India point-of-view* boundaries, simplified with Douglas–Peucker to
  4,439 points (61.6 KB) and embedded, so the map works with no network.

---

## 11. The AI layer

### 11.1 Retrieval (RAG): `rag.py`

**Hybrid retrieval over three views, fused by Reciprocal Rank Fusion (k = 60):**

1. Word-level TF-IDF
2. Character n-gram TF-IDF (`char_wb`, 4–5 grams), robust to word forms and typos
3. Dense embeddings (`nomic-embed-text` via Ollama)

- Knowledge base: **6 curated documents, 31 chunks**: corrosion mechanisms,
  external corrosion, cathodic protection, coatings, inspection methods, and
  standards & assessment.
- **Measured improvements:**
  - "How often should I inspect" scored **0.000** against a corpus that says
    "inspection interval" (TF-IDF has no stemming). Adding character n-grams
    raised recall from **14/17 to 17/17**.
  - Dense retrieval initially contributed *nothing*, because a final filter
    only admitted chunks a lexical view had already scored. A
    `DENSE_RELEVANCE = 0.45` clause lets dense *introduce* chunks, and
    paraphrase recall went from **1/8 to 6/8**. On jargon queries dense
    changed nothing (9/10 either way), which is why it is fused rather than swapped in.
- **A measured negative result:** retrieval relevance scores were tested as a
  topic gate and *cannot* serve as one. No threshold cleanly separates on-topic
  from off-topic queries.

### 11.2 Domain gate: keeps the assistant on pipeline integrity

- **Layer 1, embedding classifier** (`domain_gate.py`): compares the question
  with in-domain and out-of-domain anchor phrases and refuses clearly
  off-topic questions **before** any LLM call (margin −0.02 / +0.02).
- **Layer 2, keyword check** with an anaphora carve-out, so follow-ups like
  *"why that one?"* aren't refused. Short terms must match whole words, so
  `ut` doesn't match "about".
- Deliberately biased toward answering: wrongly refusing a real engineering
  question costs more than answering a borderline one. It is documented as a
  soft boundary, not a security control.

### 11.3 LLM providers: all free tier, no vendor SDKs

| Provider | Role |
|---|---|
| **Groq** (`openai/gpt-oss-120b`) | Fast text reasoning (free tier) |
| **OpenRouter** | Vision. **Free vision models are discovered at runtime** from the live `/models` catalogue, because the free roster changes constantly |
| **Ollama** (local) | Offline text (`llama3`), vision (`moondream`, 1.8B) and embeddings (`nomic-embed-text`) |
| **HuggingFace** | Inference fallback |
| **Mock** | Deterministic canned responses, so the UI and the whole test suite run with no keys and no network |

- Auto-selection chain: groq → huggingface → ollama → mock. An explicit
  choice is never silently overridden.
- Raw `httpx` HTTP calls with no vendor SDK, so switching provider is a config change.
- OpenRouter discovery excludes non-vision and non-chat models by purpose
  (music, TTS, whisper, guard, embed, rerank, image-gen, routers). *A music
  model would otherwise have ranked first: it was free, accepted images, and
  had the largest context window.*

### 11.4 Two-stage photo analysis: "local model sees, remote model thinks"

```
Photo ─► Stage 1: small vision model (local moondream or OpenRouter free model)
              "describe only what you see" (forbidden from guessing causes)
              │  → dedupe_observations()
              ▼
         Stage 2: strong text model (e.g. Groq gpt-oss-120b)
              reasons over observations + the segment's model prediction + RAG context
              ▼
   Four required sections: Visual observations · Consistency with the model
                           · Recommended actions · Limitations
```

- **Why split it:** the target laptop has no discrete GPU, so a big local vision
  model isn't viable. A small model can *see* and a large remote model can *reason*.
- **Guardrails (each added because it was needed):**
  - Estimating wall loss from a photo is **forbidden**: a single image cannot measure depth.
  - **Anti-escalation rule:** vague words like "hole" or "gap" must not be
    escalated into "through-wall breach". The strong model once turned
    moondream's "a large hole" into a depressurisation recommendation, which is
    hallucination amplification across a model boundary.
  - Text inside an image is treated as untrusted data, never as instructions (prompt injection).
- **Photogrammetry module** (`photogrammetry.py`): **lateral** extent (length,
  width, area) *is* measurable with a scale reference (ruler, scale card, coin,
  or the pipe's own recorded diameter, the last carrying +12% uncertainty).
  **Depth is never recoverable from one image.** Oblique angles are corrected
  by 1/cos θ and refused beyond 45°. Area uncertainty is double the length
  uncertainty. `b31g_readiness()` stops a length-only defect flowing into a
  strength calculation. *(Implemented and tested; not yet wired into the console.)*

### 11.5 Assistant behaviour

Answers are streamed token by token and cite the standard behind each claim.
Citations stream **ahead** of the answer through a NUL-delimited marker, so
sources appear before a slow local model has finished generating.

---

## 12. Standards actually implemented

| Standard | What it governs | Where |
|---|---|---|
| 49 CFR 192.903 | HCA determination, gas (incl. PIR) | `consequence.py` |
| 49 CFR 195.450 | HCA determination, hazardous liquid | `consequence.py` |
| 49 CFR 192.5 | Class location (population density) | `consequence.py` |
| 49 CFR 192.939 | Max reassessment interval, gas HCA: 84 months | `inspection.py` |
| 49 CFR 195.452(j)(3) | Max reassessment interval, liquid HCA: 60 months | `inspection.py` |
| 49 CFR 192.713 / 195.422 | Repair schedule & permanent repair | `repair.py` |
| ASME B31.4 / B31.8 | Pressure design, Barlow formula, design factors | `remaining_life.py` |
| ASME B31G (Modified) | Remaining strength of corroded pipe, Folias factor | `remaining_life.py` |
| API 570 | Remaining life from wall-loss rate | `remaining_life.py` |
| API 579-1 / API 1160 | Fitness-for-service, risk-management framing | design basis |
| NACE/AMPP SP0169, SP0502 | Cathodic protection, ECDA | knowledge base + inspection rules |
| NACE SP0775 | Corrosion-rate severity scale: low / moderate / high / severe | `corrosion_class.py` |

---

## 13. The application

### 13.1 Backend: FastAPI (25 `/api` routes + `/` landing + `/console` SPA)

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/login`, `/api/logout` | PBKDF2 auth, bearer token |
| GET | `/api/me` | Identity, role, zone |
| GET | `/api/segments` | Scored register, zone-scoped by role |
| GET | `/api/segments/{id}` | Detail + SHAP + consequence + remaining life |
| POST | `/api/segments/{id}/acknowledge` | Acknowledge an alert |
| GET | `/api/segments/{id}/inspection` | Ranked inspection plan |
| GET | `/api/segments/{id}/repair` | Ranked repair options |
| GET | `/api/segments/{id}/history`, POST `/api/history` | Back-cast rate series (bulk capped at 120 ids) |
| GET | `/api/alerts`, `/api/stats`, `/api/risk-matrix` | Fleet summaries, 5×5 grid |
| POST | `/api/schedule` | CP-SAT inspection schedule |
| POST | `/api/workorders/assign`, GET `/api/technicians` | CP-SAT dispatch, crew roster |
| GET | `/api/map/config`, `/api/map/tile/{z}/{x}/{y}.png`, `/api/map/routes` | Tile metadata (no key), relayed tiles, corridors |
| GET | `/api/knowledge/search` | RAG search |
| GET | `/api/assistant/status` | Provider & model status |
| POST | `/api/assistant/chat` | Streaming RAG answer + citations |
| POST | `/api/assistant/analyze-image` | Two-stage photo analysis |
| GET | `/api/export.csv` | At-risk export |
| GET | `/api/meta` | Which frontend build is live |

Other backend details: GZip compression (the `/api/segments` payload is about
1.6 MB of JSON and compresses ~10×), SQLAlchemy with SQLite by default and
PostgreSQL via `DATABASE_URL`, and interactive `/docs` disabled in production.

### 13.2 Frontend: React operator console

**Shell:** a top **command bar** (fleet status, critical count, scope, clock,
connection, always visible) plus a **left rail** grouped by how the work is
done:

| Group | Views |
|---|---|
| **Command** | Fleet Position (dashboard) · Zone Overview |
| **Operations** | Schedule · Dispatch |
| **Intelligence** | AI Assistant |

The rail lists only views that exist; a nav item that leads nowhere reads as broken.

**Dashboard (map-first, because a pipeline is a geographic object):**
1. **Fleet Position map** + **5×5 risk matrix** (click a cell to filter)
2. **Segment register:** a virtualised table of all 5,000 rows, 27 px rows,
   inline rate bars and 10-year sparklines
3. **Detail pane:** a split pane beside the register rather than an overlay,
   so comparing segments takes one click each

**Segment drawer tabs:** *Risk & drivers* (a 3D model of the segment, the
corrosion rate on the NACE SP0775 scale, likelihood × consequence with a
plain-language reason, SHAP tornado, remaining life, ERF) · *Inspection* ·
*Repair* (defect fix vs cause fix).

**The 3D segment model is built from the segment's own record.** Each visible
property maps to a field, so two segments look alike only when their records
are alike. Nothing is decoration, and the risk colour is deliberately *not*
painted on the pipe:

| What you see | Driven by |
|---|---|
| Outer finish: teal FBE epoxy, black coal-tar enamel, helical PE tape, bare steel | `coating_type` |
| Patches where the coating has failed | coating type × age (each coating has a working life), at least the measured metal loss |
| Rust and pits, dense or sparse | predicted corrosion rate + metal loss (cathodic protection slows it, stainless far more) |
| Chalky white calcareous film | `cathodic_protection` |
| Girth (4″ slender … 48″ stout) | `diameter_inches` |
| Cut end + wall gauge: wall left (grey), metal lost (brown), code minimum (red) | nominal, measured and minimum-required wall |
| Bore colour | `product_type` (gas, crude, refined, water) |
| Repair sleeves with weld beads, one per repair (max 4) | `historical_repair_count` |
| Soil stain on the underside | `soil_type` |
| Black body with yellow (gas) or blue stripes | HDPE material |

**How it is built:** hand-written **WebGL + GLSL**, no 3D library (the console's
CSP is `script-src 'self'`, and Three.js would add ~150 KB gzipped for a few
tubes). Tubes and rings are generated in code. One fragment shader produces
coating, steel, rust, pits and scale procedurally from **3D value noise**
(fbm, 4 rotated octaves), seeded by the segment ID so a segment always looks
the same. Thresholds are calibrated against the noise's measured distribution
(≈ normal(0.50, 0.115)), so "35% of the coating has failed" covers about 35%
of the surface. Relief comes from **bump mapping on screen-space derivatives**
(Mikkelsen's surface-gradient method). It draws only while on screen and only
when the view changes; it is orbitable by mouse, touch and keyboard, and falls
back to a 2D cross-section without WebGL.

**Performance:** the four non-landing views are lazy-loaded (code splitting),
so the markdown renderer, the largest dependency, isn't downloaded by users
who never open the assistant.

**Keyboard:** `/` focuses the filter; `Esc` unwinds one level at a time
(pane → matrix cell → filter → band).

**Fallback console:** a no-build vanilla-JS console (`frontend/`) is served
automatically if the React build is missing.

### 13.3 UI design language: control-room HMI, not a generic dashboard

The first version looked like every AI-generated dashboard. It was redesigned
around one question: *who reads this, and under what conditions?* The answer
is an integrity engineer who wants **density and precision, not polish**.

| Decision | Rationale |
|---|---|
| Petroleum-graphite background, oil-green accent; red/amber/green reserved for status | Colour always carries information, never decoration |
| 2 px corners + corner brackets | Corner ticks come from technical drawings; rounded cards read as a consumer app |
| Status lamps instead of pill badges; only *critical* pulses | On a physical panel, status is a light |
| Barlow Condensed labels + IBM Plex Mono numerals with tabular figures | Signage-style labels; decimal points align down a column |
| A sweep line instead of a spinner | Reads as an instrument taking a measurement |
| Inline proportional bars behind numbers; dotted-leader spec rows | See the distribution without reading digits; it's a spec sheet |
| All text ≥ 4.5:1 contrast in light **and** dark themes | A caption grey at 2.88:1 was found and fixed across 81 usages |
| `prefers-reduced-motion` really stops animation | It doesn't just shorten it |

### 13.4 Public landing page: a cinematic 3D scroll journey

Built with **React Three Fiber (Three.js)**: one continuous 3D world in which
**scroll position is the only state**.

- **8 chapters along one Catmull-Rom spline:** 01 Orbit · 02 The Network
  (15 real corridors over India) · 03 Digital Twin · 04 Sensor Intelligence ·
  05 Corrosion (inside the pipe) · 06 Prediction Engine · 07 Explainability
  (SHAP waterfall) · 08 Risk Intelligence (5×5 matrix).
- The camera follows a **glowing pulse** slightly ahead on the spline, and
  chapters **cross-fade through overlapping spans**, so it reads as travel
  rather than a slideshow.
- Post-processing: bloom + vignette. Smooth scrolling with Lenis.
- Built as a **separate self-contained bundle** (its own Vite config) so the
  console doesn't pay for three.js and the landing page doesn't pay for the
  console. `script-src 'self'` holds with no CDN.
- **Robustness:** WebGL is probed before mounting; the loader has four
  independent dismissal guards; without WebGL or JavaScript all the copy is
  still shown as plain content.
- The landing page's figures (R² 0.682, 89.8% coverage, risk-band counts) are
  measured ones from 21–25 Sep, shown with a "synthetic data" caveat.

---

## 14. Security

| Control | Implementation |
|---|---|
| Password storage | PBKDF2-HMAC-SHA256, **600,000 iterations**, per-user salt |
| Session tokens | 12 h absolute + 1 h idle expiry |
| Brute force | 5 failures per (user, IP) → 15-minute lockout |
| Timing attacks | `hmac.compare_digest`; dummy hash computed for unknown usernames (no user enumeration) |
| Authorisation | Server-side RBAC: inspector / supervisor / admin, on **every** route including the LLM endpoints (inspector → dispatch = 403; anonymous = 401) |
| Data scoping | Inspectors see only their own zone |
| CORS | Explicit allowlist (was `*`) |
| CSP | `default-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'` |
| XSS | Model output rendered through `react-markdown`, never as raw HTML |
| Uploads | Magic-byte + MIME validated, 8 MB cap with early abort, held in memory, never written to disk |
| Prompt injection | Text inside uploaded images treated as untrusted data |
| Secrets | API keys live server-side only (`.env`, gitignored); the tile relay keeps map keys off the browser |
| TLS | `truststore` uses the OS certificate store behind a corporate TLS proxy; **never** `verify=False` |
| Proxy headers | `X-Forwarded-For` trusted only behind a declared proxy |

Six real issues were found in a security review and fixed, each with a
regression test: a shared-salt SHA-256 hash, non-expiring tokens, no login
throttling, a non-constant-time password compare, user enumeration by timing,
and a wildcard CORS policy.

---

## 15. Technology stack

### 15.1 Languages

| Language | Where |
|---|---|
| **Python 3.11** | Backend, ML, optimisation, retrieval, data pipeline |
| **TypeScript** (strict) | Console and landing page |
| **SQL** via SQLAlchemy | Persistence (SQLite ↔ PostgreSQL) |
| GLSL / WebGL | 3D pipe visual in the segment drawer |

### 15.2 Backend, ML & data

| Technology | Version | Role |
|---|---|---|
| FastAPI | 0.141.1 | REST API, streaming responses |
| Uvicorn | 0.52.4 | ASGI server |
| Pydantic | 2.13.5 | Request validation |
| SQLAlchemy | 2.0.52 | ORM, SQLite / PostgreSQL (psycopg2) |
| pandas / NumPy | 3.0.5 / 2.4.6 | Data generation, cleaning, features |
| scikit-learn | 1.9.0 | Encoding, splits, metrics, TF-IDF retrieval |
| **XGBoost** | 3.2.0 | Corrosion-rate regression (production model) |
| **SHAP** | 0.51.0 | Exact tree attribution |
| **PyTorch** | 2.14.0 (CPU) | FT-Transformer baseline |
| **OR-Tools (CP-SAT)** | 9.15 | Scheduling and dispatch solvers |
| httpx / requests | 0.28.1 / 2.34.2 | LLM and tile HTTP (no vendor SDKs) |
| truststore | 0.10.4 | OS certificate store for TLS verification |
| matplotlib | 3.11.1 | SHAP summary plot |
| pytest | 9.1.1 | Test suite |

### 15.3 Frontend: console

| Technology | Version | Role |
|---|---|---|
| React | 19.3 | UI |
| TypeScript | 5.7 | Types (backend contract mirrored in `types.ts`) |
| Vite | 6 | Build and dev server |
| Tailwind CSS | 4 | Token-driven styling (`@theme`) |
| TanStack Query | 5 | Server state, caching, deduplication |
| TanStack Table + Virtual | 8 / 3 | Sortable register, 5,000-row virtualisation |
| Recharts | 2.15 | Charts |
| react-markdown + remark-gfm | 9 / 4 | Safe rendering of model output |
| lucide-react | 0.468 | Icons |
| Canvas 2D | native | Fleet map |
| WebGL | native | Procedural 3D pipe, hand-written |

### 15.4 Frontend: landing page

| Technology | Version | Role |
|---|---|---|
| Three.js | 0.186 | 3D engine |
| React Three Fiber / drei | 9.8 / 10.7 | React renderer for Three.js, helpers |
| @react-three/postprocessing | 3.1 | Bloom, vignette |
| Lenis | 1.3 | Smooth scrolling |
| GSAP, Framer Motion | 3.15 / 13 | Declared animation dependencies |

### 15.5 External services (all free tier or keyless)

| Service | Role | Key needed |
|---|---|---|
| Groq | Fast text LLM | Yes (free) |
| OpenRouter | Vision LLM, runtime free-model discovery | Yes (free) |
| Ollama | Local text, vision, embeddings | No |
| HuggingFace | Inference fallback | Yes (free) |
| Esri World Imagery | Satellite map tiles | No |
| Geoapify / OpenStreetMap | Styled / raster map tiles | Geoapify yes (free), OSM no |
| Natural Earth | Embedded vector basemap (public domain) | No |
| PHMSA | Real U.S. pipeline incident data (acquisition script) | No |

---

## 16. Testing and engineering quality

- **455 automated tests, all passing** (0 failing, 0 skipped), across 21
  test files. Full run on 11 Oct 2026.
- The suite passes with **no API keys, no Ollama and no internet** (mock
  provider + fakes). Tests that need Ollama skip themselves.
- Tests guard the design invariants, for example:
  `test_consequence_columns_are_not_model_features`,
  `test_indicators_are_recorded_before_imputation`,
  `test_the_cap_only_ever_shortens_the_interval`,
  `test_duplicates_leak_between_train_and_test_if_not_removed`.
- **Frontend check scripts** (Node), because nobody can "see" a canvas in a test:
  - `check-projection.mjs` asserts the map is north-up against real city positions
  - `check-orbit.mjs` proves the 3D camera basis never collapses at any angle
  - `check-journey.mjs` verifies all 8 landing scenes are in frame at their peak
  - `check-landing.mjs` verifies every CSS class has matching markup
  - `shoot-journey.mjs` takes visual screenshots

### 16.1 The recurring theme: the bugs that mattered all failed silently

These make strong slides for a technical mentor, because each one *looked like
working software*:

1. **The proven-optimal empty schedule.** CP-SAT returned OPTIMAL and scheduled
   **0 of 120** segments. The average work package (11.5 days) could not fit a
   5-day period, so the empty set really was optimal. Fixed with realistic
   capacity, `oversized` detection and explicit warnings. Utilisation went **18% → 85%**.
2. **Retrieval that silently returned nothing.** *inspect* ≠ *inspection* under
   TF-IDF. The assistant answered without citations and looked fine. Fixed
   with character n-grams + RRF (**14/17 → 17/17**).
3. **The vision model that answered `"irt."`** A 1,064-character prompt
   overwhelmed the 1.8B model. Shrinking it to 124 characters fixed that, but
   then it fell into a repetition loop (fixed with `repeat_penalty` + dedupe),
   and then the strong model escalated "a large hole" into a through-wall breach
   (fixed with the anti-escalation rule).
4. **Dense retrieval that contributed nothing.** A filter only admitted chunks
   lexical retrieval had already found (paraphrase recall **1/8 → 6/8** once fixed).
5. **The map drawn upside down.** The Albers projection's y increases northward
   and SVG's y increases downward. Nothing errored, and it still looked like a
   map. Now asserted against city positions.
6. **27 "skill gaps" that were a modelling bug** (§9.2).
7. **150-year-old pipes.** A reviewer noticed a 45-year-old segment with 105
   years of remaining life. The maths was right; the data was not. Wall
   thickness had been drawn at random (5–25 mm) regardless of diameter or
   pressure, giving 4″ pipe 18 mm walls and a fleet **median remaining life of
   420 years**, and today's wall ignored decades of corrosion. Walls are now
   designed per Barlow and standard pipe sizes, the measured wall subtracts
   each segment's corrosion history, and long projections show as "50+ years".
   The median service life of segments needing action is now **53 years**.
8. **Two crews called NOR.** Crew codes were the first three letters of the zone,
   so *Northern* and *North Eastern* were both `NOR`. The solver itself was right
   (it tracks crews by index), but every report keyed on the code merged them:
   both crews showed **122 of 80 crew-days**, an impossible overload. Zone codes
   are now unique (NOR, NE), a duplicate fails loudly, and crew load now counts
   travel as well as work, as the solver does.
9. **A network that looked blocked and wasn't.** A TLS-intercepting proxy made
   every HTTPS host look unreachable from Python. Fixed with the OS trust
   store, never by disabling verification.
10. **A 9.29 mpy pipe labelled NORMAL.** The detail panel showed the *risk*
    band right beside the corrosion *rate*, so a reviewer read a fast rate as
    "normal" and a slow one as "critical". Both numbers were right; the label
    answered a different question. The rate now carries its own NACE SP0775
    class (9.29 mpy = **High**), overall risk sits in its own section with a
    one-sentence reason, and the 3D pipe stopped being tinted green/amber/red
    by risk band and is now drawn from the segment's record.

---

## 17. Verified metrics (summary table)

| Metric | Value |
|---|---|
| Pipeline segments | 5,000 |
| Columns per segment | 43 (model uses 20 features) |
| Operating zones | 5 (Western, Northern, Eastern, Southern, North Eastern) |
| Real corridors | 15, totalling 6,414 km |
| Mean distance of segment to its corridor | 2.28 km |
| Segments per zone | ~1,000 each (983–1,019) |
| Segments in an HCA | 2,616 (52.3%) |
| Risk bands | normal 4,260 · elevated 619 · critical 121 |
| Risk matrix | low 3,897 · moderate 875 · high 165 · severe 63 |
| XGBoost test R² / MAE (deployed model) | **0.673 / 0.485 mpy** |
| Benchmark: XGBoost vs FT-Transformer R² | 0.682 vs 0.637 (XGBoost ~580× faster to train) |
| Fastest-corroding segment's risk rank | #1,029 of 5,000 (consequence decides) |
| Service life (age + remaining life), segments needing action within 50 yr | median **53 years** (p10 28, p90 77) |
| Pipe walls | designed per Barlow + standard API 5L sizes; D/t 21–96 |
| Conformal coverage at 90% target | 89.8% |
| Inspection methods / repair actions | 9 / 8 |
| Standards implemented | 12 rows (49 CFR 192/195, ASME B31.4/B31.8/B31G, API 570/579/1160, NACE SP0169/SP0502/SP0775) |
| Corrosion-rate classes (NACE SP0775) | low 3,363 · moderate 1,545 · high 81 · severe 11 |
| Rate and risk disagree | 46 of 92 high/severe-rate segments are normal risk; 107 of 121 critical-risk segments have a low/moderate rate |
| Knowledge base | 6 documents, 31 chunks |
| Dispatch: blocked orders | 27 → 0 after trade-splitting |
| Crew utilisation | 90–99% |
| API routes | 25 (+ landing and console) |
| Automated tests | **455 passing**, 0 failing, 0 skipped · 21 files |
| Python code | ~10,000 lines across 42 modules (+ ~4,500 lines of tests) |
| Console TypeScript/CSS | ~6,600 lines across 16 files |
| Landing page TypeScript | ~2,350 lines across 17 files |

*Fleet, risk and deployed-model figures were measured on the running system
on 9 October 2026, after the realistic-wall fix. The model benchmark, conformal coverage, corridor distance,
scheduler and dispatch figures were measured between 21 and 25 September 2026.
Code sizes were counted on 8 October 2026.*

---

## 18. Advantages / differentiators

- **Decision-complete:** prediction → explanation → consequence → remaining
  life → method → repair → schedule → dispatch. Most projects stop at prediction.
- **Auditable by construction:** every regulator-facing decision is
  deterministic and unit-tested; the LLM never decides.
- **Explainable per segment**, not just globally (exact SHAP).
- **Grounded in real regulation and engineering standards**, with judgement
  thresholds labelled as judgement.
- **Respects real constraints:** crew-days, zones, skills, travel and statutory
  deadlines, so the plan can be executed.
- **Honest about failure:** the scheduler says when work can't fit, retrieval
  says when it found nothing, and dispatch separates a staffing gap from a scheduling choice.
- **Tested against realistic, messy data**, not pristine columns.
- **Costs nothing to run:** free-tier and local models, with a mock mode that
  needs no keys at all.
- **Secure by default:** RBAC on every route, keys never in the browser, strict CSP.
- **Domain-appropriate interface:** built for an operator scanning a register,
  not for a screenshot.

---

## 19. Honest limitations (put these on a slide)

1. **The data is synthetic.** It is realistic in structure and failure modes,
   but R² ≈ 0.68 measures fit to a generator, not to a real operator's fleet.
   The pipeline is validated end to end; the *model* is not validated on field data.
2. **Consequence attributes are synthetic**, and 52.3% of segments in an HCA is
   at the top of the plausible range.
3. **Corridors are real; segment placement on them is synthetic.**
4. **Conformal intervals and photogrammetry are implemented and measured but
   not yet shown in the console.**
5. **No per-anomaly assessment yet:** Modified B31G is implemented but needs an ILI tally.
6. **Travel is straight-line × 1.35, not routed.** Real crews chain jobs, which
   is a vehicle-routing problem that needs a road network.
7. **Vision output is advisory only.** It is never used in calculations, and its
   accuracy on real corrosion photographs is unvalidated.
8. **The domain gate is a soft boundary**, not a security control.
9. **Demo-grade identity:** seeded accounts and in-memory tokens, no SSO/MFA.
10. **Single-process deployment:** SQLite by default, no containers, CI or migrations.

---

## 20. Future work (in priority order)

1. **Ingest a real ILI tally:** unlocks per-anomaly B31G, dig sheets, and
   corrosion growth from repeat runs. This is the highest-value change by far.
2. **Real HCA polygons** from public population and drinking-water GIS layers.
3. **Show conformal prediction intervals in the console** and drive
   conservative planning from the upper bound.
4. **Route dispatch on a real road network**, turning per-job round trips into a VRP.
5. **Wire photogrammetry into the photo workflow** (lateral defect sizing with a scale reference).
6. **Production hardening:** SSO/MFA, containerisation, CI, database migrations.
7. **Unify the visual identity** of the landing page and the console (§23).

---

## 21. Glossary (for a backup slide or speaker notes)

| Term | Meaning |
|---|---|
| **mpy** | Mils per year (1 mil = 0.001 inch), the corrosion-rate unit |
| **HCA** | High Consequence Area: a regulatory zone where failure would cause severe harm |
| **PIR** | Potential Impact Radius of an ignited gas release (`0.69·√(p·d²)`) |
| **Class location** | US population-density classification (1 = rural … 4 = dense) |
| **CP** | Cathodic protection: a current that suppresses external corrosion |
| **FBE** | Fusion-bonded epoxy, a high-quality pipe coating |
| **ILI / MFL / UT** | In-line inspection ("smart pig"), magnetic flux leakage, ultrasonic testing |
| **CIPS / DCVG / ECDA** | Above-ground CP and coating surveys, direct assessment |
| **SMYS** | Specified minimum yield strength of the pipe steel |
| **ERF** | Estimated Repair Factor = operating ÷ safe pressure (≥ 1 → repair) |
| **Barlow / B31G** | Pressure-design and corroded-pipe strength formulas |
| **SHAP** | Shapley additive explanations: per-feature contributions to one prediction |
| **Conformal prediction** | Distribution-free method for calibrated prediction intervals |
| **CP-SAT** | Google OR-Tools constraint-programming solver |
| **RAG / RRF** | Retrieval-augmented generation / Reciprocal Rank Fusion |
| **MNAR** | Missing Not At Random |
| **RBAC** | Role-based access control |

---

## 22. Suggested slide outline (18 slides)

| # | Slide | Key message | Source | Visual |
|---|---|---|---|---|
| 1 | **Title**: CORVEX, *Predict. Protect. Prevent.* | AI-powered pipeline integrity & corrosion intelligence | §1 | Dark hero, pipeline/India map motif |
| 2 | **The problem** | Thousands of segments, a handful of crews; which do we inspect, how, when? | §2 | Big question + 3 pain points |
| 3 | **What Corvex does** | Four questions answered in order | §3 | 4-step horizontal flow |
| 4 | **The core principle** | AI explains. AI never decides. | §4 | Statement slide + decision table |
| 5 | **Architecture** | Data → ML → deterministic engines → API → console / assistant | §5 | Layered block diagram |
| 6 | **Data: realistic by design** | Synthetic physics + deliberate MNAR degradation + ordered cleaning | §6 | Defects table + cleaning pipeline arrow |
| 7 | **Prediction & explainability** | XGBoost R² 0.673 / MAE 0.485 mpy; exact SHAP tornado | §7.1, §7.3 | Metric tiles + tornado sketch |
| 8 | **Model choice, measured** | XGBoost beat FT-Transformer (0.682 vs 0.637) and trained 580× faster; conformal 89.8% @ 90% | §7.2, §7.4 | Comparison table / bar chart |
| 9 | **From rate to real risk** | Likelihood × consequence under 49 CFR 192/195; the fastest-corroding pipe ranks only #1,029 | §8.1–8.2 | Formula + two-segment comparison |
| 10 | **5×5 risk matrix** | Canonical grid; not quintiles; fleet distribution | §8.3 | Heat-map grid with counts |
| 11 | **Engineering engines** | Remaining life from the measured wall (SEG-00660: 22.6% lost → 5.5 yr), 9 inspection methods, defect-vs-cause repair | §8.4–8.6 | Three columns |
| 12 | **Optimisation with CP-SAT** | Travel in the same budget; deadlines are hard; trade-split 27 → 0 blocked | §9 | Before/after table |
| 13 | **Geography** | 15 real Indian corridors, 6,414 km; satellite map, canvas rendering | §10 | Corridor map / zone table |
| 14 | **AI assistant** | Hybrid RAG + domain gate + two-stage vision ("local sees, remote thinks") with guardrails | §11 | Pipeline diagram |
| 15 | **Product & UX** | Control-room HMI console + 8-chapter 3D landing journey | §13 | Screenshots placeholders |
| 16 | **Security & quality** | RBAC, PBKDF2-600k, CSP, key relay; 455 passing tests; silent-failure stories | §14, §16 | Two columns |
| 17 | **Tech stack** | Python/FastAPI/XGBoost/SHAP/OR-Tools · React/TS/Vite/Tailwind/Three.js | §15 | Logo-style grid by layer |
| 18 | **Limitations & next steps** | Synthetic data; real ILI tally is the #1 next step | §19, §20 | Side-by-side lists |

Optional backup slides: glossary (§21), standards table (§12), API routes
(§13.1), metrics summary (§17), silent-failure stories in depth (§16.1).

---

## 23. Visual design guidance for the deck

**Logo.** Use the Corvex logo on the title slide and as a small mark on the
others. Files are in the project's `brand/` folder:

| File | Use |
|---|---|
| `brand/corvex-logo-transparent.png` | Full logo (emblem + wordmark) with a transparent background, for title and closing slides on dark backgrounds |
| `brand/corvex-logo-original.png` | Original artwork on its own dark navy background, 1536 × 1024 |
| `brand/corvex-mark-512.webp` | Emblem only (the "C" with the refinery and pipeline), for slide corners |
| `brand/corvex-logo.webp` | Full logo on its own black background, 1040 px wide |

The logo itself is brushed silver and glowing amber-gold on near-black, with a refinery and pipeline set inside the "C".

**Colours.** Match the product, a **black and glossy crimson** control-room look:

| Token | Hex | Use |
|---|---|---|
| Background | `#0A0A0B` | Slide background (near-black) |
| Panel | `#121214` | Cards / boxes |
| Line | `#2A2A30` | Dividers, hairlines |
| Ink | `#F5F5F6` | Primary text |
| Muted | `#A9A9B1` | Secondary text |
| **Accent (crimson)** | `#F23A49`, deep `#C41526` | Highlights, key numbers, buttons (glossy: lighter top half, darker bottom) |
| Amber | `#D99A32` | Warnings / "elevated" |
| Critical | `#FF6A4D` | "Critical" / "severe" only (kept distinct from the crimson brand red) |
| Normal | `#7EA64A` | "Normal" / "low" only |

- **Fonts:** *Barlow Condensed* (uppercase labels and headings), *IBM Plex Sans*
  (body), *IBM Plex Mono* (numbers, with tabular figures).
- **Shapes:** near-square 2 px corners, thin hairlines, corner-bracket accents
  in place of rounded cards.
- Use red/amber/green **only for risk meaning**, never as decoration.
- Big measured numbers (R² 0.673, 89.8%, 27 → 0, 6,414 km, #1,029, 53-yr service life) work well as stat tiles.
- Note: the public landing page uses a cyan/blue palette (`#00D4FF`, `#3A8DFF`
  on `#05070A`). The console's black and crimson above is the product UI, and
  the logo's amber-gold works as a secondary highlight beside it.

---

## 24. Live demo script (if presenting live)

```powershell
cd C:\Users\T9990\Desktop\integrityai_v2\integrityai
.\run.ps1                       # starts the server on http://localhost:8010
```

- Landing page: `http://localhost:8010/` · Console: `http://localhost:8010/console`
- Demo accounts:

| User | Password | Sees |
|---|---|---|
| `inspector1` (Raj Kumar) | `inspect123` | Western zone only |
| `supervisor1` (Harshan) | `supervise123` | Whole fleet + Schedule, Dispatch, Zone Overview |
| `admin` | `admin123` | Everything |

**Suggested demo flow:**
1. Scroll the landing page through its 8 chapters.
2. Sign in as `supervisor1` → Fleet Position: satellite map + risk matrix +
   register. Point out a low-mpy segment near the top with an amber **HCA** tag
   (consequence modelling at work).
3. Open a segment → *Risk & drivers* (SHAP tornado, remaining life, ERF, 3D
   pipe) → *Inspection* (method + statutory cap) → *Repair* (defect vs cause).
4. **Schedule** → run the optimiser (OPTIMAL, utilisation, travel included).
5. **Dispatch** → build work orders and assign to the nearest qualified crew.
6. **AI Assistant** → ask *"Why is this segment high risk?"* and show the
   citations; ask an off-topic question to show the domain gate refusing it.
7. Sign in as `inspector1` to show zone-scoped access (RBAC).
