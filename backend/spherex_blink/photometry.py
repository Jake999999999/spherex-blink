"""Aperture photometry on single SPHEREx exposures: one (time, wavelength, flux) point per exposure.

Done in each exposure's own pixel grid (no resampling), at the source's position for that date.
Fluxes are aperture sums in mJy with a local-sky annulus and no aperture correction, so they are
good for comparing points with each other (spectral shape, variability), not as absolute photometry.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

PIXEL_SR = (6.15 / 206264.806) ** 2
MJY_SR_TO_MJY_PER_PIXEL = PIXEL_SR * 1e9  # MJy/sr * sr -> MJy -> mJy

R_AP = 2.5  # px (15.4")
R_IN = 4.0
R_OUT = 7.0

FLAG_OK = 0
FLAG_BAD_PIXEL = 1  # a masked (non-saturated) pixel inside the aperture
FLAG_SATURATED = 2  # an OVERFLOW / NaN core pixel inside the aperture


@dataclass
class Phot:
    flux: float  # mJy (NaN if not measurable)
    err: float
    flag: int
    sky: float  # MJy/sr per pixel


NAN_PHOT = Phot(math.nan, math.nan, FLAG_OK, math.nan)


def aperture(
    image: np.ndarray,
    variance: np.ndarray,
    good: np.ndarray,
    overflow: np.ndarray,
    x: float,
    y: float,
    r_ap: float = R_AP,
    r_in: float = R_IN,
    r_out: float = R_OUT,
) -> Phot:
    """x, y: 0-based pixel position. Pixels count when their centre is inside the radius."""
    ny, nx = image.shape
    if not (r_ap <= x <= nx - 1 - r_ap and r_ap <= y <= ny - 1 - r_ap):
        return NAN_PHOT
    yy, xx = np.mgrid[0:ny, 0:nx]
    r2 = (xx - x) ** 2 + (yy - y) ** 2
    ap = r2 <= r_ap * r_ap
    ann = (r2 >= r_in * r_in) & (r2 <= r_out * r_out) & good
    sky_vals = image[ann]
    if sky_vals.size < 8:
        return NAN_PHOT
    sky, sky_sd = _clipped(sky_vals)
    ap_good = ap & good
    n_ap = int(ap.sum())
    if ap_good.sum() < 0.5 * n_ap:
        flag = FLAG_SATURATED if (ap & overflow).any() else FLAG_BAD_PIXEL
        return Phot(math.nan, math.nan, flag, sky)
    flag = FLAG_OK
    if (ap & overflow).any():
        flag = FLAG_SATURATED
    elif (ap & ~good).any():
        flag = FLAG_BAD_PIXEL
    s = float((image[ap_good] - sky).sum())
    var = float(variance[ap_good].sum()) + ap_good.sum() * (1.2533 * sky_sd) ** 2 / max(1, sky_vals.size)
    return Phot(s * MJY_SR_TO_MJY_PER_PIXEL, math.sqrt(max(var, 0.0)) * MJY_SR_TO_MJY_PER_PIXEL, flag, sky)


# Wing ring for stars with a saturated core (the core is 1-4 px; this ring is clean in nearly every exposure).
WING_IN = 1.5
WING_OUT = 4.0
WING_SKY_IN = 5.0
WING_SKY_OUT = 8.0


def wing(image, variance, good, overflow, x: float, y: float) -> Phot:
    """Flux in the ring WING_IN < r <= WING_OUT (local sky removed). Tracks brightness over time for
    saturated stars; the PSF fraction in the ring changes with wavelength, so not for spectral shape."""
    ny, nx = image.shape
    if not (WING_SKY_OUT <= x <= nx - 1 - WING_SKY_OUT and WING_SKY_OUT <= y <= ny - 1 - WING_SKY_OUT):
        return NAN_PHOT
    yy, xx = np.mgrid[0:ny, 0:nx]
    r2 = (xx - x) ** 2 + (yy - y) ** 2
    ring = (r2 > WING_IN**2) & (r2 <= WING_OUT**2)
    sky_m = (r2 >= WING_SKY_IN**2) & (r2 <= WING_SKY_OUT**2) & good
    if sky_m.sum() < 8:
        return NAN_PHOT
    sky, sky_sd = _clipped(image[sky_m])
    rg = ring & good
    n = int(ring.sum())
    if rg.sum() < 0.85 * n:  # don't compare rings with chunks missing
        return Phot(math.nan, math.nan, FLAG_SATURATED if (ring & overflow).any() else FLAG_BAD_PIXEL, sky)
    flag = FLAG_SATURATED if (ring & overflow).any() else (FLAG_BAD_PIXEL if (ring & ~good).any() else FLAG_OK)
    # scale up for the few missing pixels so rings stay comparable
    s = float((image[rg] - sky).sum()) * n / rg.sum()
    var = float(variance[rg].sum()) + rg.sum() * (1.2533 * sky_sd) ** 2 / max(1, int(sky_m.sum()))
    return Phot(s * MJY_SR_TO_MJY_PER_PIXEL, math.sqrt(max(var, 0.0)) * MJY_SR_TO_MJY_PER_PIXEL, flag, sky)


def _clipped(v: np.ndarray, k: float = 3.0, iters: int = 4) -> tuple[float, float]:
    v = v[np.isfinite(v)]
    med = float(np.median(v))
    sd = float(np.std(v))
    for _ in range(iters):
        keep = np.abs(v - med) < k * max(sd, 1e-12)
        if keep.sum() < 8:
            break
        v = v[keep]
        med, sd = float(np.median(v)), float(np.std(v))
    return med, sd


def wavelength_at(wave_wcs, x: float, y: float) -> tuple[float, float] | None:
    """(central wavelength, bandwidth) in µm from the exposure's WCS-WAVE lookup."""
    if wave_wcs is None:
        return None
    try:
        wl, bw = wave_wcs.pixel_to_world_values(x, y)
        wl, bw = float(wl), float(bw)
    except Exception:  # noqa: BLE001
        return None
    if not (math.isfinite(wl) and 0.5 < wl < 5.5):
        return None
    return wl, bw
