# SPHEREx Blink

**Watch the infrared sky change, using real data from NASA's SPHEREx telescope.**

SPHEREx photographs the whole sky in 102 infrared colours, once every six months. SPHEREx Blink lets anyone flip between those photos ("blinking", the way Pluto was found), subtract one visit from another to see only what changed, and click a star to see its infrared spectrum and how its brightness changes over time.

A NASA Space Apps Challenge 2026 entry. Not a NASA product.

## What you can do

- **Any spot in the sky**: type a name (“R Draconis”) or coordinates (`08h55m10.831s -07d14m42.53s`, `133.795 -7.245`), choose the field of view (2–15′), and the app fetches the SPHEREx exposures, the 2010 WISE images and Gaia stars for that patch from NASA's and ESA's archives, processes them and shows them like a little video. A link with `?ra=…&dec=…&fov=…` opens the same view (embeddable). It works two ways:
  - **In your browser, with nothing to install** (this is what the public site does): the 102-colour map comes straight from NASA's public copy of SPHEREx on Amazon S3, in seconds. To blink the spot, the app gives you a link to IRSA's list of exposures there; save that page and drop it on the app (or paste it, or drop SPHEREx FITS files you downloaded from IRSA). The app then reads just the field's rows of each exposure from S3 and masks, sky-subtracts, aligns and stacks them in your browser (a quick look is about 50–80 MB and under a minute on a good connection).
  - **With the small local server** (below), which also adds the WISE/NEOWISE frames, Gaia stars, per-star spectra and light curves, and wavelength-matched differences.

- **Blink** between the SPHEREx visits of a patch of sky, plus WISE images from 2010 and NEOWISE images from about every six months between 2014 and 2024: up to ~25 frames over 16 years, so nearby stars glide across the field like a little video.
- **Difference**: subtract an older visit from a newer one. Stars that didn't change disappear; a moving object leaves an amber/cyan pair, a brightening star turns amber.
- **Pick a wavelength**: SPHEREx's six detectors cover 0.75–5.0 µm. Cool objects (brown dwarfs) get brighter at long wavelengths.
- **Click any marked star** for its spectrum (one dot per SPHEREx exposure), its light curve and a table/CSV of every measurement.
- **Colour**: false-colour pictures from SPHEREx's 102-colour all-sky map, with presets (methane, water, warm dust) or your own three wavelength windows. Brown dwarfs turn pink in the methane view. Click any point for its map spectrum.
- **Measure motion**: centroid a moving star in each frame and fit its speed, compared with ESA's Gaia catalogue.
- **How accurate is it?** Checked against 2MASS, WISE and Gaia: brightness within 3% (star-to-star scatter 1–4% with PSF fitting), positions within 0.7″, motions within 1.3% (see [`docs/VALIDATION.md`](docs/VALIDATION.md)).
- **Listen and read**: every spectrum and light curve can be played as sound and comes with a plain-language summary; single-key shortcuts can be switched off; blinking never exceeds 3 changes per second.
- **Guided tour** (two minutes) for first-time visitors.
- **Shareable links**: the view (target, mode, wavelength, visits) is kept in the URL.

## The demo targets

| Target | What it shows |
|---|---|
| Barnard's Star | The fastest-moving star: a ~3′ leap from 2010 to 2026. Measured 10.42 ± 0.11″/yr vs Gaia's 10.39″/yr. |
| Epsilon Indi Ba+Bb | Two brown dwarfs. Their spectrum shows water, methane, CO₂ and CO absorption. |
| Pulsating red giant (Gaia DR3 2160548942811758720) | A star near the north ecliptic pole, seen daily by SPHEREx, dimming by about a third and brightening again over 18 months. |
| RW Aurigae | A young star in a dusty disc (shown with caveats: saturated at most wavelengths). |
| R Draconis | A Mira variable that pulses every 245 days; saturated in SPHEREx, so its light curve uses a ring around the centre. |
| WISE 0855−0714 | The coldest known brown dwarf. In 2025–26 it sits next to a brighter star SPHEREx can't separate, so the app says plainly that this is not a detection. |

Every frame shows where its data comes from. Nothing in the app is simulated.

## Run it

Requirements: [Bun](https://bun.sh) for the app; [uv](https://docs.astral.sh/uv/) and Python 3.12 only if you want to re-download and re-process the data.

```bash
cd frontend
bun install
bun run dev        # http://127.0.0.1:5186
```

For **any position in the sky** (fetching live from NASA), also start the local server in a second terminal. It needs [uv](https://docs.astral.sh/uv/) and Python 3.12, listens only on your own computer (127.0.0.1:8091), and the dev server forwards `/api` to it:

```bash
cd backend
uv run python -m spherex_blink serve
```

A quick look (up to 6 visits, 4 exposures per visit and detector) takes about 1–3 minutes, depending on IRSA; “all data” takes longer. Results are cached in `backend/cache/live/` (the newest 25 are kept). Without the server, the built-in targets still work.

The processed data for all five targets (6 MB) is committed in `frontend/public/benchmarks/`, so the app needs no server and works offline. `bun run build` produces a static site in `frontend/dist/` that can be hosted anywhere (it uses relative paths, so a subfolder such as GitHub Pages works).

Tests:

```bash
cd frontend && bun test && bun run typecheck
cd backend && uv run pytest -q
```

Re-processing the data from NASA's archive (downloads roughly 1.5 GB of image cutouts per target into `backend/cache/`, which is not committed):

```bash
cd backend
uv run python -m spherex_blink bake all      # or: bake barnard eps-ind-b ...
uv run python -m spherex_blink validate      # accuracy report: docs/VALIDATION.md
```

## How it works

- [`docs/HOW-IT-WORKS.md`](docs/HOW-IT-WORKS.md): the science and the processing, step by step.
- [`docs/VALIDATION.md`](docs/VALIDATION.md): how accurate the numbers are, computed against 2MASS, WISE and Gaia.
- [`docs/BUILD-LOG.md`](docs/BUILD-LOG.md): how this was built, what went wrong and what we changed.
- [`docs/GET-THE-DATA.md`](docs/GET-THE-DATA.md): what the public site can fetch by itself, and how to bring in data you downloaded (or a field someone shared).
- [`docs/ROADMAP.md`](docs/ROADMAP.md): what is done and what is planned.
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
