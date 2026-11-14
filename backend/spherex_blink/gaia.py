"""Gaia DR3 via the ESA TAP service (plain HTTP GET), plus proper-motion propagation."""

from __future__ import annotations

import csv
import io
import json
import math

import httpx

from .irsa import CACHE_ROOT, get_with_retry

GAIA_TAP = "https://gea.esac.esa.int/tap-server/tap/sync"
IRSA_TAP = "https://irsa.ipac.caltech.edu/TAP/sync"
GAIA_EPOCH = 2016.0
MJD_J2000 = 51544.5
DAYS_PER_YEAR = 365.25

COLUMNS = "source_id, ra, dec, pmra, pmdec, parallax, phot_g_mean_mag"


def mjd_to_year(mjd: float) -> float:
    return 2000.0 + (mjd - MJD_J2000) / DAYS_PER_YEAR


def year_to_mjd(year: float) -> float:
    return MJD_J2000 + (year - 2000.0) * DAYS_PER_YEAR


def propagate(ra: float, dec: float, pmra: float, pmdec: float, from_year: float, to_year: float) -> tuple[float, float]:
    """Move a star along its proper motion. pmra includes cos(dec) (Gaia convention), mas/yr.

    Linear in the tangent plane at the start position, then deprojected (gnomonic), which is
    accurate to milliarcseconds for decades of motion. Parallax is ignored (stated in the UI).
    """
    dt = to_year - from_year
    xi = math.radians(pmra * dt / 3.6e6)
    eta = math.radians(pmdec * dt / 3.6e6)
    a0, d0 = math.radians(ra), math.radians(dec)
    denom = math.cos(d0) - eta * math.sin(d0)
    a = a0 + math.atan2(xi, denom)
    d = math.atan2(math.sin(d0) + eta * math.cos(d0), math.hypot(xi, denom))
    return (math.degrees(a) % 360.0, math.degrees(d))


def _tap_csv(client: httpx.Client, url: str, adql: str) -> list[dict]:
    params = {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": adql}
    raw = get_with_retry(client, url, params=params)
    return list(csv.DictReader(io.StringIO(raw.decode("utf-8", errors="replace"))))


def _num(v: str) -> float | None:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(x) else x


def _star(r: dict) -> dict:
    return {
        "source_id": r["source_id"],
        "ra": float(r["ra"]),
        "dec": float(r["dec"]),
        "pmra": _num(r.get("pmra")) or 0.0,
        "pmdec": _num(r.get("pmdec")) or 0.0,
        "parallax": _num(r.get("parallax")),
        "g": _num(r.get("phot_g_mean_mag")),
    }


def _cached(name: str, fn):
    path = CACHE_ROOT / "gaia" / f"{name}.json"
    if path.exists():
        return json.loads(path.read_text())
    val = fn()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(val))
    return val


def source(client: httpx.Client, source_id: str) -> dict:
    def q():
        rows = _tap_csv(client, GAIA_TAP, f"SELECT {COLUMNS} FROM gaiadr3.gaia_source WHERE source_id = {int(source_id)}")
        if not rows:
            raise LookupError(f"Gaia DR3 {source_id} not found")
        return _star(rows[0])

    return _cached(f"src_{source_id}", q)


def cone(client: httpx.Client, ra: float, dec: float, radius_deg: float, gmax: float = 18.0, limit: int = 3000) -> list[dict]:
    def q():
        adql = (
            f"SELECT TOP {limit} {COLUMNS} FROM gaiadr3.gaia_source "
            f"WHERE 1 = CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra}, {dec}, {radius_deg})) "
            f"AND phot_g_mean_mag < {gmax} ORDER BY phot_g_mean_mag"
        )
        return [_star(r) for r in _tap_csv(client, GAIA_TAP, adql)]

    return _cached(f"cone_{ra:.5f}_{dec:.5f}_{radius_deg:.4f}_{gmax}", q)


def allwise_source(client: httpx.Client, ra: float, dec: float, radius_arcsec: float = 10.0) -> dict:
    """Nearest AllWISE catalog source (for objects too faint for Gaia, e.g. WISE 0855)."""

    def q():
        adql = (
            "SELECT designation, ra, dec, w1mpro, w2mpro, w1mjdmean, w2mjdmean FROM allwise_p3as_psd "
            f"WHERE 1 = CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra}, {dec}, {radius_arcsec / 3600}))"
        )
        rows = _tap_csv(client, IRSA_TAP, adql)
        if not rows:
            raise LookupError(f"no AllWISE source near {ra}, {dec}")
        rows.sort(key=lambda r: (float(r["ra"]) - ra) ** 2 + (float(r["dec"]) - dec) ** 2)
        r = rows[0]
        return {
            "designation": r["designation"],
            "ra": float(r["ra"]),
            "dec": float(r["dec"]),
            "w1": _num(r["w1mpro"]),
            "w2": _num(r["w2mpro"]),
            "mjd": _num(r["w2mjdmean"]) or _num(r["w1mjdmean"]),
        }

    return _cached(f"allwise_{ra:.5f}_{dec:.5f}", q)
