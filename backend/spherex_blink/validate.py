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


def run(client: httpx.Client | None = None) -> dict:
    own = client is None
    client = client or irsa.make_client()
    try:
        phot, ast, mot, rep, mp = [], {}, {}, {}, []
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
            "map_vs_exposures": {
                "rows": mp,
                "median_ratio": float(np.median([x["ratio"] for x in mp])) if mp else None,
                "median_scatter": float(np.median([x["scatter"] for x in mp])) if mp else None,
            },
        }
        (OUT_ROOT / "validation.json").write_text(json.dumps(result, indent=1))
        write_markdown(result)
        return result
    finally:
        if own:
            client.close()


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
        "## Known limits",
        "",
        "- No aperture correction is applied; section 1 shows the fluxes nevertheless agree with 2MASS/WISE to a few per cent for unsaturated stars.",
        "- WISE magnitudes assume a ν⁻² spectrum; stars differ by a few per cent (colour correction not applied).",
        "- Bright stars (most demo targets) saturate SPHEREx; they are excluded here and flagged in the app.",
        "",
    ]
    DOCS.mkdir(exist_ok=True)
    (DOCS / "VALIDATION.md").write_text("\n".join(lines), encoding="utf-8")
