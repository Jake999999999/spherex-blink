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
    args = ap.parse_args(argv)

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
