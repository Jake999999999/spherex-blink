import numpy as np

from spherex_blink import photometry, psf


def gaussian_epsf(sigma_px: float = 0.9) -> np.ndarray:
    """A 33x33 ePSF at 5x oversampling: a pixel-integrated Gaussian, normalised like load_epsf does."""
    o = psf.OVERSAMPLE
    c = 16
    yy, xx = np.mgrid[0:33, 0:33]
    dx = (xx - c) / o
    dy = (yy - c) / o
    # integrate over a native pixel by sub-sampling
    sub = np.linspace(-0.45, 0.45, 10)
    p = np.zeros((33, 33))
    for sx in sub:
        for sy in sub:
            p += np.exp(-((dx + sx) ** 2 + (dy + sy) ** 2) / (2 * sigma_px**2))
    return p / psf._native_sum(p)


def render(shape, stars, sigma_px=0.9):
    ny, nx = shape
    img = np.zeros(shape)
    yy, xx = np.mgrid[0:ny, 0:nx]
    sub = np.linspace(-0.45, 0.45, 10)
    for x, y, f in stars:
        s = np.zeros(shape)
        for sx in sub:
            for sy in sub:
                s += np.exp(-((xx + sx - x) ** 2 + (yy + sy - y) ** 2) / (2 * sigma_px**2))
        img += f * s / s.sum()
    return img


def test_recovers_flux_at_subpixel_position_and_with_a_neighbour():
    p = gaussian_epsf()
    shape = (31, 31)
    var = np.full(shape, 1e-6)
    good = np.ones(shape, bool)
    over = np.zeros(shape, bool)
    x, y, f = 15.3, 14.6, 10.0
    sky = 0.5
    img = render(shape, [(x, y, f)]) + sky
    ph, chi2 = psf.fit(img, var, good, over, x, y, p)
    k = photometry.MJY_SR_TO_MJY_PER_PIXEL
    assert abs(ph.flux / k - f) / f < 0.01
    # a neighbour 2.2 px away: fitted jointly, it doesn't leak into the flux
    img2 = render(shape, [(x, y, f), (x + 2.2, y + 0.4, 6.0)]) + sky
    alone, _ = psf.fit(img2, var, good, over, x, y, p)
    joint, _ = psf.fit(img2, var, good, over, x, y, p, neighbours=[(x + 2.2, y + 0.4, p)])
    assert abs(joint.flux / k - f) / f < 0.02
    assert alone.flux / k > f * 1.1  # without the neighbour the flux is contaminated


def test_saturated_core_is_refused():
    p = gaussian_epsf()
    shape = (31, 31)
    img = render(shape, [(15.0, 15.0, 10.0)])
    over = np.zeros(shape, bool)
    over[15, 15] = True
    ph, _ = psf.fit(img, np.full(shape, 1e-6), np.ones(shape, bool), over, 15.0, 15.0, p)
    assert np.isnan(ph.flux) and ph.flag == photometry.FLAG_SATURATED


def test_active_offset():
    assert psf.active_offset({"CRPIX1A": -326.0, "CRPIX2A": -1497.0}) == (327.0, 1498.0)
