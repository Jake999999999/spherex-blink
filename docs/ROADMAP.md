# Roadmap

What SPHEREx Blink does today, and what's planned. Suggestions and pull requests are welcome.

## Done

- Blink, difference and a 102-colour view of six built-in targets (the five named in the Space Apps challenge plus a pulsating giant at the north ecliptic pole), on real SPHEREx data.
- Per-exposure spectra and light curves, and per-pixel contamination flags.
- WISE 2010 and NEOWISE 2014–2024 frames, so nearby stars move across 16 years; motion fits checked against Gaia.
- Any position in the sky: with a local server (everything), or in the browser from NASA's S3 copy (colour map, blink and flags).
- Validation against 2MASS, AllWISE and Gaia, regenerated from the data ([VALIDATION.md](VALIDATION.md)).
- Exports: FITS images, ECSV/CSV tables; links that carry the view and position; Web SAMP hand-off to Aladin, TOPCAT and DS9 when running with the local server.
- PSF photometry with SPHEREx's official PSFs (star-to-star scatter against 2MASS/WISE about 1–4%), and error bars calibrated on steady stars.
- Bring your own data: SPHEREx files downloaded from IRSA, or a whole field shared by someone who ran the pipeline ([GET-THE-DATA.md](GET-THE-DATA.md)).

## Next

- **Accessibility audit.** An automated check (axe-core) plus a pass with a screen reader and keyboard only. The app already has keyboard shortcuts that can be turned off, chart descriptions, sonified spectra, no flashing above 3 per second and a colour-blind-safe palette, but it hasn't been audited yet.
- **One-click time series anywhere on the public site.** A small, static index of which SPHEREx exposures cover each patch of sky, so the browser can skip the "save IRSA's list and drop it" step. It has to be built once from IRSA's table service (which was unavailable when last tried) and fit in a few MB.
- **Outside review** of the methods and the validation by people who know SPHEREx data.
- **Wavelength-matched differences in the browser**, using each exposure's per-pixel wavelength table (`WCS-WAVE`).
- **More built-in targets**, as long as the site stays small: for example Teegarden's Star (another fast mover) or a known variable with a long SPHEREx record.
- **Hand-off to other tools without the local server**: Web SAMP works today with the local server; sending files directly from a static hosted site needs real file URLs.
- **PSF photometry for saturated stars**, fitting the unsaturated wings.
- **WISE, NEOWISE and Gaia in browser mode.** These archives can't be reached from a web page today; it needs a source that allows it, or a small hosted relay.

## Not planned

- Simulated or "filled-in" data shown as real. Everything shown is measured, and every view names its source.
