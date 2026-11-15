# How SPHEREx Blink works

This explains what the app shows and every step between NASA's archive and your screen. Numbers in this file match the code; file names point to where each step lives.

## 1. The telescope and its data

**SPHEREx** (Spectro-Photometer for the History of the Universe, Epoch of Reionization and Ices Explorer) is a NASA space telescope launched in 2025. It maps the entire sky in near-infrared light from 0.75 to 5.0 µm, splitting that range into 102 narrow colours. It covers the whole sky about every six months, so by November 2026 most places have been visited three or four times. Near the north and south ecliptic poles it looks every day.

Three facts shape everything in this app:

1. **Big pixels.** One SPHEREx pixel is 6.15″ across (Hubble's are about 0.1″). A 5–8′ patch of sky is only 50–80 pixels wide. The app smooths the display by default; the *Pixels* button (or P) shows the raw grid. All measurements use the raw pixels.
2. **Each photo is one colour per position, and each photo a different colour.** SPHEREx uses *linear variable filters*: the wavelength changes across each detector. As the telescope steps across the sky, a star lands on a different part of the filter in each exposure. A star's spectrum is built from many exposures, one point each. There is no "image at 102 colours" per visit.
3. **Six detectors.** Each covers a slice of the range: D1 0.74–1.12, D2 1.10–1.65, D3 1.64–2.44, D4 2.42–3.83, D5 3.81–4.43, D6 4.42–5.01 µm. The app shows one detector at a time.

The data comes from IRSA, NASA's infrared archive at Caltech/IPAC: Data Release 1 (`spherex_dr1`, April 2025 – May 2026) and Quick Release 3 (`spherex_qr3`, May – October 2026), plus their deep-field collections. Every fact we rely on is listed with its source in [`PLAN.md`](../PLAN.md) §2.

## 2. From the archive to a "baked" bundle (`backend/`)

The app does not talk to NASA's servers while you use it. A Python pipeline fetches and processes the data once ("baking") and writes small files the app loads. Run it with `uv run python -m spherex_blink bake <target>`.

### 2.1 Where is the target? (`gaia.py`, `bake.py`)

Nearby stars move, so a fixed coordinate is wrong: Barnard's Star has moved 4.6′ since 2000, which is outside the field of view if you use its old position. Positions come from ESA's **Gaia DR3** catalogue (measured for the year 2016.0) and are moved along the star's measured proper motion to any date:

- motion is applied in the tangent plane at the 2016 position, then projected back onto the sphere (`gaia.propagate`; accurate to milliarcseconds over decades);
- parallax (the yearly wobble from Earth's orbit) is ignored, and the app says so.

WISE 0855 is too faint for Gaia, so its position comes from the AllWISE catalogue (2010) plus the motion published by Luhman & Esplin (2016).

The image is centred halfway between the target's 2010 and 2026 positions, so both fit.

### 2.2 Finding and downloading the exposures (`irsa.py`)

- **Search:** IRSA's Simple Image Access service (`https://irsa.ipac.caltech.edu/SIA`) returns every SPHEREx exposure covering the position, with its date, detector and a direct file link. Results are cached on disk.
- **Cutouts:** instead of each full 2040×2040-pixel exposure, we ask IRSA for a small piece around the target by adding `?center=ra,dec&size=deg` to the file link. Each cutout still arrives as ~4 MB because it carries a large PSF table, which we drop before saving. A target is 250–480 cutouts, about 1.5 GB of transfer, kept in `backend/cache/`.
- **Reliability:** IRSA often answered HTTP 502/503 during this project. Every request retries with exponential backoff (5 tries for cutouts, 8 tries over ~4 minutes for searches), 4 downloads run at a time, and everything is cached so a re-run resumes.
- **Deep fields:** near the ecliptic pole 17,000+ exposures exist; we take up to 480, spread evenly in time and across the six detectors.

Each cutout is a multi-extension FITS file with `IMAGE` (surface brightness in MJy/sr), `FLAGS` (a bit per problem), `VARIANCE` (noise²), `ZODI` (a model of zodiacal light, the glow of dust in our solar system) and `WCS-WAVE` (the wavelength at every pixel).

### 2.3 Cleaning one exposure (`frames.load_exposure`)

1. Subtract the `ZODI` model from `IMAGE` (the archive does not do this).
2. Subtract any leftover background: the sigma-clipped median of the remaining good pixels.
3. Mark bad pixels using `FLAGS`: overflow/saturated (1) and the other detector problems (2, 6, 9, 10, 11, 15, 19), plus the artefacts that can fake a one-off brightening: cosmic-ray hits (0), the dichroic edge (7), persistence (17), crosstalk (20), ghosts (22–24), streaks (25), blooming (26), snowballs (27) and halos (28). Together they cost about 5% of pixels; how often each is set is measured in [`VALIDATION.md`](VALIDATION.md). **Bit 21 ("SOURCE") is deliberately not masked**: it is set on every star, and masking it would erase the stars.
4. Read the wavelength at the cutout centre (and later at each star) from `WCS-WAVE`.

### 2.4 Putting every exposure on one grid (`frames.resample`)

Exposures are rotated and shifted differently. Each one is resampled onto a common north-up grid (6.15″ per pixel, tangent-plane projection) using the exposure's own sky coordinates, including the SIP distortion terms. Resampling is bilinear (`scipy.ndimage.map_coordinates`). An output pixel that touches any bad or missing input pixel is left empty rather than filled in.

### 2.5 Grouping exposures into visits and stacking (`frames.group_epochs`, `frames.stack`)

- Exposures are split into **visits** wherever there is a gap of more than 45 days. Where coverage is continuous (the pole), long stretches are cut into equal bins of at most 75 days.
- For each visit and detector, all exposures are averaged, weighted by 1/variance (**inverse-variance weighting**: quieter exposures count more). The result is one frame per visit per detector, plus its variance.
- A visit/detector with fewer than 3 exposures is left out rather than shown noisy.

Each stacked frame mixes the wavelengths within its detector (e.g. 4.42–5.01 µm for D6). That is right for seeing positions and changes; spectra come from the single exposures (2.7).

### 2.5b Wavelength-matched stacks and our own 6.15″ map (`matched.py`)

A visit stack mixes the wavelengths inside one detector, and each visit samples a slightly different mix, so a star's colour alone could make it look brighter or fainter in a difference image. So the bake also puts every exposure's per-pixel wavelength on the grid and stacks each visit **per channel** (the map's 102 channels): S[visit, channel].

- Their average over visits, M[channel], is a 102-channel map built from the single exposures at **6.15″ pixels, twice as sharp as NASA's 12.9″ map**. The Colour view uses it by default ("Sharper map"; "NASA map" switches back). Every channel has data at every pixel for all five targets, from about 3 visits each.
- A visit's **matched frame** for a detector is the weighted mean over its channels of S − M, after removing any sky offset and a smooth sky gradient (sliding median, 15 px). The difference of two matched frames compares like with like at every wavelength, which is what the Difference view shows. Measured on the real targets, the leftover at static stars falls from 7–15% of their brightness to 6–9% (table in [`VALIDATION.md`](VALIDATION.md)); what remains is mostly small differences in image sharpness and alignment between visits.

### 2.6 The 2010 WISE image (`wise.py`)

NASA's WISE mapped the sky in 2010. We fetch AllWISE W1 (3.4 µm) and W2 (4.6 µm) cutouts, blur them to match SPHEREx's coarser pixels (Gaussian, σ = half the pixel-size ratio), subtract the background and resample onto the same grid. WISE is a different camera with different units, so it is only ever **blinked**, never subtracted from SPHEREx. W1 is paired with detectors 1–4, W2 with 5–6. If IRSA's WISE search is down at bake time, the bundle is made without it and says why.

### 2.6b NEOWISE yearly frames (`neowise.py`)

After the AllWISE survey, WISE kept scanning the whole sky every six months as NEOWISE (2014–2024). For each visit and band (W1 3.4 µm, W2 4.6 µm) we take up to 6 single exposures spread over the visit (3 in a live quick look) from IRSA's `neowiser` collection. Each is background-subtracted, low-passed from 2.75″ to the 6.15″ grid and resampled; the visit's frame is the median, which also removes cosmic rays. That adds about 20 frames between 2010 and SPHEREx, so the blink becomes a 16-year video and the motion fit gets many more points. Like the 2010 frame it is a different telescope with different units (DN): it is blinked and used for positions, never subtracted from SPHEREx. Stored as half floats in `neowise.bin`.

### 2.7 Spectra and light curves: photometry on single exposures (`photometry.py`)

For the target and up to 30 of the brightest Gaia stars in the field (G < 15), in every exposure, in the exposure's own pixels (no resampling):

- the star's position on that date → pixel position;
- **aperture photometry**: sum of the light within 2.5 pixels (15.4″) minus the median sky in a ring 4–7 pixels out, converted to millijanskys (mJy) with the pixel's solid angle;
- the error from the variance map plus the sky uncertainty;
- the wavelength and bandwidth at that pixel from `WCS-WAVE`;
- a flag if the aperture touches a saturated (2) or masked (1) pixel.

There is no aperture correction, so the fluxes are for comparing points with each other (spectral shape, variability), not absolute brightness.

**Ring photometry for saturated stars.** Bright stars saturate SPHEREx: their central 1–4 pixels have no value. For these, a second measurement sums the light in a ring 1.5–4 pixels (9–25″) from the centre, which is unsaturated in almost every exposure. The share of starlight in the ring depends on wavelength, so this is valid for comparing dates (light curves) but not for spectral shape. The light curve picks it automatically when most core measurements are saturated.

A field star near each target was checked to stay constant to about 2–5% between visits, which shows the measurements are consistent.

### 2.8 The bundle (`bake.py`)

`frontend/public/benchmarks/<target>/`:

| File | Contents |
|---|---|
| `meta.json` | grid (WCS), visits with dates and exposure counts, target motion, WISE info, the full list of exposures used, provenance and credits |
| `frames.bin` | float32 arrays: stacked frames `[visit, 6, H, W]`, their variance, then the WISE frames |
| `spectra.json` | one entry per exposure (date, detector, visit) and, per source, flux, error, flag, wavelength and ring flux |
| `gaia.json` | Gaia stars in the field (2016 positions and motions) |

`index.json` lists the targets. All five bundles total 4.4 MB.

### 2.9 The colour map (`cube.py`)

SPHEREx also publishes an all-sky map in all 102 colours (`spherex_dr1_cube`): 12,288 tiles on a HEALPix grid, each 512×512 pixels of 12.88″ by 102 channels, 321 MB. Each channel is the average of every visit up to the release (April 2025 – May 2026).

- **Finding the tile without a search:** the tile number is the HEALPix (order 5, nested) pixel of the position, computed by our own `ang2pix_nest` and checked against IRSA's answers for six positions. A field near a tile corner can need up to four tiles. The release folder (`hips_20261026`) is read from the S3 bucket listing, so a new release doesn't break it.
- **Reading only what's needed:** the files are on a public S3 mirror that allows byte-range requests. Each channel is a 1 MB block, so the window around a field is one small request per channel (102 requests, a few seconds). The header walk checks the data is a plain, uncompressed image.
- Pixels never observed (`NHITS = 0`) become empty. The tiles' `FLAGS` are not used for masking yet (their bit meanings aren't checked).
- The window is resampled onto a north-up grid at 12.3″ per pixel (twice the main grid) and stored as `cube.bin` (≈ 0.25–0.7 MB per target).

### 2.10 Validation (`validate.py`)

`uv run python -m spherex_blink validate` compares the baked numbers with independent catalogues and writes [`VALIDATION.md`](VALIDATION.md): brightness against 2MASS and AllWISE (synthetic photometry over each band, isolated unsaturated stars), positions against Gaia, motions against Gaia/literature, visit-to-visit repeatability of constant stars, and the map against the single exposures. The app's "How accurate is this?" section reads the same numbers.

## 3. The app (`frontend/`)

React + TypeScript, drawing the sky with WebGL2.

### 3.1 Drawing the sky (`src/gl/renderer.ts`)

- Every frame of a target is uploaded once into a GPU texture array (32-bit floats), so switching frames costs nothing.
- **Brightness mapping:** pixel values between a black and a white level (percentiles of all visits for that detector, so every visit is drawn on the same scale) go through an **asinh stretch** (`asinh(12x)/asinh(12)`), which lifts faint stars without blowing out bright ones; then through a colour map ("Night sky" by default, all lightness-ordered).
- **Smoothing:** Catmull-Rom bicubic interpolation in the shader, for display only. Next to a missing pixel it falls back to the raw value so it never invents data across a gap.
- **Saturated cores:** a star whose centre is saturated would show a dark hole. For display only, empty pixels next to very bright ones (top 0.5%) are filled with the brightest neighbour (`fillSaturated` in `src/lib/sequence.ts`). Hovering there says "no value (saturated or not covered)".
- **Difference:** newer minus older visit, mapped symmetrically onto a cyan-black-amber colour map.

### 3.2 Overlays (`src/components/SkyCanvas.tsx`)

Gaia stars (G < 16) are drawn as circles at their positions on the date of the frame shown. The target gets a yellow cross for that date and a dashed line from its 2010 to its 2026 position. Scale bar and north/east arrows are drawn in screen space. Sky ↔ pixel conversion is a gnomonic projection (`src/lib/wcs.ts`), tested to round-trip within 0.01 pixel.

### 3.3 Clicking a star (`src/lib/spectra.ts`, `src/components/SpectrumPanel.tsx`)

A click picks the nearest baked source within 3 pixels of where it should be on the frame's date. The panel draws:

- **Spectrum:** flux against wavelength, coloured by visit; hollow dots are flagged. Detector ranges are shaded, and water, methane, CO₂ and CO band positions are marked for reference (they are positions, not detections).
- **Light curve:** flux against date for one detector, coloured by wavelength within it.
- **Table / CSV:** every measurement.

### 3.4 Measuring motion (`src/lib/motion.ts`)

For each frame in the blink (including WISE 2010), the star's centre is found by a background-subtracted, light-weighted centroid within 3 pixels of the Gaia position for that date (that is only the starting point; the centroid follows the light). A straight line is then fitted through position against time by least squares, giving motion east and north in ″/yr, the direction (position angle) and an error from the scatter. It is only offered when the star should move more than one pixel across the frames.

### 3.5 Colour mode (`src/lib/colour.ts`, `src/components/ColourMixer.tsx`)

Colour is the view every target opens in. Three wavelength windows (red, green, blue) each become one colour: the mean of the map channels inside the window, and only where at least half of those channels have data (a saturated star has none at the wavelengths where it is too bright, and averaging the survivors would give it a false colour). All three colours share one brightness scale ("true ratios"), so a colour always means more light at that wavelength; an earlier option that stretched each colour on its own was removed because it invented colours. The image is stretched the way astronomers make colour pictures (Lupton et al. 2004): the combined brightness goes through the asinh stretch and each pixel keeps its colour ratio, so faint sky stays dark grey instead of turning into coloured speckles. Saturated star centres are painted white, like a blown-out star in a photo, and the panel says so.

Smoothing skips missing pixels instead of falling back to hard squares. The single-band views use Catmull-Rom bicubic clamped to the four nearest pixels (no dark rings around bright stars). The coarser colour grid uses a cubic B-spline, which is smooth and cannot overshoot, so stars come out round rather than as clamped, flat-topped blocks.

Explaining it: the Colours panel opens with a small diagram (the slice of light your eyes see against SPHEREx's 0.75–5 µm, and the three slices currently painted red, green and blue) and two sentences on why colours reveal molecules. Each target has a "What to look for" hint, written only where the data supports it (for Eps Indi B: the pink dot is methane). Clicking a star shows the three windows shaded on its spectrum and a sentence such as "Looks pink here: brightest in the red window, dim in the green window, where CH₄ absorbs light", computed from the same map data the picture is made from. Presets: short-to-long, methane (green on the 3.3 µm band), water (green on 1.4 µm), warm dust. With the methane preset, Eps Indi B measures R 0.69 / G 0.09 / B 0.22 (pink) while an ordinary star next to it measures R 0.23 / G 0.35 / B 0.43.

Clicking in colour mode gives the **map spectrum** of that spot: the same 15.4″ aperture and local-sky subtraction as the single-exposure points, so both share an axis. Because each map channel was observed on a different date, the map spectrum is hidden for variable stars and for stars that move more than a quarter of the aperture radius from their mid-span position (Barnard's Star), with a note saying why.

### 3.6 Listening and reading (`src/lib/sonify.ts`)

- **Listen** plays a spectrum from short to long wavelength (or a light curve from early to late) as a 3-second glide, pitch rising with brightness (220–880 Hz, logarithmic); absorption dips are heard as drops. Sound starts only on a click and never under `?silent`; Esc stops it.
- Every chart has a sentence underneath, generated from the data: where the spectrum peaks and which dips line up with reference bands (only dips deeper than 25% *and* well above the noise), or whether a light curve changes. Light curves are first divided by the star's typical brightness at each wavelength and compared visit by visit, so a star that is merely brighter at some wavelengths than others isn't called variable.
- Other accessibility rules: blinking is capped at 3 frame changes per second (the WCAG flash limit) and doesn't start on its own if the system asks for reduced motion; frame changes are announced to screen readers only when you step, not during playback; the sky view has a text description; single-key shortcuts can be switched off in Help and are ignored while typing or using a slider; small text is at least 7.9:1 contrast.

### 3.6b Any position in the sky (`server.py`, `LiveSearch.tsx`)

Web pages can't query IRSA or Gaia directly (their services send no CORS headers), so a small local server does it. It uses only Python's standard library and listens on 127.0.0.1:8091; Vite forwards `/api` to it.

- **Name lookup:** CDS Sesame (SIMBAD/NED) turns a name into a position. Coordinates are read in decimal degrees or sexagesimal (`08h55m10.8s -07d14m42.5s`, `08:55:10.8 -07:14:42.5`).
- **Fetching and processing:** the server runs `python -m spherex_blink field --ra --dec --fov` in a subprocess: the same pipeline as the built-in targets (SIA search, cutouts, masks, stacks, wavelength-matched frames, 102-channel maps, WISE 2010, Gaia, photometry, flags), with the field centre as the "target". A quick look picks up to 6 visits spread over the whole span and 4 exposures per visit and detector, keeping exactly those visits when stacking. "All data" takes up to 10 visits and 12 exposures per cell.
- **Safety:** starting a job needs a JSON POST, and the server only answers requests whose Host is this computer (other web pages can't trigger downloads, DNS rebinding is blocked). It sends no CORS headers, validates every input (finite numbers, Dec within ±90°, field 2–15′, names up to 64 characters), and serves only an allowlist of bundle files from `backend/cache/live/<16 hex>/`. One job runs at a time, with a 25-minute timeout and a cancel button. Results are written to a temporary folder and renamed only when complete, and the newest 25 are kept. Live results never go into the public site folder.
- **Fallbacks:** if ESA's Gaia service doesn't answer, Gaia DR3 comes from IRSA's copy. If our 6.15″ map is incomplete (a quick look has too few exposures to fill every channel), Colour uses NASA's map.
- **Sharing:** while a live field is shown, the URL carries `ra`, `dec` and `fov`, so the link (or an iframe) opens the same patch for anyone running the server.

### 3.6c Contamination flags

For each visit and detector the bake records the share of exposures flagged at every pixel (`flags.bin`) and which flags were set (in `meta.json`). The "Contamination flags" switch tints flagged pixels orange; hovering shows the percentage and the panel lists the flags (for example HALO 3.3%, TRANSIENT 3.2%). Flagged pixels are always left out of the stacks.

### 3.7 Getting the data out

- **FITS** (button on the image): exactly what's on screen (a visit frame, a difference or the three colour planes), with raw values (never the display-only fills), full sky coordinates and provenance in the header.
- **ECSV** and CSV (spectrum panel): every measurement with units, errors, wavelength, bandwidth and flags; ECSV opens directly with astropy.
- A test writes both with the app's own code and reads them back with astropy (`backend/tests/test_exports.py`).
- Cite with `CITATION.cff`; tests run on every push (`.github/workflows/ci.yml`).

### 3.8 Tour, URL and keys

The guided tour (`src/lib/tour.ts`) is a list of steps; each can set up the view, spotlight a part of the page and wait for the visitor to try one thing. The view is mirrored in the URL (`?target=…&mode=…&band=…&t1=…&t2=…`). Keys: Space, ← →, D, G, P, R, Esc. `?silent` is for automated testing.

## 4. What the results mean, honestly

- **Barnard's Star:** moves 1–2 SPHEREx pixels between visits; the jump is obvious only against 2010. Motion measured from the images: 10.42 ± 0.11″/yr, Gaia says 10.39″/yr. Too bright for a reliable spectrum.
- **Epsilon Indi Ba+Bb:** 0.7″ apart, so one blended dot. The spectrum shows peaks near 1.25, 1.6, 2.1 and 4.0 µm and deep absorption by water (1.4, 1.9 µm), methane (2.3, 3.3 µm), CO₂ (4.3 µm) and CO (4.6 µm), as expected for cool brown dwarfs; a field star next to it shows none of this.
- **The pulsating giant:** saturated at every wavelength; the ring light curve shows it dimming by about a third between visits and brightening again over 18 months, once the change of brightness with wavelength inside a detector is divided out (Gaia's period: about 372 days).
- **RW Aurigae:** saturated on detectors 2–6. On detector 1 its brightness differs by 20–40% between visits, from only a few clean points each.
- **WISE 0855−0714:** passes 4–11″ from a brighter background star during the SPHEREx visits, inside the measuring aperture. What we measure is mostly that star; this is not a detection.
