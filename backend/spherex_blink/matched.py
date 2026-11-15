"""Wavelength-matched stacks (PLAN.md S2).

A visit stack mixes every wavelength inside one detector, and each visit samples a slightly different
mix, so a star's colour alone can make it look brighter or fainter in a difference image. Here each
exposure pixel goes into the channel its own wavelength falls in. Per visit v and channel k we get a
stack S[v,k]; their mean over visits, M[k], is a 102-channel map at the main 6.15" resolution. A
visit's *matched* frame for a detector is the weighted mean over that detector's channels of
(S[v,k] - M[k]): the difference of two matched frames compares like with like at every wavelength.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .frames import DETECTOR_RANGES_UM, robust_background


@dataclass
class Channels:
    detector: np.ndarray  # [K] 1..6
    wl_min: np.ndarray  # [K] µm
    wl_max: np.ndarray
    wavelength: np.ndarray
    bandwidth: np.ndarray

    def of_detector(self, d: int) -> np.ndarray:
        return np.nonzero(self.detector == d)[0]


def channels_from_cube(desc: dict | None) -> Channels:
    """The archive cube's 102-channel table if we have it, else 17 equal channels per detector."""
    ch = (desc or {}).get("channels") or {}
    if ch.get("wl_min") and ch.get("wl_max") and ch.get("detector"):
        wmin = np.asarray(ch["wl_min"], float)
        wmax = np.asarray(ch["wl_max"], float)
        return Channels(np.asarray(ch["detector"], int), wmin, wmax, np.asarray(ch["wavelength"], float), wmax - wmin)
    det, lo, hi = [], [], []
    for d, (a, b) in DETECTOR_RANGES_UM.items():
        edges = np.linspace(a, b, 18)
        det += [d] * 17
        lo += list(edges[:-1])
        hi += list(edges[1:])
    lo_a, hi_a = np.asarray(lo), np.asarray(hi)
    return Channels(np.asarray(det), lo_a, hi_a, 0.5 * (lo_a + hi_a), hi_a - lo_a)


BACKGROUND_BOX = 15  # px (92"): far wider than a star (PSF ~1-2 px), narrower than sky gradients


def smooth_background(img: np.ndarray, box: int = BACKGROUND_BOX) -> np.ndarray:
    """Large-scale sky level (sliding median) to remove gradients between visits before differencing.
    Gaps are filled with the overall median first so they don't bias the filter; they stay NaN after."""
    from scipy import ndimage

    ok = np.isfinite(img)
    if ok.sum() < 20:
        return np.zeros_like(img)
    filled = np.where(ok, img, np.median(img[ok]))
    return ndimage.median_filter(filled, size=box, mode="nearest")


@dataclass
class MatchedResult:
    fine: np.ndarray  # [K, ny, nx] M[k], MJy/sr, NaN = no data
    fine_n: np.ndarray  # [K, ny, nx] number of visits contributing
    matched: np.ndarray  # [E, 6, ny, nx] weighted mean over channels of S[v,k] - M[k]
    matched_var: np.ndarray  # [E, 6, ny, nx]
    coverage: dict


def build(
    visits: list[list[tuple[int, np.ndarray, np.ndarray, np.ndarray]]],
    channels: Channels,
    shape: tuple[int, int],
    min_visits: int = 2,
) -> MatchedResult:
    """visits[v] = list of (detector, image, variance, wavelength) on the common grid (NaN = no data)."""
    E = len(visits)
    K = len(channels.detector)
    ny, nx = shape
    sw = np.zeros((E, K, ny, nx))
    swv = np.zeros((E, K, ny, nx))
    for v, exps in enumerate(visits):
        for det, img, var, wl in exps:
            ok = np.isfinite(img) & np.isfinite(var) & (var > 0) & np.isfinite(wl)
            if not ok.any():
                continue
            w = np.where(ok, 1.0 / np.where(ok, var, 1.0), 0.0)
            for k in channels.of_detector(det):
                m = ok & (wl >= channels.wl_min[k]) & (wl < channels.wl_max[k])
                if m.any():
                    sw[v, k][m] += w[m]
                    swv[v, k][m] += w[m] * img[m]
    with np.errstate(invalid="ignore", divide="ignore"):
        S = np.where(sw > 0, swv / sw, np.nan)
        SW = sw.sum(axis=0)
        fine = np.where(SW > 0, swv.sum(axis=0) / SW, np.nan)
    n_vis = (sw > 0).sum(axis=0)

    matched = np.full((E, 6, ny, nx), np.nan)
    mvar = np.full((E, 6, ny, nx), np.nan)
    usable = n_vis >= min_visits  # [K, ny, nx]: a channel counts only where >= 2 visits saw it
    for d in range(1, 7):
        ks = channels.of_detector(d)
        if not len(ks):
            continue
        for v in range(E):
            w = np.where(usable[ks] & (sw[v, ks] > 0), sw[v, ks], 0.0)
            den = w.sum(axis=0)
            with np.errstate(invalid="ignore", divide="ignore"):
                num = np.where(w > 0, w * (S[v, ks] - fine[ks]), 0.0).sum(axis=0)
                mv = np.where(den > 0, num / den, np.nan)
                # remove any overall background offset between this visit and the average (sky level),
                # so a difference image is black where nothing changed, not tinted
                fin = mv[np.isfinite(mv)]
                if fin.size > 20:
                    mv = mv - robust_background(fin)
                    mv = mv - smooth_background(mv)
                matched[v, d - 1] = mv
                # variance of a weighted mean of (S - M); M's own noise is ignored (it averages >= 2 visits)
                mvar[v, d - 1] = np.where(den > 0, 1.0 / den, np.nan)

    filled = np.isfinite(fine)
    coverage = {
        "channels_with_data": int((filled.any(axis=(1, 2))).sum()),
        "median_pixel_fill": float(np.median(filled.mean(axis=0))),  # fraction of channels with data, per pixel
        "median_visits_per_channel": float(np.median(n_vis[n_vis > 0])) if (n_vis > 0).any() else 0.0,
    }
    return MatchedResult(fine.astype(np.float32), n_vis.astype(np.int16), matched.astype(np.float32), mvar.astype(np.float32), coverage)
