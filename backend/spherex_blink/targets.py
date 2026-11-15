"""Demo targets (PLAN.md §3). Positions come from Gaia DR3 + proper motion at bake time,
never from hard-coded J2000 coordinates."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Target:
    id: str
    name: str
    tagline: str
    blurb: str
    fov_arcmin: float
    default_mode: str  # "blink" | "diff" | "colour"
    default_band: int  # detector 1..6
    gaia_id: str | None = None
    # For objects without Gaia astrometry (WISE 0855): an AllWISE seed position + literature motion.
    allwise_seed: tuple[float, float] | None = None
    pm_mas_yr: tuple[float, float] | None = None  # (pmra*cos dec, pmdec)
    pm_source: str | None = None
    max_exposures: int = 480  # deep-field targets get sub-sampled evenly in time
    notes: list[str] = field(default_factory=list)
    status: str = "ready"  # "ready" | "conditional"
    variable: bool = False  # brightness changes: time-averaged map spectra would mix phases
    colour_preset: str = "spread"  # preset shown first in Colour mode (frontend/src/lib/colour.ts PRESETS)
    colour_hint: str = ""  # what to look for in Colour mode; only claims checked against the data
    # live fields: a plain sky position with no catalogue object (motion zero, labelled "Field centre")
    position: tuple[float, float] | None = None
    visits_max: int = 0  # 0 = all visits; live quick looks cap it
    per_cell: int = 0  # 0 = old behaviour (max_exposures spread per detector); else exposures per visit and detector


TARGETS: dict[str, Target] = {
    t.id: t
    for t in [
        Target(
            id="barnard",
            colour_preset="spread",
            colour_hint="Barnard's Star is so bright that its centre is blown out (white) at most wavelengths, so its own colour can't be measured here. Its neighbours show the usual pattern: ordinary stars look blue in this view, because they are brightest at the shortest infrared wavelengths.",
            name="Barnard's Star",
            tagline="The fastest star in the sky",
            blurb="The fastest-moving star in the sky: 10.4″ per year. Between SPHEREx visits it steps "
            "about 1–2 pixels; against the 2010 WISE image it has leapt almost 3 arcminutes.",
            fov_arcmin=8.0,
            default_mode="colour",
            default_band=6,
            gaia_id="4472832130942575872",
            notes=["Too bright for SPHEREx: its centre saturates in nearly every exposure, so its spectrum is unreliable. Positions still work."],
        ),
        Target(
            id="eps-ind-b",
            colour_preset="methane",
            colour_hint="Look for the pink dot in the middle: the brown dwarfs. Methane in their cold air swallows the green window (3.3 µm), so they lose green, while the ordinary star nearby stays blue-white.",
            name="Epsilon Indi Ba+Bb",
            tagline="Twin brown dwarfs: water and methane",
            blurb="A pair of brown dwarfs 12 light-years away, 0.7″ apart — one blended source to SPHEREx. "
            "It moves 4.7″ per year, so the difference of two visits shows a faint ± pair.",
            fov_arcmin=5.0,
            default_mode="colour",
            default_band=3,
            gaia_id="6412596012146801152",
        ),
        Target(
            id="nep-lpv",
            colour_preset="spread",
            colour_hint="This giant is blown out (white) at most wavelengths, and because it pulses, the map (an average over a year) mixes its bright and faint moments. Its story is in Blink and its light curve.",
            variable=True,
            name="Pulsating red giant (Gaia DR3 2160548942811758720)",
            tagline="A giant star that swells and fades",
            blurb="A long-period variable (Gaia: ~372-day period) next to the north ecliptic pole, where "
            "SPHEREx looks every day. Frames here are two-month bins of 480 exposures sampled from 17,000.",
            fov_arcmin=5.0,
            default_mode="colour",
            default_band=6,
            gaia_id="2160548942811758720",
            max_exposures=480,
            notes=["Its centre saturates in every detector; the light curve uses a ring around the centre instead."],
        ),
        Target(
            id="rw-aur",
            colour_preset="spread",
            colour_hint="RW Aurigae is blown out (white) at most wavelengths, so its colour here isn't meaningful. The fainter stars around it show the normal blue of ordinary stars.",
            variable=True,
            name="RW Aurigae",
            tagline="A young star in a dusty disc",
            blurb="A young star still surrounded by a dusty disc; it has dimmed and brightened in the "
            "infrared for years.",
            fov_arcmin=5.0,
            default_mode="colour",
            default_band=4,
            gaia_id="156430822114424576",
            status="conditional",
            notes=["A and B (1.5″ apart) are blended.", "Saturates on detectors 2–6; only detector 1 (0.75–1.1 µm) measures cleanly."],
        ),
        Target(
            id="r-dra",
            variable=True,
            colour_preset="spread",
            colour_hint="R Draconis is blown out (white) at most wavelengths, and because it pulses, the map (an average over a year) mixes its bright and faint moments. Its story is in Blink and its light curve.",
            name="R Draconis",
            tagline="A giant star that pulses every 8 months",
            blurb="A Mira-type red giant that swells and shrinks every 245 days, changing brightness several-fold. "
            "It is one of the challenge's test targets: its light curve shows the pulsation visit by visit.",
            fov_arcmin=6.0,
            default_mode="colour",
            default_band=6,
            gaia_id="1648328016354496384",
            per_cell=5,  # ~180 exposures: keeps total downloads near the owner-approved budget
            visits_max=6,
            status="conditional",
            notes=["Far too bright for SPHEREx: its centre saturates at every wavelength, so its light curve uses a ring around the centre."],
        ),
        Target(
            id="wise-0855",
            colour_preset="spread",
            colour_hint="WISE 0855 is lost in the light of a brighter background star 4–11″ away, so there is nothing special to see in colour here: one 12.9″ pixel can't tell two objects that close apart.",
            name="WISE 0855−0714",
            tagline="Coldest brown dwarf, hidden by a neighbour",
            blurb="The coldest known brown dwarf (about −20 °C). Too faint for one SPHEREx exposure; "
            "only a stack of the longest-wavelength exposures can show it.",
            fov_arcmin=5.0,
            default_mode="colour",
            default_band=6,
            allwise_seed=(133.7951, -7.2451),
            pm_mas_yr=(-8118.0, 680.0),
            pm_source="Luhman & Esplin 2016 (UNVERIFIED in PLAN.md)",
            status="conditional",
            notes=["In 2025–26 it passes 4–11″ from a Gaia G = 16.3 background star, inside SPHEREx's aperture: "
                   "the light measured here is mostly that star, so this is not a detection of WISE 0855."],
        ),
    ]
}
