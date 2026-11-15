"""CLI: uv run python -m spherex_blink bake <target...> | targets"""

from __future__ import annotations

import argparse
import sys

from .targets import TARGETS


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):  # Windows consoles default to cp1252
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(prog="spherex_blink")
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("bake", help="fetch real IRSA data and write frontend/public/benchmarks/<id>/")
    b.add_argument("targets", nargs="+", help=f"target ids or 'all' ({', '.join(TARGETS)})")
    sub.add_parser("targets", help="list demo targets")
    sub.add_parser("index", help="rewrite frontend/public/benchmarks/index.json from the baked bundles")
    sub.add_parser("retext", help="refresh names/notes in baked bundles from targets.py (no network)")
    sub.add_parser("serve", help="local live server on 127.0.0.1:8091 (any sky position, fetched on request)")
    f = sub.add_parser("field", help="bake any sky position into OUT (used by the live server)")
    f.add_argument("--ra", type=float, required=True)
    f.add_argument("--dec", type=float, required=True)
    f.add_argument("--fov", type=float, default=5.0, help="field of view, arcmin (2-15)")
    f.add_argument("--quick", action="store_true", help="quick look: up to 6 visits, 4 exposures per visit and detector")
    f.add_argument("--name", default="")
    f.add_argument("--id", required=True, help="bundle id (folder name)")
    f.add_argument("--out", required=True, help="folder to write <id>/ into (never the public site)")
    sub.add_parser("inject", help="injection-recovery tests on the baked targets (writes injection.json; then run validate)")
    sub.add_parser("validate", help="compare baked numbers with 2MASS/AllWISE/Gaia; write validation.json and docs/VALIDATION.md")
    args = ap.parse_args(argv)

    if args.cmd == "serve":
        from .server import serve

        serve()
        return 0

    if args.cmd == "field":
        import math
        from pathlib import Path

        from . import irsa as irsa_mod
        from .bake import OUT_ROOT, bake_target
        from .targets import Target

        if not (math.isfinite(args.ra) and math.isfinite(args.dec) and -90 <= args.dec <= 90 and math.isfinite(args.fov)):
            ap.error("ra/dec/fov must be finite numbers, dec within -90..90")
        out = Path(args.out).resolve()
        if out == OUT_ROOT.resolve() or OUT_ROOT.resolve() in out.parents:
            ap.error("live fields must not be written into the public site folder")
        fov = min(15.0, max(2.0, args.fov))
        name = args.name.strip()[:80] or f"RA {args.ra % 360:.4f}°, Dec {args.dec:+.4f}°"
        t = Target(
            id=args.id, name=name, tagline="Your field", blurb="A patch of sky you asked for, fetched live from NASA's archives.",
            fov_arcmin=fov, default_mode="blink", default_band=3, position=(args.ra % 360.0, args.dec),
            per_cell=4 if args.quick else 12, visits_max=6 if args.quick else 10,
        )
        with irsa_mod.make_client() as client:
            bake_target(t, client, out)
        return 0

    if args.cmd == "inject":
        from .bake import TARGET_ORDER
        from .inject import run_all

        run_all(TARGET_ORDER)
        return 0

    if args.cmd == "validate":
        from .validate import run

        r = run()
        for b, v in r["photometry"]["bands"].items():
            print(f"{b:3s} n={v['n']:3d} ours/catalogue {v['median_ratio']:.2f} spread {v['scatter'] * 100:.0f}%")
        print(f"positions: median {r['astrometry']['median_arcsec']:.2f}\" over {r['astrometry']['n']}")
        for k, v in r["motion"].items():
            print(f"motion {k}: {v['measured']:.2f} vs Gaia {v['gaia']:.2f} ({v['diff_pct']:+.1f}%)")
        print(f"repeatability: median {r['repeatability']['median'] * 100:.1f}%")
        if r["map_vs_exposures"]["median_ratio"] is not None:
            print(f"map/exposures: {r['map_vs_exposures']['median_ratio']:.2f}, spread {r['map_vs_exposures']['median_scatter'] * 100:.0f}%")
        return 0

    if args.cmd == "retext":
        from .bake import retext

        for i in TARGETS:
            if retext(i):
                print(f"updated {i}")
        return 0

    if args.cmd == "index":
        from .bake import write_index

        for e in write_index():
            print(e["id"])
        return 0

    if args.cmd == "targets":
        for t in TARGETS.values():
            print(f"{t.id:12s} {t.status:12s} {t.name}")
        return 0

    from . import irsa
    from .bake import bake

    ids = list(TARGETS) if args.targets == ["all"] else args.targets
    unknown = [i for i in ids if i not in TARGETS]
    if unknown:
        ap.error(f"unknown target(s): {', '.join(unknown)}")
    failed = []
    with irsa.make_client() as client:
        for i in ids:
            try:
                bake(i, client)
            except Exception as e:  # noqa: BLE001 - keep baking the others
                print(f"  !! {i}: {type(e).__name__}: {e}", flush=True)
                failed.append(i)
    if failed:
        print(f"failed: {', '.join(failed)}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
