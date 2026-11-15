"""NEOWISE yearly frames (2014-2024): WISE kept imaging the whole sky every six months after AllWISE.
Stacking each visit gives ~20 extra epochs between the 2010 AllWISE image and SPHEREx, so a nearby
star's motion becomes a long, smooth video and motion fits get a long baseline.

Single-exposure (L1b) frames from IRSA's `neowiser` collection; per visit and band we take up to
`per_visit` exposures spread in time, subtract each one's background, low-pass them to the 6.15" grid
and take the median (which also removes cosmic rays). Different telescope and units (DN): blink only.
"""

from __future__ import annotations

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

from . import frames, irsa

WISE_PIXEL_ARCSEC = 2.75  # NEOWISE single-exposure pixels
BANDS = {"W1": 3.4, "W2": 4.6}


def _rows(client, ra: float, dec: float) -> list[dict]:
    rows = irsa.sia_query(client, "neowiser", ra, dec, 0.001)
    return [r for r in rows if r.get("dataproduct_subtype") == "science" and r.get("access_url", "").endswith("-int-1b.fits")]


def neowise_frames(client, ra: float, dec: float, size_deg: float, dst_wcs: WCS, shape: tuple[int, int], per_visit: int = 8, log=print) -> list[dict]:
    rows = _rows(client, ra, dec)
    if not rows:
        return []
    picks: list[tuple[str, int, dict]] = []  # (band, visit index, row)
    for band in BANDS:
        rb = [r for r in rows if r.get("energy_bandpassname") == band]
        if not rb:
            continue
        mjds = [0.5 * (float(r["t_min"]) + float(r["t_max"])) for r in rb]
        for v, g in enumerate(frames.group_epochs(mjds)):
            g = sorted(g, key=lambda i: mjds[i])
            if len(g) > per_visit:
                g = [g[int(k)] for k in np.unique(np.round(np.linspace(0, len(g) - 1, per_visit)).astype(int))]
            picks += [(band, v, rb[i]) for i in g]
    urls = [irsa.cutout_url(r["access_url"], ra, dec, size_deg, "&gzip=false") for _, _, r in picks]
    log(f"  NEOWISE: {len(picks)} single exposures in {len({(b, v) for b, v, _ in picks})} visit-bands", flush=True)
    paths = irsa.fetch_many(client, urls, slim=False)
    stacks: dict[tuple[str, int], list] = {}
    for (band, v, r), u in zip(picks, urls):
        p = paths.get(u)
        if p is None:
            continue
        try:
            with fits.open(p, memmap=False) as h:
                hdu = h[0] if h[0].data is not None else h[1]
                img = hdu.data.astype(np.float64)
                w = WCS(hdu.header)
        except (OSError, ValueError, IndexError):
            continue
        good = np.isfinite(img)
        if good.sum() < 20:
            continue
        img = img - frames.robust_background(img[good])
        img = frames.smooth_to_scale(img, WISE_PIXEL_ARCSEC, frames.PIXEL_SCALE_ARCSEC)
        good = np.isfinite(img)
        res, _, valid = frames.resample(np.nan_to_num(img), np.ones_like(img), good, w, dst_wcs, shape)
        if valid.mean() < 0.3:
            continue
        mjd = 0.5 * (float(r["t_min"]) + float(r["t_max"]))
        stacks.setdefault((band, v), []).append((mjd, res))
    out = []
    for (band, v), items in sorted(stacks.items(), key=lambda kv: (kv[0][0], np.mean([m for m, _ in kv[1]]))):
        if len(items) < 3:
            continue
        cube = np.stack([im for _, im in items])
        with np.errstate(invalid="ignore"):
            med = np.nanmedian(cube, axis=0)
        mj = [m for m, _ in items]
        out.append({"band": band, "wavelength_um": BANDS[band], "mjd": float(np.mean(mj)), "mjd_min": float(min(mj)), "mjd_max": float(max(mj)), "n": len(items), "image": med.astype(np.float32)})
    out.sort(key=lambda f: (f["band"], f["mjd"]))
    return out
