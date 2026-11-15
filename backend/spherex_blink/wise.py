"""AllWISE 2010 W1/W2 frames on the same grid as the SPHEREx stacks (blink only, never subtracted)."""

from __future__ import annotations

import math

import httpx
import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

from . import frames, irsa

WISE_PIXEL_ARCSEC = 1.375


def allwise_frames(client: httpx.Client, ra: float, dec: float, size_deg: float, dst_wcs: WCS, shape: tuple[int, int]) -> list[dict]:
    rows = irsa.sia_query(client, "wise_allwise", ra, dec, 0.001)
    out = []
    for band in ("w1", "w2"):
        cands = [r for r in rows if r.get("access_url", "").endswith(f"-{band}-int-3.fits")]
        if not cands:
            continue
        # Start with the atlas tile closest to the field centre; mosaic additional overlapping tiles if needed.
        cands.sort(key=lambda r: _sep(ra, dec, float(r["s_ra"]), float(r["s_dec"])))
        mosaic: np.ndarray | None = None
        covered = np.zeros(shape, dtype=bool)
        for cand in cands:
            url = irsa.cutout_url(cand["access_url"], ra, dec, size_deg, "&gzip=false")
            path = irsa.fetch_cutout(client, url, slim=False)
            with fits.open(path, memmap=False) as h:
                hdu = h[0] if h[0].data is not None else h[1]
                img = hdu.data.astype(np.float64)
                w = WCS(hdu.header)
            img = frames.smooth_to_scale(img, WISE_PIXEL_ARCSEC, frames.PIXEL_SCALE_ARCSEC)
            good = np.isfinite(img)
            if good.sum() > 20:
                img = img - frames.robust_background(img[good])
            res, _, valid = frames.resample(img, np.ones_like(img), good, w, dst_wcs, shape)
            if mosaic is None:
                mosaic = res.copy()
                covered = valid.copy()
            else:
                fill = valid & ~covered
                mosaic[fill] = res[fill]
                covered |= valid
            if covered.all():
                break
        assert mosaic is not None
        r = cands[0]
        out.append(
            {
                "band": band.upper(),
                "wavelength_um": 3.4 if band == "w1" else 4.6,
                "mjd": 0.5 * (float(r["t_min"]) + float(r["t_max"])),
                "mjd_min": float(r["t_min"]),
                "mjd_max": float(r["t_max"]),
                "source_url": r["access_url"],
                "image": mosaic,
                "coverage": float(covered.mean()),
            }
        )
    return out


def _sep(ra1: float, dec1: float, ra2: float, dec2: float) -> float:
    d = math.radians
    c = math.sin(d(dec1)) * math.sin(d(dec2)) + math.cos(d(dec1)) * math.cos(d(dec2)) * math.cos(d(ra1 - ra2))
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))
