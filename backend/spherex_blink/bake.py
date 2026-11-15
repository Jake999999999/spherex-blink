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

from . import __version__, cube, frames, gaia, irsa, photometry, wise
from .targets import TARGETS, Target

OUT_ROOT = Path(__file__).resolve().parents[2] / "frontend" / "public" / "benchmarks"
MIN_PER_CELL = 3
WISE_YEAR = 2010.4
NOW_YEAR = 2026.5
MAX_BUNDLE_BYTES = 4 * 1024 * 1024


TARGET_ORDER = ["barnard", "eps-ind-b", "nep-lpv", "rw-aur", "wise-0855"]


def write_index(out_root: Path = OUT_ROOT) -> list[dict]:
    """index.json listing every baked bundle, in demo order."""
    found = []
    for meta_path in out_root.glob("*/meta.json"):
        m = json.loads(meta_path.read_text())
        found.append({"id": m["id"], "name": m["name"], "tagline": m.get("tagline", ""), "status": m["status"]})
    order = {k: i for i, k in enumerate(TARGET_ORDER)}
    found.sort(key=lambda e: order.get(e["id"], 99))
    out_root.mkdir(parents=True, exist_ok=True)
    (out_root / "index.json").write_text(json.dumps({"targets": found}, indent=1))
    return found


TEXT_FIELDS = ("name", "tagline", "blurb", "notes", "status", "default_mode", "default_band", "variable")


def retext(target_id: str, out_root: Path = OUT_ROOT) -> bool:
    """Refresh the descriptive fields of a baked bundle from targets.py (no data changes, no network)."""
    path = out_root / target_id / "meta.json"
    if not path.exists():
        return False
    meta = json.loads(path.read_text())
    t = TARGETS[target_id]
    for f in TEXT_FIELDS:
        meta[f] = getattr(t, f)
    path.write_text(json.dumps(meta, separators=(",", ":")))
    sp = out_root / target_id / "spectra.json"
    if sp.exists():
        s = json.loads(sp.read_text())
        if s.get("sources") and s["sources"][0]["id"] == "target":
            s["sources"][0]["name"] = t.name
            sp.write_text(json.dumps(s, separators=(",", ":")))
    write_index(out_root)
    return True


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


MAX_FIELD_SOURCES = 30
FIELD_G_MAX = 15.0


def photometry_sources(t: Target, motion: dict, field: list[dict], grid, npix: int) -> list[dict]:
    """The target first, then the brightest Gaia stars inside the frame (spectra are baked only for these)."""
    srcs = [{
        "id": "target", "name": t.name, "gaia_id": t.gaia_id, "g": motion.get("g"),
        "ra": motion["ra"], "dec": motion["dec"], "pmra": motion["pmra"], "pmdec": motion["pmdec"],
        "ref_year": motion["ref_year"],
    }]
    margin = 4
    for s in sorted((s for s in field if s["g"] is not None and s["g"] < FIELD_G_MAX), key=lambda s: s["g"]):
        if t.gaia_id and s["source_id"] == t.gaia_id:
            continue
        if gaia_sep_arcsec(s["ra"], s["dec"], motion["ra"], motion["dec"]) < 8 and motion["ref_year"] == gaia.GAIA_EPOCH:
            continue  # blended with the target (e.g. a close companion)
        x, y = grid.world_to_pixel_values(*position_at({**s, "ref_year": gaia.GAIA_EPOCH}, NOW_YEAR))
        if not (margin <= x < npix - margin and margin <= y < npix - margin):
            continue
        srcs.append({
            "id": f"gaia-{s['source_id']}", "name": f"Gaia DR3 {s['source_id']}", "gaia_id": s["source_id"], "g": s["g"],
            "ra": s["ra"], "dec": s["dec"], "pmra": s["pmra"], "pmdec": s["pmdec"], "ref_year": gaia.GAIA_EPOCH,
        })
        if len(srcs) > MAX_FIELD_SOURCES:
            break
    return srcs


def gaia_sep_arcsec(ra1: float, dec1: float, ra2: float, dec2: float) -> float:
    dra = (ra1 - ra2) * math.cos(math.radians(0.5 * (dec1 + dec2)))
    return math.hypot(dra, dec1 - dec2) * 3600.0


def measure_spectra(loaded: list, epoch_of: dict[int, int], sources: list[dict]) -> dict:
    """One point per (exposure, source): exposure-level columns are shared, per-source arrays align with them."""
    cols = {"mjd": [], "det": [], "epoch": []}
    per = [{**s, "flux": [], "err": [], "flag": [], "wl": [], "bw": [], "wing_flux": [], "wing_err": [], "wing_flag": []} for s in sources]
    for i, (e, ex, _img, _var) in enumerate(loaded):
        cols["mjd"].append(round(e.mjd, 5))
        cols["det"].append(e.detector)
        cols["epoch"].append(epoch_of.get(i, -1))
        year = gaia.mjd_to_year(e.mjd)
        for s in per:
            ra, dec = gaia.propagate(s["ra"], s["dec"], s["pmra"], s["pmdec"], s["ref_year"], year)
            x, y = ex.wcs.world_to_pixel_values(ra, dec)
            x, y = float(x), float(y)
            p = photometry.aperture(ex.image, ex.variance, ex.good, ex.overflow, x, y)
            wp = photometry.wing(ex.image, ex.variance, ex.good, ex.overflow, x, y)
            ok = math.isfinite(p.flux)
            wok = math.isfinite(wp.flux)
            # The filter wavelength changes across the detector, so each source gets its own.
            wl = photometry.wavelength_at(ex.wave_wcs, x, y) if (ok or wok) else None
            if wl is None:
                ok = wok = False
            s["wing_flux"].append(round(wp.flux, 4) if wok else None)
            s["wing_err"].append(round(wp.err, 4) if wok else None)
            s["wing_flag"].append(wp.flag)
            s["flux"].append(round(p.flux, 4) if ok else None)
            s["err"].append(round(p.err, 4) if ok else None)
            s["flag"].append(p.flag)
            s["wl"].append(round(wl[0], 4) if wl else None)
            s["bw"].append(round(wl[1], 4) if wl and math.isfinite(wl[1]) else None)
    return {
        "units": "mJy",
        "aperture_arcsec": round(photometry.R_AP * frames.PIXEL_SCALE_ARCSEC, 1),
        "sky_annulus_arcsec": [photometry.R_IN * frames.PIXEL_SCALE_ARCSEC, photometry.R_OUT * frames.PIXEL_SCALE_ARCSEC],
        "note": "Aperture sums with a local sky annulus, no aperture correction: compare points with each other, "
        "not with catalogue magnitudes. Wavelength is the filter centre at the source's pixel in that exposure.",
        "flags": {"0": "ok", "1": "masked pixel in aperture", "2": "saturated pixel in aperture"},
        "wing_arcsec": [photometry.WING_IN * frames.PIXEL_SCALE_ARCSEC, photometry.WING_OUT * frames.PIXEL_SCALE_ARCSEC],
        "wing_note": "Flux in a ring around the core, for stars whose core saturates. Tracks brightness over time; "
        "the ring holds a different share of the light at different wavelengths, so don't read spectral shape from it.",
        "exposures": cols,
        "sources": per,
    }


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

        wise_missing = None
        try:
            wise_frames = wise.allwise_frames(client, cra, cdec, size_deg, grid, shape)
        except irsa.FetchError as err:
            # The 2010 frame is optional: bake without it, re-bake from cache once IRSA's WISE search is back.
            wise_frames = []
            wise_missing = f"AllWISE image search failed at bake time ({err})"
            print(f"  ! no WISE frame: {err}", flush=True)
        field = gaia.cone(client, cra, cdec, t.fov_arcmin / 60.0 * 0.75, gmax=19.0)

        epoch_of = {}
        for ei, g in enumerate(groups):
            for i in g:
                epoch_of[i] = ei
        sources = photometry_sources(t, motion, field, grid, npix)
        spectra = measure_spectra(loaded, epoch_of, sources)
        n_pts = sum(1 for f in spectra["sources"][0]["flux"] if f is not None)
        print(f"  photometry: {len(sources)} sources, target has {n_pts} points", flush=True)

        cube_arr, cube_desc = None, None
        try:
            cube_arr, cube_desc = cube.bake_cube(client, cra, cdec, t.fov_arcmin)
        except (irsa.FetchError, httpx.HTTPError, ValueError, KeyError) as err:
            # Colour is optional: bake without it and say why.
            print(f"  ! no colour cube: {err}", flush=True)
            cube_desc = {"missing": str(err)}

        out = out_root / t.id
        out.mkdir(parents=True, exist_ok=True)
        if cube_arr is not None:
            (out / "cube.bin").write_bytes(cube_arr.astype("<f4").tobytes())
            cube_desc["file"] = "cube.bin"
            cube_desc["shape"] = list(cube_arr.shape)
        elif (out / "cube.bin").exists():
            (out / "cube.bin").unlink()
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
            "tagline": t.tagline,
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
            "cube": cube_desc,
            "variable": t.variable,
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
                "wise_missing": wise_missing,
                "mask_bits": list(frames.BAD_BITS),
            },
            "exposures": exp_meta,
        }
        (out / "meta.json").write_text(json.dumps(meta, separators=(",", ":")))
        (out / "gaia.json").write_text(json.dumps({"ref_year": gaia.GAIA_EPOCH, "stars": field}, separators=(",", ":")))
        (out / "spectra.json").write_text(json.dumps(spectra, separators=(",", ":")))
        size = sum(f.stat().st_size for f in out.iterdir())
        print(f"  wrote {out} ({size / 1e6:.2f} MB, {E} visits, {len(wise_frames)} WISE frames, {len(field)} Gaia stars)", flush=True)
        if size > MAX_BUNDLE_BYTES:
            print(f"  ! bundle is over the {MAX_BUNDLE_BYTES / 1e6:.0f} MB limit", flush=True)
        write_index(out_root)
        return meta
    finally:
        if own:
            client.close()
