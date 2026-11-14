"""Demo targets (PLAN.md §3). Positions come from Gaia DR3 + proper motion at bake time,
never from hard-coded J2000 coordinates."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Target:
    id: str
    name: str
    blurb: str
    fov_arcmin: float
    default_mode: str  # "blink" | "diff"
    default_band: int  # detector 1..6
    gaia_id: str | None = None
    # For objects without Gaia astrometry (WISE 0855): an AllWISE seed position + literature motion.
    allwise_seed: tuple[float, float] | None = None
    pm_mas_yr: tuple[float, float] | None = None  # (pmra*cos dec, pmdec)
    pm_source: str | None = None
    max_exposures: int = 480  # deep-field targets get sub-sampled evenly in time
    notes: list[str] = field(default_factory=list)
    status: str = "ready"  # "ready" | "conditional"


TARGETS: dict[str, Target] = {
    t.id: t
    for t in [
        Target(
            id="barnard",
            name="Barnard's Star",
            blurb="The fastest-moving star in the sky: 10.4″ per year. Between SPHEREx visits it steps "
            "about 1–2 pixels; against the 2010 WISE image it has leapt almost 3 arcminutes.",
            fov_arcmin=8.0,
            default_mode="blink",
            default_band=6,
            gaia_id="4472832130942575872",
            notes=["Core saturated near 2 µm (detectors 2–4); detectors 5–6 are clean."],
        ),
        Target(
            id="eps-ind-b",
            name="Epsilon Indi Ba+Bb",
            blurb="A pair of brown dwarfs 12 light-years away, 0.7″ apart — one blended source to SPHEREx. "
            "It moves 4.7″ per year, so the difference of two visits shows a faint ± pair.",
            fov_arcmin=5.0,
            default_mode="diff",
            default_band=3,
            gaia_id="6412596012146801152",
        ),
        Target(
            id="nep-lpv",
            name="Pulsating red giant (Gaia DR3 2160548942811758720)",
            blurb="A long-period variable (Gaia: ~372-day period) next to the north ecliptic pole, where "
            "SPHEREx looks every day. Its brightness changes from visit to visit.",
            fov_arcmin=5.0,
            default_mode="blink",
            default_band=5,
            gaia_id="2160548942811758720",
            max_exposures=480,
            notes=["One core pixel saturates near 2 µm."],
        ),
        Target(
            id="rw-aur",
            name="RW Aurigae",
            blurb="A young star still surrounded by a dusty disc; it has dimmed and brightened in the "
            "infrared for years.",
            fov_arcmin=5.0,
            default_mode="diff",
            default_band=4,
            gaia_id="156430822114424576",
            status="conditional",
            notes=["A and B (1.5″ apart) are blended."],
        ),
        Target(
            id="wise-0855",
            name="WISE 0855−0714",
            blurb="The coldest known brown dwarf (about −20 °C). Too faint for one SPHEREx exposure; "
            "only a stack of the longest-wavelength exposures can show it.",
            fov_arcmin=5.0,
            default_mode="blink",
            default_band=6,
            allwise_seed=(133.7951, -7.2451),
            pm_mas_yr=(-8118.0, 680.0),
            pm_source="Luhman & Esplin 2016 (UNVERIFIED in PLAN.md)",
            status="conditional",
        ),
    ]
}
