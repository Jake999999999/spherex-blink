"""S6 study: do PSF fits beat the aperture sums? Same checks as validate.py (catalogue agreement for
isolated stars, visit-to-visit repeatability of constant stars), on the same exposures.

    uv run python scripts/psf_study.py            # measure, compare, cache PSF results
    uv run python scripts/psf_study.py --apply    # also write the PSF columns into spectra.json
"""

from __future__ import annotations

import copy
import json
import sys
import time
import warnings
from pathlib import Path

import numpy as np

warnings.filterwarnings("ignore")
from astropy import log  # noqa: E402

log.setLevel("ERROR")

from spherex_blink import irsa, rephot, validate  # noqa: E402
from spherex_blink.bake import OUT_ROOT, TARGET_ORDER  # noqa: E402

CACHE = irsa.CACHE_ROOT / "psf_study"


def main() -> None:
    apply = "--apply" in sys.argv
    client = irsa.make_client()
    metas = {t: json.loads((OUT_ROOT / t / "meta.json").read_text()) for t in TARGET_ORDER}
    ep = rephot.epsf_tables(client, list(metas.values()))
    CACHE.mkdir(parents=True, exist_ok=True)
    rows_ap, rows_psf, rep_ap, rep_psf = [], [], [], []
    for tid in TARGET_ORDER:
        f = CACHE / f"{tid}.json"
        t0 = time.time()
        if f.exists():
            res = json.loads(f.read_text())
        else:
            res = rephot.measure(tid, ep, "as-is")
            f.write_text(json.dumps(res))
        sp = json.loads((OUT_ROOT / tid / "spectra.json").read_text())
        gstars = json.loads((OUT_ROOT / tid / "gaia.json").read_text())["stars"]
        sp_psf = copy.deepcopy(sp)
        for s in sp_psf["sources"]:
            r = res.get(s["id"])
            if r:
                s["flux"], s["err"], s["flag"] = r["flux"], r["err"], r["flag"]
        a = validate.photometry_check(client, tid, metas[tid], sp, gstars)
        p = validate.photometry_check(client, tid, metas[tid], sp_psf, gstars)
        rows_ap += a
        rows_psf += p
        rep_ap += validate.repeatability_check(sp)
        rep_psf += validate.repeatability_check(sp_psf)
        print(f"{tid}: {time.time() - t0:.0f}s, catalogue rows ap {len(a)} psf {len(p)}", flush=True)
        if apply:
            rephot.apply(tid, res, "as-is")

    def summary(rows):
        out = {}
        for b in ("J", "H", "Ks", "W1", "W2"):
            r = [x["ratio"] for x in rows if x["band"] == b]
            if r:
                med = float(np.median(r))
                out[b] = (len(r), round(med, 3), round(float(np.median(np.abs(np.array(r) / med - 1))) * 1.4826, 3))
        return out

    print("catalogue (n, median ratio, robust spread):")
    sa, sp_ = summary(rows_ap), summary(rows_psf)
    for b in sa:
        print(f"  {b:3s} aperture {sa[b]}   psf {sp_.get(b)}")
    print(f"repeatability median: aperture {np.median(rep_ap):.4f} (n={len(rep_ap)})  psf {np.median(rep_psf):.4f} (n={len(rep_psf)})")
    (CACHE / "summary.json").write_text(json.dumps({"catalogue_aperture": sa, "catalogue_psf": sp_, "repeat_aperture": float(np.median(rep_ap)), "repeat_psf": float(np.median(rep_psf)), "n_repeat": [len(rep_ap), len(rep_psf)]}, indent=1))


if __name__ == "__main__":
    main()
