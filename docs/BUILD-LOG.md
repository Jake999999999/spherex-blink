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
- **Saturation everywhere:** most targets are too bright for SPHEREx. Barnard's Star saturated in 240 of 243 measurements. The pole star (Gaia G = 12.4, but very red) saturated in 448 of 480. The fix was **ring photometry**: measure the light in a ring around the saturated centre. That recovered the pole star's pulsation: once the change of brightness with wavelength is allowed for, it dims by about a third between visits and brightens again over 18 months.
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

## 9. Colour, validation and accessibility

The owner asked for SPHEREx's 102 colours, proof of accuracy, and accessibility, plus a design for an "any coordinate" live mode (planned, not built). Before writing code:

- **Live checks:** web pages cannot read IRSA's services directly (no CORS). But the public S3 mirror of the same files allows browser access, including byte ranges, and the all-sky cube tiles follow a fixed naming pattern. So colour at any coordinate can work with no server at all; only blinking at any coordinate needs a tiny metadata proxy.
- **Architect review:** a second model reviewed the plan and found five must-fix issues:
  - the map spectra needed the same units as the exposure spectra;
  - time-averaged spectra of moving or variable stars mislead;
  - cube pixels with no observations needed masking, and compressed files would break the byte offsets;
  - screen-reader announcements must not fire on every blink frame;
  - the biggest risk in the planned live mode is porting the pipeline to TypeScript, which needs test files generated from Python.

  It also caught a real bug: resampled variance used interpolated values instead of Σw²·var.

What came out:

- **Colour mode** works from the cube window read straight from S3, and the brown dwarfs measurably turn pink in the methane view. A first rule hiding map spectra for "fast movers" was too strict (it hid Eps Indi B); it now uses the aperture size.
- **Validation** turned out better than expected: fluxes match 2MASS/WISE within 3% (2–6% spread) even without an aperture correction, positions within 0.56″, motions within 1%.
- **The pulsation was overstated:** "fades to half" compared different wavelengths. Divided by wavelength and compared visit by visit, the giant dims by about a third; the tour and docs were corrected.
- **The chart descriptions first got two things wrong.** They called constant stars "variable" (wavelength trend and single-exposure noise) and read noise in empty sky as "dips". Both were fixed with tests.

## 10. Making colour the main view

The owner found smoothing looked poor in Colour mode and wanted the 102-colour view as the default, better explained. What was wrong, measured rather than guessed:

- **Ringing:** the colour grid is coarse (about 25 pixels across a field), and the Catmull-Rom filter overshoots around bright stars. With three channels each ringing differently, that showed as coloured fringes. Fix: clamp each smoothed value to its four nearest pixels, and skip missing pixels instead of drawing hard squares. Smoothed: 82 hard edges in the image, against 858 with raw pixels.
- **Coloured noise:** stretching each colour separately turns sky noise into confetti. Fix: the Lupton et al. (2004) stretch on combined brightness, keeping colour ratios.
- **A display option that lied:** "Balanced" (each colour stretched on its own) painted an ordinary star green. Removed; only true ratios remain.
- **Saturation faked colours:** the three bright targets came out deep red, only because their short-wavelength light was missing. Windows now need real data in half their channels, and blown-out cores are painted white with a note.
- **Hints were checked before being written.** The planned "water makes the giant stand out" and "warm dust makes RW Aur red" didn't survive the measurements, so those hints say what is actually visible. The brown dwarfs measure as pink (R 0.69, G 0.09, B 0.22), not magenta, and the text now says pink.

## 11. Making it a science tool (S1–S4)

- **S1, masks:** 1,901 cached cutouts were counted bit by bit. TRANSIENT, DICHROIC, PERSIST, CROSSTALK, the GHOST bits, STREAK, BLOOM, SNOWBALL and HALO were added to the masked bits (about 5% of pixels in all), because each can fake a one-off brightening.
- **S2, honest differences:** a plain difference of two visits leaves light and dark leftovers on every star, because SPHEREx sees each star at a slightly different wavelength each time. Each visit is now compared against the all-visit map at the same wavelengths, with the sky gradient removed. Leftovers dropped from 12.4% to 6.6% (Epsilon Indi B) and from 15.1% to 7.3% (WISE 0855). The same exposures give our own 6.15″ 102-channel map, twice as sharp as the archive's.
- **S3, error bars:** the scatter of repeated measurements was compared with the pipeline's errors, and per-detector scale factors (1.0–2.4) are applied to every exported error.
- **S4, injection and recovery:** fake stars were added to real frames and measured back, giving detection limits of 0.06–0.5 mJy depending on the field. Fake movers showed that SPHEREx alone can't measure slow motions reliably in crowded fields, so the motion tool warns when the 2010 WISE frame isn't there to anchor it.

## 12. Any spot in the sky, with a local server

A small standard-library server (loopback only, architect-reviewed) runs the same pipeline for any name or coordinates. Two fixes came from live testing: ESA's Gaia service stopped answering (IRSA's copy of Gaia DR3 is now the fallback), and a quick look's sampled visits got regrouped (the bake now keeps exactly the visits it sampled). R Draconis came back as a built-in target, and contamination flags became a per-pixel overlay.

## 13. Sixteen years of motion: NEOWISE

WISE kept imaging the sky every six months after 2010. A median of up to 8 single exposures per visit gives about 20 extra frames from 2014–2024, so Barnard's Star now crosses the field smoothly from 2010 to 2026. A few IRSA 503s cost 3 of 252 exposures for one target. Re-running the bake picks them up from the cache.

## 14. Any spot, with no server at all

The public site can't run a server, and NASA's search services can't be called from a web page. NASA's S3 copy of SPHEREx can, so the browser now does the work itself: the 102-colour map in seconds, and the time series from IRSA's exposure list saved and dropped by the user. The first real test turned up something the synthetic tests couldn't: the full level-2 files store FLAGS RICE-compressed. A RICE decoder now reads just the needed rows, and the synthetic fixtures include astropy-compressed FLAGS. A second real file had an `l2b_retry` folder name that the safety pattern refused; the pattern now allows exactly that. The strongest check: dropping the 258 cutouts the WISE 0855 bake used reproduces the bake, every pixel within 0.002 MJy/sr. Section 3.6d of HOW-IT-WORKS has the details.

## 15. PSF photometry, and sharing data without a server

SPHEREx ships an effective PSF for every region of every detector. Fitting it at each star's Gaia position (with neighbours fitted too) halved the star-to-star scatter against 2MASS and WISE, from 3-7% to 1-4%, without moving the calibration. Two things were checked before trusting it: the orientation of the PSF images (as stored; flipped or transposed fits much worse) and the active-pixel offset of each cutout. Astropy applies the SIP distortion to that linear axis too, so it is computed by hand. One surprise: the fit skips saturated cores, so for Barnard's Star the PSF column was nearly empty, and the app now falls back to the aperture when the fit has fewer than half the points. Also new: a field built by the pipeline can be shared as its files and dropped on the public site, and docs/GET-THE-DATA.md explains what the site can fetch by itself and how to bring in the rest.

## Testing, in numbers

- Pipeline: 53 pytest tests (now also the PSF fit) (including the cube reader against a fake Range server and the HEALPix tile lookup against IRSA's answers) (resampling accuracy, stacking, flag handling, photometry within 2%, ring photometry with a saturated core, retry logic, catalogue parsing, Gaia propagation to 0.5″).
- App: 81 bun tests (now also the browser-mode FITS reader, RICE decoding, TAN-SIP and HPX projections against astropy, HEALPix tiles, exposure-list parsing and URL safety, and the browser builder against the Python pipeline) (including colour maths, honest-colour rules, map spectra, sonification and chart descriptions) (sky coordinates, stretch maths, URL state, bundle format, centroid and motion fit, spectra helpers, saturated fill, tour steps and card placement), plus TypeScript type-checking and a production build.
- Browser checks after each milestone, on real data.

## Open decisions

- Keep or drop RW Aurigae (weak evidence of change) and WISE 0855 (not detected); a clean alternative is Teegarden's Star.
- Live mode is built (local server, and browser-only without one). Still open: PSF photometry (S6), SAMP once hosted, an accessibility audit, and the hosting itself.
