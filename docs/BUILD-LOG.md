# Build log

How SPHEREx Blink was built, in order, including what went wrong. Built on 14 November 2026 by the project owner with AI assistance: Anthropic's Claude (Opus) wrote the code and ran the tests and browser checks; a second model (Claude Fable) reviewed the plan against NASA's live archive before any code was written. Every step was committed to git, so the history shows each change.

## 0. The starting point: a spec from a chatbot

The project began with a long, confident spec written by a web AI chat: a "flagship" app with 102-band image cubes, five "NASA benchmark targets", bloom effects, a 3D globe and a "zero-failure guarantee" that would quietly swap in simulated data when real data was missing. It is kept as [`SPEC-original.md`](../SPEC-original.md).

## 1. Checking the plan against reality before writing code

Instead of building the spec as written, a reviewer model queried NASA's IRSA archive directly (searches, real cutouts, file headers) and rewrote the plan as [`PLAN.md`](../PLAN.md), marking each fact verified (with a source) or unverified. The surprises:

- **Right:** the archive collections (`spherex_dr1`, `spherex_qr3`, …), the file structure and the cutout syntax were real.
- **Wrong target positions:** three of the five targets were given at their year-2000 or 2010 positions. Barnard's Star and WISE 0855 had moved out of their own fields of view.
- **Wrong data model:** SPHEREx does not produce a 102-colour image per visit. Each exposure is one wavelength per position. So the app shows per-detector stacks for blinking and builds spectra from single exposures.
- **Overstated drama:** Barnard's Star moves only 1–2 SPHEREx pixels between visits. The 2010 WISE image is what makes the motion obvious.
- **Saturation:** R Draconis turned out hopelessly saturated and was replaced with a pulsating star at the ecliptic pole, where SPHEREx looks every day.
- **Wrong name:** the WISE image collection is `wise_allwise`, not `allwise_p3am_cdd` (that's a folder).
- **A trap in the flags:** the "SOURCE" flag is set on every star, so the spec's "mask flagged pixels" would have deleted the stars.
- **Dropped on purpose:** the automatic fake-data fallback (simulated data must never pass as real), bloom, the 3D globe, and the "NASA benchmark" name.

The work was split into milestones with acceptance checks: M0 scaffold, M1 blink/difference on real data, M2 spectra/light curves/tour, M3 live "any coordinate" mode, M4 polish. The owner chose to focus on a strong static demo first (M3 deferred) and approved downloading ~8 GB for all five targets.

## 2. Scaffold

Bun + Vite + React 19 + TypeScript + Tailwind v4 for the app, a uv/Python 3.12 project for the pipeline. First check: that astropy and scipy load on this PC (some scientific libraries are blocked by Windows Application Control here; these weren't).

## 3. The pipeline

Archive search, cached and retrying cutout downloads, cleaning, resampling onto one grid, grouping into visits and inverse-variance stacking, Gaia positions, WISE frames, and a `bake` command that writes small static files. Thirteen tests on synthetic data (no network). A bug caught by the first test run: the resampler stacked coordinate arrays the wrong way (`np.vstack` instead of `np.stack`).

## 4. The first viewer

A WebGL2 renderer holding every frame on the GPU, blink and difference modes, detector picker, brightness controls, Gaia markers, URL state and keyboard shortcuts. A trial run on partly downloaded real data worked: the 2010 WISE frame showed Barnard's Star about 2.8′ south of its 2026 position, right where Gaia predicted. Fixes found in the browser:

- React's development mode mounts components twice, which destroyed the GPU program while still in use, so the image went black.
- The Gaia markers were far too crowded.

## 5. Downloading for real, and IRSA's bad day

Cutouts came at about 8 per minute, with roughly one request in three answered "503 Service Unavailable". Then IRSA's search and catalogue services had outages lasting hours ("502 Bad Gateway"), and one catalogue query simply hung. Each failure led to a fix:

- search results are cached on disk;
- metadata queries retry for about 4 minutes;
- the AllWISE catalogue lookup moved to IRSA's older Gator service, which kept working;
- the 2010 WISE frame became optional, so a target still bakes without it and says why.

## 6. Spectra, light curves, tour

Aperture photometry on every single exposure for the target and up to 30 field stars, a spectrum / light-curve / table panel, click-to-select, a motion fitter and a first tour. Results on real data:

- **Barnard's Star motion** from the images: 10.42 ± 0.11″/yr; Gaia: 10.39″/yr.
- **Saturation everywhere:** most targets are too bright for SPHEREx. Barnard's Star saturated in 240 of 243 measurements. The pole star (Gaia G = 12.4, but very red) saturated in 448 of 480. The fix was **ring photometry**: measure the light in a ring around the saturated centre. That recovered the pole star's pulsation, fading to about half and back over 18 months.
- **Epsilon Indi B's spectrum** came out textbook: water, methane, CO₂ and CO absorption, absent in a nearby ordinary star.
- **WISE 0855 failed honestly:** its signal at short wavelengths, where it should be invisible, gave it away. It is passing 4–11″ from a brighter background star that SPHEREx cannot separate from it. The app now says this is not a detection.
- **Bug:** a URL setting (`band=5`) was ignored, because a value was set inside a React state updater, which development mode calls twice.

## 7. Making it look and read better

The owner's feedback: it worked but looked pixelated and the interface was confusing. Changes:

- **Pixelation explained and fixed:** SPHEREx pixels really are 6.15″ wide, so a target is only 50–80 pixels across. The display is now smoothed (bicubic, for display only, never across missing data), with a one-click switch back to raw pixels.
- **Nicer image:** a "Night sky" colour map; saturated star centres filled for display instead of showing black squares; quieter Gaia markers kept inside the image.
- **New layout:** target cards with one-line hooks, a "now showing" card explaining each frame, a proper timeline with a 15-year gap marker for 2010, a wavelength bar drawn to scale, switches with explanations, and the expert settings folded away. It was checked on desktop and on a phone-sized screen.

## 8. A tour that teaches

The first tour was three paragraphs of text and left the owner confused. The new tour has nine short steps. Each spotlights one part of the screen, asks you to try one thing (click the 2010 dot, press play, switch to Difference, click the brown dwarfs), checks that you did it, and then explains what you just saw. Its logic is unit-tested, and every step was clicked through in the browser.

## Testing, in numbers

- Pipeline: 19 pytest tests (resampling accuracy, stacking, flag handling, photometry within 2%, ring photometry with a saturated core, retry logic, catalogue parsing, Gaia propagation to 0.5″).
- App: 37 bun tests (sky coordinates, stretch maths, URL state, bundle format, centroid and motion fit, spectra helpers, saturated fill, tour steps and card placement), plus TypeScript type-checking and a production build.
- Browser checks after each milestone, on real data.

## Open decisions

- Keep or drop RW Aurigae (weak evidence of change) and WISE 0855 (not detected); a clean alternative is Teegarden's Star.
- M3 "any coordinate" live mode and M4 polish (image/video export, sonification) are not built.
