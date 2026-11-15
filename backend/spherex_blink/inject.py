"""S4: injection-recovery. Plant fake stars (and fake movers) of known brightness and speed into the real
single exposures, run the same measurement code, and see what comes back.

PSF: the cached cutouts don't carry SPHEREx's EPSF table, so the planted stars use a Gaussian whose
width is measured per detector from real, isolated, unsaturated stars in the same field (stated in the
report). S6 replaces this with the official PSF.
"""

from __future__ import annotations

import json
import math

import numpy as np

from . import frames, gaia, irsa, photometry
from .bake import OUT_ROOT

RNG_SEED = 20261115
FLUXES_MJY = [0.03, 0.06, 0.12, 0.25, 0.5, 1.0, 2.0, 4.0, 8.0]
PER_LEVEL = 12
SPEEDS_ARCSEC_YR = [1.0, 2.0, 4.0, 8.0, 16.0]
MOVER_FLUX_MJY = 5.0


def _cutouts(meta: dict):
    ra, dec = meta["wcs"]["crval"]
    size = meta["fov_arcmin"] / 60 * 1.5
    for e in meta["exposures"]:
        if not e.get("used"):
            continue
        p = irsa.cache_path(irsa.cutout_url(e["url"], ra, dec, size))
        if p.exists():
            yield e, p


def measure_psf_sigma(meta: dict, gstars: list[dict], max_exposures: int = 60) -> dict[int, float]:
    """Gaussian sigma (px) per detector from second moments of isolated G 11-14 stars in single exposures."""
    sig: dict[int, list[float]] = {}
    n = 0
    for e, p in _cutouts(meta):
        if n >= max_exposures * 6:
            break
        ex = frames.load_exposure(p)
        yr = gaia.mjd_to_year(e["mjd"])
        for s in gstars:
            if s["g"] is None or not (11 <= s["g"] <= 14):
                continue
            ra, dec = gaia.propagate(s["ra"], s["dec"], s["pmra"], s["pmdec"], 2016.0, yr)
            x, y = (float(v) for v in ex.wcs.world_to_pixel_values(ra, dec))
            xi, yi = int(round(x)), int(round(y))
            if not (5 <= xi < ex.image.shape[1] - 5 and 5 <= yi < ex.image.shape[0] - 5):
                continue
            box = ex.image[yi - 4 : yi + 5, xi - 4 : xi + 5]
            good = ex.good[yi - 4 : yi + 5, xi - 4 : xi + 5]
            if not good.all() or (ex.overflow[yi - 4 : yi + 5, xi - 4 : xi + 5]).any():
                continue
            b = box - np.median(ex.image[ex.good])
            b = np.clip(b, 0, None)
            if b.sum() <= 0 or b.max() < 10 * np.sqrt(np.median(ex.variance[ex.good])):
                continue
            yy, xx = np.mgrid[-4:5, -4:5]
            cx, cy = (b * xx).sum() / b.sum(), (b * yy).sum() / b.sum()
            m2 = ((b * ((xx - cx) ** 2 + (yy - cy) ** 2)).sum() / b.sum()) / 2
            if 0.2 < m2 < 9:
                sig.setdefault(e["detector"], []).append(math.sqrt(m2))
        n += 1
    return {d: float(np.median(v)) for d, v in sig.items() if len(v) >= 5}


def _blank_positions(meta: dict, gstars: list[dict], k: int, rng: np.random.Generator) -> list[tuple[float, float]]:
    """Random sky positions inside the field, at least 4 px from any Gaia star and the target."""
    from .validate import _to_pix

    h, w = meta["layout"]["frames"]["shape"][2:]
    yr = gaia.mjd_to_year(meta["epochs"][0]["mjd"])
    stars = [_to_pix(meta, *gaia.propagate(s["ra"], s["dec"], s["pmra"], s["pmdec"], 2016.0, yr)) for s in gstars]
    t = meta["target"]
    stars += [_to_pix(meta, *gaia.propagate(t["ra"], t["dec"], t["pmra"], t["pmdec"], t["ref_year"], gaia.mjd_to_year(e["mjd"]))) for e in meta["epochs"]]
    grid = frames.grid_wcs(*meta["wcs"]["crval"], meta["wcs"]["naxis"][0])
    out = []
    tries = 0
    while len(out) < k and tries < k * 200:
        tries += 1
        x, y = rng.uniform(6, w - 7), rng.uniform(6, h - 7)
        if all(math.hypot(x - sx, y - sy) > 4 for sx, sy in stars) and all(math.hypot(x - ox, y - oy) > 6 for ox, oy in [grid.world_to_pixel_values(*o) for o in out]):
            ra, dec = grid.pixel_to_world_values(x, y)
            out.append((float(ra), float(dec)))
    return out


def _plant(ex: frames.Exposure2D, x: float, y: float, flux_mjy: float, sigma: float) -> None:
    """Add a Gaussian star of total flux_mjy (mJy) at (x, y) to the exposure image (MJy/sr per pixel)."""
    ny, nx = ex.image.shape
    x0, x1 = max(0, int(x) - 8), min(nx, int(x) + 9)
    y0, y1 = max(0, int(y) - 8), min(ny, int(y) + 9)
    if x0 >= x1 or y0 >= y1:
        return
    yy, xx = np.mgrid[y0:y1, x0:x1]
    g = np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * sigma**2)) / (2 * math.pi * sigma**2)
    ex.image[y0:y1, x0:x1] += (flux_mjy / photometry.MJY_SR_TO_MJY_PER_PIXEL) * g


def _phot(ex: frames.Exposure2D, x: float, y: float) -> photometry.Phot:
    """Aperture photometry on a crop (fast; same function as the bake)."""
    ny, nx = ex.image.shape
    xi, yi = int(round(x)), int(round(y))
    r = 9
    x0, x1, y0, y1 = max(0, xi - r), min(nx, xi + r + 1), max(0, yi - r), min(ny, yi + r + 1)
    return photometry.aperture(ex.image[y0:y1, x0:x1], ex.variance[y0:y1, x0:x1], ex.good[y0:y1, x0:x1], ex.overflow[y0:y1, x0:x1], x - x0, y - y0)


def run_target(tid: str) -> dict | None:
    d = OUT_ROOT / tid
    if not (d / "meta.json").exists():
        return None
    meta = json.loads((d / "meta.json").read_text())
    spectra = json.loads((d / "spectra.json").read_text())
    gstars = json.loads((d / "gaia.json").read_text())["stars"]
    scale = (spectra.get("error_model") or {}).get("scale", {})
    psf = measure_psf_sigma(meta, gstars)
    rng = np.random.default_rng(RNG_SEED)
    stars = [(f, ra, dec) for f in FLUXES_MJY for ra, dec in _blank_positions(meta, gstars, PER_LEVEL, rng)]
    movers = [(v, ra, dec, rng.uniform(0, 2 * math.pi)) for v in SPEEDS_ARCSEC_YR for ra, dec in _blank_positions(meta, gstars, 3, rng)]
    ref_year = gaia.mjd_to_year(np.mean([e["mjd"] for e in meta["epochs"]]))

    # per injected star: inverse-variance mean of its single-exposure fluxes (honest errors), clean of the real sky
    acc = [[0.0, 0.0, 0] for _ in stars]  # sum(w f), sum(w), n
    grid = frames.grid_wcs(*meta["wcs"]["crval"], meta["wcs"]["naxis"][0])
    shape = tuple(meta["layout"]["frames"]["shape"][2:])
    groups: dict[int, list] = {}
    epoch_of = {}
    for ei, ep in enumerate(meta["epochs"]):
        epoch_of[ei] = (ep["mjd_min"] - 1, ep["mjd_max"] + 1)
    for e, p in _cutouts(meta):
        det = e["detector"]
        if det not in psf:
            continue
        ex = frames.load_exposure(p)
        base = ex.image.copy()
        yr = gaia.mjd_to_year(e["mjd"])
        s_err = max(1.0, scale.get(str(det), 1.0))
        for j, (f, ra, dec) in enumerate(stars):
            x, y = (float(v) for v in ex.wcs.world_to_pixel_values(ra, dec))
            ex.image[:] = base
            _plant(ex, x, y, f, psf[det])
            ph = _phot(ex, x, y)
            if math.isfinite(ph.flux) and ph.flag == photometry.FLAG_OK and ph.err > 0:
                w = 1.0 / (ph.err * s_err) ** 2
                acc[j][0] += w * ph.flux
                acc[j][1] += w
                acc[j][2] += 1
        # movers: plant all at once (they're far apart), keep the frame for per-visit stacks
        ex.image[:] = base
        for v, ra, dec, pa in movers:
            dra = v * math.sin(pa) * 1000  # mas/yr east
            ddec = v * math.cos(pa) * 1000
            pr, pd = gaia.propagate(ra, dec, dra, ddec, ref_year, yr)
            x, y = (float(q) for q in ex.wcs.world_to_pixel_values(pr, pd))
            _plant(ex, x, y, MOVER_FLUX_MJY, psf[det])
        img, var, _ = frames.resample(ex.image, ex.variance, ex.good, ex.wcs, grid, shape)
        ei = next((k for k, (a, b) in epoch_of.items() if a <= e["mjd"] <= b), None)
        if ei is not None:
            groups.setdefault(ei, []).append((det, img, var, e["mjd"]))

    # recovery of static stars
    levels = []
    for f in FLUXES_MJY:
        rows = [acc[j] for j, (ff, _, _) in enumerate(stars) if ff == f]
        rec, ratios = 0, []
        for swf, sw, n in rows:
            if sw <= 0 or n < 3:
                continue
            mean, err = swf / sw, 1 / math.sqrt(sw)
            if mean / err >= 5:
                rec += 1
                ratios.append(mean / f)
        levels.append({"flux_mjy": f, "n": len(rows), "completeness": rec / max(1, len(rows)), "bias": float(np.median(ratios)) - 1 if ratios else None,
                       "scatter": float(np.std(ratios)) if len(ratios) > 2 else None})

    # recovery of movers: per-visit stacks on the long-wavelength detectors, centroid, straight-line fit
    from .validate import centroid

    mres = []
    for v, ra, dec, pa in movers:
        pts = []
        for ei, items in sorted(groups.items()):
            its = [it for it in items if it[0] in (4, 5, 6)]
            if len(its) < 3:
                continue
            m, _, _ = frames.stack([it[1] for it in its], [it[2] for it in its])
            yr = gaia.mjd_to_year(float(np.mean([it[3] for it in its])))
            pr, pd = gaia.propagate(ra, dec, v * math.sin(pa) * 1000, v * math.cos(pa) * 1000, ref_year, yr)
            x, y = (float(q) for q in grid.world_to_pixel_values(pr, pd))
            c = centroid(m, x, y)
            if c:
                pts.append((yr, *c))
        if len(pts) >= 3:
            a = np.array(pts)
            tm = a[:, 0].mean()
            bx = np.polyfit(a[:, 0] - tm, a[:, 1], 1)[0]
            by = np.polyfit(a[:, 0] - tm, a[:, 2], 1)[0]
            meas = math.hypot(bx, by) * frames.PIXEL_SCALE_ARCSEC
            mres.append({"injected": v, "measured": meas, "baseline_yr": float(a[:, 0].max() - a[:, 0].min())})
    return {"psf_sigma_px": psf, "static": levels, "movers": mres, "n_exposures": sum(len(v) for v in groups.values())}


def limiting_flux(levels: list[dict], completeness: float = 0.9) -> float | None:
    """Faintest injected flux at and above which at least `completeness` of stars were recovered."""
    ok = None
    for lv in sorted(levels, key=lambda l: -l["flux_mjy"]):
        if lv["completeness"] >= completeness:
            ok = lv["flux_mjy"]
        else:
            break
    return ok


def expected_aperture_fraction(sigma_px: float, r_px: float = photometry.R_AP) -> float:
    """Share of a Gaussian star's light inside the photometry aperture (what a perfect measurement returns)."""
    return 1.0 - math.exp(-(r_px**2) / (2 * sigma_px**2))


def run_all(tids: list[str]) -> dict:
    out = {}
    for tid in tids:
        print(f"== {tid}", flush=True)
        r = run_target(tid)
        if not r:
            continue
        r["limit_90_mjy"] = limiting_flux(r["static"])
        sig = list(r["psf_sigma_px"].values())
        r["expected_bright_bias"] = (float(np.median([expected_aperture_fraction(v) for v in sig])) - 1) if sig else None
        mv = r["movers"]
        good = {}
        for v in SPEEDS_ARCSEC_YR:
            rows = [m for m in mv if m["injected"] == v]
            if rows:
                within = sum(abs(m["measured"] - v) <= max(0.25 * v, 0.5) for m in rows)
                good[str(v)] = {"n": len(rows), "within_25pct": within, "median_measured": float(np.median([m["measured"] for m in rows]))}
        r["mover_summary"] = good
        ok = [float(v) for v, g in good.items() if g["within_25pct"] == g["n"]]
        # slowest speed from which every faster one was also recovered
        fastest_ok = None
        for v in sorted(SPEEDS_ARCSEC_YR, reverse=True):
            g = good.get(str(v))
            if g and g["within_25pct"] == g["n"]:
                fastest_ok = v
            else:
                break
        r["min_reliable_speed"] = fastest_ok
        print(f"   limit {r['limit_90_mjy']} mJy, motions >= {fastest_ok} arcsec/yr recovered", flush=True)
        out[tid] = r
    (OUT_ROOT / "injection.json").write_text(json.dumps(out, indent=1))
    return out
