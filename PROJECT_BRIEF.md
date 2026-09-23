# IntegrityAI — Project Brief

> **Superseded.** This file was written on 2026-09-10, before consequence
> modelling, remaining life, repair selection, dispatch, the realistic
> dataset and the security work. Several "limitations" and "what's next"
> items below have since been built. **[BRIEF.md](BRIEF.md)** is the current
> document; this one is kept for the record.

> **How to use this file:** paste the whole thing into Claude with a prompt like
> *"Build a presentation from this brief — 16 slides, technical audience (engineering mentor),
> use the suggested outline at the bottom."* Everything below is verified against the
> actual codebase, not estimated.

---

## 1. One-line pitch

A pipeline corrosion integrity console that predicts which pipeline segments are
corroding fastest, explains *why* in feature-level terms, recommends the specific
inspection method each one needs, schedules the field crews to cover them under real
capacity limits, and lets an engineer interrogate all of it in natural language —
including by uploading a photograph of the pipe.

## 2. The problem

An operator runs thousands of buried pipeline segments. Only a handful of crews.
Inspecting everything every year is impossible; inspecting the wrong things is how
leaks happen. The real question is not *"is this pipe corroding?"* but
**"given finite crew-days, which segments do we inspect, with which technique, in which month?"**

Existing tools answer the first question. IntegrityAI answers the second.

## 3. The organising principle (the most important slide)

> **Every decision that must be auditable is deterministic code.
> The language model only explains — it never decides.**

Risk banding, inspection-method selection, and crew scheduling are all plain tested
Python. The LLM sits *on top* and narrates.

**Why this matters:** an integrity engineer has to justify to a regulator why segment
SEG-04412 got a DCVG survey and not an ILI run. A model that picks a different method
on Tuesday than it picked on Monday cannot be defended. So the method selection is a
rule engine with 9 named techniques and cited standards, and it is unit-tested to
produce the identical plan for identical inputs.

This is the design decision that separates the project from an "AI wrapper."

---

## 4. Technology stack

### Languages
| Language | Where | Why |
|---|---|---|
| **Python 3.11** | Entire backend, ML, optimisation, retrieval | The scientific stack (XGBoost, SHAP, OR-Tools, scikit-learn) only exists here |
| **TypeScript** | Entire frontend | Compile-time checking on API response shapes — the backend contract is mirrored in `web/src/lib/types.ts` |
| **SQL** (via SQLAlchemy) | Persistence layer | Same code targets SQLite locally and PostgreSQL in deployment |

### Backend
| Tool | Version | Role |
|---|---|---|
| **FastAPI** | 0.115+ | HTTP API — 16 endpoints, automatic OpenAPI docs, native async for LLM streaming |
| **Uvicorn** | 0.32+ | ASGI server |
| **Pydantic** | 2.9+ | Request/response validation at the boundary — malformed input is rejected before it reaches business logic |
| **XGBoost** | 2.1+ | Gradient-boosted regression → corrosion rate in mils/year |
| **SHAP** | 0.46+ | `TreeExplainer` — exact per-prediction feature attribution |
| **scikit-learn** | 1.5+ | Preprocessing, ordinal encoding, TF-IDF vectorisers for retrieval |
| **OR-Tools (CP-SAT)** | 9.11+ | Constraint-programming solver for crew scheduling |
| **SQLAlchemy** | 2.0+ | ORM; SQLite ↔ PostgreSQL portability |
| **pandas / numpy** | 2.2+ / 1.26+ | Data generation and feature handling |
| **httpx** | 0.27+ | Async HTTP to LLM providers — **no vendor SDKs**, so swapping provider is a config change |
| **python-multipart** | 0.0.9+ | Multipart parsing for the photo-upload endpoint |
| **pytest** | 8.3+ | **102 tests, all passing** |

### Frontend
| Tool | Version | Role |
|---|---|---|
| **React** | 18.3 | UI |
| **Vite** | 6.0 | Build tool — production bundle builds in ~11 s |
| **Tailwind CSS** | 4.0 | Styling via `@theme` design tokens (new v4 engine) |
| **TanStack Query** | 5.62 | Server-state caching, background refetch, request deduplication |
| **TanStack Table** | 8.20 | Headless sorting/filtering over the segment register |
| **TanStack Virtual** | 3.11 | Row virtualisation |
| **Recharts** | 2.15 | Distribution charts |
| **react-markdown + remark-gfm** | 9.0 / 4.0 | Renders LLM output as markdown — **never as HTML**, which closes the XSS path |
| **lucide-react** | 0.468 | Icon set |

### LLM providers — all free tier, per project constraint
| Provider | Model | Role |
|---|---|---|
| **Groq** | `openai/gpt-oss-120b` | Text reasoning — free, very fast inference |
| **Ollama** (local) | `moondream` (1.8B vision) | Sees the photograph, on-device |
| **Ollama** (local) | `llama3` / `llama3.2:1b` | Offline text fallback |
| **HuggingFace** | Inference API | Third fallback |
| **Mock** | — | Deterministic canned responses so the UI and the 102 tests run with zero credentials |

Provider selection is a runtime chain with graceful degradation — the app never
hard-fails because a key is missing.

---

## 5. What actually happens (data flow)

```
Synthetic generator ──► 5,000 pipeline segments (17 columns)
                              │
                         Preprocessing (ordinal encoding)
                              │
                         XGBoost regressor ──► corrosion_rate_mpy
                              │
              ┌───────────────┼────────────────┐
              ▼               ▼                ▼
        SHAP explainer   Rule engine     CP-SAT solver
        (why this rate)  (which test)    (who goes when)
              │               │                │
              └───────────────┼────────────────┘
                              ▼
                     FastAPI (16 endpoints, RBAC)
                              │
                  ┌───────────┴───────────┐
                  ▼                       ▼
          React console            LLM assistant
                                   (+ RAG, + vision)
```

**One request, end to end:** the operator clicks a segment → React fires a cached
TanStack Query → FastAPI checks the session token and the user's region permission →
loads the row → runs the XGBoost prediction → runs `TreeExplainer` on that single row →
returns the rate, the risk band, and the ranked SHAP contributions → the drawer draws
a tornado plot of the drivers. Switching to the Inspection tab calls the rule engine,
which returns the ranked methods with their standards citations.

---

## 6. The six features

### Feature 1 — Corrosion rate prediction (XGBoost)
- **What:** predicts external corrosion rate in mils/year from 14 features (age, diameter, wall thickness, material, coating type, cathodic protection, soil resistivity, soil type, pressure, temperature, product, time since last inspection, repair history, region).
- **Numbers:** 300 trees, depth 5, lr 0.05. **Test R² ≈ 0.67, MAE ≈ 0.83 mils/year** on an 80/20 split.
- **Why XGBoost and not a neural net:** trains in seconds, needs no GPU, and SHAP support for trees is *exact* rather than approximated. The scope originally called for an FT-Transformer — swapping it in touches only `src/models/train.py`, because preprocessing, SHAP, and prioritisation are all model-agnostic.

### Feature 2 — Explainability (SHAP)
- **What:** for every individual prediction, exact Shapley values showing how much each feature pushed the rate up or down. They sum to the prediction — it is an additive decomposition, not a correlation heuristic.
- **UI:** a diverging tornado plot around a centre line — left reduces the rate, right increases it. That is how sensitivity is conventionally shown in engineering.
- **Why it matters:** "SEG-04412 is high risk" is not actionable. "SEG-04412 is high risk *because it is uncoated, has no cathodic protection, and sits in 900 ohm-cm soil*" tells the crew what to fix.

### Feature 3 — Inspection method recommendation (deterministic rule engine)
- **What:** given a segment, returns a ranked list of the specific NDT techniques it needs, each with a rationale, a standard citation, and an estimated crew-day cost.
- **9 methods:** CIPS, DCVG, UT, ILI-MFL, ILI-UT, ECDA, DIG, CUI, COAT.
- **Standards cited:** NACE/AMPP SP0169, SP0502, API 570, API 579-1, API 1160, ASME B31.4 / B31.8.
- **Tunable thresholds** are declared at the top of the file, not buried: corrosive soil < 2000 ohm-cm, minimum piggable diameter 6", overdue at 5 years, old pipe at 30 years, CUI temperature window 10–60 °C, high pressure > 1000 psi, repeat-repair trigger at 3.
- **Why rules, not an LLM:** reproducibility and defensibility (see §3).

### Feature 4 — Crew scheduling (OR-Tools CP-SAT)
- **What:** a constraint-optimisation model that selects *and* assigns segments across multiple periods, maximising risk covered subject to crew-day capacity, with optional region locking.
- **Objective:** risk-weighted coverage, weights `critical 3.0 / elevated 1.8 / normal 1.0`, with a small tie-break preferring earlier periods.
- **Reports back:** solver status (proven-optimal vs feasible), solve time in ms, crew utilisation %, risk coverage %, uncovered criticals, and an `oversized` list of segments whose work package physically cannot fit one crew-period.
- **Why constraint programming, not sort-by-risk:** greedy sorting ignores capacity interactions. CP-SAT proves optimality or tells you it couldn't.

### Feature 5 — RAG over a corrosion knowledge base
- **What:** retrieval over **6 curated documents / 31 chunks** covering external corrosion, cathodic protection, coatings, corrosion mechanisms, inspection methods, and standards. Retrieved passages are injected as grounding context and surfaced as citations.
- **How:** *dual lexical retrieval* — a word-level TF-IDF view and a character n-gram view (`char_wb`, 4–5 grams) — fused with **Reciprocal Rank Fusion** (k=60).
- **Why two views:** see the retrieval bug in §9. Word-level TF-IDF alone scored **0.000** on "how often should I inspect" because the corpus says "inspection interval" — no stemming, no match. Character n-grams match the shared substring. Fusing them took recall from **14/17 to 17/17**.

### Feature 6 — Domain-restricted LLM assistant + photo analysis
Two capabilities behind one interface.

**6a. Corrosion Q&A.** A domain gate keeps the assistant on oil-and-gas pipeline topics and refuses everything else. The gate is deliberately *conservative*: it only refuses when a question contains **no** in-domain vocabulary **and** an explicit off-domain marker — because falsely refusing a real engineering question is worse than answering a borderline one. Responses stream token-by-token and carry citations, delimited from the text with a NUL sentinel.

**6b. Two-stage pipeline photo analysis** — the mentor's idea, and the most interesting engineering in the project.

```
Photo ──► Stage 1: moondream (1.8B, LOCAL)  "describe only what you see"
              │                              ↓ raw observations
              │                          dedupe_observations()
              ▼
          Stage 2: Groq gpt-oss-120b (REMOTE)  reasons over
              observations + the segment's model prediction + RAG context
              ↓
   4 required sections: Visual observations · Consistency with the model
                        · Recommended actions · Limitations
```

**Why split it:** the hardware has no discrete GPU (Intel UHD, 15 W i7-10510U), so a
large local vision model is not viable. But a *small* vision model can see, and a
*large* remote text model can reason. So the local model is restricted to pure
observation — it is explicitly forbidden from guessing causes — and the strong model
does all the inference. **Local model sees, remote model thinks.**

**Guardrails, all of which exist because they were needed:**
- The stage-2 prompt **forbids estimating wall loss from a photograph** — you cannot measure remaining wall thickness from a JPEG, and claiming otherwise is dangerous.
- An explicit anti-escalation rule: vague words like "hole", "gap", or "cavity" in the observations must **not** be concluded to be a through-wall penetration or a leak.
- Text visible *inside* the image is treated as untrusted data, never as instructions — this closes a prompt-injection path.
- Uploads are MIME-validated, capped at 8 MB, held in memory, and **never written to disk**.

---

## 7. Security model

| Control | Implementation |
|---|---|
| **Server-side RBAC** | Region and role checks enforced in FastAPI, extended to the LLM endpoints. Three roles: inspector (single region), supervisor (fleet + scheduler), admin (full). |
| **API keys never reach the browser** | All provider calls proxy through the backend. The frontend never sees a credential. |
| **Secrets hygiene** | Real keys live in gitignored `.env`; `.env.example` holds placeholders only. |
| **LLM output is never HTML** | Rendered through react-markdown, so model output cannot inject script. |
| **Uploads are untrusted** | MIME-checked, size-capped, in-memory only, and image-embedded text is never followed as an instruction. |

---

## 8. UI/UX — control-room HMI, deliberately not a generic dashboard

The first version looked like every AI-generated dashboard: slate-blue accent, evenly
rounded cards, generous whitespace, icon-and-label sidebar. It was redesigned around a
single question — *who reads this, and under what conditions?* Answer: an integrity
engineer, between other tasks, who wants **density and precision, not polish**.

So the design language is a **SCADA / control-room HMI**, and every choice is derived
from the domain rather than from taste:

| Decision | Rationale |
|---|---|
| **Safety amber `#f5a524` on graphite `#0d1013`** | Hazard signage. Red/amber/green retain their industrial meanings and are used for *nothing decorative* — colour is always information |
| **2px corners + corner brackets** | Rounded corners read as consumer app; corner ticks come from technical drawings. This is the single change that breaks the "card grid" look |
| **Status lamps instead of pill badges** | On a physical panel, status is a light. Critical *pulses* — the alarm state is the only thing that moves |
| **Barlow Condensed labels + IBM Plex Mono numerals with `tabular-nums`** | Condensed uppercase is signage; tabular figures make decimal points align down a column so you can scan a register |
| **Top status rail instead of a sidebar** | Reclaims horizontal space for data |
| **An amber sweep line instead of a dot spinner** | Reads as an instrument taking a measurement |
| **Inline proportional bars behind rate numbers** | See the distribution without reading a digit |
| **Dotted-leader spec rows** for attributes | It is a spec sheet, not a card grid |
| **Near-threshold blueprint grid** on the background | Depth without ornament |
| **Red hairline on critical rows** | Peripheral-vision detection while scanning |

The two-stage vision pipeline is drawn on screen as a **signal chain with stage lamps**,
so the architecture is visible while it runs, and the raw stage-1 observations are
collapsible — the user can audit what the vision model actually said.

---

## 9. Engineering stories worth presenting (three bugs that failed *silently*)

These are the strongest slides for a technical mentor, because all three looked like
working software while being wrong. All three now have regression tests.

**1. The proven-optimal empty schedule.**
CP-SAT returned status OPTIMAL and scheduled **0 of 120** segments. Not a crash — a
mathematically correct answer to the wrong question. Crews had 5 day-periods; the
average work package needed 11.5 days, so *no* segment could fit and the optimal
solution was genuinely the empty set. Fixed by raising the default to 20 crew-days,
adding explicit `oversized` detection, and surfacing `warnings` instead of an
innocent-looking zero. **Utilisation went 18% → 85%.**

**2. Retrieval that returned nothing on a word-form mismatch.**
"How often should I inspect" scored **0.000** against a corpus that discusses
"inspection intervals." Pure TF-IDF has no stemming, so *inspect* ≠ *inspection*.
The assistant simply answered without citations and looked fine. Fixed with the
character n-gram view + RRF. **Recall 14/17 → 17/17.**

**3. The vision model that emitted `"irt."`**
A 1064-character system prompt overwhelmed the 1.8B moondream model, which returned
four characters. Shrinking the stage-1 prompt to 124 characters produced 436 usable
characters of description. Then it fell into a **repetition loop** — one sentence
repeated ten times, 1800+ characters — fixed with `repeat_penalty` and a
`dedupe_observations()` pass, down to 297 clean characters. Then the *real* danger:
moondream said "a large hole," and the strong model **escalated that into a through-wall
breach requiring depressurisation.** That is hallucination amplification across a model
boundary, and it is why the explicit anti-escalation rule now exists.

**A measured negative result worth including:** retrieval relevance scores were tested
as a topic gate and *cannot* serve as one — no threshold cleanly separates on-topic from
off-topic queries. Documented rather than hidden; the domain gate remains the boundary.

---

## 10. Project scale (verified)

| Metric | Value |
|---|---|
| Python | **4,419 lines** across 20 modules |
| TypeScript / CSS | **2,827 lines** across 13 files |
| Tests | **102, all passing** (~36 s) |
| API endpoints | **16** |
| Dataset | **5,000 segments × 17 columns**, synthetic |
| Model features | 14 |
| Knowledge base | 6 documents / 31 chunks |
| Inspection methods | 9 |
| Standards cited | 7 |
| Production CSS bundle | 39.4 kB |

---

## 11. Advantages

- **Decision-complete, not just predictive.** It goes prediction → explanation → method → schedule. Most student ML projects stop at the first arrow.
- **Auditable by construction.** Every regulator-facing decision is deterministic and unit-tested.
- **Explainable at the individual level.** SHAP gives per-segment attribution, not global feature importance.
- **Respects real constraints.** The scheduler models crew-days and regions, so its output is executable rather than aspirational.
- **Honest about failure.** The scheduler reports when it *cannot* fit work; retrieval reports when it found nothing; the vision stage shows its raw output.
- **Costs nothing to run.** Entirely free-tier LLM providers, with a local option and a mock fallback — the full test suite runs with no credentials at all.
- **Provider-portable.** Raw `httpx`, no vendor SDK lock-in.
- **Grounded in real standards.** NACE/AMPP and API citations throughout, not invented terminology.
- **Domain-appropriate interface.** Designed for an operator scanning a register, not for a screenshot.

## 12. Limitations (state these honestly — it strengthens the presentation)

- **The dataset is synthetic.** This is the big one. The labels come from a simplified physical relationship the generator itself defines, so **R² ≈ 0.67 measures fit to a generator, not to reality.** The pipeline is validated end-to-end; the *model* is not validated against field data. Real ILI or PHMSA incident data would be the next step.
- **The corrosion-rate tail is not physically realistic** — the generator produces values up to ~232 mpy, well above what carbon steel in soil actually does. Documented in the README rather than quietly clipped.
- **It models likelihood only, not risk.** True pipeline risk is *likelihood × consequence*. A segment crossing a high-consequence area (a river, a populated zone) deserves different priority at the same corrosion rate. Consequence modelling is absent.
- **No geography.** Segments have a region label but no route, no coordinates, no elevation, no crossings — so the scheduler cannot model travel time between jobs.
- **The domain gate is heuristic**, not a classifier. Deliberately biased toward answering; a determined user can push it off-topic.
- **Authentication is demo-grade.** Token-based with seeded accounts — suitable for a class project, not production.
- **Photo analysis is qualitative only.** It cannot measure. No scale reference, no wall-loss estimate, no defect sizing — and the prompts actively forbid pretending otherwise.
- **Vision quality is bounded by a 1.8B local model** chosen for hardware reasons; a larger vision model would observe far more.
- **Single-machine deployment.** No containerisation, no CI, no migrations.
- **Retrieval is lexical, not semantic.** No embeddings — a paraphrase with no shared vocabulary still misses.

## 13. What's next — status as of 2026-09-21

1. **Replace synthetic data with real ILI / PHMSA incident data** — **still open.**
   Still the single highest-value change. The dataset is now *deliberately
   degraded* to look realistic (missing records weighted toward old assets,
   unit confusion, duplicates, label noise), which tests the pipeline
   honestly, but it is still not field data.
2. ~~Add consequence modelling to turn likelihood into true risk~~ — **done.**
   `src/integrity/consequence.py`. Risk is now likelihood — consequence, with
   HCA determined under both 49 CFR 192.903 (gas) and 195.450 (liquid) and
   the published Potential Impact Radius formula. A segment corroding at only
   3.2 mpy now ranks first of 5,000 because of where it is.
3. ~~Add geospatial routing so the scheduler accounts for travel~~ — **done,
   with one honest caveat.** `src/integrity/geo.py` supplies coordinates,
   haversine distance and travel time, and BOTH CP-SAT models now charge
   travel against the crew-day budget. It is *distance-aware*, not *routed*:
   real crews chain jobs, which is a vehicle routing problem needing a road
   network this project does not have.
4. ~~Swap TF-IDF for embedding-based retrieval~~ — **done, as a fusion
   rather than a swap.** Dense retrieval via `nomic-embed-text` is fused with
   the two lexical views by RRF. Deliberately not a swap, because lexical is
   genuinely better on this domain's jargon — measured, dense changed nothing
   on jargon queries (9/10 either way) and took paraphrase recall from
   **1/8 to 6/8**.
5. **Swap XGBoost for the originally scoped FT-Transformer** — **blocked, not
   skipped.** PyTorch is not installed and there is no network access from
   this environment to install it. The swap still touches only
   `src/models/train.py`. It is also not obviously the right next step: on
   5,000 rows of tabular data with a deliberately noisy label, gradient
   boosting is a strong baseline that tabular transformers frequently fail to
   beat, and moving off trees would cost the *exact* SHAP attribution the
   whole explainability story rests on.
6. **Real authentication, containerisation, CI** — auth was **hardened**
   (PBKDF2 with per-user salt, token expiry, login throttling — see README
   section 12), but SSO/MFA, containers and CI remain open.

Built since this list was written and not on it: repair and mitigation
selection, work-order dispatch with proximity assignment, statutory deadline
constraints, the realistic-data-quality pipeline, an OpenRouter free-tier
vision provider, a security review, and the landing page.

---

## 14. Suggested slide outline (16 slides)

1. **Title** — IntegrityAI: Pipeline Corrosion Risk Assessment
2. **The problem** — thousands of segments, a handful of crews (§2)
3. **The core principle** — deterministic decisions, LLM explains (§3)
4. **Architecture diagram** (§5)
5. **Technology stack** (§4)
6. **Feature 1 + 2** — XGBoost prediction and SHAP explainability
7. **Feature 3** — inspection method rule engine, 9 methods, 7 standards
8. **Feature 4** — CP-SAT crew scheduling
9. **Feature 5** — RAG with dual retrieval + RRF
10. **Feature 6a** — domain-restricted assistant
11. **Feature 6b** — two-stage vision pipeline (diagram + "local sees, remote thinks")
12. **Security model** (§7)
13. **UI/UX** — why control-room HMI (§8)
14. **Three silent failures** (§9) — the engineering-depth slide
15. **Advantages and limitations** side by side (§11, §12)
16. **What's next** (§13)
