"""S6: PSF photometry with SPHEREx's official effective PSFs (ePSF).

Every level-2 file carries an EPSF table: 451 ePSFs of 33x33 at 5x oversampling, one per region of the
detector (XCENTER/YCENTER in active-pixel coordinates), with the filter's centre wavelength (CWAVE).
The table is the same in every file of a detector, so it is read once per detector, by HTTP Range,
from one level-2 file on NASA's S3 copy (about 4 MB each) and cached.

Forced photometry: the source position is known (Gaia, propagated to the exposure date), so only the
amplitude is fitted, by weighted linear least squares on the pixels within R_FIT of the source,
after the same local-sky annulus as the aperture. Gaia neighbours inside the fit radius are fitted at
the same time (their amplitudes are free), so a nearby star doesn't leak into the flux.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

import httpx
import numpy as np
from scipy import ndimage

from . import cube, irsa, photometry

R_FIT = 3.0  # px (18.5")
OVERSAMPLE = 5
MIN_GOOD = 0.7  # share of fit pixels that must be usable


@dataclass
class Epsf:
    detector: int
    xc: np.ndarray  # bin centres, active pixels
    yc: np.ndarray
    cwave: np.ndarray
    psfs: np.ndarray  # [nbin, 33, 33], each normalised so a centred star sums to 1 over native pixels
    source: str


def _cache() -> Path:
    return irsa.CACHE_ROOT / "epsf"


def s3_key_from_url(url: str) -> str | None:
    i = url.find("/spherex/")
    return url[i + len("/spherex/") :].split("?")[0] if i >= 0 else None


def load_epsf(client: httpx.Client, detector: int, l2_key: str) -> Epsf:
    """EPSF table of one detector, read from the level-2 file `l2_key` on S3 (cached as .npz)."""
    path = _cache() / f"epsf_D{detector}.npz"
    if not path.exists():
        url = cube.S3_BASE + l2_key
        hdus = cube.walk_hdus(client, url)
        h = cube.hdu(hdus, "EPSF")
        t = cube.read_table(client, url, h)
        raw = np.asarray(t["EPSF"], np.float64).reshape(len(t), 33, 33)
        path.parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(path, xc=np.asarray(t["XCENTER"], float), yc=np.asarray(t["YCENTER"], float), cwave=np.asarray(t["CWAVE"], float), psfs=raw, source=np.array(l2_key))
    z = np.load(path)
    psfs = z["psfs"].copy()
    for k in range(len(psfs)):
        psfs[k] /= _native_sum(psfs[k])
    return Epsf(detector, z["xc"], z["yc"], z["cwave"], psfs, str(z["source"]))


def _native_sum(p: np.ndarray) -> float:
    """Sum over native pixels of a star centred on a pixel (the ePSF sampled every OVERSAMPLE points)."""
    c = (p.shape[0] - 1) // 2
    return float(p[c % OVERSAMPLE :: OVERSAMPLE, c % OVERSAMPLE :: OVERSAMPLE].sum())


def nearest_bin(e: Epsf, ax: float, ay: float) -> int:
    return int(np.argmin((e.xc - ax) ** 2 + (e.yc - ay) ** 2))


def model(psf: np.ndarray, dx: np.ndarray, dy: np.ndarray, orient: str = "as-is") -> np.ndarray:
    """ePSF value at native-pixel offsets (dx, dy) from the star (cubic spline on the oversampled grid)."""
    p = {"as-is": psf, "transpose": psf.T, "flipx": psf[:, ::-1], "flipy": psf[::-1, :]}[orient]
    c = (p.shape[0] - 1) / 2.0
    return ndimage.map_coordinates(p, [c + OVERSAMPLE * dy, c + OVERSAMPLE * dx], order=3, mode="constant", cval=0.0)


def active_offset(header) -> tuple[float, float]:
    """Cutout pixel (0-based) -> active detector pixel: the LINEAR 'A' axis (astropy would also apply
    SIP to it, which is wrong for this axis, so it's computed directly)."""
    return 1.0 - float(header.get("CRPIX1A", 1.0)), 1.0 - float(header.get("CRPIX2A", 1.0))


def fit(
    image: np.ndarray,
    variance: np.ndarray,
    good: np.ndarray,
    overflow: np.ndarray,
    x: float,
    y: float,
    psf: np.ndarray,
    neighbours: list[tuple[float, float, np.ndarray]] = (),
    orient: str = "as-is",
) -> tuple[photometry.Phot, float]:
    """Forced PSF fit at (x, y). Returns (flux in mJy, reduced chi²)."""
    ny, nx = image.shape
    if not (photometry.R_OUT <= x <= nx - 1 - photometry.R_OUT and photometry.R_OUT <= y <= ny - 1 - photometry.R_OUT):
        return photometry.NAN_PHOT, math.nan
    yy, xx = np.mgrid[0:ny, 0:nx]
    r2 = (xx - x) ** 2 + (yy - y) ** 2
    region = r2 <= R_FIT * R_FIT
    ann = (r2 >= photometry.R_IN**2) & (r2 <= photometry.R_OUT**2) & good
    if ann.sum() < 8:
        return photometry.NAN_PHOT, math.nan
    sky, sky_sd = photometry._clipped(image[ann])
    use = region & good & np.isfinite(variance) & (variance > 0)
    if (region & overflow).any():
        return photometry.Phot(math.nan, math.nan, photometry.FLAG_SATURATED, sky), math.nan
    if use.sum() < MIN_GOOD * region.sum():
        return photometry.Phot(math.nan, math.nan, photometry.FLAG_BAD_PIXEL, sky), math.nan
    px, py = xx[use], yy[use]
    d = image[use] - sky
    w = 1.0 / (variance[use] + (sky_sd**2) / max(1, int(ann.sum())))
    cols = [model(psf, px - x, py - y, orient)]
    for nxp, nyp, npsf in neighbours:
        if (nxp - x) ** 2 + (nyp - y) ** 2 <= (R_FIT + 2.0) ** 2:
            cols.append(model(npsf, px - nxp, py - nyp, orient))
    A = np.stack(cols, axis=1)
    Aw = A * w[:, None]
    M = A.T @ Aw
    try:
        cov = np.linalg.inv(M)
    except np.linalg.LinAlgError:
        return photometry.NAN_PHOT, math.nan
    amp = cov @ (Aw.T @ d)
    resid = d - A @ amp
    dof = max(1, len(d) - len(amp))
    chi2 = float((resid**2 * w).sum() / dof)
    flag = photometry.FLAG_BAD_PIXEL if (region & ~good).any() else photometry.FLAG_OK
    k = photometry.MJY_SR_TO_MJY_PER_PIXEL
    return photometry.Phot(float(amp[0]) * k, math.sqrt(max(cov[0, 0], 0.0)) * k, flag, sky), chi2


def save_summary(path: Path, obj: dict) -> None:
    path.write_text(json.dumps(obj, indent=1))
