import io
import math

import httpx
import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS

from spherex_blink import frames, gaia, irsa


def gaussian(shape, x0, y0, sigma=1.2, amp=10.0):
    yy, xx = np.mgrid[0 : shape[0], 0 : shape[1]]
    return amp * np.exp(-((xx - x0) ** 2 + (yy - y0) ** 2) / (2 * sigma**2))


def rotated_wcs(ra, dec, n, scale_arcsec, angle_deg):
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
    a = math.radians(angle_deg)
    s = scale_arcsec / 3600
    w.wcs.cd = [[-s * math.cos(a), s * math.sin(a)], [s * math.sin(a), s * math.cos(a)]]
    return w


def centroid(img, x0, y0, r=4):
    yy, xx = np.mgrid[0 : img.shape[0], 0 : img.shape[1]]
    m = ((xx - x0) ** 2 + (yy - y0) ** 2 <= r * r) & np.isfinite(img)
    w = np.where(m, img, 0.0)
    return float((w * xx).sum() / w.sum()), float((w * yy).sum() / w.sum())


def test_resample_puts_star_where_the_sky_says():
    ra, dec = 150.0, 30.0
    src = rotated_wcs(ra, dec, 61, 6.15, 37.0)
    # star at a known sky position, slightly off centre
    sra, sdec = ra + 20 / 3600 / math.cos(math.radians(dec)), dec - 14 / 3600
    sx, sy = src.world_to_pixel_values(sra, sdec)
    img = gaussian((61, 61), float(sx), float(sy), sigma=1.6)
    dst = frames.grid_wcs(ra, dec, 51)
    out, var, valid = frames.resample(img, np.ones_like(img), np.ones_like(img, bool), src, dst, (51, 51))
    tx, ty = dst.world_to_pixel_values(sra, sdec)
    cx, cy = centroid(out, float(tx), float(ty))
    assert abs(cx - tx) < 0.1 and abs(cy - ty) < 0.1
    assert valid[25, 25]


def test_resample_never_interpolates_across_bad_pixels():
    w = frames.grid_wcs(10.0, 0.0, 21)
    img = np.ones((21, 21))
    good = np.ones((21, 21), bool)
    good[10, 10] = False
    out, _, valid = frames.resample(img, img, good, w, w, (21, 21))
    assert not valid[10, 10] and np.isnan(out[10, 10])
    assert valid[0, 0] and out[0, 0] == pytest.approx(1.0)


def test_stack_ignores_nan_and_weights_by_variance():
    a = np.array([[1.0, np.nan]])
    b = np.array([[3.0, 5.0]])
    m, v, n = frames.stack([a, b], [np.array([[1.0, 1.0]]), np.array([[3.0, 1.0]])])
    assert m[0, 0] == pytest.approx((1 / 1 + 3 / 3) / (1 + 1 / 3))
    assert m[0, 1] == pytest.approx(5.0)
    assert v[0, 0] == pytest.approx(1 / (1 + 1 / 3))
    assert list(n[0]) == [2, 1]


def test_bad_mask_keeps_source_pixels():
    assert frames.BAD_MASK & (1 << 21) == 0
    assert frames.BAD_MASK & (1 << 1)  # OVERFLOW masked


def test_moving_star_makes_a_dipole_and_static_star_cancels():
    shape = (41, 41)
    # moving star shifts 1.7 px; static star stays
    t1 = gaussian(shape, 12, 20) + gaussian(shape, 30, 30)
    t2 = gaussian(shape, 12, 21.7) + gaussian(shape, 30, 30)
    d = t2 - t1
    assert d[22, 12] > 3 and d[19, 12] < -3
    static = np.abs(d[26:35, 26:35]).max() / t1[30, 30]
    assert static < 0.05


def test_group_epochs_splits_visits_and_bins_continuous_coverage():
    mjds = [100, 101, 110, 290, 300, 480]
    assert frames.group_epochs(mjds) == [[0, 1, 2], [3, 4], [5]]
    cont = list(np.arange(0, 300, 2.0))  # deep field: continuous for 300 days
    groups = frames.group_epochs(cont)
    assert len(groups) == 4 and sum(len(g) for g in groups) == len(cont)


def test_gaia_propagation_barnard():
    # Gaia DR3 4472832130942575872 at 2016.0
    ra, dec = gaia.propagate(269.44850252543836, 4.739420051112412, -801.551, 10362.394, 2016.0, 2026.5)
    assert abs((ra - 269.4462) * 3600 * math.cos(math.radians(dec))) < 0.5
    assert abs((dec - 4.7696) * 3600) < 0.5


def test_mjd_year_round_trip():
    assert gaia.mjd_to_year(gaia.year_to_mjd(2025.37)) == pytest.approx(2025.37)


def test_get_with_retry_survives_503():
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        return httpx.Response(503) if calls["n"] < 3 else httpx.Response(200, content=b"ok")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    assert irsa.get_with_retry(client, "https://example.test/x", sleep=lambda s: None) == b"ok"
    assert calls["n"] == 3


def test_get_with_retry_gives_up_on_404():
    client = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(404)))
    with pytest.raises(irsa.FetchError):
        irsa.get_with_retry(client, "https://example.test/x", sleep=lambda s: None)


def test_slim_fits_drops_epsf():
    hdul = fits.HDUList([fits.PrimaryHDU()])
    for name in ("IMAGE", "FLAGS", "VARIANCE", "ZODI"):
        hdul.append(fits.ImageHDU(np.zeros((3, 3), np.float32), name=name))
    hdul.append(fits.BinTableHDU.from_columns([fits.Column(name="A", format="E", array=np.zeros(5))], name="EPSF"))
    buf = io.BytesIO()
    hdul.writeto(buf)
    slim = fits.open(io.BytesIO(irsa.slim_fits(buf.getvalue())))
    assert [h.name for h in slim] == ["PRIMARY", "IMAGE", "FLAGS", "VARIANCE", "ZODI"]


def test_parse_spherex_rows_filters_non_science():
    rows = [
        {"dataproduct_subtype": "science", "dataproduct_type": "image", "energy_bandpassname": "SPHEREx-D4",
         "obs_collection": "spherex_dr1", "obs_id": "x", "access_url": "u", "t_min": "1", "t_max": "3",
         "obs_publisher_did": "d1"},
        {"dataproduct_subtype": "calibration", "dataproduct_type": "image", "energy_bandpassname": "SPHEREx-D4"},
    ]
    (e,) = irsa.parse_spherex_rows(rows)
    assert e.detector == 4 and e.mjd == 2.0


# ---------------------------------------------------------------- photometry

from spherex_blink import photometry  # noqa: E402


def _star_field(flux_total=100.0, sigma=0.9, x0=20.3, y0=19.6, shape=(41, 41), sky=0.5):
    img = gaussian(shape, x0, y0, sigma=sigma, amp=1.0)
    img = img / img.sum() * flux_total + sky
    return img, np.full(shape, 1e-6), np.ones(shape, bool), np.zeros(shape, bool)


def test_aperture_recovers_synthetic_flux_within_2_percent():
    img, var, good, ovf = _star_field()
    p = photometry.aperture(img, var, good, ovf, 20.3, 19.6, r_ap=3.0)
    expected = 100.0 * photometry.MJY_SR_TO_MJY_PER_PIXEL
    assert abs(p.flux - expected) / expected < 0.02
    assert p.flag == photometry.FLAG_OK
    assert p.sky == pytest.approx(0.5, abs=1e-3)


def test_aperture_flags_saturated_and_masked_pixels():
    img, var, good, ovf = _star_field()
    ovf[20, 20] = True
    good[20, 20] = False
    assert photometry.aperture(img, var, good, ovf, 20.3, 19.6).flag == photometry.FLAG_SATURATED
    img, var, good, ovf = _star_field()
    good[19, 21] = False
    assert photometry.aperture(img, var, good, ovf, 20.3, 19.6).flag == photometry.FLAG_BAD_PIXEL


def test_aperture_off_the_edge_is_nan():
    img, var, good, ovf = _star_field()
    assert math.isnan(photometry.aperture(img, var, good, ovf, 0.5, 20).flux)


def test_aperture_error_grows_with_variance():
    img, var, good, ovf = _star_field()
    lo = photometry.aperture(img, var, good, ovf, 20.3, 19.6).err
    hi = photometry.aperture(img, var * 100, good, ovf, 20.3, 19.6).err
    assert hi > 5 * lo


def test_wing_flux_is_proportional_and_ignores_a_saturated_core():
    img, var, good, ovf = _star_field(flux_total=100.0, sigma=1.2, x0=20.0, y0=20.0)
    ref = photometry.wing(img, var, good, ovf, 20.0, 20.0)
    img2, var2, good2, ovf2 = _star_field(flux_total=200.0, sigma=1.2, x0=20.0, y0=20.0)
    for yx in [(20, 20), (20, 21), (21, 20)]:  # saturated core
        good2[yx] = False
        ovf2[yx] = True
        img2[yx] = np.nan
    p = photometry.wing(img2, var2, good2, ovf2, 20.0, 20.0)
    assert p.flag == photometry.FLAG_OK
    assert p.flux / ref.flux == pytest.approx(2.0, rel=0.01)


def test_parse_ipac_table():
    text = (
        "\fixlen = T\n"
        "|  designation|        ra|      dec|  w2mpro|\n"
        "|         char|    double|   double|  double|\n"
        "|             |       deg|      deg|     mag|\n"
        "   J085510.74-071442.5  133.7947597   -7.2451456  13.704\n"
    )
    (row,) = gaia.parse_ipac_table(text)
    assert row["designation"] == "J085510.74-071442.5"
    assert float(row["dec"]) == pytest.approx(-7.2451456)


def test_bilinear_variance_is_sum_of_squared_weights():
    img = np.array([[1.0, 3.0], [1.0, 3.0]])
    var = np.full((2, 2), 4.0)
    good = np.ones((2, 2), bool)
    v, s2, ok = frames.bilinear(img, var, good, np.array([[0.0]]), np.array([[0.5]]))
    assert v[0, 0] == pytest.approx(2.0)
    assert s2[0, 0] == pytest.approx(0.5 * 0.5 * 4 + 0.5 * 0.5 * 4)  # = 2, not 4
    assert ok[0, 0]
    # exactly on a pixel: variance unchanged
    _, s2b, _ = frames.bilinear(img, var, good, np.array([[1.0]]), np.array([[1.0]]))
    assert s2b[0, 0] == pytest.approx(4.0)


def test_validate_centroid_matches_frontend_algorithm():
    from spherex_blink import validate

    img = gaussian((31, 31), 14.3, 16.7, sigma=1.0, amp=100) + 2
    c = validate.centroid(img, 16, 15)
    assert abs(c[0] - 14.3) < 0.1 and abs(c[1] - 16.7) < 0.1


def test_validate_zero_points_give_vega_like_fluxes():
    from spherex_blink import validate

    # a mag-0 star has the zero-point flux; mag 10 is 1e-4 of it
    c, w, f0 = validate.BANDS["Ks"]
    assert f0 * 10 ** (-0.4 * 10) * 1000 == pytest.approx(66.67, rel=1e-3)
