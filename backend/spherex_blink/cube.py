"""SPHEREx all-sky spectral cube (spherex_dr1_cube): read just the window around a field, by HTTP Range.

A tile is a 512x512x102 float32 cube (321 MB) in HEALPix order-5 tiles with an RA---HPX projection
(PLAN.md D15, L2-L4). Each channel is one contiguous 1 MB plane, so a field window costs one small
Range request per channel. Headers and windows are cached on disk.
"""

from __future__ import annotations

import hashlib
import io
import json
import math
import re
import warnings
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import httpx
import numpy as np
from astropy.io import fits
from astropy.wcs import WCS, FITSFixedWarning

from . import frames, irsa

warnings.filterwarnings("ignore", category=FITSFixedWarning)

S3_BASE = "https://nasa-irsa-spherex.s3.amazonaws.com/"
CUBE_COLLECTION = "spherex_dr1_cube"
CUBE_SCALE_ARCSEC = 12.3  # 2x the main 6.15" grid, close to the cube's native 12.88"
BLOCK = 2880


@dataclass
class Hdu:
    name: str
    header: fits.Header
    data_offset: int
    nbytes: int


def _cache_dir() -> Path:
    return irsa.CACHE_ROOT / "cube"


def _key(*parts) -> str:
    return hashlib.sha1("|".join(map(str, parts)).encode()).hexdigest()


def read_range(client: httpx.Client, url: str, start: int, n: int) -> bytes:
    """Byte range [start, start+n). Retries like every other request."""
    if n <= 0:
        return b""
    for attempt in range(6):
        raw = irsa.get_with_retry_headers(client, url, {"Range": f"bytes={start}-{start + n - 1}"})
        if len(raw) == n:
            return raw
    raise irsa.FetchError(f"{url}: short read at {start} (+{n})")


def walk_hdus(client: httpx.Client, url: str) -> list[Hdu]:
    """Read every HDU header without downloading data (cached as JSON)."""
    cache = _cache_dir() / f"hdus_{_key(url)}.json"
    if cache.exists():
        raw = json.loads(cache.read_text())
        return [Hdu(h["name"], fits.Header.fromstring(h["header"]), h["data_offset"], h["nbytes"]) for h in raw]
    hdus: list[Hdu] = []
    off = 0
    size = None
    while size is None or off < size:
        buf = b""
        end = None
        while end is None:
            chunk = read_range(client, url, off + len(buf), BLOCK * 4) if size is None else read_range(client, url, off + len(buf), min(BLOCK * 4, size - off - len(buf)))
            if not chunk:
                break
            buf += chunk
            end = next((k for k in range(0, len(buf), 80) if buf[k : k + 80].rstrip() == b"END"), None)
            if len(buf) > BLOCK * 400:
                raise ValueError(f"{url}: no END card")
        if end is None:
            break
        hlen = (end // BLOCK + 1) * BLOCK
        h = fits.Header.fromstring(buf[:hlen].decode("ascii"))
        naxes = [h[f"NAXIS{j}"] for j in range(1, h.get("NAXIS", 0) + 1)]
        n = 0
        if naxes:
            n = abs(h["BITPIX"]) // 8
            for v in naxes:
                n *= v
            n += h.get("PCOUNT", 0)
        hdus.append(Hdu(h.get("EXTNAME", "PRIMARY"), h, off + hlen, n))
        off += hlen + ((n + BLOCK - 1) // BLOCK) * BLOCK
        if size is None:
            size = irsa.content_length(client, url)
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps([{"name": x.name, "header": x.header.tostring(), "data_offset": x.data_offset, "nbytes": x.nbytes} for x in hdus]))
    return hdus


def hdu(hdus: list[Hdu], name: str) -> Hdu:
    for x in hdus:
        if x.name == name:
            return x
    raise KeyError(name)


def sky_wcs(h: fits.Header) -> WCS:
    """2-D celestial WCS of a cube HDU (the third axis is a WAVE-TAB lookup we don't need here)."""
    h2 = h.copy()
    for k in list(h2.keys()):
        if k in ("NAXIS3", "CTYPE3", "CUNIT3", "CRPIX3", "CDELT3", "CRVAL3", "PC3_3", "PV3_3", "PS3_0", "PS3_1", "PS3_2", "PC1_3", "PC2_3", "PC3_1", "PC3_2"):
            del h2[k]
    h2["NAXIS"] = 2
    h2["WCSAXES"] = 2
    return WCS(h2, naxis=2)


def _dtype(h: fits.Header) -> np.dtype:
    return {-32: np.dtype(">f4"), -64: np.dtype(">f8"), 32: np.dtype(">i4"), 16: np.dtype(">i2"), 8: np.dtype("u1")}[h["BITPIX"]]


def read_window(client: httpx.Client, url: str, h: Hdu, x0: int, x1: int, y0: int, y1: int, workers: int = 4) -> np.ndarray:
    """[nchan, y1-y0, x1-x0] for a 3-D image HDU (FITS axis 1 = x fastest). BZERO/BSCALE applied."""
    nx, ny = h.header["NAXIS1"], h.header["NAXIS2"]
    nchan = h.header.get("NAXIS3", 1)
    dt = _dtype(h.header)
    cache = _cache_dir() / f"win_{_key(url, h.name, x0, x1, y0, y1)}.npy"
    if cache.exists():
        return np.load(cache)
    row_bytes = nx * dt.itemsize

    def one(k: int) -> np.ndarray:
        start = h.data_offset + (k * ny + y0) * row_bytes
        raw = read_range(client, url, start, (y1 - y0) * row_bytes)
        return np.frombuffer(raw, dtype=dt).reshape(y1 - y0, nx)[:, x0:x1]

    with ThreadPoolExecutor(max_workers=workers) as pool:
        planes = list(pool.map(one, range(nchan)))
    out = np.stack(planes).astype(np.float32 if dt.kind == "f" else np.int64)
    bscale = h.header.get("BSCALE", 1.0)
    bzero = h.header.get("BZERO", 0.0)
    if bscale != 1.0 or bzero != 0.0:
        out = out.astype(np.float64) * bscale + bzero
    cache.parent.mkdir(parents=True, exist_ok=True)
    np.save(cache, out)
    return out


def read_table(client: httpx.Client, url: str, h: Hdu) -> fits.FITS_rec:
    raw = read_range(client, url, h.data_offset, h.nbytes)
    pad = (-len(raw)) % BLOCK
    hdul = fits.HDUList([fits.PrimaryHDU(), fits.BinTableHDU(header=h.header)])
    buf = io.BytesIO()
    buf.write(fits.PrimaryHDU().header.tostring().encode("ascii"))
    buf.write(h.header.tostring().encode("ascii"))
    buf.write(raw + b"\0" * pad)
    del hdul
    with fits.open(io.BytesIO(buf.getvalue()), memmap=False) as f:
        return f[1].data.copy()


# ---------------------------------------------------------------- HEALPix (nested), for finding tiles

def _spread_bits(v: int) -> int:
    out = 0
    for b in range(32):
        out |= ((v >> b) & 1) << (2 * b)
    return out


def ang2pix_nest(nside: int, ra_deg: float, dec_deg: float) -> int:
    """HEALPix nested pixel index (same algorithm as the HEALPix C library's ang2pix_nest)."""
    z = math.sin(math.radians(dec_deg))
    za = abs(z)
    tt = (math.radians(ra_deg % 360.0) / (0.5 * math.pi)) % 4.0
    if za <= 2.0 / 3.0:
        t1 = nside * (0.5 + tt)
        t2 = nside * z * 0.75
        jp = int(t1 - t2)
        jm = int(t1 + t2)
        ifp = jp // nside
        ifm = jm // nside
        face = (ifp | 4) if ifp == ifm else (ifp if ifp < ifm else ifm + 8)
        ix = jm & (nside - 1)
        iy = nside - (jp & (nside - 1)) - 1
    else:
        ntt = min(3, int(tt))
        tp = tt - ntt
        tmp = nside * math.sqrt(3.0 * (1.0 - za))
        jp = min(int(tp * tmp), nside - 1)
        jm = min(int((1.0 - tp) * tmp), nside - 1)
        if z >= 0:
            face, ix, iy = ntt, nside - jm - 1, nside - jp - 1
        else:
            face, ix, iy = ntt + 8, jp, jm
    return face * nside * nside + _spread_bits(ix) + (_spread_bits(iy) << 1)


ORDER = 5
NSIDE = 2**ORDER


def tile_key(npix: int, release: str) -> str:
    return f"dr1/hips5_cube/{release}/Norder{ORDER}/Dir{(npix // 10000) * 10000}/Npix{npix}_cube.fits"


def latest_release(client: httpx.Client) -> str:
    """Newest hips_YYYYMMDD folder in the public S3 bucket (so a new release doesn't break us)."""
    raw = irsa.get_with_retry(client, S3_BASE, params={"list-type": "2", "prefix": "dr1/hips5_cube/", "delimiter": "/"}, **irsa.META_RETRY)
    found = sorted(re.findall(r"<Prefix>dr1/hips5_cube/(hips_\d{8})/</Prefix>", raw.decode()))
    if not found:
        raise irsa.FetchError("no hips_* release folder in the S3 bucket")
    return found[-1]


def field_tiles(ra: float, dec: float, half_deg: float) -> list[int]:
    """Tiles touched by a square field: centre, corners and edge midpoints (a corner field can need 4)."""
    out = set()
    cosd = max(1e-6, math.cos(math.radians(dec)))
    for fy in (-1, 0, 1):
        for fx in (-1, 0, 1):
            d = max(-90.0, min(90.0, dec + fy * half_deg))
            out.add(ang2pix_nest(NSIDE, ra + fx * half_deg / cosd, d))
    return sorted(out)


def s3_key(row: dict) -> str | None:
    """IRSA's CSV leaves the cloud_access JSON unquoted, so its commas split it across columns;
    find the key anywhere in the row."""
    vals = [str(v) for k, v in row.items() if k is not None]
    extra = row.get(None) or []
    m = re.search(r'"key"\s*:\s*"([^"]+)"', ",".join(vals + [str(x) for x in extra]))
    return m.group(1) if m else None


def tile_urls(client: httpx.Client, ra: float, dec: float, radius_deg: float) -> list[str]:
    """Cube tiles overlapping a circle, as S3 URLs when the archive gives an S3 key (CORS-friendly mirror)."""
    rows = irsa.sia_query(client, CUBE_COLLECTION, ra, dec, radius_deg)
    urls = []
    for r in rows:
        if r.get("dataproduct_type") != "cube":
            continue
        key = s3_key(r)
        urls.append(S3_BASE + key if key else r["access_url"])
    return sorted(set(urls))


# ---------------------------------------------------------------- bake


def check_plain_image(h: Hdu) -> None:
    """Byte-offset reads only work on uncompressed images."""
    if h.header.get("XTENSION") != "IMAGE" or "ZIMAGE" in h.header:
        raise ValueError(f"{h.name}: not a plain IMAGE extension (compressed?)")


def bake_cube(client: httpx.Client, ra: float, dec: float, fov_arcmin: float, release: str | None = None) -> tuple[np.ndarray, dict]:
    """102-channel window around a field, resampled onto a north-up TAN grid at CUBE_SCALE_ARCSEC.

    Returns ([102, n, n] float32 MJy/sr, NaN = no data) and a JSON-able description.
    """
    release = release or latest_release(client)
    n = int(math.ceil(fov_arcmin * 60.0 / CUBE_SCALE_ARCSEC)) | 1
    grid = frames.grid_wcs(ra, dec, n, CUBE_SCALE_ARCSEC)
    yy, xx = np.mgrid[0:n, 0:n]
    world = grid.pixel_to_world_values(xx.ravel(), yy.ravel())
    half = fov_arcmin / 60.0 * 0.75
    tiles = field_tiles(ra, dec, half)
    out = None
    chans = None
    used = []
    span = [math.inf, -math.inf]
    for npix in tiles:
        url = S3_BASE + tile_key(npix, release)
        hdus = walk_hdus(client, url)
        im = hdu(hdus, "IMAGE")
        hits = hdu(hdus, "NHITS")
        check_plain_image(im)
        check_plain_image(hits)
        prim = hdus[0].header
        if "MJD-BEG" in prim:
            span = [min(span[0], float(prim["MJD-BEG"])), max(span[1], float(prim["MJD-END"]))]
        nchan = im.header["NAXIS3"]
        w = sky_wcs(im.header)
        sx, sy = (np.asarray(v).reshape(n, n) for v in w.world_to_pixel_values(*world))
        inside = (sx >= -1) & (sx <= im.header["NAXIS1"]) & (sy >= -1) & (sy <= im.header["NAXIS2"])
        if not inside.any():
            continue
        x0 = max(0, int(np.floor(sx[inside].min())) - 2)
        x1 = min(im.header["NAXIS1"], int(np.ceil(sx[inside].max())) + 3)
        y0 = max(0, int(np.floor(sy[inside].min())) - 2)
        y1 = min(im.header["NAXIS2"], int(np.ceil(sy[inside].max())) + 3)
        win = read_window(client, url, im, x0, x1, y0, y1).astype(np.float64)
        nh = read_window(client, url, hits, x0, x1, y0, y1)
        win[nh <= 0] = np.nan  # never observed
        if chans is None:
            chans = read_table(client, url, hdu(hdus, "SPECTRAL_CHANNELS"))
            out = np.full((nchan, n, n), np.nan, np.float32)
        ones = np.ones(win.shape[1:])
        for k in range(nchan):
            good = np.isfinite(win[k])
            v, _, ok = frames.bilinear(np.nan_to_num(win[k]), ones, good, sy - y0, sx - x0)
            fill = ok & np.isnan(out[k])
            out[k][fill] = v[fill]
        used.append(url)
    if out is None or chans is None:
        raise irsa.FetchError(f"no cube tile covers {ra}, {dec}")
    blank = [k for k in range(out.shape[0]) if not np.isfinite(out[k]).any()]
    names = chans.columns.names
    col = lambda c: [round(float(x), 5) for x in chans[c]] if c in names else None  # noqa: E731
    desc = {
        "wcs": frames.grid_header(grid, n),
        "pixel_scale_arcsec": CUBE_SCALE_ARCSEC,
        "native_scale_arcsec": 12.88,
        "release": release,
        "tiles": used,
        "mjd_min": span[0] if math.isfinite(span[0]) else None,
        "mjd_max": span[1] if math.isfinite(span[1]) else None,
        "units": "MJy/sr",
        "channels": {
            "wavelength": col("WAVELENGTH"),
            "wl_min": col("WL_MIN"),
            "wl_max": col("WL_MAX"),
            "bandwidth": col("BANDWIDTH"),
            "detector": [int(x) for x in chans["DETECTOR"]] if "DETECTOR" in names else None,
        },
        "blank": blank,
        "note": "SPHEREx all-sky spectral map: each channel is the average of every visit up to the release, "
        "so different channels at one spot come from different dates.",
    }
    return out, desc
