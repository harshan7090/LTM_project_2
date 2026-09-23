"""
Dimensional measurement from a photograph, with a scale reference.

WHAT CHANGED AND WHAT DID NOT

  Photo analysis was qualitative only: "corrosion morphology, coating
  condition, staining", with quantitative claims forbidden outright. That was
  correct as a default and too blunt as a permanent rule, because ONE of the
  two dimensions B31G needs is genuinely recoverable from a single image.

      LATERAL extent - length, width, area   RECOVERABLE with a scale reference
      DEPTH - wall loss, pit depth           NOT RECOVERABLE. Ever. From one image.

  Depth is not a limitation of the model or the resolution. A single
  projection discards the range coordinate; you cannot invert it without a
  second viewpoint (stereo), a projected pattern (structured light), or
  multiple illumination angles (photometric stereo). No amount of prompting
  recovers information the sensor never captured. UT, ILI or a pit gauge
  measure depth; a camera does not.

  So this module measures what is measurable, propagates the uncertainty
  honestly, and refuses the rest. `b31g_readiness()` exists specifically to
  say "you now have length, you still need depth" rather than letting a
  half-populated defect flow into a remaining-strength calculation.

HOW THE SCALE IS ESTABLISHED

  Something of known size must be in the frame and in the same plane as the
  feature being measured. Best to worst:

    1. A purpose-made photogrammetric target or scale card.
    2. A ruler or tape laid against the pipe.
    3. A coin (well-known diameters, usually to hand).
    4. The pipe's own outside diameter - this console already knows it from
       the segment record, which makes it the only option that needs nothing
       brought to site. It is also the weakest, because the apparent width of
       a cylinder depends on how much of it the frame sees.

WHY THE PERSPECTIVE WARNINGS ARE NOT BOILERPLATE

  A scale factor derived from a reference at one distance is only valid for
  features at that same distance and in that same plane. A reference lying on
  the ground next to a pipe photographed from above will under-report the
  pipe's features, because the pipe is nearer the camera. The error is linear
  in the distance ratio and easily 20-30% in a casual site photo, which is
  why `oblique_angle_deg` feeds a widened uncertainty band rather than a
  footnote.
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field

# --- reference objects ------------------------------------------------------
# Diameters in millimetres. Coins are here because an inspector always has one
# and rarely has a scale card.
KNOWN_REFERENCES = {
    "scale_card_50mm": 50.0,
    "ruler_100mm": 100.0,
    "ruler_150mm": 150.0,
    "coin_inr_10": 27.0,
    "coin_usd_quarter": 24.26,
    "coin_eur_2": 25.75,
    "coin_gbp_1": 23.43,
}

MM_PER_INCH = 25.4

# Baseline relative uncertainty on a hand-placed reference: edge localisation
# in a site photo is a few pixels at best, and the reference is rarely exactly
# perpendicular to the lens.
BASE_RELATIVE_UNCERTAINTY = 0.08

# Using the pipe's own diameter as the reference is meaningfully worse - the
# apparent width of a cylinder depends on framing, and the edges are curved
# rather than sharp.
PIPE_DIAMETER_EXTRA_UNCERTAINTY = 0.12

# Beyond this the projection error stops being a correction and starts being
# the dominant term. Refuse rather than quote a number nobody should use.
MAX_USABLE_OBLIQUE_DEG = 45.0


@dataclass
class ScaleResult:
    mm_per_pixel: float
    relative_uncertainty: float      # fractional, 1 sigma
    reference_name: str
    reference_mm: float
    reference_pixels: float
    oblique_angle_deg: float
    usable: bool
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["mm_per_pixel"] = round(self.mm_per_pixel, 5)
        d["relative_uncertainty_pct"] = round(self.relative_uncertainty * 100, 1)
        return d


@dataclass
class Measurement:
    length_mm: float
    length_uncertainty_mm: float
    width_mm: float
    width_uncertainty_mm: float
    area_mm2: float
    area_uncertainty_mm2: float
    confidence: str                  # good | fair | poor
    warnings: list[str] = field(default_factory=list)
    # Stated on every measurement, not buried in documentation.
    depth_measurable: bool = False
    depth_note: str = (
        "Depth cannot be measured from a single photograph. A 2D projection "
        "discards the range coordinate; recovering it needs stereo imaging, "
        "structured light, or photometric stereo. Use UT, ILI or a pit gauge."
    )

    def to_dict(self) -> dict:
        d = asdict(self)
        for k in ("length_mm", "length_uncertainty_mm", "width_mm",
                  "width_uncertainty_mm"):
            d[k] = round(d[k], 1)
        d["area_mm2"] = round(self.area_mm2, 0)
        d["area_uncertainty_mm2"] = round(self.area_uncertainty_mm2, 0)
        return d


# ------------------------------------------------------------------ scale ---

def scale_from_reference(reference_pixels: float,
                         reference_mm: float | None = None,
                         reference_name: str | None = None,
                         oblique_angle_deg: float = 0.0,
                         is_pipe_diameter: bool = False) -> ScaleResult:
    """Millimetres per pixel from a reference of known size.

    `oblique_angle_deg` is the angle between the camera axis and the surface
    normal. A feature photographed at angle t is foreshortened by cos(t), so
    the correction is a division by cos(t) - and the uncertainty grows with
    it, because the angle itself is being eyeballed.
    """
    warnings: list[str] = []

    if reference_mm is None:
        if reference_name not in KNOWN_REFERENCES:
            return ScaleResult(
                0.0, 1.0, reference_name or "unknown", 0.0, reference_pixels,
                oblique_angle_deg, usable=False,
                warnings=[f"Unknown reference '{reference_name}'. Give an "
                          f"explicit reference_mm, or use one of: "
                          f"{', '.join(sorted(KNOWN_REFERENCES))}."],
            )
        reference_mm = KNOWN_REFERENCES[reference_name]

    if reference_pixels <= 0 or reference_mm <= 0:
        return ScaleResult(0.0, 1.0, reference_name or "custom", reference_mm,
                           reference_pixels, oblique_angle_deg, usable=False,
                           warnings=["Reference size must be positive in both "
                                     "pixels and millimetres."])

    angle = abs(oblique_angle_deg)
    if angle >= MAX_USABLE_OBLIQUE_DEG:
        return ScaleResult(
            0.0, 1.0, reference_name or "custom", reference_mm,
            reference_pixels, oblique_angle_deg, usable=False,
            warnings=[f"Camera is {angle:.0f} degrees off the surface normal. "
                      f"Beyond {MAX_USABLE_OBLIQUE_DEG:.0f} the projection "
                      f"error dominates the measurement. Re-shoot square to "
                      f"the surface."],
        )

    cos_t = math.cos(math.radians(angle))
    mm_per_pixel = (reference_mm / reference_pixels) / max(cos_t, 1e-6)

    uncertainty = BASE_RELATIVE_UNCERTAINTY
    if is_pipe_diameter:
        uncertainty += PIPE_DIAMETER_EXTRA_UNCERTAINTY
        warnings.append(
            "Scale taken from the pipe's own outside diameter. The apparent "
            "width of a cylinder depends on framing and its edges are curved, "
            "so this is the least reliable reference - prefer a ruler or scale "
            "card laid against the pipe."
        )
    # Angle error grows roughly as tan(t): small near square-on, steep as the
    # camera tilts.
    uncertainty += 0.35 * math.tan(math.radians(angle))

    if reference_pixels < 50:
        uncertainty += 0.10
        warnings.append(
            f"Reference spans only {reference_pixels:.0f} pixels. A few pixels "
            f"of edge error is then a large fraction of the scale - fill more "
            f"of the frame with the reference."
        )
    if angle > 15:
        warnings.append(
            f"Camera is {angle:.0f} degrees off square. Foreshortening has been "
            f"corrected by 1/cos, but the correction is only as good as the "
            f"angle estimate."
        )

    return ScaleResult(mm_per_pixel, min(uncertainty, 0.95),
                       reference_name or "custom", reference_mm,
                       reference_pixels, oblique_angle_deg, usable=True,
                       warnings=warnings)


def scale_from_pipe_diameter(pipe_pixels: float, diameter_inches: float,
                             oblique_angle_deg: float = 0.0) -> ScaleResult:
    """Scale from the segment's recorded outside diameter.

    The only reference this console can supply without anyone bringing
    anything to site, because `diameter_inches` is already on the segment
    record - and correspondingly the least trustworthy.
    """
    return scale_from_reference(
        reference_pixels=pipe_pixels,
        reference_mm=diameter_inches * MM_PER_INCH,
        reference_name=f"pipe OD {diameter_inches:.0f} in",
        oblique_angle_deg=oblique_angle_deg,
        is_pipe_diameter=True,
    )


# ------------------------------------------------------------ measurement ---

def measure_defect(length_pixels: float, width_pixels: float,
                   scale: ScaleResult) -> Measurement:
    """Lateral extent of a visible feature. Depth is never returned."""
    if not scale.usable:
        return Measurement(0, 0, 0, 0, 0, 0, "poor",
                           warnings=["No usable scale."] + scale.warnings)

    length = length_pixels * scale.mm_per_pixel
    width = width_pixels * scale.mm_per_pixel
    rel = scale.relative_uncertainty

    # Area is a product of two lengths that share the same scale factor, so
    # the scale error enters twice and the relative uncertainty roughly
    # doubles. Treating it as the same as a length would understate it by 2x.
    area = length * width
    area_rel = min(2 * rel, 0.99)

    if rel <= 0.12:
        confidence = "good"
    elif rel <= 0.25:
        confidence = "fair"
    else:
        confidence = "poor"

    warnings = list(scale.warnings)
    if confidence == "poor":
        warnings.append(
            f"Total scale uncertainty is {rel * 100:.0f}%. Treat these figures "
            f"as indicative only - they are not a substitute for a measured "
            f"survey."
        )

    return Measurement(
        length_mm=length, length_uncertainty_mm=length * rel,
        width_mm=width, width_uncertainty_mm=width * rel,
        area_mm2=area, area_uncertainty_mm2=area * area_rel,
        confidence=confidence, warnings=warnings,
    )


def b31g_readiness(measurement: Measurement) -> dict:
    """What a B31G assessment still needs after a photo measurement.

    Exists so a half-populated defect cannot drift into a remaining-strength
    calculation. B31G takes depth AND length; a photograph supplies one of
    them, and the missing one is the term the failure pressure is most
    sensitive to.
    """
    have_length = measurement.length_mm > 0 and measurement.confidence != "poor"
    return {
        "length_available": have_length,
        "length_mm": round(measurement.length_mm, 1) if have_length else None,
        "depth_available": False,
        "ready_for_b31g": False,
        "blocking": [
            "Maximum pit depth as a percentage of wall thickness. Obtain by "
            "ultrasonic thickness survey, an ILI run, or a pit gauge at a dig. "
            "A photograph cannot supply it at any resolution."
        ],
        "note": (
            "Length from imagery can seed the assessment, but failure pressure "
            "under Modified B31G is far more sensitive to depth than to length "
            "- so a length-only defect is not a partial answer, it is an "
            "unanswered question."
        ),
    }
