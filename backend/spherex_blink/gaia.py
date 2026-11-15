"""Gaia DR3 via the ESA TAP service (plain HTTP GET), plus proper-motion propagation."""

from __future__ import annotations

import csv
import io
import json
import math

import httpx

from .irsa import CACHE_ROOT, META_RETRY, FetchError, get_with_retry

GAIA_TAP = "https://gea.esac.esa.int/tap-server/tap/sync"
GAIA_MIRRORS = [
    GAIA_TAP,
    "https://gaia.ari.uni-heidelberg.de/tap/sync",
    "https://gaia.aip.de/tap/sync",
]
IRSA_TAP = "https://irsa.ipac.caltech.edu/TAP/sync"
VIZIER_TAP = "https://tapvizier.cds.unistra.fr/TAPVizieR/tap/sync"
VIZIER_CATALOGS: dict[str, dict] = {
    "allwise_p3as_psd": {
        "table": "II/328/allwise",
        "ra_col": "RAJ2000",
        "dec_col": "DEJ2000",
        "cols": {
            "designation": "AllWISE",
            "ra": "RAJ2000",
            "dec": "DEJ2000",
            "w1mpro": "W1mag",
            "w2mpro": "W2mag",
            "ph_qual": "qph",
            "cc_flags": "ccf",
            "ext_flg": "ex",
        },
    },
    "fp_psc": {
        "table": "II/246/out",
        "ra_col": "RAJ2000",
        "dec_col": "DEJ2000",
        "cols": {
            "ra": "RAJ2000",
            "dec": "DEJ2000",
            "j_m": "Jmag",
            "h_m": "Hmag",
            "k_m": "Kmag",
            "ph_qual": "Qflg",
            "cc_flg": "Cflg",
        },
    },
}
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


def _tap_csv(client: httpx.Client, url: str, adql: str, *, fail_fast_statuses: set[int] | None = None, tries: int | None = None) -> list[dict]:
    params = {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": adql}
    # ESA: two quick tries, then the caller falls back to IRSA's copy of Gaia DR3
    retry = {"tries": tries, "base_delay": 2.0} if tries is not None else ({"tries": 2, "base_delay": 3.0} if url == GAIA_TAP else META_RETRY)
    raw = get_with_retry(client, url, params=params, fail_fast_statuses=fail_fast_statuses, **retry)
    return list(csv.DictReader(io.StringIO(raw.decode("utf-8", errors="replace"))))


def vizier_cone(client: httpx.Client, catalog: str, ra: float, dec: float, radius_arcsec: float, cols: str) -> list[dict]:
    """Query CDS VizieR TAP mirror for AllWISE ('II/328/allwise') or 2MASS ('II/246/out')."""
    spec = VIZIER_CATALOGS[catalog]
    req_cols = [c.strip() for c in cols.split(",") if c.strip()]
    col_map: dict[str, str] = spec["cols"]
    viz_cols = [col_map.get(c, c) for c in req_cols]
    # Select only columns that exist in our VizieR mapping (or pass-through), deduplicated preserving order
    select_expr = ", ".join(dict.fromkeys(viz_cols))
    ra_col, dec_col = spec["ra_col"], spec["dec_col"]
    radius_deg = radius_arcsec / 3600.0
    adql = (
        f'SELECT {select_expr} FROM "{spec["table"]}" '
        f"WHERE 1 = CONTAINS(POINT('ICRS', {ra_col}, {dec_col}), CIRCLE('ICRS', {ra}, {dec}, {radius_deg}))"
    )
    rows = _tap_csv(client, VIZIER_TAP, adql, tries=2)
    out = []
    for r in rows:
        mapped = {}
        for c in req_cols:
            vc = col_map.get(c, c)
            if vc in r:
                mapped[c] = r[vc]
        out.append(mapped)
    return out


def catalog_cone_with_vizier_fallback(
    client: httpx.Client, catalog: str, ra: float, dec: float, radius_arcsec: float, cols: str
) -> list[dict]:
    """Query IRSA TAP for AllWISE/2MASS, failing over immediately to VizieR TAP on 502/503/504 or timeout."""
    radius_deg = radius_arcsec / 3600.0
    adql = (
        f"SELECT {cols} FROM {catalog} "
        f"WHERE 1 = CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra}, {dec}, {radius_deg}))"
    )
    try:
        return _tap_csv(client, IRSA_TAP, adql, fail_fast_statuses={502, 503, 504}, tries=1)
    except (FetchError, httpx.TimeoutException, httpx.TransportError):
        if catalog in VIZIER_CATALOGS:
            return vizier_cone(client, catalog, ra, dec, radius_arcsec, cols)
        raise


GATOR = "https://irsa.ipac.caltech.edu/cgi-bin/Gator/nph-query"


def parse_ipac_table(text: str) -> list[dict]:
    """Minimal IPAC table reader: '\\' lines are keywords, the first '|' line names the columns,
    data rows are whitespace-separated (fine for the numeric/designation columns we ask for)."""
    names: list[str] | None = None
    rows = []
    for line in text.splitlines():
        if not line.strip() or line.startswith("\\"):
            continue
        if line.startswith("|"):
            if names is None:
                names = [c.strip() for c in line.strip().strip("|").split("|")]
            continue
        if names:
            vals = line.split()
            if len(vals) >= len(names):
                rows.append(dict(zip(names, vals)))
    return rows


def gator_cone(client: httpx.Client, catalog: str, ra: float, dec: float, radius_arcsec: float, cols: str) -> list[dict]:
    params = {"catalog": catalog, "spatial": "cone", "objstr": f"{ra} {dec}", "radius": str(radius_arcsec),
              "outfmt": "1", "selcols": cols}
    raw = get_with_retry(client, GATOR, params=params, fail_fast_statuses={502, 503, 504}, tries=2, base_delay=2.0)
    return parse_ipac_table(raw.decode("utf-8", errors="replace"))


GAIA_COLS = "source_id,ra,dec,pmra,pmdec,parallax,phot_g_mean_mag"


def _gator_gaia(client: httpx.Client, ra: float | None = None, dec: float | None = None, radius_arcsec: float = 0.0, constraint: str | None = None) -> list[dict]:
    """Gaia DR3 through IRSA (same table as ESA's), used when ESA's TAP service is unreachable."""
    params = {"catalog": "gaia_dr3_source", "outfmt": "1", "selcols": GAIA_COLS}
    if constraint:
        params |= {"spatial": "NONE", "constraints": constraint}
    else:
        params |= {"spatial": "cone", "objstr": f"{ra} {dec}", "radius": str(radius_arcsec)}
    raw = get_with_retry(client, GATOR, params=params, **META_RETRY)
    return parse_ipac_table(raw.decode("utf-8", errors="replace"))


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


def _gaia_tap_with_mirrors(client: httpx.Client, adql: str) -> list[dict]:
    last_err: Exception | None = None
    for url in GAIA_MIRRORS:
        try:
            return _tap_csv(client, url, adql, tries=1)
        except (FetchError, httpx.TimeoutException, httpx.TransportError) as e:
            last_err = e
    raise last_err if last_err is not None else FetchError("All Gaia TAP mirrors failed")


def source(client: httpx.Client, source_id: str) -> dict:
    def q():
        try:
            rows = _gaia_tap_with_mirrors(client, f"SELECT {COLUMNS} FROM gaiadr3.gaia_source WHERE source_id = {int(source_id)}")
        except (FetchError, httpx.TimeoutException, httpx.TransportError):
            rows = _gator_gaia(client, constraint=f"source_id={int(source_id)}")
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
        try:
            rows = _gaia_tap_with_mirrors(client, adql)
        except (FetchError, httpx.TimeoutException, httpx.TransportError):
            # All Gaia TAP mirrors unreachable; fall back to IRSA Gator
            rows = [r for r in _gator_gaia(client, ra=ra, dec=dec, radius_arcsec=radius_deg * 3600) if (_num(r.get("phot_g_mean_mag")) or 99) < gmax]
            rows.sort(key=lambda r: _num(r.get("phot_g_mean_mag")) or 99)
            rows = rows[:limit]
        return [_star(r) for r in rows]

    return _cached(f"cone_{ra:.5f}_{dec:.5f}_{radius_deg:.4f}_{gmax}", q)


def allwise_source(client: httpx.Client, ra: float, dec: float, radius_arcsec: float = 10.0) -> dict:
    """Nearest AllWISE catalog source (for objects too faint for Gaia, e.g. WISE 0855)."""

    def q():
        cols = "designation,ra,dec,w1mpro,w2mpro,w1mjdmean,w2mjdmean"
        try:
            # Gator is fast when up; fail fast on 502/503/504 so we can fall back to TAP/VizieR
            rows = gator_cone(client, "allwise_p3as_psd", ra, dec, radius_arcsec, cols)
        except (FetchError, httpx.TimeoutException, httpx.TransportError):
            rows = catalog_cone_with_vizier_fallback(client, "allwise_p3as_psd", ra, dec, radius_arcsec, "designation,ra,dec,w1mpro,w2mpro")
        if not rows:
            raise LookupError(f"no AllWISE source near {ra}, {dec}")
        rows.sort(key=lambda r: (float(r["ra"]) - ra) ** 2 + (float(r["dec"]) - dec) ** 2)
        r = rows[0]
        return {
            "designation": r["designation"],
            "ra": float(r["ra"]),
            "dec": float(r["dec"]),
            "w1": _num(r.get("w1mpro")),
            "w2": _num(r.get("w2mpro")),
            "mjd": _num(r.get("w2mjdmean")) or _num(r.get("w1mjdmean")),
        }

    return _cached(f"allwise_{ra:.5f}_{dec:.5f}", q)
