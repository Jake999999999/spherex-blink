"""IRSA access: SIA2 searches and cached, retrying cutout downloads.

Facts this relies on (PLAN.md §2): SIA returns direct FITS URLs; a cutout is the FITS URL plus
``?center=ra,dec&size=deg``; cutouts are ~4 MB (mostly the EPSF table) and the service often
answers HTTP 503, so every call retries with backoff and every result is cached on disk in a
slimmed form (EPSF dropped).
"""

from __future__ import annotations

import csv
import hashlib
import io
import random
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

import httpx
from astropy.io import fits

SIA_URL = "https://irsa.ipac.caltech.edu/SIA"
SPHEREX_COLLECTIONS = ("spherex_dr1", "spherex_qr3", "spherex_dr1_deep", "spherex_qr3_deep")
KEEP_HDUS = ("IMAGE", "FLAGS", "VARIANCE", "ZODI", "WCS-WAVE")
RETRY_STATUS = {429, 500, 502, 503, 504}
USER_AGENT = "spherex-blink/0.1 (NASA Space Apps 2026 project)"

CACHE_ROOT = Path(__file__).resolve().parents[1] / "cache"


class FetchError(RuntimeError):
    pass


def make_client(timeout: float = 120.0) -> httpx.Client:
    return httpx.Client(
        timeout=httpx.Timeout(timeout, connect=30.0),
        limits=httpx.Limits(max_connections=8, max_keepalive_connections=8),
        headers={"User-Agent": USER_AGENT},
        follow_redirects=True,
    )


def get_with_retry(
    client: httpx.Client,
    url: str,
    params: dict | None = None,
    tries: int = 5,
    base_delay: float = 3.0,
    sleep: Callable[[float], None] = time.sleep,
    max_delay: float = 60.0,
) -> bytes:
    """GET with exponential backoff on 5xx/429 and network errors."""
    last: str = ""
    for attempt in range(tries):
        try:
            r = client.get(url, params=params)
            if r.status_code == 200:
                return r.content
            last = f"HTTP {r.status_code}"
            if r.status_code not in RETRY_STATUS:
                break
        except (httpx.TimeoutException, httpx.TransportError) as e:
            last = f"{type(e).__name__}: {e}"
        if attempt < tries - 1:
            sleep(min(max_delay, base_delay * (2**attempt)) * (0.75 + 0.5 * random.random()))
    raise FetchError(f"{url} failed after {tries} tries ({last})")


# ---------------------------------------------------------------- SIA


# Metadata services (SIA, TAP) have outages of a few minutes: retry longer than for cutouts.
META_RETRY = {"tries": 8, "base_delay": 5.0}


def sia_query(client: httpx.Client, collection: str, ra: float, dec: float, radius_deg: float) -> list[dict]:
    """SIA search, cached on disk (delete backend/cache/sia/ to pick up newly released data)."""
    params = {
        "COLLECTION": collection,
        "POS": f"circle {ra} {dec} {radius_deg}",
        "RESPONSEFORMAT": "CSV",
    }
    key = cache_path(f"{SIA_URL}?{sorted(params.items())}", kind="sia").with_suffix(".csv")
    if key.exists():
        raw = key.read_bytes()
    else:
        raw = get_with_retry(client, SIA_URL, params=params, **META_RETRY)
        key.parent.mkdir(parents=True, exist_ok=True)
        key.write_bytes(raw)
    text = raw.decode("utf-8", errors="replace")
    return list(csv.DictReader(io.StringIO(text)))


@dataclass(frozen=True)
class Exposure:
    collection: str
    obs_id: str
    detector: int  # 1..6
    url: str
    mjd: float  # mid-exposure
    did: str  # obs_publisher_did, unique per exposure+detector

    def to_json(self) -> dict:
        return {
            "collection": self.collection,
            "obs_id": self.obs_id,
            "detector": self.detector,
            "mjd": round(self.mjd, 6),
            "url": self.url,
        }


def parse_spherex_rows(rows: Iterable[dict]) -> list[Exposure]:
    out = []
    for r in rows:
        if r.get("dataproduct_subtype") != "science" or r.get("dataproduct_type") != "image":
            continue
        band = r.get("energy_bandpassname", "")
        if not band.startswith("SPHEREx-D"):
            continue
        out.append(
            Exposure(
                collection=r["obs_collection"],
                obs_id=r["obs_id"],
                detector=int(band[-1]),
                url=r["access_url"],
                mjd=0.5 * (float(r["t_min"]) + float(r["t_max"])),
                did=r["obs_publisher_did"],
            )
        )
    return out


def spherex_exposures(client: httpx.Client, ra: float, dec: float, radius_deg: float = 0.01) -> list[Exposure]:
    """All DR1 + QR3 spectral images (wide and deep) that cover (ra, dec), oldest first."""
    seen: dict[str, Exposure] = {}
    for coll in SPHEREX_COLLECTIONS:
        for e in parse_spherex_rows(sia_query(client, coll, ra, dec, radius_deg)):
            seen.setdefault(e.did, e)
    return sorted(seen.values(), key=lambda e: (e.mjd, e.detector))


# ---------------------------------------------------------------- cutouts


def cutout_url(url: str, ra: float, dec: float, size_deg: float, extra: str = "") -> str:
    return f"{url}?center={ra:.6f},{dec:.6f}&size={size_deg:.5f}{extra}"


def cache_path(url: str, kind: str = "cutouts") -> Path:
    h = hashlib.sha1(url.encode()).hexdigest()
    return CACHE_ROOT / kind / h[:2] / f"{h}.fits"


def slim_fits(raw: bytes, keep: Iterable[str] = KEEP_HDUS) -> bytes:
    """Keep the primary HDU plus the named extensions (drops the 4 MB EPSF table)."""
    keep = set(keep)
    with fits.open(io.BytesIO(raw), memmap=False) as hdul:
        out = fits.HDUList([fits.PrimaryHDU(header=hdul[0].header)])
        for hdu in hdul[1:]:
            if hdu.name in keep:
                out.append(hdu.copy())
        buf = io.BytesIO()
        out.writeto(buf)
    return buf.getvalue()


def fetch_cutout(client: httpx.Client, url: str, slim: bool = True, **kw) -> Path:
    path = cache_path(url)
    if path.exists() and path.stat().st_size > 0:
        return path
    raw = get_with_retry(client, url, **kw)
    if not raw.startswith(b"SIMPLE"):
        raise FetchError(f"{url} did not return FITS ({raw[:80]!r})")
    data = slim_fits(raw) if slim else raw
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".part")
    tmp.write_bytes(data)
    tmp.replace(path)
    return path


def fetch_many(
    client: httpx.Client,
    urls: list[str],
    workers: int = 4,
    slim: bool = True,
    progress: Callable[[int, int, int], None] | None = None,
) -> dict[str, Path | None]:
    """Fetch cutouts concurrently (max 4 by default). Failed ones map to None."""
    results: dict[str, Path | None] = {}
    todo = []
    for u in urls:
        p = cache_path(u)
        if p.exists() and p.stat().st_size > 0:
            results[u] = p
        else:
            todo.append(u)
    done = len(results)
    failed = 0
    if progress:
        progress(done, failed, len(urls))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = {pool.submit(fetch_cutout, client, u, slim): u for u in todo}
        for f in as_completed(futs):
            u = futs[f]
            try:
                results[u] = f.result()
                done += 1
            except Exception as e:  # noqa: BLE001 - record and keep going
                results[u] = None
                failed += 1
                print(f"  ! {e}", flush=True)
            if progress:
                progress(done, failed, len(urls))
    return results
