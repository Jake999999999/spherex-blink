"""Bake a demo target into a static bundle: frontend/public/benchmarks/<id>/{meta.json, frames.bin, gaia.json}.

frames.bin layout (little-endian float32, row-major, row 0 = south edge since FITS y grows north):
  [E, 6, H, W] stacked SPHEREx frames (MJy/sr, NaN = no data)
  [E, 6, H, W] variance of the stack ((MJy/sr)^2)
  [Nw, H, W]   AllWISE frames (DN, background-subtracted)
Offsets in bytes are in meta.json "layout".
"""

from __future__ import annotations

import datetime as dt
import json
import math
from pathlib import Path

import httpx
import numpy as np

from . import __version__, frames, gaia, irsa, wise
from .targets import TARGETS, Target

OUT_ROOT = Path(__file__).resolve().parents[2] / "frontend" / "public" / "benchmarks"
MIN_PER_CELL = 3
WISE_YEAR = 2010.4
NOW_YEAR = 2026.5
MAX_BUNDLE_BYTES = 4 * 1024 * 1024


def resolve_motion(client: httpx.Client, t: Target) -> dict:
    """Reference position + proper motion for the target, with its source."""
    if t.gaia_id:
        s = gaia.source(client, t.gaia_id)
        return {
            "ra": s["ra"], "dec": s["dec"], "pmra": s["pmra"], "pmdec": s["pmdec"],
            "parallax": s["parallax"], "g": s["g"], "ref_year": gaia.GAIA_EPOCH,
            "source": f"Gaia DR3 {t.gaia_id}",
        }
    assert t.allwise_seed and t.pm_mas_yr
    a = gaia.allwise_source(client, *t.allwise_seed)
    return {
        "ra": a["ra"], "dec": a["dec"], "pmra": t.pm_mas_yr[0], "pmdec": t.pm_mas_yr[1],
        "parallax": None, "g": None, "ref_year": gaia.mjd_to_year(a["mjd"]),
        "source": f"AllWISE {a['designation']} position; motion {t.pm_source}",
        "w1": a["w1"], "w2": a["w2"],
    }


def position_at(m: dict, year: float) -> tuple[float, float]:
    return gaia.propagate(m["ra"], m["dec"], m["pmra"], m["pmdec"], m["ref_year"], year)


def subsample(exps: list[irsa.Exposure], max_n: int) -> list[irsa.Exposure]:
    """Evenly in time, per detector, so every detector keeps its share."""
    if len(exps) <= max_n:
        return exps
    per = max(1, max_n // 6)
    out = []
    for d in range(1, 7):
        ed = sorted((e for e in exps if e.detector == d), key=lambda e: e.mjd)
        if len(ed) <= per:
            out.extend(ed)
        else:
            idx = np.unique(np.round(np.linspace(0, len(ed) - 1, per)).astype(int))
            out.extend(ed[i] for i in idx)
    return sorted(out, key=lambda e: (e.mjd, e.detector))


def _progress(done: int, failed: int, total: int) -> None:
    if done + failed == total or (done + failed) % 20 == 0:
        print(f"  cutouts {done}/{total} ok, {failed} failed", flush=True)


def bake(target_id: str, client: httpx.Client | None = None, out_root: Path = OUT_ROOT) -> dict:
    t = TARGETS[target_id]
    own = client is None
    client = client or irsa.make_client()
    try:
        print(f"== {t.name}", flush=True)
        motion = resolve_motion(client, t)
        p_now = position_at(motion, NOW_YEAR)
        p_wise = position_at(motion, WISE_YEAR)
        # Centre between the 2010 and 2026 positions so both are in the frame.
        cra = 0.5 * (p_now[0] + p_wise[0])
        cdec = 0.5 * (p_now[1] + p_wise[1])
        npix = int(math.ceil(t.fov_arcmin * 60.0 / frames.PIXEL_SCALE_ARCSEC)) | 1
        shape = (npix, npix)
        grid = frames.grid_wcs(cra, cdec, npix)
        size_deg = t.fov_arcmin / 60.0 * 1.5  # room for detector rotation

        all_exps = irsa.spherex_exposures(client, cra, cdec)
        exps = subsample(all_exps, t.max_exposures)
        print(f"  {len(all_exps)} exposures cover the field; using {len(exps)}", flush=True)
        urls = [irsa.cutout_url(e.url, cra, cdec, size_deg) for e in exps]
        paths = irsa.fetch_many(client, urls, progress=_progress)

        loaded: list[tuple[irsa.Exposure, frames.Exposure2D, np.ndarray, np.ndarray]] = []
        exp_meta = []
        for e, u in zip(exps, urls):
            p = paths.get(u)
            entry = e.to_json()
            entry["used"] = False
            if p is None:
                entry["error"] = "download failed"
                exp_meta.append(entry)
                continue
            try:
                ex = frames.load_exposure(p)
                img, var, valid = frames.resample(ex.image, ex.variance, ex.good, ex.wcs, grid, shape)
            except Exception as err:  # noqa: BLE001
                entry["error"] = f"{type(err).__name__}: {err}"
                exp_meta.append(entry)
                continue
            entry["wavelength_um"] = None if ex.wavelength_um is None else round(ex.wavelength_um, 4)
            entry["coverage"] = round(float(valid.mean()), 3)
            if valid.mean() < 0.05:
                entry["error"] = "field not covered"
                exp_meta.append(entry)
                continue
            entry["used"] = True
            exp_meta.append(entry)
            loaded.append((e, ex, img, var))

        groups = frames.group_epochs([e.mjd for e, *_ in loaded])
        E = len(groups)
        if E < 2:
            raise RuntimeError(f"{t.id}: only {E} usable visit(s); need 2")
        cube = np.full((E, 6, npix, npix), np.nan, np.float32)
        vcube = np.full_like(cube, np.nan)
        epochs = []
        for ei, g in enumerate(groups):
            mj = [loaded[i][0].mjd for i in g]
            ep = {"index": ei, "mjd_min": min(mj), "mjd_max": max(mj), "mjd": float(np.mean(mj)), "bands": []}
            for d in range(1, 7):
                members = [loaded[i] for i in g if loaded[i][0].detector == d]
                band = {"detector": d, "n": len(members)}
                if len(members) >= MIN_PER_CELL:
                    m, v, _ = frames.stack([x[2] for x in members], [x[3] for x in members])
                    cube[ei, d - 1], vcube[ei, d - 1] = m, v
                    band["mjd"] = float(np.mean([x[0].mjd for x in members]))
                    wls = [x[1].wavelength_um for x in members if x[1].wavelength_um]
                    if wls:
                        band["wl_min"], band["wl_max"] = round(min(wls), 3), round(max(wls), 3)
                else:
                    band["missing"] = True
                ep["bands"].append(band)
            epochs.append(ep)
            print(f"  visit {ei + 1}: MJD {ep['mjd_min']:.1f}-{ep['mjd_max']:.1f}  per detector "
                  + " ".join(str(b["n"]) for b in ep["bands"]), flush=True)

        wise_frames = wise.allwise_frames(client, cra, cdec, size_deg, grid, shape)
        field = gaia.cone(client, cra, cdec, t.fov_arcmin / 60.0 * 0.75, gmax=19.0)

        out = out_root / t.id
        out.mkdir(parents=True, exist_ok=True)
        blobs = [cube.tobytes(), vcube.tobytes()] + [w["image"].astype(np.float32).tobytes() for w in wise_frames]
        payload = b"".join(blobs)
        (out / "frames.bin").write_bytes(payload)
        plane = npix * npix * 4
        layout = {
            "dtype": "float32",
            "frames": {"offset": 0, "shape": [E, 6, npix, npix]},
            "variance": {"offset": E * 6 * plane, "shape": [E, 6, npix, npix]},
            "wise": {"offset": 2 * E * 6 * plane, "shape": [len(wise_frames), npix, npix]},
            "bytes": len(payload),
        }
        meta = {
            "id": t.id,
            "name": t.name,
            "blurb": t.blurb,
            "notes": t.notes,
            "status": t.status,
            "default_mode": t.default_mode,
            "default_band": t.default_band,
            "fov_arcmin": t.fov_arcmin,
            "wcs": frames.grid_header(grid, npix),
            "pixel_scale_arcsec": frames.PIXEL_SCALE_ARCSEC,
            "target": {**motion, "pos_now": list(p_now), "pos_2010": list(p_wise)},
            "detectors": [{"detector": d, "wl_min": r[0], "wl_max": r[1]} for d, r in frames.DETECTOR_RANGES_UM.items()],
            "epochs": epochs,
            "wise": [{k: v for k, v in w.items() if k != "image"} for w in wise_frames],
            "layout": layout,
            "provenance": {
                "label": f"IRSA DR1+QR3 (baked {dt.date.today().isoformat()})",
                "collections": sorted({e["collection"] for e in exp_meta if e["used"]}),
                "credit": "Data: NASA/JPL-Caltech/IPAC (IRSA). Not a NASA product.",
                "dois": {"spherex_dr1": "10.26131/IRSA678", "spherex_qr3": "10.26131/IRSA662"},
                "wise": "AllWISE atlas images, NASA/JPL-Caltech/UCLA (IRSA)",
                "gaia": "ESA Gaia DR3 (gea.esac.esa.int)",
                "pipeline": f"spherex_blink {__version__}",
                "baked_utc": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                "exposures_found": len(all_exps),
                "mask_bits": list(frames.BAD_BITS),
            },
            "exposures": exp_meta,
        }
        (out / "meta.json").write_text(json.dumps(meta, separators=(",", ":")))
        (out / "gaia.json").write_text(json.dumps({"ref_year": gaia.GAIA_EPOCH, "stars": field}, separators=(",", ":")))
        size = sum(f.stat().st_size for f in out.iterdir())
        print(f"  wrote {out} ({size / 1e6:.2f} MB, {E} visits, {len(wise_frames)} WISE frames, {len(field)} Gaia stars)", flush=True)
        if size > MAX_BUNDLE_BYTES:
            print(f"  ! bundle is over the {MAX_BUNDLE_BYTES / 1e6:.0f} MB limit", flush=True)
        return meta
    finally:
        if own:
            client.close()
