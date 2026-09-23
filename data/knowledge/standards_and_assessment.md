# Standards, Fitness-for-Service and Integrity Management

## The standards that govern this work

These are the documents most often cited in pipeline external-corrosion
integrity work. Descriptions below summarise each standard's scope; consult the
current published edition for actual requirements, criteria and clause text.

**NACE/AMPP SP0169** — Control of External Corrosion on Intermediate and Buried
Metallic Piping Systems. The core cathodic protection standard for buried pipe.
It sets out the criteria for demonstrating protection, including the widely used
−850 mV (CSE) criterion and the 100 mV polarisation shift alternative.

**NACE/AMPP SP0502** — External Corrosion Direct Assessment methodology. Defines
the four-step ECDA process and the requirement to use complementary indirect
inspection techniques.

**API 570** — Piping Inspection Code. Covers inspection, rating, repair and
alteration of in-service piping systems, including inspection intervals and
corrosion-under-insulation considerations.

**API 579-1 / ASME FFS-1** — Fitness-For-Service. The engineering methodology
for assessing whether equipment containing a known flaw is fit to remain in
service, organised in progressive assessment levels of increasing rigour.

**API 1160** — Managing System Integrity for Hazardous Liquid Pipelines. Covers
integrity management programme structure, risk assessment and assessment method
selection.

**ASME B31.4 and B31.8** — Pipeline transportation systems for liquids and
slurries (B31.4) and gas transmission and distribution piping (B31.8). Design,
construction and operating requirements.

**49 CFR Parts 192 and 195** — the United States federal pipeline safety
regulations for gas and hazardous liquid pipelines respectively, administered by
PHMSA. These impose mandatory integrity management requirements, including
assessment intervals in high consequence areas.

## Fitness-for-service and remaining life

Fitness-for-service assessment answers a specific question: given a flaw of
known size in a component of known geometry and material, operating at known
conditions, is it acceptable to continue operating?

The essential input is **measured** dimensions. A remaining-life calculation
combines a measured current wall thickness, a limiting thickness below which the
component is unacceptable, and a corrosion rate:

    remaining life ≈ (measured thickness − limiting thickness) / corrosion rate

Every term has to come from somewhere defensible. The measured thickness comes
from UT or ILI. The limiting thickness comes from a design calculation for the
operating pressure. The corrosion rate ideally comes from repeat measurements at
the same location over time, which is why establishing a baseline matters.

A predicted corrosion rate from a statistical model can be used for
prioritisation and planning. It is not an acceptable substitute for measured
data in a fitness-for-service assessment, and treating it as one would not
survive review.

## Unit conversions that matter

Corrosion rates in North American practice are usually in mils per year (mpy).
Wall thicknesses are often recorded in millimetres.

- 1 mil = 0.001 inch = 0.0254 mm
- 1 mpy = 0.0254 mm/year
- To convert mpy to mm/year, multiply by 0.0254
- To convert mm/year to mpy, divide by 0.0254

A worked example: a segment with 12 mm remaining wall, a limiting thickness of
6 mm, and a corrosion rate of 8 mpy. Converting the rate: 8 × 0.0254 = 0.203
mm/year. Remaining life = (12 − 6) / 0.203 ≈ 29 years. Note this assumes uniform
loss; if the attack is pitting, the governing number is the deepest pit, not the
average.

## Risk-based inspection prioritisation

Risk is conventionally treated as the product of likelihood of failure and
consequence of failure. Corrosion rate models address the likelihood side.
Consequence depends on what the line carries, at what pressure, and what is
nearby — population, water crossings, environmentally sensitive areas.

Two segments with identical predicted corrosion rates can warrant very different
priorities if one runs through a high consequence area and the other through
open country. A prioritisation scheme that ranks purely on predicted rate is
incomplete, and this is worth stating explicitly when presenting model output:
the model addresses likelihood, not consequence.

High consequence area designation carries specific regulatory assessment
interval requirements under the PHMSA regulations, which can be more demanding
than a rate-based schedule would suggest.

## Interpreting model predictions responsibly

A machine-learning model trained on pipeline attributes produces an estimate of
corrosion rate conditioned on the patterns in its training data. Several
cautions apply when using such output:

- It is a statistical estimate, not a measurement, and should never be presented
  as one.
- Its accuracy outside the range of its training data is unknown. Extreme
  predictions in particular deserve scrutiny before being acted on.
- Feature attributions such as SHAP values explain what drove the model's
  output. They describe the model's reasoning, not necessarily physical
  causation, though on a well-specified model the two often align.
- The appropriate use is prioritisation: deciding where to point real
  instruments first. The instruments still have to be pointed.
