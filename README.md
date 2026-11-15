# SPHEREx Blink

**Watch the infrared sky change, using real data from NASA's SPHEREx telescope.**

SPHEREx photographs the whole sky in 102 infrared colours, once every six months. SPHEREx Blink lets anyone flip between those photos ("blinking", the way Pluto was found), subtract one visit from another to see only what changed, and click a star to see its infrared spectrum and how its brightness changes over time.

A NASA Space Apps Challenge 2026 entry. Not a NASA product.

## What you can do

- **Blink** between the SPHEREx visits of a patch of sky, plus a 2010 image from NASA's WISE telescope. Fast-moving nearby stars visibly jump.
- **Difference**: subtract an older visit from a newer one. Stars that didn't change disappear; a moving object leaves an amber/cyan pair, a brightening star turns amber.
- **Pick a wavelength**: SPHEREx's six detectors cover 0.75–5.0 µm. Cool objects (brown dwarfs) get brighter at long wavelengths.
- **Click any marked star** for its spectrum (one dot per SPHEREx exposure), its light curve and a table/CSV of every measurement.
- **Measure motion**: centroid a moving star in each frame and fit its speed, compared with ESA's Gaia catalogue.
- **Guided tour** (two minutes) for first-time visitors.
- **Shareable links**: the view (target, mode, wavelength, visits) is kept in the URL.

## The demo targets

| Target | What it shows |
|---|---|
| Barnard's Star | The fastest-moving star: a ~3′ leap from 2010 to 2026. Measured 10.42 ± 0.11″/yr vs Gaia's 10.39″/yr. |
| Epsilon Indi Ba+Bb | Two brown dwarfs. Their spectrum shows water, methane, CO₂ and CO absorption. |
| Pulsating red giant (Gaia DR3 2160548942811758720) | A star near the north ecliptic pole, seen daily by SPHEREx, fading to half brightness and back over 18 months. |
| RW Aurigae | A young star in a dusty disc (shown with caveats: saturated at most wavelengths). |
| WISE 0855−0714 | The coldest known brown dwarf. In 2025–26 it sits next to a brighter star SPHEREx can't separate, so the app says plainly that this is not a detection. |

Every frame shows where its data comes from. Nothing in the app is simulated.

## Run it

Requirements: [Bun](https://bun.sh) for the app; [uv](https://docs.astral.sh/uv/) and Python 3.12 only if you want to re-download and re-process the data.

```bash
cd frontend
bun install
bun run dev        # http://127.0.0.1:5186
```

The processed data for all five targets (4.4 MB) is committed in `frontend/public/benchmarks/`, so the app needs no server and works offline. `bun run build` produces a static site in `frontend/dist/` that can be hosted anywhere (it uses relative paths, so a subfolder such as GitHub Pages works).

Tests:

```bash
cd frontend && bun test && bun run typecheck
cd backend && uv run pytest -q
```

Re-processing the data from NASA's archive (downloads roughly 1.5 GB of image cutouts per target into `backend/cache/`, which is not committed):

```bash
cd backend
uv run python -m spherex_blink bake all      # or: bake barnard eps-ind-b ...
```

## How it works

- [`docs/HOW-IT-WORKS.md`](docs/HOW-IT-WORKS.md): the science and the processing, step by step.
- [`docs/BUILD-LOG.md`](docs/BUILD-LOG.md): how this was built, what went wrong and what we changed.
- [`PLAN.md`](PLAN.md): verified data facts with sources, milestones and status.
- [`SPEC-original.md`](SPEC-original.md): the first, unverified spec this project started from (kept for the record; several of its facts were wrong).

## Layout

```
backend/              Python 3.12 pipeline (numpy, scipy, astropy, httpx)
  spherex_blink/      irsa.py (search + cutouts), frames.py (resample, stack), photometry.py,
                      gaia.py (Gaia, AllWISE), wise.py, targets.py, bake.py, __main__.py (CLI)
  tests/              pytest, synthetic data, no network
frontend/             Vite + React 19 + TypeScript + Tailwind v4, WebGL2
  public/benchmarks/  baked data, one folder per target
  src/gl/             renderer (shaders) and colour maps
  src/lib/            pure, unit-tested logic: bundle format, WCS, stretch, photometry helpers, tour
  src/components/     sky view, timeline, wavelength picker, spectrum panel, tour
  test/               bun tests
docs/                 explanations
```

## Credits

- SPHEREx data: NASA/JPL-Caltech/IPAC, via the NASA/IPAC Infrared Science Archive (IRSA). SPHEREx DR1 doi:10.26131/IRSA678, QR3 doi:10.26131/IRSA662.
- AllWISE images and catalogue: NASA/JPL-Caltech/UCLA, via IRSA.
- Gaia DR3: European Space Agency, Gaia Data Processing and Analysis Consortium.
- Proper motion of WISE 0855−0714: Luhman & Esplin (2016).

This project was built with heavy AI assistance (Anthropic's Claude); see the build log.

## Licence

The code is released under the [MIT licence](LICENSE). The data in `frontend/public/benchmarks/` is derived from public NASA and ESA archives; please keep the credits above when you reuse it.
