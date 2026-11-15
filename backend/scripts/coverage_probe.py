"""Size the static coverage index: how many SPHEREx level-2 exposures are in IRSA, per collection.

Retries IRSA TAP (it often answers 502 behind its proxy) and writes the answer to
backend/cache/coverage/probe.json. Read-only and small.

    uv run python scripts/coverage_probe.py
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import httpx

OUT = Path(__file__).resolve().parents[1] / "cache" / "coverage" / "probe.json"
SYNC = "https://irsa.ipac.caltech.edu/TAP/sync"
QUERIES = {
    "counts": "SELECT obs_collection, COUNT(*) AS n, MIN(t_min) AS t0, MAX(t_max) AS t1 FROM spherex.obscore "
    "WHERE dataproduct_subtype = 'science' GROUP BY obs_collection",
    "sample": "SELECT TOP 6 obs_id, s_ra, s_dec, s_region, t_min, t_max, energy_bandpassname, access_url "
    "FROM spherex.obscore WHERE obs_collection = 'spherex_dr1' AND dataproduct_subtype = 'science'",
}


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    got: dict[str, str] = json.loads(OUT.read_text()) if OUT.exists() else {}
    with httpx.Client(timeout=600) as c:
        for attempt in range(40):
            for name, q in QUERIES.items():
                if name in got:
                    continue
                try:
                    r = c.post(SYNC, data={"QUERY": q, "LANG": "ADQL", "FORMAT": "csv"})
                    if r.status_code == 200 and not r.text.lstrip().startswith("<"):
                        got[name] = r.text
                        OUT.write_text(json.dumps(got, indent=1))
                        print(f"{name}: ok", flush=True)
                    else:
                        print(f"{name}: HTTP {r.status_code}", flush=True)
                except httpx.HTTPError as e:
                    print(f"{name}: {type(e).__name__}", flush=True)
            if all(k in got for k in QUERIES):
                print(got["counts"])
                return
            time.sleep(120)
    print("gave up")


if __name__ == "__main__":
    main()
