"""Turn single SPHEREx exposures into per-visit, per-detector stacked frames on one TAN grid."""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
from astropy import log as astropy_log
from astropy.io import fits
from astropy.wcs import WCS, FITSFixedWarning
from scipy import ndimage

astropy_log.setLevel("WARNING")  # SPHEREx headers carry SIP terms on a plain TAN CTYPE; astropy applies them and says so
warnings.filterwarnings("ignore", category=FITSFixedWarning)

PIXEL_SCALE_ARCSEC = 6.15

# FLAGS bits that make a pixel unusable (PLAN.md D13). SOURCE (21) is deliberately NOT here:
# it is set on every star.
BAD_BITS = (1, 2, 6, 9, 10, 11, 15, 19)
BAD_MASK = sum(1 << b for b in BAD_BITS)
OVERFLOW_BIT = 1

DETECTOR_RANGES_UM = {1: (0.74, 1.12), 2: (1.10, 1.65), 3: (1.64, 2.44), 4: (2.42, 3.83), 5: (3.81, 4.43), 6: (4.42, 5.01)}


def grid_wcs(ra: float, dec: float, npix: int, scale_arcsec: float = PIXEL_SCALE_ARCSEC) -> WCS:
    """North-up, east-left TAN grid, npix x npix, centred on (ra, dec)."""
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [(npix + 1) / 2.0, (npix + 1) / 2.0]
    w.wcs.cdelt = [-scale_arcsec / 3600.0, scale_arcsec / 3600.0]
    w.wcs.cunit = ["deg", "deg"]
    return w


def grid_header(w: WCS, npix: int) -> dict:
    """WCS as plain numbers for the frontend (FITS 1-based crpix)."""
    return {
        "ctype": list(w.wcs.ctype),
        "crval": [float(w.wcs.crval[0]), float(w.wcs.crval[1])],
        "crpix": [float(w.wcs.crpix[0]), float(w.wcs.crpix[1])],
        "cdelt": [float(w.wcs.cdelt[0]), float(w.wcs.cdelt[1])],
        "naxis": [npix, npix],
    }


def _source_coords(src_wcs: WCS, dst_wcs: WCS, shape: tuple[int, int]) -> np.ndarray:
    ny, nx = shape
    yy, xx = np.mgrid[0:ny, 0:nx]
    world = dst_wcs.pixel_to_world_values(xx.ravel(), yy.ravel())
    sx, sy = src_wcs.world_to_pixel_values(*world)
    return np.stack([np.asarray(sy).reshape(shape), np.asarray(sx).reshape(shape)])


def resample(
    image: np.ndarray,
    variance: np.ndarray,
    good: np.ndarray,
    src_wcs: WCS,
    dst_wcs: WCS,
    shape: tuple[int, int],
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Bilinear resample of image/variance onto dst grid. Output pixels touching bad/out-of-frame
    input are invalid (NaN), never interpolated across."""
    coords = _source_coords(src_wcs, dst_wcs, shape)
    # Snap round-off just outside the edge pixels back onto them (else edge pixels read as uncovered).
    for axis, n in enumerate(image.shape):
        c = coords[axis]
        c[(c > -1e-3) & (c < 0)] = 0.0
        c[(c > n - 1) & (c < n - 1 + 1e-3)] = n - 1
    return bilinear(image, variance, good, coords[0], coords[1])


def bilinear(image: np.ndarray, variance: np.ndarray, good: np.ndarray, sy: np.ndarray, sx: np.ndarray):
    """Bilinear interpolation at source pixel positions (sy, sx).

    value = Σ wᵢ·vᵢ, variance = Σ wᵢ²·varᵢ (the variance of a weighted sum of independent pixels).
    An output pixel is valid only if every input pixel with non-negligible weight is good and inside.
    """
    ny, nx = image.shape
    x0 = np.floor(sx).astype(np.int64)
    y0 = np.floor(sy).astype(np.int64)
    fx = sx - x0
    fy = sy - y0
    val = np.zeros(sx.shape, np.float64)
    var = np.zeros(sx.shape, np.float64)
    valid = np.isfinite(sx) & np.isfinite(sy)
    for dy, dx, w in ((0, 0, (1 - fx) * (1 - fy)), (0, 1, fx * (1 - fy)), (1, 0, (1 - fx) * fy), (1, 1, fx * fy)):
        xi = x0 + dx
        yi = y0 + dy
        matters = w > 1e-6
        inside = (xi >= 0) & (xi < nx) & (yi >= 0) & (yi < ny)
        xc = np.clip(xi, 0, nx - 1)
        yc = np.clip(yi, 0, ny - 1)
        ok = inside & good[yc, xc]
        valid &= ~matters | ok
        v = np.where(ok, image[yc, xc], 0.0)
        s2 = np.where(ok, variance[yc, xc], 0.0)
        val += np.where(matters, w * v, 0.0)
        var += np.where(matters, w * w * s2, 0.0)
    out_img = np.where(valid, val, np.nan).astype(np.float32)
    out_var = np.where(valid, var, np.nan).astype(np.float32)
    return out_img, out_var, valid


@dataclass
class Exposure2D:
    image: np.ndarray  # zodi- and background-subtracted, MJy/sr
    variance: np.ndarray
    good: np.ndarray  # bool
    overflow: np.ndarray  # bool (saturated cores)
    wcs: WCS
    detector: int
    mjd: float
    wavelength_um: float | None  # at the cutout centre
    wave_wcs: WCS | None = None  # per-pixel (wavelength, bandwidth) lookup


def load_exposure(path, subtract_background: bool = True) -> Exposure2D:
    with fits.open(path, memmap=False) as h:
        hdr = h["IMAGE"].header
        img = h["IMAGE"].data.astype(np.float32)
        zodi = h["ZODI"].data.astype(np.float32)
        var = h["VARIANCE"].data.astype(np.float32)
        flags = h["FLAGS"].data.astype(np.int64)
        wcs = WCS(hdr)
        wl = None
        ww = None
        try:
            ww = WCS(hdr, fobj=h, key="W")
            ww.sip = None
            ny, nx = img.shape
            wl = float(ww.pixel_to_world_values((nx - 1) / 2.0, (ny - 1) / 2.0)[0])
        except Exception:  # noqa: BLE001 - wavelength is informational here
            wl, ww = None, None
        det = int(hdr.get("DETECTOR", 0))
        mjd = float(hdr.get("MJD-AVG", np.nan))
    sci = img - zodi
    good = np.isfinite(sci) & np.isfinite(var) & (var > 0) & ((flags & BAD_MASK) == 0)
    overflow = ((flags >> OVERFLOW_BIT) & 1).astype(bool) | ~np.isfinite(img)
    if subtract_background and good.sum() > 20:
        sci = sci - robust_background(sci[good])
    return Exposure2D(sci, var, good, overflow, wcs, det, mjd, wl, ww)


def robust_background(values: np.ndarray, iters: int = 5, k: float = 3.0) -> float:
    """Sigma-clipped median: residual sky after the ZODI model."""
    v = values[np.isfinite(values)]
    if v.size == 0:
        return 0.0
    med = float(np.median(v))
    for _ in range(iters):
        mad = float(np.median(np.abs(v - med))) * 1.4826
        if mad <= 0:
            break
        keep = np.abs(v - med) < k * mad
        if keep.sum() < 10:
            break
        v = v[keep]
        med = float(np.median(v))
    return med


def stack(images: list[np.ndarray], variances: list[np.ndarray]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Inverse-variance mean, ignoring NaN. Returns (mean, variance of mean, n used per pixel)."""
    if not images:
        raise ValueError("nothing to stack")
    img = np.stack(images).astype(np.float64)
    var = np.stack(variances).astype(np.float64)
    ok = np.isfinite(img) & np.isfinite(var) & (var > 0)
    w = np.where(ok, 1.0 / np.where(ok, var, 1.0), 0.0)
    sw = w.sum(axis=0)
    n = ok.sum(axis=0)
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = (np.where(ok, img, 0.0) * w).sum(axis=0) / sw
        vmean = 1.0 / sw
    mean = np.where(sw > 0, mean, np.nan).astype(np.float32)
    vmean = np.where(sw > 0, vmean, np.nan).astype(np.float32)
    return mean, vmean, n.astype(np.int16)


def group_epochs(mjds: list[float], gap_days: float = 45.0, max_span_days: float = 75.0) -> list[list[int]]:
    """Split sorted-or-not exposure times into visits: break at gaps > gap_days, and cut visits
    longer than max_span_days (continuous deep-field coverage) into equal time bins."""
    order = sorted(range(len(mjds)), key=lambda i: mjds[i])
    groups: list[list[int]] = []
    for i in order:
        if groups and mjds[i] - mjds[groups[-1][-1]] <= gap_days:
            groups[-1].append(i)
        else:
            groups.append([i])
    out: list[list[int]] = []
    for g in groups:
        span = mjds[g[-1]] - mjds[g[0]]
        if span <= max_span_days:
            out.append(g)
            continue
        nbins = int(np.ceil(span / max_span_days))
        edges = np.linspace(mjds[g[0]], mjds[g[-1]], nbins + 1)
        for b in range(nbins):
            lo, hi = edges[b], edges[b + 1]
            part = [i for i in g if (lo <= mjds[i] < hi) or (b == nbins - 1 and mjds[i] == hi)]
            if part:
                out.append(part)
    return out


def smooth_to_scale(image: np.ndarray, src_scale_arcsec: float, dst_scale_arcsec: float) -> np.ndarray:
    """Low-pass a finer image (e.g. WISE 1.375"/px) before sampling it on the coarse grid."""
    ratio = dst_scale_arcsec / src_scale_arcsec
    if ratio <= 1.0:
        return image
    sigma = 0.5 * ratio
    good = np.isfinite(image)
    num = ndimage.gaussian_filter(np.where(good, image, 0.0), sigma)
    den = ndimage.gaussian_filter(good.astype(np.float64), sigma)
    with np.errstate(invalid="ignore", divide="ignore"):
        out = num / den
    return np.where(den > 0.5, out, np.nan)
