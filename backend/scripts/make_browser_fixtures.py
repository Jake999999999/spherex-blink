"""Golden values for the browser-side readers (frontend/test/browserdata.test.ts).

Writes frontend/test/fixtures/browser-wcs.json: real FITS header cards (no pixel data) of SPHEREx
exposures and all-sky map tiles, with astropy's pixel <-> sky answers at sample points, plus HEALPix
tile numbers from cube.ang2pix_nest. Needs the bake cache (and fetches a few tile headers from S3,
a few KB each).

    uv run python scripts/make_browser_fixtures.py
"""

from __future__ import annotations

import glob
import json
import random
import warnings
from pathlib import Path

import httpx
import numpy as np
from astropy.io import fits
from astropy.wcs import WCS, FITSFixedWarning

from spherex_blink import cube

warnings.filterwarnings("ignore", category=FITSFixedWarning)
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "frontend" / "test" / "fixtures" / "browser-wcs.json"


def cards(h: fits.Header) -> list[str]:
    s = h.tostring()
    return [s[i : i + 80] for i in range(0, len(s), 80)]


def exposure_cases(n: int = 4) -> list[dict]:
    out = []
    files = sorted(glob.glob(str(ROOT / "backend" / "cache" / "cutouts" / "*" / "*.fits")))
    random.Random(1).shuffle(files)
    for f in files:
        try:
            with fits.open(f, memmap=False) as h:
                if "IMAGE" not in h:
                    continue
                hdr = h["IMAGE"].header
        except OSError:
            continue
        w = WCS(hdr)
        ny, nx = hdr["NAXIS2"], hdr["NAXIS1"]
        xs = np.linspace(0, nx - 1, 5)
        ys = np.linspace(0, ny - 1, 5)
        px = [(float(x), float(y)) for x in xs for y in ys]
        world = w.pixel_to_world_values([p[0] for p in px], [p[1] for p in px])
        out.append({"cards": cards(hdr), "pixel": px, "world": [[float(a), float(d)] for a, d in zip(*world)]})
        if len(out) >= n:
            break
    return out


def tile_case(client: httpx.Client, npix: int, release: str) -> dict:
    url = cube.S3_BASE + cube.tile_key(npix, release)
    hdus = cube.walk_hdus(client, url)
    im = cube.hdu(hdus, "IMAGE")
    w = cube.sky_wcs(im.header)
    xs = np.linspace(5, 506, 6)
    px = [(float(x), float(y)) for x in xs for y in xs]
    world = w.pixel_to_world_values([p[0] for p in px], [p[1] for p in px])
    h2 = im.header.copy()
    return {"npix": npix, "cards": cards(h2), "pixel": px, "world": [[float(a) % 360.0, float(d)] for a, d in zip(*world)]}


def synth(i: int, ny: int, nx: int) -> dict[str, np.ndarray]:
    """Deterministic synthetic exposure i (the TypeScript test rebuilds the same pixels from this formula)."""
    y, x = np.mgrid[0:ny, 0:nx]
    spike = np.where((x * 31 + y * 17 + i * 7) % 23 == 0, 50.0 + ((x + y) % 7) * 10.0, 0.0)
    zodi = 2.0 + 0.01 * x
    img = 10.0 + zodi + spike
    img[(x == 40) & (y == 40)] = np.nan  # a saturated core
    var = 1.0 + 0.1 * ((x * 7 + y * 3 + i) % 10)
    flags = np.where((x * 13 + y * 7 + i) % 37 == 0, 1, 0) | np.where((x + y) % 5 == 0, 1 << 21, 0) | np.where((x * 3 + y * 11 + i) % 53 == 0, 1 << 28, 0)
    return {"IMAGE": img.astype(np.float32), "FLAGS": flags.astype(np.int32), "VARIANCE": var.astype(np.float32), "ZODI": zodi.astype(np.float32)}


def stack_case(tmp: Path) -> dict:
    """Four synthetic exposures (2 visits, detector 3) on a real exposure WCS; the Python pipeline's
    stacks are the golden values for the browser builder."""
    from spherex_blink import frames

    files = sorted(glob.glob(str(ROOT / "backend" / "cache" / "cutouts" / "*" / "*.fits")))
    tpl = None
    for f in files:
        with fits.open(f, memmap=False) as h:
            if "IMAGE" in h and h["IMAGE"].header["NAXIS1"] >= 60 and h["IMAGE"].header["NAXIS2"] >= 60:
                tpl = h["IMAGE"].header.copy()
                break
    assert tpl is not None
    ny, nx = tpl["NAXIS2"], tpl["NAXIS1"]
    ra0, dec0 = (float(v) for v in WCS(tpl).pixel_to_world_values((nx - 1) / 2, (ny - 1) / 2))
    fov = 3.0
    npix = int(np.ceil(fov * 60 / frames.PIXEL_SCALE_ARCSEC)) | 1
    grid = frames.grid_wcs(ra0, dec0, npix)
    mjds = [61000.0, 61000.1, 61100.0, 61100.1]
    exps = []
    for i, mjd in enumerate(mjds):
        hdr = tpl.copy()
        hdr["CRVAL1"] = tpl["CRVAL1"] + 0.002 * i
        hdr["CRVAL2"] = tpl["CRVAL2"] - 0.0015 * i
        hdr["MJD-AVG"] = mjd
        hdr["DETECTOR"] = 3
        data = synth(i, ny, nx)
        hl = [fits.PrimaryHDU()]
        for name in ("IMAGE", "FLAGS", "VARIANCE", "ZODI"):
            h2 = hdr.copy() if name == "IMAGE" else fits.Header()
            if name != "IMAGE":
                for k in ("CTYPE1", "CTYPE2", "CRVAL1", "CRVAL2", "CRPIX1", "CRPIX2", "PC1_1", "PC1_2", "PC2_1", "PC2_2", "CDELT1", "CDELT2"):
                    h2[k] = hdr[k]
            hl.append(fits.ImageHDU(data[name], header=h2, name=name))
        p = tmp / f"synth{i}.fits"
        fits.HDUList(hl).writeto(p, overwrite=True)
        exps.append({"cards": {name: cards(fits.getheader(p, name)) for name in ("IMAGE", "FLAGS", "VARIANCE", "ZODI")}, "primary": cards(fits.getheader(p, 0))})
    cells = []
    for v in (0, 1):
        ims, vs, flg = [], [], []
        for i in (2 * v, 2 * v + 1):
            ex = frames.load_exposure(tmp / f"synth{i}.fits")
            im, va, _ = frames.resample(ex.image, ex.variance, ex.good, ex.wcs, grid, (npix, npix))
            ims.append(im)
            vs.append(va)
            bad = ((ex.flags & frames.BAD_MASK) != 0).astype(np.float32)
            bf, _, cov = frames.resample(bad, np.ones_like(ex.image), np.ones_like(ex.good), ex.wcs, grid, (npix, npix))
            flg.append(np.where(cov, bf, np.nan))
        m, va, _ = frames.stack(ims, vs)
        with np.errstate(invalid="ignore"):
            fr = np.nanmean(np.stack(flg), axis=0)
        pct = np.where(np.isfinite(fr), np.clip(np.round(fr * 100), 0, 100), 255)
        nanlist = lambda a: [None if not np.isfinite(z) else float(z) for z in a.ravel()]  # noqa: E731
        cells.append({"mean": nanlist(m), "variance": nanlist(va), "flag_pct": [int(z) for z in pct.ravel()]})
    return {"ra": ra0, "dec": dec0, "fov": fov, "npix": npix, "shape": [ny, nx], "mjds": mjds, "exposures": exps, "visits": cells}


def main() -> None:
    client = httpx.Client(timeout=60, follow_redirects=True)
    release = cube.latest_release(client)
    tiles = []
    # equatorial (WISE 0855), north polar facet (NEP field), RA ~ 0 seam, south polar
    for ra, dec in ((133.795, -7.245), (270.5, 66.5), (0.2, 10.0), (359.8, -60.0)):
        tiles.append(tile_case(client, cube.ang2pix_nest(cube.NSIDE, ra, dec), release))
    rng = random.Random(2)
    pts = [(rng.uniform(0, 360), np.degrees(np.arcsin(rng.uniform(-1, 1)))) for _ in range(400)]
    pts += [(0.0, 0.0), (359.9999, 89.9), (180.0, -89.9), (45.0, 41.81), (90.0, -41.82)]
    hp = [[float(a), float(d), cube.ang2pix_nest(cube.NSIDE, a, d)] for a, d in pts]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"release": release, "exposures": exposure_cases(), "tiles": tiles, "healpix": hp}))
    print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB)")
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:  # synthetic FITS never leave the temp folder
        st = stack_case(Path(tmp))
    out2 = OUT.with_name("browser-stack.json")
    out2.write_text(json.dumps(st))
    print(f"wrote {out2} ({out2.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
