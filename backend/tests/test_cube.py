import io

import httpx
import numpy as np
import pytest
from astropy.io import fits

from spherex_blink import cube, irsa


@pytest.fixture(autouse=True)
def tmp_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(irsa, "CACHE_ROOT", tmp_path)


def make_cube_fits(nx=20, ny=16, nchan=5) -> tuple[bytes, np.ndarray]:
    data = np.arange(nchan * ny * nx, dtype=np.float32).reshape(nchan, ny, nx)
    data[2] = np.nan  # a blank channel
    img = fits.ImageHDU(data, name="IMAGE")
    img.header["CTYPE1"], img.header["CTYPE2"] = "RA---TAN", "DEC--TAN"
    img.header["CRVAL1"], img.header["CRVAL2"] = 100.0, 20.0
    img.header["CRPIX1"], img.header["CRPIX2"] = nx / 2, ny / 2
    img.header["CDELT1"], img.header["CDELT2"] = -12.88 / 3600, 12.88 / 3600
    img.header["CTYPE3"], img.header["CUNIT3"] = "WAVE-TAB", "um"
    flags = fits.ImageHDU(np.zeros((nchan, ny, nx), np.int32), name="FLAGS")
    chans = fits.BinTableHDU.from_columns(
        [fits.Column(name="WAVELENGTH", format="E", array=np.linspace(1, 2, nchan)), fits.Column(name="DETECTOR", format="J", array=np.ones(nchan))],
        name="SPECTRAL_CHANNELS",
    )
    buf = io.BytesIO()
    fits.HDUList([fits.PrimaryHDU(), img, flags, chans]).writeto(buf)
    return buf.getvalue(), data


def range_client(blob: bytes) -> tuple[httpx.Client, list]:
    calls = []

    def handler(request: httpx.Request):
        if request.method == "HEAD":
            return httpx.Response(200, headers={"content-length": str(len(blob))})
        rng = request.headers.get("range")
        a, b = (int(x) for x in rng.removeprefix("bytes=").split("-"))
        calls.append((a, b))
        return httpx.Response(206, content=blob[a : min(b + 1, len(blob))])

    return httpx.Client(transport=httpx.MockTransport(handler)), calls


def test_walk_hdus_finds_every_extension_and_offset():
    blob, _ = make_cube_fits()
    client, _ = range_client(blob)
    hdus = cube.walk_hdus(client, "https://example.test/c.fits")
    assert [h.name for h in hdus] == ["PRIMARY", "IMAGE", "FLAGS", "SPECTRAL_CHANNELS"]
    with fits.open(io.BytesIO(blob)) as f:
        assert hdus[1].data_offset == f[1].fileinfo()["datLoc"]
        assert hdus[3].data_offset == f[3].fileinfo()["datLoc"]


def test_read_window_returns_exact_pixels_with_small_requests():
    blob, data = make_cube_fits()
    client, calls = range_client(blob)
    url = "https://example.test/c.fits"
    hdus = cube.walk_hdus(client, url)
    calls.clear()
    win = cube.read_window(client, url, cube.hdu(hdus, "IMAGE"), 3, 9, 4, 11)
    assert win.shape == (5, 7, 6)
    np.testing.assert_array_equal(win[0], data[0, 4:11, 3:9])
    np.testing.assert_array_equal(win[4], data[4, 4:11, 3:9])
    assert np.isnan(win[2]).all()
    assert len(calls) == 5  # one Range request per channel
    assert max(b - a + 1 for a, b in calls) == 7 * 20 * 4  # only the needed rows


def test_read_window_is_cached():
    blob, _ = make_cube_fits()
    client, calls = range_client(blob)
    url = "https://example.test/c.fits"
    hdus = cube.walk_hdus(client, url)
    cube.read_window(client, url, cube.hdu(hdus, "IMAGE"), 0, 4, 0, 4)
    n = len(calls)
    cube.read_window(client, url, cube.hdu(hdus, "IMAGE"), 0, 4, 0, 4)
    assert len(calls) == n


def test_read_table_and_sky_wcs():
    blob, _ = make_cube_fits()
    client, _ = range_client(blob)
    url = "https://example.test/c.fits"
    hdus = cube.walk_hdus(client, url)
    t = cube.read_table(client, url, cube.hdu(hdus, "SPECTRAL_CHANNELS"))
    assert t["WAVELENGTH"][-1] == pytest.approx(2.0)
    w = cube.sky_wcs(cube.hdu(hdus, "IMAGE").header)
    assert w.naxis == 2
    x, y = w.world_to_pixel_values(100.0, 20.0)
    assert (float(x), float(y)) == pytest.approx((9.0, 7.0))


def test_s3_key_from_split_csv_row():
    # IRSA's CSV leaves the cloud_access JSON unquoted, so DictReader splits it
    row = {"access_url": "https://irsa/x.fits", "cloud_access": '{"aws": {"bucket_name": "nasa-irsa-spherex"', None: [' "key":"dr1/hips5_cube/a/Npix1_cube.fits"', ' "region": "us-east-1"}}']}
    assert cube.s3_key(row) == "dr1/hips5_cube/a/Npix1_cube.fits"
    assert cube.s3_key({"access_url": "x"}) is None
