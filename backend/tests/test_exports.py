"""S5: the app's FITS/ECSV writers (TypeScript) must produce files astropy reads correctly."""

import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest
from astropy.io import fits
from astropy.table import Table
from astropy.wcs import WCS

FRONTEND = Path(__file__).resolve().parents[2] / "frontend"


@pytest.fixture(scope="module")
def exported(tmp_path_factory):
    if not shutil.which("bun"):
        pytest.skip("bun not installed")
    out = tmp_path_factory.mktemp("exports")
    subprocess.run(["bun", str(FRONTEND / "test" / "write-export-fixtures.ts"), str(out)], check=True, cwd=FRONTEND)
    return out


def test_fits_opens_with_correct_wcs_and_data(exported):
    with fits.open(exported / "export.fits") as h:
        h.verify("exception")
        img = h[0].data
        w = WCS(h[0].header)
        assert h[0].header["BUNIT"] == "MJy/sr"
    assert img.shape == (21, 21)
    assert img[10, 14] == 7.0  # row 10, column 14: same pixel the writer set
    ra, dec = w.pixel_to_world_values(10, 10)  # crpix 11 (1-based) = pixel 10 (0-based)
    assert ra == pytest.approx(269.448) and dec == pytest.approx(4.7465)
    # east to the left: increasing x lowers RA
    ra2, _ = w.pixel_to_world_values(11, 10)
    assert ra2 < ra


def test_ecsv_round_trips_with_units(exported):
    t = Table.read(exported / "export.ecsv", format="ascii.ecsv")
    assert str(t["wavelength"].unit) == "um" and str(t["flux"].unit) == "mJy"
    assert t["flag"].dtype.kind == "i"
    assert np.ma.is_masked(t["flux"][1]) or np.isnan(t["flux"][1])
    assert t.meta["source"] == "test star" and t.meta["aperture_arcsec"] == 15.4
