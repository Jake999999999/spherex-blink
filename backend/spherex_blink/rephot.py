"""Re-measure a baked target's photometry from the cutout cache (no new downloads apart from the six
EPSF tables): adds PSF-fit fluxes (S6) to spectra.json next to the aperture sums.

    uv run python -m spherex_blink rephot [ids…] [--study]
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import httpx
import numpy as np
from astropy.io import fits

from . import frames, gaia, irsa, psf
from .bake import OUT_ROOT

ORIENTS = ("as-is", "transpose", "flipx", "flipy")


def used_exposures(meta: dict) -> list[tuple[dict, Path]]:
    cra, cdec = meta["wcs"]["crval"]
    size = meta["fov_arcmin"] / 60.0 * 1.5
    out = []
    for e in meta["exposures"]:
        if e.get("used"):
            out.append((e, irsa.cache_path(irsa.cutout_url(e["url"], cra, cdec, size))))
    return out


def epsf_tables(client: httpx.Client, metas: list[dict]) -> dict[int, psf.Epsf]:
    keys: dict[int, str] = {}
    for m in metas:
        for e in m["exposures"]:
            k = psf.s3_key_from_url(e["url"])
            if e.get("used") and k and e["detector"] not in keys:
                keys[e["detector"]] = k
    return {d: psf.load_epsf(client, d, k) for d, k in sorted(keys.items())}


def measure(tid: str, epsfs: dict[int, psf.Epsf], orient: str = "as-is", only: set[str] | None = None, limit: int | None = None, root: Path = OUT_ROOT) -> dict:
    """PSF fluxes for every source of spectra.json, aligned with its exposure columns."""
    d = root / tid
    meta = json.loads((d / "meta.json").read_text())
    spectra = json.loads((d / "spectra.json").read_text())
    gj = json.loads((d / "gaia.json").read_text())
    gstars = [{**g, "ref_year": gj.get("ref_year", gaia.GAIA_EPOCH)} for g in gj["stars"]]
    used = used_exposures(meta)
    n = len(spectra["exposures"]["mjd"])
    if len(used) != n:
        raise RuntimeError(f"{tid}: {len(used)} used exposures in meta.json but {n} in spectra.json")
    srcs = [s for s in spectra["sources"] if only is None or s["id"] in only]
    res = {s["id"]: {"flux": [None] * n, "err": [None] * n, "flag": [0] * n, "chi2": [None] * n} for s in srcs}
    for i, (e, path) in enumerate(used):
        if limit is not None and i >= limit:
            break
        if abs(e["mjd"] - spectra["exposures"]["mjd"][i]) > 1e-3:
            raise RuntimeError(f"{tid}: exposure order differs at {i}")
        if not path.exists():
            continue
        ex = frames.load_exposure(path)
        hdr = fits.getheader(path, "IMAGE")
        ox, oy = psf.active_offset(hdr)
        tab = epsfs[ex.detector]
        year = gaia.mjd_to_year(ex.mjd)

        def pos(s):
            ra, dec = gaia.propagate(s["ra"], s["dec"], s.get("pmra") or 0.0, s.get("pmdec") or 0.0, s.get("ref_year", gaia.GAIA_EPOCH), year)
            x, y = ex.wcs.world_to_pixel_values(ra, dec)
            return float(x), float(y)

        neigh_all = []
        for g in gstars:
            x, y = pos(g)
            if -5 <= x <= ex.image.shape[1] + 5 and -5 <= y <= ex.image.shape[0] + 5:
                neigh_all.append((g["source_id"], x, y))
        for s in srcs:
            x, y = pos(s)
            k = psf.nearest_bin(tab, x + ox, y + oy)
            nb = [
                (nx_, ny_, tab.psfs[psf.nearest_bin(tab, nx_ + ox, ny_ + oy)])
                for sid, nx_, ny_ in neigh_all
                if sid != s.get("gaia_id") and 0.7 ** 2 < (nx_ - x) ** 2 + (ny_ - y) ** 2 <= (psf.R_FIT + 2.0) ** 2
            ]
            p, chi2 = psf.fit(ex.image, ex.variance, ex.good, ex.overflow, x, y, tab.psfs[k], nb, orient)
            r = res[s["id"]]
            ok = math.isfinite(p.flux)
            r["flux"][i] = round(p.flux, 4) if ok else None
            r["err"][i] = round(p.err, 4) if ok else None
            r["flag"][i] = p.flag
            r["chi2"][i] = round(chi2, 3) if math.isfinite(chi2) else None
    return res


def apply(tid: str, res: dict, orient: str, root: Path = OUT_ROOT) -> None:
    """Write PSF columns into spectra.json (aperture columns stay)."""
    p = root / tid / "spectra.json"
    sp = json.loads(p.read_text())
    for s in sp["sources"]:
        r = res.get(s["id"])
        if r is None:
            continue
        s["psf_flux"], s["psf_err"], s["psf_flag"], s["psf_chi2"] = r["flux"], r["err"], r["flag"], r["chi2"]
    sp["psf"] = {
        "method": "forced fit of SPHEREx's official ePSF (EPSF table of the level-2 files, nearest detector region), "
        f"amplitude only, pixels within {psf.R_FIT * frames.PIXEL_SCALE_ARCSEC:.1f}\" of the source, local sky from the aperture annulus, "
        "Gaia neighbours within the fit fitted at the same time; flux is the total in the 33x33 ePSF box",
        "orientation": orient,
        "units": "mJy",
    }
    p.write_text(json.dumps(sp, separators=(",", ":")))


def run(tids: list[str], client: httpx.Client | None = None, root: Path = OUT_ROOT) -> None:
    """Add PSF columns to each target's spectra.json (the `rephot` command, and the end of every bake)."""
    own = client is None
    client = client or irsa.make_client()
    try:
        metas = [json.loads((root / t / "meta.json").read_text()) for t in tids]
        epsfs = epsf_tables(client, metas)
        for t in tids:
            res = measure(t, epsfs, "as-is", root=root)
            apply(t, res, "as-is", root=root)
            n = sum(1 for r in res.values() for f in r["flux"] if f is not None)
            print(f"  PSF photometry: {n} measurements for {len(res)} sources ({t})", flush=True)
    finally:
        if own:
            client.close()


def chi2_by_orientation(tids: list[str], epsfs: dict[int, psf.Epsf], per_target: int = 40) -> dict[str, float]:
    """Median reduced chi² of isolated, unsaturated field stars for each ePSF orientation: tells which
    way the table's 33x33 images are laid out relative to the image pixels."""
    out = {}
    for o in ORIENTS:
        vals = []
        for tid in tids:
            sp = json.loads((OUT_ROOT / tid / "spectra.json").read_text())
            ids = {s["id"] for s in sp["sources"][1:] if s.get("g") and 10 <= s["g"] <= 13.5}
            r = measure(tid, epsfs, o, only=ids, limit=per_target)
            vals += [c for v in r.values() for c in v["chi2"] if c is not None]
        out[o] = float(np.median(vals)) if vals else math.nan
    return out
