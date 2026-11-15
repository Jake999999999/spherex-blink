"""SPHEREx all-sky spectral cube (spherex_dr1_cube): read just the window around a field, by HTTP Range.

A tile is a 512x512x102 float32 cube (321 MB) in HEALPix order-5 tiles with an RA---HPX projection
(PLAN.md D15, L2-L4). Each channel is one contiguous 1 MB plane, so a field window costs one small
Range request per channel. Headers and windows are cached on disk.
"""

from __future__ import annotations

import hashlib
import io
import json
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
