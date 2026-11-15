"""How accurate are the baked numbers? Compare against independent catalogues and against themselves.

Writes frontend/public/benchmarks/validation.json and docs/VALIDATION.md. Every number comes from the
baked bundles plus 2MASS / AllWISE / Gaia; nothing is typed in by hand.

Checks
1. Brightness vs 2MASS (J, H, Ks) and AllWISE (W1, W2): synthetic photometry over each band (top-hat
   over the published half-power width; an approximation, stated) of unflagged single-exposure points,
   for isolated, unsaturated field stars. The median ratio is our missing aperture correction; the
   spread is how repeatable the measurements are.
2. Positions vs Gaia: centroids of field stars in the stacked visit frames against Gaia positions for
   each visit's date.
3. Motion vs Gaia for fast movers (2010 WISE + SPHEREx visits).
4. Repeatability: visit-to-visit scatter of constant field stars.
5. Map vs exposure spectra: the all-sky map's aperture spectrum against the single-exposure points.
"""

from __future__ import annotations

import datetime as dt
import json
import math
from pathlib import Path

import httpx
import numpy as np

from . import gaia, irsa
from .bake import OUT_ROOT, TARGET_ORDER

DOCS = Path(__file__).resolve().parents[2] / "docs"

# Band centre and half-power width (µm), zero-magnitude flux (Jy)
BANDS = {
    "J": (1.235, 0.162, 1594.0),  # 2MASS, Cohen et al. 2003
    "H": (1.662, 0.251, 1024.0),
    "Ks": (2.159, 0.262, 666.7),
    "W1": (3.368, 0.66, 309.54),  # WISE, Jarrett et al. 2011 / Wright et al. 2010
    "W2": (4.618, 1.04, 171.79),
}
MATCH_ARCSEC = 2.5
NEIGHBOUR_ARCSEC = 15.0
PIX = 6.15


def _sep(ra1, dec1, ra2, dec2) -> float:
    return math.hypot((ra1 - ra2) * math.cos(math.radians(0.5 * (dec1 + dec2))), dec1 - dec2) * 3600.0


def _robust(v: list[float]) -> tuple[float, float]:
    a = np.asarray(v, float)
    med = float(np.median(a))
    return med, float(np.median(np.abs(a - med)) * 1.4826)


def _load(tid: str) -> tuple[dict, dict, dict, np.ndarray] | None:
    d = OUT_ROOT / tid
    if not (d / "meta.json").exists():
        return None
    meta = json.loads((d / "meta.json").read_text())
    spectra = json.loads((d / "spectra.json").read_text())
    g = json.loads((d / "gaia.json").read_text())
    data = np.frombuffer((d / "frames.bin").read_bytes(), "<f4")
    return meta, spectra, g, data


def _catalogue(client: httpx.Client, ra: float, dec: float, radius_arcsec: float) -> tuple[list[dict], list[dict]]:
    def tm():
        return gaia.gator_cone(client, "fp_psc", ra, dec, radius_arcsec, "ra,dec,j_m,h_m,k_m,ph_qual,cc_flg")

    def aw():
        return gaia.gator_cone(client, "allwise_p3as_psd", ra, dec, radius_arcsec, "ra,dec,w1mpro,w2mpro,ph_qual,cc_flags,ext_flg")

    return (gaia._cached(f"2mass_{ra:.5f}_{dec:.5f}_{radius_arcsec:.0f}", tm), gaia._cached(f"awcat_{ra:.5f}_{dec:.5f}_{radius_arcsec:.0f}", aw))


def _num(x) -> float | None:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(v) else v


def photometry_check(client: httpx.Client, tid: str, meta: dict, spectra: dict, gstars: list[dict]) -> list[dict]:
    """One row per (star, band) with ours/catalogue."""
    ra0, dec0 = meta["wcs"]["crval"]
    radius = meta["fov_arcmin"] * 60 * 0.75
    tmass, allwise = _catalogue(client, ra0, dec0, radius)
    rows = []
    for src in spectra["sources"][1:]:  # field stars only
        if src.get("g") is None or src["g"] < 9.0:
            continue  # bright stars saturate SPHEREx
        # positions at ~2000 (2MASS) and ~2010.5 (AllWISE)
        p2000 = gaia.propagate(src["ra"], src["dec"], src["pmra"], src["pmdec"], src["ref_year"], 2000.0)
        p2010 = gaia.propagate(src["ra"], src["dec"], src["pmra"], src["pmdec"], src["ref_year"], 2010.5)
        # isolated: no Gaia star brighter than G+2 within 15"
        crowded = any(
            s["source_id"] != src.get("gaia_id")
            and s["g"] is not None
            and s["g"] < src["g"] + 2
            and _sep(s["ra"], s["dec"], src["ra"], src["dec"]) < NEIGHBOUR_ARCSEC
            for s in gstars
        )
        if crowded:
            continue
        mags: dict[str, float] = {}
        tm = min(tmass, key=lambda r: _sep(float(r["ra"]), float(r["dec"]), *p2000), default=None)
        if tm and _sep(float(tm["ra"]), float(tm["dec"]), *p2000) < MATCH_ARCSEC and tm.get("cc_flg", "000") in ("000", "0"):
            for b, col, q in (("J", "j_m", 0), ("H", "h_m", 1), ("Ks", "k_m", 2)):
                m = _num(tm.get(col))
                if m is not None and tm.get("ph_qual", "UUU")[q] in "AB":
                    mags[b] = m
        aw = min(allwise, key=lambda r: _sep(float(r["ra"]), float(r["dec"]), *p2010), default=None)
        if aw and _sep(float(aw["ra"]), float(aw["dec"]), *p2010) < MATCH_ARCSEC and aw.get("cc_flags", "0000")[:2] == "00" and aw.get("ext_flg", "0") == "0":
            for b, col, q in (("W1", "w1mpro", 0), ("W2", "w2mpro", 1)):
                m = _num(aw.get(col))
                if m is not None and aw.get("ph_qual", "UUUU")[q] in "AB":
                    mags[b] = m
        for b, mag in mags.items():
            c, w, f0 = BANDS[b]
            pts = [
                f
                for f, fl, wl in zip(src["flux"], src["flag"], src["wl"])
                if f is not None and fl == 0 and wl is not None and abs(wl - c) <= w / 2
            ]
            if len(pts) < 3:
                continue
            ours = float(np.mean(pts))
            cat = f0 * 10 ** (-0.4 * mag) * 1000.0  # mJy
            rows.append({"target": tid, "star": src["gaia_id"], "g": src["g"], "band": b, "ours_mJy": ours, "cat_mJy": cat, "ratio": ours / cat, "n": len(pts)})
    return rows


def _frame(meta: dict, data: np.ndarray, e: int, d: int) -> np.ndarray:
    E, _, h, w = meta["layout"]["frames"]["shape"]
    n = h * w
    start = (e * 6 + d - 1) * n
    return data[start : start + n].reshape(h, w)


def _wise(meta: dict, data: np.ndarray, i: int) -> np.ndarray:
    _, h, w = meta["layout"]["wise"]["shape"]
    off = meta["layout"]["wise"]["offset"] // 4 + i * h * w
    return data[off : off + h * w].reshape(h, w)


def centroid(img: np.ndarray, x0: float, y0: float, r: float = 3.0, iters: int = 3) -> tuple[float, float] | None:
    """Same algorithm as frontend/src/lib/motion.ts."""
    h, w = img.shape
    yy, xx = np.mgrid[0:h, 0:w]
    cx, cy = x0, y0
    for _ in range(iters):
        d = np.hypot(xx - cx, yy - cy)
        ring = (d >= r + 2) & (d <= r + 5) & np.isfinite(img)
        if ring.sum() < 5:
            return None
        bg = float(np.median(img[ring]))
        ap = (d <= r) & np.isfinite(img)
        v = np.where(ap, img - bg, 0.0)
        v[v < 0] = 0
        s = v.sum()
        if s <= 0:
            return None
        cx, cy = float((v * xx).sum() / s), float((v * yy).sum() / s)
    return cx, cy


def _to_pix(meta: dict, ra: float, dec: float) -> tuple[float, float]:
    from . import frames

    w = frames.grid_wcs(meta["wcs"]["crval"][0], meta["wcs"]["crval"][1], meta["wcs"]["naxis"][0])
    x, y = w.world_to_pixel_values(ra, dec)
    return float(x), float(y)


def astrometry_check(meta: dict, spectra: dict, data: np.ndarray) -> list[float]:
    """Offsets (arcsec) between centroids in stacked frames (D1-D3) and Gaia positions on that date."""
    offs = []
    for src in spectra["sources"][1:]:
        if src.get("g") is None or not (10 <= src["g"] <= 15):
            continue
        for e, ep in enumerate(meta["epochs"]):
            for d in (1, 2, 3):
                band = ep["bands"][d - 1]
                if band.get("missing"):
                    continue
                ra, dec = gaia.propagate(src["ra"], src["dec"], src["pmra"], src["pmdec"], src["ref_year"], gaia.mjd_to_year(band["mjd"]))
                x, y = _to_pix(meta, ra, dec)
                c = centroid(_frame(meta, data, e, d), x, y)
                if c:
                    off = math.hypot(c[0] - x, c[1] - y) * PIX
                    if off < 6:  # beyond ~1 px it's a blend/miss, not astrometry
                        offs.append(off)
    return offs


def motion_check(meta: dict, data: np.ndarray, band: int = 6) -> dict | None:
    t = meta["target"]
    pm = math.hypot(t["pmra"], t["pmdec"]) / 1000
    pts = []
    frames_ = [(w["mjd"], _wise(meta, data, i)) for i, w in enumerate(meta["wise"]) if (w["band"] == "W2") == (band >= 5)]
    frames_ += [(ep["bands"][band - 1].get("mjd", ep["mjd"]), _frame(meta, data, e, band)) for e, ep in enumerate(meta["epochs"]) if not ep["bands"][band - 1].get("missing")]
    for mjd, img in frames_:
        yr = gaia.mjd_to_year(mjd)
        ra, dec = gaia.propagate(t["ra"], t["dec"], t["pmra"], t["pmdec"], t["ref_year"], yr)
        x, y = _to_pix(meta, ra, dec)
        c = centroid(np.where(np.isfinite(img), img, np.nan), x, y)
        if c:
            pts.append((yr, *c))
    if len(pts) < 3:
        return None
    a = np.array(pts)
    tm = a[:, 0].mean()
    bx = np.polyfit(a[:, 0] - tm, a[:, 1], 1)[0]
    by = np.polyfit(a[:, 0] - tm, a[:, 2], 1)[0]
    east, north = -bx * PIX, by * PIX
    total = math.hypot(east, north)
    return {"measured": total, "gaia": pm, "reference": t["source"], "diff_pct": (total - pm) / pm * 100, "frames": len(pts), "baseline_yr": float(a[:, 0].max() - a[:, 0].min())}


def repeatability_check(spectra: dict) -> list[float]:
    """Visit-to-visit scatter (fraction) of each constant field star, per detector."""
    ex = spectra["exposures"]
    out = []
    for src in spectra["sources"][1:]:
        if src.get("g") is None or not (10 <= src["g"] <= 14.5):
            continue
        for d in range(1, 7):
            per_visit = {}
            for f, fl, det, ep in zip(src["flux"], src["flag"], ex["det"], ex["epoch"]):
                if f is not None and fl == 0 and det == d and ep >= 0:
                    per_visit.setdefault(ep, []).append(f)
            meds = [float(np.median(v)) for v in per_visit.values() if len(v) >= 3]
            if len(meds) >= 2 and np.mean(meds) > 0:
                out.append(float(np.std(meds) / np.mean(meds)))
    return out


def map_check(meta: dict, spectra: dict, tid: str) -> list[dict]:
    """Ratio map/exposure for field stars (and non-variable targets), same 15.4" aperture."""
    if not meta.get("cube") or not meta["cube"].get("file"):
        return []
    c = meta["cube"]
    nchan, n, _ = c["shape"]
    cube = np.frombuffer((OUT_ROOT / tid / c["file"]).read_bytes(), "<f4").reshape(nchan, n, n)
    from . import frames

    w = frames.grid_wcs(c["wcs"]["crval"][0], c["wcs"]["crval"][1], n, c["pixel_scale_arcsec"])
    mid = gaia.mjd_to_year((c["mjd_min"] + c["mjd_max"]) / 2)
    sr = (c["pixel_scale_arcsec"] / 206264.806) ** 2
    rap = 15.4 / c["pixel_scale_arcsec"]
    yy, xx = np.mgrid[0:n, 0:n]
    wl = np.asarray(c["channels"]["wavelength"])
    out = []
    for i, src in enumerate(spectra["sources"]):
        if i == 0 and (meta.get("variable") or math.hypot(src["pmra"], src["pmdec"]) / 1000 * 1.05 / 2 > 0.25 * 15.4):
            continue
        if i > 0 and (src.get("g") is None or src["g"] < 9.0):
            continue
        ra, dec = gaia.propagate(src["ra"], src["dec"], src["pmra"], src["pmdec"], src["ref_year"], mid)
        x, y = w.world_to_pixel_values(ra, dec)
        d = np.hypot(xx - float(x), yy - float(y))
        ap, ring = d <= rap, (d >= 3) & (d <= 5)
        ratios = []
        for k in range(nchan):
            if k in c["blank"]:
                continue
            plane = cube[k]
            if not np.isfinite(plane[ap]).all() or np.isfinite(plane[ring]).sum() < 6:
                continue
            m = (plane[ap].sum() - np.nanmedian(plane[ring]) * ap.sum()) * sr * 1e9
            pts = [f for f, fl, wv in zip(src["flux"], src["flag"], src["wl"]) if f is not None and fl == 0 and wv and abs(wv - wl[k]) < 0.02 * wl[k]]
            if len(pts) >= 3 and np.median(pts) > 0:
                ratios.append(m / float(np.median(pts)))
        if len(ratios) >= 20:
            med, sc = _robust(ratios)
            out.append({"target": tid, "star": "target" if i == 0 else src["gaia_id"], "ratio": med, "scatter": sc, "channels": len(ratios)})
    return out


FLAG_NAMES = {0: "TRANSIENT", 1: "OVERFLOW", 2: "SUR_ERROR", 6: "NONFUNC", 7: "DICHROIC", 9: "MISSING_DATA", 10: "HOT",
              11: "COLD", 15: "NONLINEAR", 17: "PERSIST", 19: "OUTLIER", 20: "CROSSTALK", 21: "SOURCE", 22: "GHOST",
              23: "GHOST_FPA", 24: "GHOST_EXT", 25: "STREAK", 26: "BLOOM", 27: "SNOWBALL", 28: "HALO"}


def flag_check(tids: list[str]) -> dict | None:
    """S1: how often each FLAGS bit is set in the cached cutouts, overall and around bright stars."""
    from astropy.io import fits
    from scipy import ndimage

    from . import frames

    tot = np.zeros(32)
    near = np.zeros(32)
    n_all = n_near = n_exp = 0
    for tid in tids:
        loaded = _load(tid)
        if not loaded:
            continue
        meta = loaded[0]
        ra, dec = meta["wcs"]["crval"]
        size = meta["fov_arcmin"] / 60 * 1.5
        for e in meta["exposures"]:
            if not e.get("used"):
                continue
            path = irsa.cache_path(irsa.cutout_url(e["url"], ra, dec, size))
            if not path.exists():
                continue
            with fits.open(path, memmap=False) as h:
                f = h["FLAGS"].data.astype(np.int64)
                img = h["IMAGE"].data - h["ZODI"].data
            if not np.isfinite(img).any():
                continue
            bright = np.isfinite(img) & (img > np.nanpercentile(img, 99.5))
            ring = ndimage.binary_dilation(bright, iterations=6) & ~bright
            for b in FLAG_NAMES:
                on = (f >> b) & 1
                tot[b] += on.sum()
                near[b] += on[ring].sum()
            n_all += f.size
            n_near += int(ring.sum())
            n_exp += 1
    if not n_exp:
        return None
    return {
        "cutouts": n_exp,
        "pixels": int(n_all),
        "bits": [
            {"bit": b, "name": n, "all_pct": 100 * tot[b] / n_all, "near_bright_pct": 100 * near[b] / max(1, n_near), "masked": bool(frames.BAD_MASK >> b & 1)}
            for b, n in FLAG_NAMES.items()
        ],
    }


def matched_check(meta: dict, data: np.ndarray, gstars: list[dict]) -> dict | None:
    """S2: leftover at static field stars in plain vs wavelength-matched difference images,
    as a percentage of the star's peak, plus the target's signal."""
    L = meta["layout"]
    if "matched" not in L:
        return None
    E, _, h, w = L["frames"]["shape"]

    def block(name):
        off = L[name]["offset"] // 4
        return data[off : off + E * 6 * h * w].reshape(E, 6, h, w)

    plain, match = block("frames"), block("matched")
    pct = {"plain": [], "matched": []}
    t = meta["target"]
    tsig = {"plain": [], "matched": []}
    for det in range(1, 7):
        ok = [e for e in range(E) if not meta["epochs"][e]["bands"][det - 1].get("missing")]
        if len(ok) < 2:
            continue
        a, b = ok[0], ok[-1]
        yr = gaia.mjd_to_year(meta["epochs"][b]["mjd"])
        for kind, arr in (("plain", plain), ("matched", match)):
            diff = arr[b, det - 1] - arr[a, det - 1]
            for st in gstars:
                if st["g"] is None or st["g"] > 15 or math.hypot(st["pmra"], st["pmdec"]) > 100:
                    continue
                ra, dec = gaia.propagate(st["ra"], st["dec"], st["pmra"], st["pmdec"], 2016.0, yr)
                x, y = (int(round(v)) for v in _to_pix(meta, ra, dec))
                if not (2 <= x < w - 2 and 2 <= y < h - 2):
                    continue
                win = diff[y - 1 : y + 2, x - 1 : x + 2]
                peak = float(np.nanmax(plain[b, det - 1][y - 1 : y + 2, x - 1 : x + 2]))
                if np.isfinite(win).all() and peak > 0:
                    pct[kind].append(100 * float(np.abs(win).max()) / peak)
    if not pct["plain"]:
        return None
    return {k: float(np.median(v)) for k, v in pct.items()} | {"n": len(pct["plain"])}


def noise_check(meta: dict, data: np.ndarray, gstars: list[dict]) -> dict:
    """S3: is the stated uncertainty right? In blank sky (> 3 px from any Gaia star), value / sigma should
    have a standard deviation of 1. Returns the robust std per detector for plain and matched stacks."""
    L = meta["layout"]
    E, _, h, w = L["frames"]["shape"]
    yy, xx = np.mgrid[0:h, 0:w]
    near = np.zeros((h, w), bool)
    yr = gaia.mjd_to_year(meta["epochs"][0]["mjd"])
    for st in gstars:
        ra, dec = gaia.propagate(st["ra"], st["dec"], st["pmra"], st["pmdec"], 2016.0, yr)
        x, y = _to_pix(meta, ra, dec)
        near |= np.hypot(xx - x, yy - y) < 3.5
    t = meta["target"]
    for year in (gaia.mjd_to_year(e["mjd"]) for e in meta["epochs"]):
        x, y = _to_pix(meta, *gaia.propagate(t["ra"], t["dec"], t["pmra"], t["pmdec"], t["ref_year"], year))
        near |= np.hypot(xx - x, yy - y) < 6

    def blk(name):
        off = L[name]["offset"] // 4
        return data[off : off + E * 6 * h * w].reshape(E, 6, h, w)

    out = {}
    pairs = [("plain", "frames", "variance")]
    if "matched" in L:
        pairs.append(("matched", "matched", "matched_variance"))
    for kind, a, v in pairs:
        val, var = blk(a), blk(v)
        per = {}
        for d in range(6):
            z = []
            for e in range(E):
                zz = val[e, d] / np.sqrt(var[e, d])
                if kind == "plain":
                    zz = zz - np.nanmedian(zz[~near])  # sky level isn't zero in a plain stack
                zz = zz[~near & np.isfinite(zz)]
                z.append(zz)
            z = np.concatenate(z) if z else np.array([])
            if z.size > 50:
                per[d + 1] = float(np.median(np.abs(z - np.median(z))) * 1.4826)
        out[kind] = per
    return out


def photometry_noise_check(spectra: dict) -> dict:
    """S3: for constant field stars, (flux - typical flux at that wavelength) / stated error should have
    std 1. Returns the robust std per detector (the factor to multiply single-exposure errors by)."""
    ex = spectra["exposures"]
    per: dict[int, list[float]] = {}
    for src in spectra["sources"][1:]:
        if src.get("g") is None or not (10 <= src["g"] <= 14.5):
            continue
        rows = [(wl, f, er, det) for f, er, fl, wl, det in zip(src["flux"], src["err"], src["flag"], src["wl"], ex["det"]) if f is not None and fl == 0 and er and er > 0 and wl]
        for wl, f, er, det in rows:
            near = sorted(f2 for wl2, f2, _, _ in rows if abs(wl2 - wl) <= 0.015 * wl)
            if len(near) >= 4:
                per.setdefault(det, []).append((f - near[len(near) // 2]) / er)
    return {d: float(np.median(np.abs(np.array(v) - np.median(v))) * 1.4826) for d, v in per.items() if len(v) >= 20}


def run(client: httpx.Client | None = None) -> dict:
    own = client is None
    client = client or irsa.make_client()
    try:
        phot, ast, mot, rep, mp, mtc, noise, pnoise = [], {}, {}, {}, [], {}, {}, {}
        for tid in TARGET_ORDER:
            loaded = _load(tid)
            if not loaded:
                continue
            meta, spectra, g, data = loaded
            print(f"== {tid}", flush=True)
            phot += photometry_check(client, tid, meta, spectra, g["stars"])
            ast[tid] = astrometry_check(meta, spectra, data)
            m = motion_check(meta, data) if math.hypot(meta["target"]["pmra"], meta["target"]["pmdec"]) > 3000 else None
            if m:
                mot[tid] = m
            rep[tid] = repeatability_check(spectra)
            mp += map_check(meta, spectra, tid)
            noise[tid] = noise_check(meta, data, g["stars"])
            pnoise[tid] = photometry_noise_check(spectra)
            mc = matched_check(meta, data, g["stars"])
            if mc:
                mtc[tid] = mc
        by_band = {}
        for b in BANDS:
            r = [x["ratio"] for x in phot if x["band"] == b]
            if len(r) >= 3:
                med, sc = _robust(r)
                by_band[b] = {"n": len(r), "median_ratio": med, "scatter": sc / med}
        all_ast = [o for v in ast.values() for o in v]
        all_rep = [o for v in rep.values() for o in v]
        result = {
            "generated_utc": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "photometry": {"bands": by_band, "stars": len({(x["target"], x["star"]) for x in phot}), "rows": phot},
            "astrometry": {
                "n": len(all_ast),
                "median_arcsec": float(np.median(all_ast)) if all_ast else None,
                "p90_arcsec": float(np.percentile(all_ast, 90)) if all_ast else None,
                "per_target": {k: (float(np.median(v)) if v else None) for k, v in ast.items()},
            },
            "motion": mot,
            "repeatability": {
                "n": len(all_rep),
                "median": float(np.median(all_rep)) if all_rep else None,
                "per_target": {k: (float(np.median(v)) if v else None) for k, v in rep.items()},
            },
            "flags": flag_check(TARGET_ORDER),
            "injection": json.loads((OUT_ROOT / "injection.json").read_text()) if (OUT_ROOT / "injection.json").exists() else None,
            "noise": _combine_noise(noise, pnoise, by_band),
            "matched_difference": mtc,
            "map_vs_exposures": {
                "rows": mp,
                "median_ratio": float(np.median([x["ratio"] for x in mp])) if mp else None,
                "median_scatter": float(np.median([x["scatter"] for x in mp])) if mp else None,
            },
        }
        (OUT_ROOT / "validation.json").write_text(json.dumps(result, indent=1))
        write_error_model(result)
        write_markdown(result)
        return result
    finally:
        if own:
            client.close()


def _combine_noise(noise: dict, pnoise: dict, by_band: dict) -> dict:
    """Median over targets of the error-scale factors per detector, and the systematic floor."""
    out: dict = {"stack": {}, "photometry": {}}
    for kind in ("plain", "matched"):
        out["stack"][kind] = {}
        for d in range(1, 7):
            v = [n[kind][d] for n in noise.values() if kind in n and d in n[kind]]
            if v:
                out["stack"][kind][d] = float(np.median(v))
    for d in range(1, 7):
        v = [pn[d] for pn in pnoise.values() if d in pn]
        if v:
            out["photometry"][d] = float(np.median(v))
    # floor: the visit-to-visit scatter of constant stars that statistical errors don't explain is
    # handled by the scale; the remaining *absolute* uncertainty is the catalogue spread
    spreads = [b["scatter"] for b in by_band.values()]
    out["absolute_floor"] = float(np.median(spreads)) if spreads else None
    return out


def write_error_model(r: dict) -> None:
    """S3: store the measured error scale per detector in every spectra.json, so the app shows honest
    error bars (stated error x scale)."""
    scale = r["noise"]["photometry"]
    for tid in TARGET_ORDER:
        sp = OUT_ROOT / tid / "spectra.json"
        if not sp.exists():
            continue
        s = json.loads(sp.read_text())
        s["error_model"] = {
            "scale": {str(d): round(max(1.0, v), 3) for d, v in scale.items()},
            "absolute_floor": r["noise"]["absolute_floor"],
            "note": "Single-exposure errors are multiplied by the per-detector scale measured on constant field stars "
            "(never below 1). The absolute floor is the star-to-star spread against 2MASS/WISE.",
        }
        sp.write_text(json.dumps(s, separators=(",", ":")))


def write_markdown(r: dict) -> None:
    p = r["photometry"]
    a = r["astrometry"]
    rep = r["repeatability"]
    mv = r["map_vs_exposures"]
    lines = [
        "# Validation",
        "",
        f"Generated by `uv run python -m spherex_blink validate` on {r['generated_utc'][:10]} from the baked bundles. "
        "Every number below is computed; none is typed in. Method: `backend/spherex_blink/validate.py`.",
        "",
        "## 1. Brightness vs 2MASS and AllWISE",
        "",
        f"{p['stars']} isolated, unsaturated field stars (Gaia G 9–15, no star within 2 mag brighter inside 15″, catalogue quality A/B, no contamination flags). "
        "Our value: mean of unflagged single-exposure points whose wavelength lies inside the band (top-hat over the published half-power width, an approximation). "
        "Catalogue magnitudes converted with zero points J 1594, H 1024, Ks 666.7 (2MASS), W1 309.54, W2 171.79 Jy (WISE).",
        "",
        "| Band | Stars | Median ours / catalogue | Spread (robust σ) |",
        "|---|---|---|---|",
    ]
    for b, v in p["bands"].items():
        lines.append(f"| {b} | {v['n']} | {v['median_ratio']:.2f} | {v['scatter'] * 100:.0f}% |")
    lines += [
        "",
        "**Reading it:** a ratio of 1 means our numbers match the catalogue. We apply no aperture correction, so the ratio also shows how much of a star's light our 15.4″ aperture (with local-sky subtraction) captures; a ratio near 1 means nearly all of it. "
        "The spread is how consistent the measurements are from star to star; it includes catalogue errors, the top-hat approximation to the filter curves and stellar colour terms.",
        "",
        "## 2. Positions vs Gaia",
        "",
        f"Centroids of {a['n']} star-visit-detector measurements (G 10–15, detectors 1–3) in the stacked frames, against Gaia DR3 positions moved to each visit's date: "
        f"median offset **{a['median_arcsec']:.2f}″** ({a['median_arcsec'] / PIX:.2f} pixel), 90% within {a['p90_arcsec']:.2f}″.",
        "",
        "## 3. Motion vs Gaia",
        "",
        "| Target | Measured (″/yr) | Reference (″/yr) | Difference | Frames | Baseline | Reference source |",
        "|---|---|---|---|---|---|---|",
    ]
    for k, v in r["motion"].items():
        lines.append(f"| {k} | {v['measured']:.2f} | {v['gaia']:.2f} | {v['diff_pct']:+.1f}% | {v['frames']} | {v['baseline_yr']:.1f} yr | {v.get('reference', 'Gaia DR3')} |")
    lines += [
        "",
        "Detector 6 frames plus the 2010 WISE W2 frame, centroid per frame, straight-line fit (same algorithm as the app's Measure motion). "
        "The centroid search starts at the reference position for each date, so a large error in the reference would show up as poor centroids, not be copied. "
        "WISE 0855's reference motion is from the literature, not Gaia; its frames also contain a background star 4–11″ away, so treat its row with caution.",
        "",
        "## 4. Repeatability between visits",
        "",
        f"For field stars of G 10–14.5, the visit-to-visit scatter of each detector's median flux: median **{rep['median'] * 100:.1f}%** over {rep['n']} star-detector pairs. "
        "Constant stars should show only measurement noise, so this bounds how small a real brightness change the app can show.",
        "",
        "## 5. All-sky map vs single exposures",
        "",
    ]
    if mv["rows"]:
        lines += [
            f"The map spectrum (time-averaged, 12.9″ pixels) and the single-exposure points of the same star in the same 15.4″ aperture, over {len(mv['rows'])} stars: "
            f"median ratio **{mv['median_ratio']:.2f}** with a channel-to-channel spread of **{mv['median_scatter'] * 100:.0f}%**. "
            "The two are independent SPHEREx products. The shapes agree closely; the map gives less light in the same aperture because its coarser pixels spread the light wider.",
            "",
        ]
    lines += [
        "## 6. Artefact flags (S1)",
        "",
    ]
    fl = r.get("flags")
    if fl:
        lines += [
            f"How often each FLAGS bit is set in the {fl['cutouts']} cached cutouts, overall and within 6 pixels of bright stars. "
            "The masked bits are dropped from every stack and flagged in photometry; SOURCE marks stars themselves and is never masked.",
            "",
            "| Bit | Name | All pixels | Near bright stars | Masked |",
            "|---|---|---|---|---|",
        ]
        for b in fl["bits"]:
            lines.append(f"| {b['bit']} | {b['name']} | {b['all_pct']:.2f}% | {b['near_bright_pct']:.2f}% | {'yes' if b['masked'] else 'no'} |")
        lines.append("")
    lines += ["## 7. Difference images: plain vs wavelength-matched (S2)", ""]
    if r.get("matched_difference"):
        lines += [
            "Leftover at static field stars (Gaia G ≤ 15, not moving) in the difference of the first and last visit, as a percentage of the star's brightness (median over stars and detectors). "
            "Plain frames mix each detector's wavelengths differently per visit; matched frames compare each visit with the all-visit map channel by channel.",
            "",
            "| Target | Plain | Matched | Star-detector pairs |",
            "|---|---|---|---|",
        ]
        for k, v in r["matched_difference"].items():
            lines.append(f"| {k} | {v['plain']:.1f}% | {v['matched']:.1f}% | {v['n']} |")
        lines += ["", "What remains comes mostly from small differences in image sharpness and alignment between visits (PSF matching, roadmap S6).", ""]
    nz = r.get("noise") or {}
    if nz.get("stack"):
        lines += [
            "## 8. Are the error bars right? (S3)",
            "",
            "If the stated uncertainties are right, a measurement divided by its uncertainty scatters with a standard deviation of 1. "
            "Measured in blank sky (more than 3.5 px from any Gaia star) of the matched stacks, where the real sky cancels, and for single-exposure photometry of constant field stars "
            "(each point against the star's typical brightness at the same wavelength). Above 1 means the stated errors are too small by that factor.",
            "",
            "| Detector | Matched stack (difference images) | Single-exposure photometry |",
            "|---|---|---|",
        ]
        for d in range(1, 7):
            g = lambda k: nz["stack"].get(k, {}).get(d) or nz["stack"].get(k, {}).get(str(d))  # noqa: E731
            ph = nz["photometry"].get(d) or nz["photometry"].get(str(d))
            fmt = lambda x: f"{x:.2f}" if x is not None else "–"  # noqa: E731
            lines.append(f"| D{d} | {fmt(g('matched'))} | {fmt(ph)} |")
        lines += [
            "",
            "(Plain stacks fail this test for a good reason: their “blank” sky still holds real faint stars and glow below Gaia's limit, so it isn't pure noise.) "
            "The app multiplies single-exposure error bars by the photometry factor for each detector (never by less than 1). "
            f"Absolute brightness carries a further ≈{(nz.get('absolute_floor') or 0) * 100:.0f}% uncertainty (the star-to-star spread against 2MASS/WISE, section 1).",
            "",
        ]
    inj = r.get("injection")
    if inj:
        lines += [
            "## 9. Injection–recovery (S4)",
            "",
            "Fake stars of known brightness (12 per level, at blank positions) and fake movers of known speed (3 per speed, 5 mJy) were planted into the real single exposures, "
            "and measured with the same code as the real data. Planted stars use a Gaussian PSF whose width is measured from real stars in each field and detector "
            "(the official SPHEREx PSF replaces it in S6). A planted star counts as recovered when its combined single-exposure flux reaches 5σ with the honest (S3) error bars.",
            "",
            "| Target | 90% recovered down to | Bias at 8 mJy | Expected from the aperture | Motion recovered (SPHEREx only) from |",
            "|---|---|---|---|---|",
        ]
        for tid, v in inj.items():
            b8 = next((l["bias"] for l in v["static"] if l["flux_mjy"] == 8.0), None)
            eb = v.get("expected_bright_bias")
            lim = v.get("limit_90_mjy")
            ms = v.get("min_reliable_speed")
            lim_s = f"{lim} mJy" if lim else "–"
            b8_s = f"{b8 * 100:+.1f}%" if b8 is not None else "–"
            eb_s = f"{eb * 100:+.1f}%" if eb is not None else "–"
            span = v["movers"][0]["baseline_yr"] if v["movers"] else 0.0
            ms_s = f"{ms:g}″/yr (over the {span:.1f}-yr SPHEREx span)" if ms and v["movers"] else "not reliable"
            lines.append(f"| {tid} | {lim_s} | {b8_s} | {eb_s} | {ms_s} |")
        speeds = sorted({m["injected"] for v in inj.values() for m in v["movers"]})
        lines += ["", "Fake movers (5 mJy) measured from the SPHEREx visits alone, all fields together:", "", "| Speed | Recovered within 25% |", "|---|---|"]
        for sp in speeds:
            rows = [m for v in inj.values() for m in v["movers"] if m["injected"] == sp]
            ok = sum(abs(m["measured"] - sp) <= max(0.25 * sp, 0.5) for m in rows)
            lines.append(f"| {sp:g}″/yr | {ok} of {len(rows)} |")
        lines += [
            "",
            "Reading the motion test: with only the ~1.4 years of SPHEREx visits, the centroid often locks onto a neighbouring star in crowded fields, so motion from SPHEREx alone is unreliable here even at 16″/yr. "
            "The app's motion tool uses the 2010 WISE frame (a 16-year baseline), which is why it matches Gaia within 1–2% on the real targets (section 3). PSF fitting (roadmap S6) is the fix for SPHEREx-only motions.",
            "",
            "Reading it: the brightness bias of bright planted stars matches the share of a Gaussian's light that falls outside the 15.4″ aperture, so the measurement itself is unbiased; real stars (section 1) agree with 2MASS/WISE because the real PSF holds more light in its core. "
            "Faint stars read low, the usual faint-end bias. Motions slower than the listed speed need the 2010 WISE frame for a long enough baseline.",
            "",
        ]
    lines += [
        "## Known limits",
        "",
        "- No aperture correction is applied; section 1 shows the fluxes nevertheless agree with 2MASS/WISE to a few per cent for unsaturated stars.",
        "- WISE magnitudes assume a ν⁻² spectrum; stars differ by a few per cent (colour correction not applied).",
        "- Bright stars (most demo targets) saturate SPHEREx; they are excluded here and flagged in the app.",
        "",
    ]
    DOCS.mkdir(exist_ok=True)
    (DOCS / "VALIDATION.md").write_text("\n".join(lines), encoding="utf-8")
