import numpy as np
import pytest

from spherex_blink import frames, matched


def _visit(sample_wls, flux_at, shape=(15, 15), star=(7, 7), shift=(0.0, 0.0)):
    """One visit: an exposure per wavelength; a star whose brightness depends on wavelength."""
    exps = []
    ny, nx = shape
    yy, xx = np.mgrid[0:ny, 0:nx]
    for wl in sample_wls:
        psf = np.exp(-((xx - star[1] - shift[1]) ** 2 + (yy - star[0] - shift[0]) ** 2) / (2 * 1.2**2))
        img = flux_at(wl) * psf
        exps.append((3, img, np.full(shape, 0.01), np.full(shape, wl)))
    return exps


def red_star(wl):
    return 10.0 + 40.0 * (wl - 1.64)  # much brighter at the long end of detector 3


def test_constant_red_star_cancels_only_when_matched():
    ch = matched.channels_from_cube(None)
    d3 = ch.of_detector(3)
    lo, hi = ch.wl_min[d3], ch.wl_max[d3]
    centres = 0.5 * (lo + hi)
    # visit A samples the short half of detector 3 twice as often; visit B the long half
    a = _visit(list(centres[:9]) * 2 + list(centres[9:]), red_star)
    b = _visit(list(centres[:9]) + list(centres[9:]) * 2, red_star)
    res = matched.build([a, b], ch, (15, 15))
    # plain (unmatched) stacks: different wavelength mixes -> a spurious brightening
    plain = [frames.stack([e[1] for e in v], [e[2] for e in v])[0] for v in (a, b)]
    spurious = plain[1][7, 7] - plain[0][7, 7]
    real_diff = res.matched[1, 2, 7, 7] - res.matched[0, 2, 7, 7]
    assert abs(spurious) > 1.0
    assert abs(real_diff) < 1e-6 * abs(spurious) + 1e-9
    # the 6.15" map has the star's spectrum: brighter in long channels
    assert res.fine[d3[-1], 7, 7] > res.fine[d3[0], 7, 7]


def test_a_mover_still_shows():
    ch = matched.channels_from_cube(None)
    centres = 0.5 * (ch.wl_min[ch.of_detector(3)] + ch.wl_max[ch.of_detector(3)])
    a = _visit(list(centres), red_star)
    b = _visit(list(centres), red_star, shift=(0.0, 2.0))
    res = matched.build([a, b], ch, (15, 15))
    d = res.matched[1, 2] - res.matched[0, 2]
    assert d[7, 9] > 1 and d[7, 6] < -1  # bright where it went, dark where it was


def test_channels_need_two_visits():
    ch = matched.channels_from_cube(None)
    centres = 0.5 * (ch.wl_min[ch.of_detector(3)] + ch.wl_max[ch.of_detector(3)])
    only_a = _visit([centres[0]], red_star)
    only_b = _visit([centres[5]], red_star)
    res = matched.build([only_a, only_b], ch, (15, 15))
    assert np.isnan(res.matched[0, 2, 7, 7])  # no channel seen twice -> no matched value
    assert np.isfinite(res.fine[ch.of_detector(3)[0], 7, 7])


def test_cube_channel_table_is_used_when_present():
    desc = {"channels": {"wavelength": [1.0, 1.1], "wl_min": [0.95, 1.05], "wl_max": [1.05, 1.15], "detector": [1, 1]}}
    ch = matched.channels_from_cube(desc)
    assert list(ch.of_detector(1)) == [0, 1]
    assert ch.bandwidth[0] == pytest.approx(0.1)


def test_background_offset_between_visits_is_removed():
    ch = matched.channels_from_cube(None)
    centres = 0.5 * (ch.wl_min[ch.of_detector(3)] + ch.wl_max[ch.of_detector(3)])
    a = _visit(list(centres), red_star)
    b = [(d, img + 0.3, var, wl) for d, img, var, wl in _visit(list(centres), red_star)]  # brighter sky in visit B
    res = matched.build([a, b], ch, (15, 15))
    diff = res.matched[1, 2] - res.matched[0, 2]
    assert abs(float(np.median(diff))) < 1e-6


def test_sky_gradient_between_visits_is_removed_but_a_star_change_is_kept():
    ch = matched.channels_from_cube(None)
    centres = 0.5 * (ch.wl_min[ch.of_detector(3)] + ch.wl_max[ch.of_detector(3)])
    shape = (41, 41)
    yy, xx = np.mgrid[0:41, 0:41]
    a = _visit(list(centres), red_star, shape=shape, star=(20, 20))
    # visit B: a sky gradient across the field, and the star got 20% brighter
    b = [(d, 1.2 * img + 0.02 * xx, var, wl) for d, img, var, wl in _visit(list(centres), red_star, shape=shape, star=(20, 20))]
    res = matched.build([a, b], ch, shape)
    diff = res.matched[1, 2] - res.matched[0, 2]
    assert abs(float(diff[5, 35])) < 0.05  # far from the star: the gradient is gone
    assert diff[20, 20] > 1.0  # the star's brightening survives
