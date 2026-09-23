# IntegrityAI — Pipeline Corrosion Risk Assessment

Predicts external corrosion rate for pipeline segments, explains *why* via
SHAP, recommends which inspection technique each one needs, and optimises the
inspection schedule against crew capacity.

> **Just want to run it and see the output?** → **[RUN.md](RUN.md)** has the
> copy-paste terminal commands for every feature, with what to expect from each.

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

## 3a. The dataset is deliberately hard

The generator produces physics. Real pipeline data is physics plus fifty years
of people writing things down, and the second part is most of the work. A
model scoring R^2 0.72 on pristine columns has not been tested against what it
will actually meet.

So `src/data/data_quality.py` degrades the clean output on purpose:

| Defect | Rate | Why it is realistic |
|---|---|---|
| **Missing records** | 3,852 cells | A 1974 line whose soil survey was never digitised |
| **Measurement error** | 2-25% by field | UT repeatability; soil resistivity varies seasonally |
| **Unit confusion** | 75 rows | Wall thickness entered in inches into a millimetre column |
| **Decimal slips** | 20 rows | 850 psi recorded as 85 or 8500 |
| **Categorical drift** | 922 rows | "FBE", "fbe", "Fusion Bonded Epoxy", " FBE " |
| **Duplicates** | 60 rows | The same segment entered twice after a merger |
| **Label noise** | sigma 12% | The rate comes from two ILI runs, each with tool tolerance |

**Missingness is MNAR, not random.** Records are worse for OLD assets and for
assets not inspected recently — exactly the segments most likely to be
corroding. That is the hard case: mean-imputing it tells the model an
unsurveyed 1974 line is average, which is false in the dangerous direction.
Uniform random missingness would have been easier and would have taught the
pipeline nothing.

`src/data/cleaning.py` answers it, in an order that matters:

```
deduplicate  ->  canonicalise  ->  repair units  ->  flag implausible
             ->  missing flags  ->  impute
```

Flags are recorded **before** imputation. Impute first and every indicator is
zero, the column still exists, and the information is gone — silently.
`test_indicators_are_recorded_before_imputation` guards that.

Measured on the current dataset:

```
duplicates removed  : 60 / 60
unit errors repaired: 68 / 75      (7 were blanked by missingness first)
categorical variants: 17 -> 4 coatings, 12 -> 4 soils
implausible blanked : 11
imputed cells       : 3,863
```

**What it costs, honestly:**

| | R^2 | MAE |
|---|---|---|
| clean physics (unattainable ceiling) | 0.722 | 0.756 |
| degraded, naive fill | 0.515 | 1.622 |
| degraded, **full cleaning pipeline** | **0.541** | 1.735 |

Realistic data quality costs about **0.18 R^2** and cleaning recovers only
part of it. That is the real shape of the problem — no preprocessing recovers
information that was never recorded, and the label noise alone puts a ceiling
on what any model can score.

**A finding worth keeping.** The first version of the cleaning benefit test
compared each pipeline on its own train/test split, and the naive pipeline
came out *ahead*. The reason is that it keeps the duplicates, so a duplicated
segment can land in train and test at once and the model scores partly on rows
it memorised. The test now evaluates both against the same never-degraded
holdout, which is the only comparison that answers the question.
`test_duplicates_leak_between_train_and_test_if_not_removed` pins it.

**What is still not fixable, and is said out loud:** a pressure recorded as 85
psi when it should be 850 is indistinguishable from a genuine low-pressure
line without a second source. The high-side version is catchable because it
exceeds what the pipe could hold. The cleaner catches roughly half the decimal
errors and reports that rather than implying the data is now correct.

## 4. Run tests

```bash
python -m pytest tests/ -v
```

375 tests total:

| File | Tests | Covers |
|---|---|---|
| `test_pipeline.py` | 5 | data generation, preprocessing, training — including the core physical relationship the synthetic labels encode (no CP → higher mean corrosion rate) |
| `test_database.py` | 5 | SQLite/Postgres layer, acknowledgement round-trip |
| `test_backend_auth.py` | 10 | authentication and role-based access control |
| `test_assistant.py` | 44 | the domain restriction in both directions, region scoping applied to assistant grounding, upload validation, and the two-stage vision pipeline's guard rails |
| `test_integrity.py` | 38 | inspection method selection (§6), OR-Tools scheduling (§7), RAG retrieval (§8) |
| `test_consequence.py` | 27 | PIR formula, the two HCA regimes, consequence scoring, the risk product — and that consequence never leaks into the model's features (§5a) |
| `test_remaining_life.py` | 25 | unit conversion, Barlow round-trip, B31.8 design factors, Folias two-branch, Modified B31G, remaining life and ERF verdicts (§5b) |
| `test_risk_integration.py` | 16 | statutory caps, remaining-life-driven urgency, deadlines as hard CP-SAT constraints, compliance reporting (§5c) |
| `test_security.py` | 25 | password hashing, user enumeration, login throttling, token expiry, CORS, security headers, upload sniffing (§12) |
| `test_data_quality.py` | 25 | realistic degradation and the cleaning that answers it, including a demonstration that duplicates leak between train and test (§3a) |
| `test_openrouter.py` | 40 | free-tier and vision filtering on the OpenRouter catalogue, offline against stubbed payloads |
| `test_provider_contract.py` | 31 | the whole documented failure space of an OpenAI-compatible provider, offline — including a counterfactual proving the old parser fails it |
| `test_limitations_fixed.py` | 25 | the corrosion-rate ceiling, soil-factor saturation, and photogrammetric measurement with uncertainty |
| `test_rag_dense.py` | 12 | the dense index, the measured retrieval win, and graceful degradation (skips without Ollama) |
| `test_maintenance.py` | 37 | haversine/travel maths, repair method selection, trade splitting, proximity assignment (§5d, §5e) |

Several are regression tests for bugs documented below, each of which failed
*silently* in a way that looked like working software: the proven-optimal empty
schedule, retrieval returning nothing on a word-form mismatch, and the vision
model emitting `"irt."` when handed too long a prompt.

**None of these call a real LLM.** They pass with no Ollama daemon, no API key,
and no internet. That's possible because the parts that must be trustworthy —
the domain gate, the inspection rules, the optimiser — are all deterministic
code rather than prompts.

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

**What's still demo-grade, on purpose:** there is no SSO/MFA and the token
store is in memory, so sessions end on restart. A real deployment needs a
proper identity provider rather than a hand-rolled token store.

**What is no longer demo-grade:** password hashing, login throttling, token
expiry, CORS and response headers were all hardened — see
[§12 Security](#12-security). The previous version used SHA-256 with one
shared salt, compared hashes with `!=`, never expired a token and allowed any
CORS origin.

Chart.js is vendored locally in `frontend/vendor/` rather than loaded from
a CDN, specifically because a blocked CDN domain would silently leave the
Fleet Overview histogram blank — one less thing that can fail on a
restrictive network.

### Two frontends, and why both exist

The server picks whichever is present, preferring React:

```
web/dist/     React + TypeScript + Vite + Tailwind v4  (needs Node; run npm run build)
frontend/     vanilla ES modules, no build step        (needs nothing)
```

The vanilla console is a genuine fallback, not dead code: it needs no Node, no
npm and no build step, so the app still runs on a machine where installing the
toolchain isn't an option — the same defensive reasoning as vendoring Chart.js
locally. Delete `web/dist` and the server reverts to it with no code change.
`GET /api/meta` reports which one is live, which is useful when a React change
isn't showing up because the build is stale.

**Building the React console:**

```bash
cd web
npm install
npm run build          # emits web/dist, served automatically at :8010
npm run dev            # or: hot-reload dev server on :5173, proxying /api to :8010
```

Stack: React 18, TypeScript (strict), Vite 6, Tailwind v4, TanStack Query,
TanStack Table + Virtual, Recharts, lucide-react.

**What the rebuild added over the original single-file console:** all 5000
segments are now reachable — the old table rendered only the top 150 with no
search or pagination — via a virtualised table that keeps only visible rows in
the DOM. Plus sortable columns, live search, a segment drawer with a dedicated
inspection-plan tab, a light/dark toggle, keyboard-accessible rows, and
responsive layout down to mobile.

## 5a. Risk = likelihood x consequence

Until this was added the project scored **likelihood only** — how fast a
segment is corroding. That is half of risk, and it cannot prioritise work: a
segment corroding at 14 mpy under farmland is not more urgent than one
corroding at 3 mpy under a school and across a drinking-water source.

It is also not merely an academic point. It is the organising principle of US
pipeline regulation — 49 CFR 192.903 / 195.450 define High Consequence Areas,
and 192.907 / 195.452 require operators to prioritise assessments inside them.

`src/integrity/consequence.py` scores consequence 0-100 from population
exposure (class location, 49 CFR 192.5), drinking water, ecological
sensitivity, navigable waterways, product hazard and release volume. Risk is
then `likelihood_percentile x consequence`, with a multiplier for HCA status.

**What this changes in practice.** The top segment in the current fleet is
`SEG-04574`, corroding at only **3.20 mpy** — merely "elevated" on likelihood,
and buried in the middle of the old rate-ranked register. Its consequence
score is **87.0** (high population area + drinking water source + sensitive
ecological area), which puts it **first out of 5,000**.

Current fleet split:

| | critical | elevated | normal |
|---|---|---|---|
| by risk (likelihood x consequence) | 103 | 631 | 4,266 |
| by likelihood alone (old ranking) | 501 | 1,000 | 3,499 |

2,637 of 5,000 segments (52.7%) fall in an HCA. That is at the top of the
plausible range and reflects the synthetic consequence distribution, not a
measured one — the class-location weights in `consequence.py` are the knob.

Two implementation notes that matter:

- **Consequence attributes are deliberately NOT model features.** If where the
  pipe is became a predictor of how fast it corrodes, the two halves of the
  risk product would stop being independent and the whole thing would be
  circular. `test_consequence_columns_are_not_model_features` enforces this.
- **Likelihood is a percentile, not raw mpy.** Multiplying a 0-100 consequence
  by a raw rate gives a number in no interpretable unit, and the rate
  distribution has a long unphysical tail (see Known issue, below) that would
  compress every real segment into the bottom few percent.

Real HCA determination is a GIS operation against population and
drinking-water layers. This project has no geometry, so the attributes are
synthetic columns — swapping in real HCA polygons replaces one function
(`consequence_inputs_from_row`) and nothing else.

## 5b. Remaining life and fitness-for-service

Nobody acts on a corrosion rate. They act on a date.

`src/integrity/remaining_life.py` converts the predicted rate into the
quantity an integrity engineer actually schedules against:

```
t_min          = P·D / (2·S·F·E·T)          ASME B31.8 / B31.4 (Barlow)
remaining_life = (t_actual − t_min) / rate  API 570
ERF            = operating pressure / safe pressure
```

For `SEG-04574`: grade X70, 14.73 mm wall against a 14.94 mm minimum, **ERF
1.01**, verdict **repair_now** — the operating pressure has already passed
what the present wall safely supports.

Also implemented: **ASME B31G / Modified B31G** remaining strength of corroded
pipe, including the Folias bulging factor with its two-branch definition (the
quadratic form goes negative past z = 50, so applying it beyond that is a
domain error rather than a conservative answer). That function is tested but
**not yet reachable from the UI**, because it needs per-anomaly defect depth
and length from an ILI tally, which this project does not yet ingest. It is
there so adding an anomaly table is a data change, not a maths change.

**Units are the hazard here.** The dataset mixes millimetres (wall), inches
(diameter), psi (pressure) and mils per year (rate). A wrong conversion does
not raise — it produces a confident number off by a factor of 25.4. Every
function works internally in inches and psi, conversion happens once at the
boundary, and parameter names carry their unit.

`HDPE` is refused rather than given a number: it is not a yield-strength-
governed material under B31.8 and does not corrode electrochemically.

## 5c. Statutory deadlines as hard constraints

HCA status is not just a higher score — it puts the segment on a different
legal clock. The inspection planner now applies a cap **last, and only ever
downward**:

- **84 months** (7 years) for gas transmission — 49 CFR 192.939
- **60 months** (5 years) for hazardous liquid — 49 CFR 195.452(j)(3)

A risk-based interval shorter than the cap governs; the cap never relaxes it.
`test_the_cap_only_ever_shortens_the_interval` exists because an engine that
stretched a 6-month interval out to 60 "because the law permits it" would be
actively unsafe.

In the **scheduler**, a deadline is a hard constraint rather than a weight —
no CP-SAT variable exists past it, so the solver cannot buy a better objective
by running a compliance date late. Segments whose deadline cannot be met are
reported as `missed_deadlines` with an explicit compliance warning, because
otherwise they simply fail to appear in the schedule and nothing says why.

The scheduler objective is now risk, not corrosion rate, and the candidate
pool is truncated by risk — truncating by rate would drop exactly the segments
consequence modelling exists to surface.

## 5d. Repair and mitigation selection

Inspection tells you what is wrong. `src/integrity/repair.py` decides what to
do about it — a different question with a different answer set.

| Code | Action | Category |
|---|---|---|
| `DERATE` | Interim pressure reduction | operational |
| `GRIND` | Grind out and blend shallow loss | reinforcement |
| `SLV-A` | Composite sleeve (Type A) | reinforcement |
| `SLV-B` | Welded steel sleeve (Type B) | reinforcement |
| `CUTOUT` | Cut out and replace the joint | replacement |
| `CP-UP` | Cathodic protection upgrade | mitigation |
| `RECOAT` | Excavate, blast and recoat | mitigation |

Deterministic, for the same reason as inspection method selection: 49 CFR
192.713 / 195.422 constrain which repairs are permissible for which defect.

**The design point is the reinforcement/mitigation split.** The commonest
mistake in a corrosion repair plan is treating the symptom. A composite sleeve
over wall loss on a line with a failed rectifier is a patch on a pipe that
will keep corroding either side of it. So every plan separates fixing the
**defect** from fixing the **cause**, and emits both where both apply.

Selection is driven by ERF and remaining life (how urgent, and whether
pressure containment is needed at all), leak risk (a Type A sleeve cannot
contain pressure, so deep loss gets Type B), repair history (four previous
repairs on one joint is a replacement case), diameter (below 4 in, sleeve
hardware is impractical), and HCA status, which compresses the repair window
by 40%.

## 5e. Work orders and proximity dispatch

`src/integrity/workorders.py` answers the next question: given repairs that
need doing, **who goes**, and is that the cheapest competent person to send?

**Why travel has to be in the objective.** Without it every certified
technician looks identical to the solver, and it will send someone 900 km past
a nearer colleague because the assignment is arbitrary. Travel is also not a
rounding error: Houston to Midland is a **3.6 crew-day round trip** before any
work starts, which is longer than most repairs in the catalogue. So travel is
charged against the same crew-day budget as the work, and "nearest competent"
falls out of the optimiser rather than being hard-coded.

This needed geography, which the project did not have — `src/integrity/geo.py`
adds coordinates scattered around real basin centroids (Permian, Marcellus,
Gulf Coast ship channel), haversine distance, a road factor and travel time.

**A bug worth recording.** The first version emitted one work order per
segment carrying every skill the plan needed, and the assignment model then
demanded one technician holding all of them. On the real roster that is
nobody, so **27 of 39 orders came back "blocked by skill gap"** — a staffing
conclusion produced entirely by a modelling mistake. Field work is not
dispatched that way: a coatings crew and a CP crew are different trucks. Orders
are now split by trade, and actions sharing a trade stay bundled so the same
crew is not sent to the same place twice.

```
                    before split      after split
work orders              39                81
skill-gap blocked        27                 0
urgent unassigned         9                 0
technician utilisation  15-78%           90-99%
```

Current run — 40 segments, 81 orders, 10 technicians, 20 crew-days each:

```
status            OPTIMAL (proven)          solve  232 ms
assigned          48 / 81                   risk covered  59.6%
work / travel     117.5 d / 71.6 d          travel share  37.9%
distance          18,625 km                 skill gaps    0
```

The console warns at 37.9% travel share, which is the warning doing its job —
at that ratio a nearer depot or regional batching is worth considering.

**Three things this model is honest about:**

- Travel is a **round trip from a home depot per job, not a route**. Real crews
  chain jobs, and chaining is a vehicle routing problem needing a road network
  this project does not have. Per-job round trips overstate travel for
  clustered work — deliberately, because the opposite error makes distant work
  look free.
- Distances are straight-line inflated by a road factor, not routed.
- Skills are **hard constraints**. There is no partial credit for nearly
  holding a certificate, so an unqualified-but-close technician is not a
  variable in the model at all — and a job nobody is certified for is reported
  as a staffing gap, never as a scheduling decision.

The **Dispatch** tab (supervisor/admin) runs it, with a work-order board per
technician and a crew-load view where each bar is split into work and travel —
because travel is capacity that produces nothing, and seeing the split is the
point.

## 6. Inspection method recommendation

`GET /api/segments/{id}/inspection` answers *which* inspection technique a
segment needs, not just that it needs one — CIPS, DCVG, ILI (MFL or UT tool),
ECDA, UT thickness readings, CUI inspection, or excavation — each with the
reasoning that selected it and the standard it maps to.

**This is deterministic rule-based code, not an LLM call, and that is
deliberate.** Choosing an inspection method is a decision an operator has to
justify to a regulator. It must be auditable and identical every time for
identical inputs. A model that picks differently on Tuesday than on Monday is
unusable for that purpose. So the decision lives in
`src/integrity/inspection.py` where you can read and test it; the LLM's job is
to *explain* it, and the system prompt explicitly forbids substituting its own
methods.

The logic follows the structure of real practice — NACE/AMPP SP0502 (ECDA),
SP0169 (CP criteria), API 570, API 579-1, API 1160. Some examples of what it
encodes:

- Absent CP → CIPS, because confirming it is cheap and changes the whole plan
- Polyethylene tape coating → DCVG **plus an explicit shielding warning**, since
  disbonded tape blocks CP current and a passing potential survey does not
  prove protection
- 4-inch line at critical risk → ECDA, *not* ILI, because it can't take a tool
- 24-inch line at critical risk → ILI, with a caveat that piggability is
  inferred from diameter alone
- Repeat repairs → excavation and direct examination

Thresholds are engineering-judgement defaults collected at the top of the file
so an operator can tune them. Where a value is ours rather than a standard's,
it says so.

## 7. Inspection scheduling (OR-Tools CP-SAT)

`POST /api/schedule` decides which segments to inspect, in which period, with
which crew — maximising risk covered subject to crew capacity and region
constraints. Supervisor/admin only.

Picking the top-N by predicted rate, which the console did before, ignores
capacity entirely: it will hand a crew a week of work in a period with three
days available, and cannot express "an inspector only works their own region."

**Why CP-SAT and not the routing solver:** OR-Tools' routing library minimises
travel distance between geographic points. This dataset has region labels but
no coordinates, so there is no distance matrix and a VRP would be fabricating
geography that doesn't exist. What this actually is — multi-period selection
and assignment under a capacity constraint — CP-SAT models directly and proves
optimal on 120 candidates in about 200 ms.

**A bug worth recording, because the failure mode is invisible.** Crews were
initially given 5 days per period while a full inspection package runs 10-12
crew-days. No segment could ever fit, so CP-SAT correctly returned a
*proven-optimal empty schedule* — 0 of 120 scheduled, no error, no explanation.
The fix is in two parts: the default period is now a working month (20 days),
and any segment whose package exceeds every eligible crew's capacity is now
detected up front and returned in an `oversized` list with a reason, instead of
silently vanishing into an optimal-looking result.

The `critical_deadline_period` hard constraint defaults to **off** for the same
class of reason: with it on, a critical segment that can't fit the deadline is
dropped from the schedule entirely rather than scheduled late, turning a
capacity shortfall into an invisible coverage gap. Left off, the urgency
weighting still pulls critical work forward, and anything that slips is visible
in the period it landed in. Turning it on raised crew utilisation from 18% to
85% on the same inputs.

## 8. RAG — retrieval over a corrosion knowledge base

The assistant retrieves supporting passages from a curated corrosion
engineering corpus in `data/knowledge/` (6 documents, 31 chunks) and cites them
inline. `GET /api/knowledge/search?q=...` exposes retrieval directly, which is
useful on its own and invaluable for debugging when the assistant cites
something odd.

**Why TF-IDF and not a vector database.** At ~31 chunks a vector DB is pure
overhead — a service to run, a model to download, a new failure mode — for no
measurable gain. There is also a domain-specific reason sparse retrieval fits:
the queries are dense with exact jargon ("DCVG", "SP0169", "MIC", "−850 mV"),
which is precisely what TF-IDF matches best and what dense embeddings are most
likely to blur. scikit-learn is already a dependency, so this adds no packages
and works fully offline. Dense retrieval via Ollama embeddings is supported as
an optional enhancement, fused with Reciprocal Rank Fusion.

**Two lexical views, because one had a real hole.** Word-level TF-IDF does no
stemming, so *"how often should I inspect"* scored **exactly 0.000** against a
corpus that says "inspection" — a legitimate question getting no reference
material at all. Rather than add a stemmer and a dependency, the index carries
a second character-n-gram view that matches "inspect" inside "inspection"
without any linguistic rules. Measured on a 25-query probe set, this took
recall from 14/17 to **17/17** with keyword precision 14/14.

**What retrieval relevance can and cannot do — measured, not assumed.** No
threshold on any signal tested — word cosine, char cosine, or the peakedness
ratio of top score to median — cleanly separates on-topic from off-topic
queries. They all overlap. *"chocolate cake baking temperature"* scores 0.221
on char cosine, higher than several genuine engineering questions, because
"temperature" really is all over a corrosion corpus. The best combined rule
found was 16/17 recall at 5/8 false positives, which is not a usable gate.

That's a property of lexical retrieval over a small corpus, not a tuning
failure: a retriever returns its best match for whatever it's asked and has no
concept of "this question isn't about my subject." **So the topic boundary is
the domain gate in `backend/assistant.py`, which runs before retrieval.** The
relevance floors only trim the obvious tail — they took false positives from
7/8 to 2/8, and those two are refused by the domain gate anyway.

## 9. AI assistant (corrosion Q&A + pipeline photo analysis)

A domain-restricted assistant that answers corrosion and integrity questions
**grounded in this console's actual data**, and analyses uploaded photos of
pipeline assets.

### What makes it more than a chatbot bolted on

Every answer is given the real context for the segment in question — its
attributes, the model's predicted rate, and the SHAP contributions behind that
prediction. Ask "why is SEG-03037 critical?" and it reasons over that pipe's
actual 504 ohm-cm soil resistivity and absent cathodic protection, not generic
corrosion theory.

The photo analysis works the same way: the segment's numbers go *into* the
vision prompt, so the model reports whether the photograph **corroborates or
contradicts** the tabular model. A contradiction is a genuinely useful finding,
and the prompt explicitly asks for it rather than forcing agreement.

### Choosing a provider — all free

Nothing is configured by default; the console auto-detects in this order:
**groq → huggingface → ollama → mock**. Copy `.env.example` to `.env` to pin one.

| Provider | Cost | Setup | Vision | Speed |
|---|---|---|---|---|
| **Ollama** | Free | Install Ollama, `ollama pull llama3.2:1b` | Needs a vision model (below) | Slow on CPU — 1-3 min per grounded answer |
| **Groq** | Free tier | Key from console.groq.com | Yes, built in | Fast — a few seconds |
| **HuggingFace** | Free tier | Token from huggingface.co | Yes | Moderate |
| **mock** | Free | Nothing | Canned | Instant |

**Ollama is the best choice on a restricted network** — it runs locally and
makes no outbound calls at all. **Groq is dramatically faster.** Measured on
this machine: `llama3.2:1b` ≈ 17 char/s, `llama3` ≈ 12 char/s, so a full
grounded answer takes one to three minutes locally. Answers stream so you see
them arrive, and there's a Stop button.

**Photo analysis needs a vision model — text-only models cannot see images.**
`llama3` and `llama3.2:1b` are text-only. Enable vision with either:

```bash
ollama pull llama3.2-vision     # ~8 GB, fully local
ollama pull moondream           # ~1.7 GB, smaller and faster
```

…or set `GROQ_API_KEY` in `.env`. The console detects this and **says so in the
UI** rather than silently producing hallucinated image descriptions — if no
vision model is available, the upload area is replaced with instructions.

### How the domain restriction works, and its honest limits

Two layers:

1. **A deterministic pre-filter** (`backend/assistant.py`) that rejects clearly
   off-topic questions without spending an LLM call at all. It is deliberately
   conservative — it only rejects when a question has *no* domain vocabulary
   *and* matches an off-domain marker, so "write a Python script to compute
   corrosion rate" still gets through.
2. **A scoped system prompt** grounded in real standards — NACE/AMPP SP0169,
   API 570, API 579-1/ASME FFS-1, ASME B31.4/B31.8 — instructing the model to
   decline anything outside pipeline integrity.

**This is a soft boundary, not a security control.** A determined user can talk
their way past a prompt-based restriction; that is true of every product that
ships one. It is documented here rather than oversold, the same way
`backend/auth.py` documents being demo-grade. What it *is* good for is keeping
honest but off-topic questions from turning the console into a general chatbot.

### The photo path runs on two models, not one

Photo analysis is split in half, because the two halves of the job have
opposite model requirements:

| Stage | Job | Runs on |
|---|---|---|
| **1 — SEE** | Describe what is literally in the photograph | a vision model (local Ollama) |
| **2 — REASON** | Turn that into the engineering assessment, against the segment's data | the text model (Groq) |

**Why split it.** Small local vision models are acceptable at plain visual
description and unreliable at everything else. The strongest available text
model often cannot see images at all — Groq's free tier currently serves none.
Splitting the work runs each stage on a model suited to it, and removes the
requirement that sight and reasoning come from the same provider. Vision is
selected independently of `LLM_PROVIDER`: the server uses the text provider for
images if it can see, otherwise falls back to local Ollama.

**Three measured failures this design had to absorb**, all from moondream (1.8B):

- **Long prompts break it outright.** A 1064-character system prompt produced
  the 4-character output `"irt."`. The same request with a 124-character prompt
  produced a usable 436-character description. Small vision models don't
  partially comply — they collapse. So the stage-1 prompt is deliberately tiny,
  detail lives in the user turn as plain questions, and a test asserts the
  prompt stays under 250 characters.
- **Repetition loops.** It repeated one sentence ten times until it hit the
  token cap. Fixed at the decoding level (`repeat_penalty`) and again with a
  sentence de-duplicator, because a looped observation isn't just wasteful — it
  makes one shaky claim look corroborated by repetition.
- **Hallucination amplification.** moondream reported "a large hole"; stage 2
  escalated that to a through-wall breach warranting depressurisation. That is
  the characteristic danger of this architecture: a capable model reasoning
  confidently on top of a weak model's guess. Stage 2 is now explicitly told
  that "hole", "gap" or "cavity" from a low-confidence description far more
  often means a pit, stain or shadow, and that it must report a through-wall
  breach as **unconfirmed** and make confirming it the first action.

Both stages are returned by the API and shown in the UI, so an engineer can see
what was *observed* versus what was *inferred*.

### What the photo analysis will not claim

The vision prompt forbids, and the tests verify it forbids:

- **Wall thickness, wall loss percentage, or pit depth.** Those require UT, ILI,
  or laser scanning. A photograph has no scale reference unless a ruler is
  visibly in frame.
- **Remaining life or a fitness-for-service verdict.** That is API 579-1/ASME
  FFS-1 work requiring measured thickness data.

Every analysis ends with a required **Limitations** section, and the UI repeats
the caveat under each result. This is qualitative triage to help an inspector
decide where to point real instruments — not a substitute for them.

### Security notes

- **The API key never reaches the browser.** All LLM calls proxy through
  FastAPI. This is why the endpoints exist at all instead of the frontend
  calling a provider directly.
- **Region scoping applies to the assistant too.** An inspector asking about a
  segment outside their region gets a real 403, verified by
  `tests/test_assistant.py` — otherwise the assistant would be a way to read
  data the RBAC otherwise blocks.
- **Uploaded images are treated as untrusted.** Text inside a photo is a
  prompt-injection vector, so the vision prompt instructs the model to describe
  such text rather than obey it. Uploads are capped at 8 MB, MIME-validated,
  held in memory, and never written to disk.
- **Model output is escaped before rendering.** The markdown renderer in
  `js/ui.js` escapes first and re-introduces only a known-safe subset of tags.

## 10. Viewing the data as a database (DB Browser for SQLite / pgAdmin)

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

## 11. Where this stands vs. what's next

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
- A domain-restricted AI assistant grounded in the segment database and the
  model's own SHAP output, with pipeline photo analysis fused against the
  numeric prediction (§9) — provider-agnostic across Ollama / Groq /
  HuggingFace, all free tiers
- Inspection method recommendation (§6) — deterministic, auditable rules that
  select CIPS / DCVG / ILI / ECDA / UT per segment with justification
- **OR-Tools inspection scheduling (§7)** — the milestone previously listed
  below as "not started". CP-SAT, proven optimal on 120 candidates in ~200 ms
- RAG over a curated corrosion knowledge base (§8), with citations
- Two frontends: a React + TypeScript console and the original no-build vanilla
  one as a fallback

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
- **Real authentication** (SSO/OAuth, hashed+salted passwords in a real
  database, HTTPS) — the current login demonstrates the access-control
  *pattern* the console needs, not a production-ready auth system.
- **Geographic scheduling** — the CP-SAT model (§7) optimises selection and
  crew assignment, but not travel. Adding lat/long per segment would make an
  OR-Tools routing model meaningful; without coordinates there is no distance
  matrix to minimise, so it is deliberately not attempted.
- **Consequence-of-failure modelling** — risk is likelihood × consequence, and
  everything here addresses likelihood only. Two segments with identical
  predicted rates warrant different priorities if one crosses a high
  consequence area. The scheduler would rank differently with that input.

## 11a. Dense retrieval, and a bug that produced no symptom

Retrieval now fuses THREE views — word-level TF-IDF, character n-grams, and
embeddings from a local `nomic-embed-text` model — with Reciprocal Rank Fusion.

```bash
ollama pull nomic-embed-text
python scripts/build_dense_index.py      # ~160 s once, then ~3 ms at startup
```

**It is a fusion, not a swap, and that is deliberate.** Lexical retrieval is
genuinely better on this domain's vocabulary — queries are dense with exact
tokens like `DCVG`, `SP0169`, `-850 mV`. Measured recall@3:

| | lexical only | + dense |
|---|---|---|
| jargon queries | 9/10 | 9/10 |
| **paraphrase queries** | **1/8** | **6/8** |
| off-topic queries | 0 admitted | 0 admitted |

Dense adds nothing on jargon and fixes the paraphrase case. "electrical way of
protecting pipe" shares no vocabulary at all with the cathodic-protection
chunk that answers it, and no number of character n-grams bridges that.

> **The bug.** Dense retrieval was already fully implemented — it built its
> index, ran on every query, and contributed **nothing**. The final filter in
> `search()` admitted a fused hit only if a *lexical* view had scored it:
>
> ```python
> if best_word.get(idx, 0.0) >= min_score
> or best_char.get(idx, 0.0) >= CHAR_RELEVANCE
> ```
>
> A chunk that only the embedding view found — precisely the paraphrase case
> dense exists for — was discarded before it could be returned. Dense could
> reorder what lexical had already found; it could never introduce anything.
> Enabling it produced byte-identical results and raised no error.
> `test_dense_can_introduce_a_chunk_lexical_missed` is the guard.

**The admission threshold is measured, not guessed.** `DENSE_RELEVANCE = 0.45`,
from a probe run: relevant chunks averaged cosine 0.560, off-topic queries
topped out at 0.396. At 0.45 the gate admits 44/45 relevant chunks and 0/93
off-topic ones.

Worth noting what dense does *not* do here: it barely separates the correct
document from a wrong one within the domain (0.560 vs 0.527). It separates
in-domain from out-of-domain. So it is an admission gate, and RRF still
decides the order.

**Cost, stated plainly.** Embedding one query on CPU takes about **6 seconds**.
That is acceptable for chat, where generation already takes 10-20 s and the
retrieval win is real, and it is the *entire* cost of a `/api/knowledge/search`
call. Set `RAG_DENSE_QUERIES=0` to keep the index loaded but skip query-time
embedding.

It also broke a property the README claims: that the suite passes with no
Ollama and no internet. `tests/conftest.py` now forces `RAG_DENSE_QUERIES=0`
for the suite, and `tests/test_rag_dense.py` skips when Ollama is absent.

## 11b. Better vision via OpenRouter free tier

The local vision model is `moondream` — 1.8B, chosen because the machine has
no discrete GPU. It manages "brown discolouration and surface pitting on a
metal pipe" and little more.

`backend/openrouter.py` adds a provider that discovers **free, vision-capable**
models at runtime:

```bash
# https://openrouter.ai/keys  (free)
OPENROUTER_API_KEY=sk-or-...
```

**There is no vision model trained on oil and gas pipelines.** Not on a free
tier, not on a paid one. Anything carrying that label is a general VLM behind
a domain prompt, and this module does not pretend otherwise. What actually
improves domain quality, in order of effect:

1. **A much larger general VLM.** 1.8B to 70B+ is the single biggest available
   improvement, and it is what this provider is for.
2. **Domain grounding in the prompt** — the two-stage pipeline already reasons
   over the observations together with the segment's numbers and the retrieved
   standards.
3. **Retrieving the relevant standard alongside the image** — also already done.

**Discovery is at runtime, and the reason is a scar.** The Groq provider once
hardcoded `llama-3.3-70b-versatile`; the model was decommissioned and every
request began returning a 404 that looked like a broken integration. So this
asks `/api/v1/models` what exists, then filters on **numeric pricing** rather
than the `:free` suffix — the suffix is a naming convention, the pricing is
what bills — and on **declared input modalities** rather than whether the id
contains "vision". A configured model that turns out to be paid is ignored
rather than silently billed (`test_a_configured_model_that_is_paid_is_ignored`).

Preference order puts the largest vision models first: Qwen2.5-VL 72B, then
Llama-4 Maverick/Scout, InternVL3, Gemma 3, Mistral Small 3.2.

**Now live-verified** — see the TLS section below for why it initially
appeared unreachable. Checked against the real catalogue: **446 models, 24
free, 14 free and image-capable.**

That check immediately invalidated the original selection logic. Of those 14,
**exactly one matched the hardcoded preference list** — the free roster had
turned over completely, and none of qwen2.5-vl-72b, llama-4-maverick,
internvl3 or gemma-3 were on it. Ranking now comes from metadata the catalogue
publishes (an explicit vision signal in the name or description, then context
length, then max completion tokens), with the name list demoted to a tiebreak
among the top three.

It also surfaced a class of model no modality check can filter:

| Model | Free | Accepts images | Actually does |
|---|---|---|---|
| `google/lyria-3-pro-preview` | yes | yes | **generates music** |
| `nvidia/...-content-safety:free` | yes | yes | **safety classifier** |
| `openrouter/free` | yes | yes | **a meta-router** |

Lyria has the largest context window of any free image-accepting model, so it
would have been selected as the best vision model and returned something
useless for a corrosion photograph. `EXCLUDED_PURPOSES` filters on purpose,
not capability.

## 11c. Travel-aware inspection scheduling

The dispatch optimiser already charged travel against the crew-day budget. The
*inspection* scheduler did not — it knew crews had regions but not where they
were, so between two crews who could both take a segment the choice was
arbitrary.

Both CP-SAT models now price distance the same way:

```
capacity:   work_days + travel_days <= crew_days_per_period
objective:  risk × urgency  -  travel_penalty × travel_days
```

Default crews get a depot at their region centroid. With one Midwest crew on
8 crew-days and two equal-risk 4-day segments — one next door, one on the Gulf
Coast — the near one is scheduled and the far one appears in `oversized`,
because 7.08 crew-days of travel does not fit in an 8-day budget.

**A segment with no coordinates costs zero travel**, so a caller that supplies
no geography gets exactly the previous behaviour rather than a silently
distorted objective. The oversized check subtracts travel too: comparing
`est_days` against raw capacity would let a segment past the filter and then
find it unschedulable inside the model, which surfaces as a quietly missing
segment instead of an explicit "does not fit" report.

Still distance-aware, **not routed**. Real crews chain jobs; that is a vehicle
routing problem needing a road network this project does not have.

## 11d. A network that looked blocked and was not

Several hosts appeared unreachable and were not. The diagnosis matters more
than the fix, because the symptom is indistinguishable from a firewall:

```
curl https://openrouter.ai/api/v1/models   ->  000
python httpx.get(...)                       ->  CERTIFICATE_VERIFY_FAILED
```

Both are **client-side TLS trust failures**, not blocking. This network
intercepts TLS: a proxy terminates the connection, re-signs with an internal
root CA, and that CA is installed in the Windows certificate store. Browsers
read that store, so the site loads normally. Python ships its own CA bundle
and does not, and Git Bash's curl uses schannel and failed a revocation check
it could not reach. `curl -k` returning **200** settled it.

`src/net_trust.py` routes verification through the OS trust store via
`truststore`, which is what pip itself adopted. Full verification is kept —
the alternative people reach for when this error appears is `verify=False`,
which turns a trust problem into no trust at all.

With it enabled, every host that appeared blocked returns 200: openrouter.ai,
cdnjs, github.com, huggingface.co, fonts.googleapis.com.

**Two conclusions in this README were wrong because of it.** The
FT-Transformer was reported as blocked on an uninstallable PyTorch — pip
worked the whole time, going through the proxy correctly. And OpenRouter was
reported as not live-verifiable. Both are now done.

**One conclusion survives.** The landing page still avoids a CDN-hosted 3D
library, because the console's `Content-Security-Policy` is `script-src
'self'` — the browser blocks it regardless of whether the host resolves.
That decision rested on CSP and integrated graphics, not on reachability.

## 12. Security

A review of the console found six real issues. All are patched, and each has a
regression test in `tests/test_security.py` — they are worth testing because
every one of them is invisible in normal use: the application behaves
identically whether or not passwords are cheap to crack.

| # | Issue | Severity | Fix |
|---|---|---|---|
| 1 | **SHA-256 with one shared salt** for every password | High | PBKDF2-HMAC-SHA256, 600k iterations, per-user random salt |
| 2 | **Password compared with `!=`** — short-circuits on the first differing byte, leaking how much matched | Medium | `hmac.compare_digest` |
| 3 | **User enumeration** — an unknown username returned before hashing, so it answered measurably faster than a wrong password | Medium | Dummy PBKDF2 verification on the miss path; identical error message for both |
| 4 | **Tokens never expired** — a captured token was valid until the process restarted | High | 12 h absolute + 1 h idle expiry, with a sweep so the store cannot grow unbounded |
| 5 | **No login rate limiting** — the three demo passwords were brute-forceable at network speed | High | 5 failures per (username, IP) then a 15-minute lockout, `429` + `Retry-After` |
| 6 | **`CORS allow_origins=["*"]`** with `allow_methods/headers` `*` | Medium | Explicit allowlist, `GET`/`POST` only, credentials off |

Also hardened, without an issue number because they were gaps rather than
defects:

- **Unbounded upload buffering.** `analyze-image` did `await file.read()` and
  checked the size *afterwards*, so the 413 only fired once the whole body was
  already in memory. Now read in 64 KB chunks and aborted as soon as the cap
  is passed.
- **`content_type` was trusted.** It is client-supplied, so anything could be
  labelled `image/png` and forwarded to the vision model. Now the leading
  bytes are sniffed and the declared type must agree.
- **Exception text leaked to the client** mid-stream, which can carry file
  paths or parts of a request URL. Now logged server-side and reported
  generically. `LLMError` is still shown in full because those messages are
  ours.
- **Security headers**: `X-Content-Type-Options: nosniff`, `X-Frame-Options:
  DENY`, `Referrer-Policy: no-referrer`, and a CSP with `script-src 'self'`,
  `object-src 'none'` and `frame-ancestors 'none'`. Model output goes through
  react-markdown rather than `dangerouslySetInnerHTML`, but a defence that
  does not depend on that staying true is worth having.
- **`/docs` and `/openapi.json`** are an inventory of the attack surface. Off
  when `INTEGRITYAI_ENV=production`.
- **`X-Forwarded-For` is only trusted** when `INTEGRITYAI_BEHIND_PROXY` is
  set. Trusting it unconditionally would let an attacker rotate the header and
  defeat the login lockout entirely.

**Verified clean:** no secrets in tracked files (`.env` is gitignored,
`.env.example` holds placeholders only); RBAC is enforced server-side on every
route including the LLM endpoints (`403` for an inspector hitting
`/api/schedule` or `/api/stats`, `401` unauthenticated — confirmed against the
running server); no SQL string interpolation (SQLAlchemy parameter binding
throughout); uploaded images are never written to disk.

**Configuration:**

```bash
INTEGRITYAI_ENV=production                        # disables /docs
INTEGRITYAI_ALLOWED_ORIGINS=https://your.host     # CORS allowlist
INTEGRITYAI_BEHIND_PROXY=true                     # trust X-Forwarded-For
```

**Still outstanding, and deliberately so:** no HTTPS enforcement (terminate at
a reverse proxy), no CSRF tokens (not needed while the session token travels
in an `Authorization` header rather than a cookie — revisit if that changes),
and no audit log of who viewed what.

## Fixed: the corrosion-rate tail is now physically realistic

The generator used to produce rates up to **232 mpy** — roughly an inch of wall
in four years, which does not happen to buried carbon steel. It was documented
rather than clipped, because a clip would have hidden the cause.

**The cause was an unbounded hyperbola.** Soil corrosivity was
`15000 / soil_resistivity`, and with resistivity floored at 200 ohm-cm that
peaks at a **75x** multiplier.

**The fix is physical, not a clip.** External corrosion in soil is cathodically
controlled by oxygen reduction, and oxygen arrives by diffusion. Once the
cathodic reaction is mass-transport limited, a more conductive electrolyte
cannot make it go faster — there is a limiting current density. So the
multiplier has to saturate:

```
soil_factor = f_max * R_half / (R_half + resistivity)
```

with `f_max = 4.0` and the half-saturation constant at **3,000 ohm-cm**, near
the "corrosive / moderately corrosive" boundary of the soil classification that
traces back to Romanoff's NBS burial studies and is still used in AMPP/NACE
practice. Multipliers become 3.75x at 200 ohm-cm, 2.0x at 3,000, 0.2x at
60,000 — monotonic, bounded, ordering preserved.

A second **soft ceiling** compresses the top of the distribution toward 40 mpy
with `tanh` rather than truncating, because a hard clip piles probability mass
on the limit and creates a spike the model learns as a real feature. In
practice the saturating soil factor alone is sufficient; the ceiling never
activates.

| | before | after |
|---|---|---|
| max | 232.3 mpy | **16.5 mpy** |
| p99 | 31.4 mpy | **7.2 mpy** |
| above 20 mpy | 1.96% | **0.00%** |
| median | 0.99 mpy | 0.64 mpy |

**The relationships the model must learn survived**: no-CP still corrodes 2.6x
faster than protected pipe, uncoated 5x faster than FBE, corrosive soil 1.5x
faster than benign.

**It also made the model better.** Test R^2 went **0.565 to 0.682** and MAE
**1.693 to 0.483 mpy**. The unphysical tail had been actively hurting the fit
— a handful of impossible segments were dominating the squared error.

## Fixed: the domain gate is a classifier, not a word list

The gate was keyword matching: refuse only when a question has no domain
vocabulary AND an explicit off-domain marker. That has a structural blind spot
— it matches words, so *"write a poem about a pipeline"* contains a domain
term and was accepted.

`backend/domain_gate.py` adds an embedding classifier. It compares the question
against two sets of anchor phrases and decides on the **margin** between the
best in-domain and best out-of-domain match, not an absolute threshold, because
absolute cosine drifts with phrasing length while the margin is stable.

| probe | keyword only | layered |
|---|---|---|
| in-domain accepted | 8/8 | **8/8** |
| off-domain refused | **2/8** | **8/8** |
| follow-ups allowed | 5/5 | **5/5** |

Layered rather than swapped in, because the classifier needs Ollama — without
it the keyword filter still runs and the gate degrades to its previous
behaviour instead of failing open.

**Two bugs found while building it**, both of which had been latent:

- `DOMAIN_TERMS` matched substrings, so `"ut"` (the ultrasonic testing code)
  matched the middle of **"about"** and `"api"` matched **"rapid"**. Harmless
  while the gate could only be permissive; a real problem once a classifier
  could refuse. Terms of four characters or fewer now match whole words only.
- The follow-up carve-out tokenised with `q.split()`, which keeps punctuation,
  so `"why?"` produced the token `"why?"` and never matched the marker
  `"why"` — the shortest and most common follow-up in existence was the one
  case it missed.

**Follow-ups are detected by anaphora, not length.** Length was tried first and
is the wrong discriminator: *"best pizza recipe"* is three words. What marks a
follow-up is that it **points back** instead of naming its subject. `"this"`,
`"how"` and `"and"` are excluded from the marker set for the same reason —
*"help me debug this python function"* names its own topic completely.

## Fixed: photo analysis can measure lateral extent

Photo analysis was qualitative only. That was right as a default and too blunt
as a permanent rule, because **one of the two dimensions B31G needs is
genuinely recoverable** from a single image.

| | recoverable from one photo? |
|---|---|
| **Lateral** — length, width, area | **Yes**, with a scale reference |
| **Depth** — wall loss, pit depth | **No. Not at any resolution.** |

Depth is not a model or resolution limitation. A single projection discards the
range coordinate; recovering it needs stereo, structured light, or photometric
stereo. No prompt recovers information the sensor never captured.

`src/integrity/photogrammetry.py` measures what is measurable and propagates
the uncertainty:

- Scale from a ruler, scale card, coin (four currencies), or **the pipe's own
  recorded outside diameter** — the only reference needing nothing brought to
  site, and correspondingly the least reliable, so it carries an extra 12%
  uncertainty and says so.
- Oblique angle corrected by `1/cos(t)`, with uncertainty growing as `tan(t)`
  because the angle itself is being eyeballed. Beyond 45 degrees it refuses
  rather than quoting a number nobody should use.
- **Area uncertainty is double the length uncertainty**, because area is a
  product of two lengths sharing one scale factor so the scale error enters
  twice. Treating it as a length would understate it by 2x.
- `b31g_readiness()` exists specifically to stop a length-only defect flowing
  into a remaining-strength calculation. Failure pressure under Modified B31G
  is far more sensitive to depth than to length, so a length-only defect is
  not a partial answer — it is an unanswered question.

## Built and measured: FT-Transformer

The originally scoped architecture now exists in `src/models/ft_transformer.py`
— feature tokenizer, [CLS] token, pre-norm Transformer encoder, per-feature
learned scaling for numerics and embedding tables for categoricals.

Trained head-to-head on the same split:

| | R^2 | MAE | train | parameters |
|---|---|---|---|---|
| **XGBoost** | **0.682** | **0.483** | **0.4 s** | 300 trees |
| FT-Transformer | 0.637 | 0.497 | 233 s | 87,616 |

**XGBoost wins**, by 0.044 R^2, while training 580x faster. That is the
measured answer rather than an assumed one, and it is consistent with the
original paper, whose own result is that FT-Transformer is *competitive* with
gradient boosting rather than dominant.

There is a second reason to stay on trees that the numbers do not show:
`shap.TreeExplainer` computes **exact** Shapley values by exploiting tree
structure. For a transformer you fall back to sampling-based explainers, which
are approximate and orders of magnitude slower — and the whole explainability
story of this console rests on that exactness.

Run it yourself:

```bash
pip install torch
python -c "from src.models.train_ft import compare_with_xgboost; compare_with_xgboost()"
```

## Note on the synthetic dataset

One coating category was originally named `"None"`. Pandas silently reads
that back as a missing value on CSV load (not on generation — only when the
file is re-read), which crashed the console's segment-detail endpoint with
a JSON serialization error. Renamed to `"Uncoated"` and hardened the CSV
reads elsewhere against the same class of bug. If you regenerate the
dataset from an older copy of this repo, delete
`data/processed/synthetic_pipeline_corrosion.csv` and `models/` first so
they rebuild with the fix.

