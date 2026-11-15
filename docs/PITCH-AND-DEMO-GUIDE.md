# SPHEREx Blink — Complete Feature Reference, Slideshow & Video Script Guide

> **How to use this document:** Hand this file to your slide/video AI (or read it while recording) to generate a concise NASA Space Apps Challenge 2026 pitch deck, demo video, and narration script. Everything marked **`★ JUDGE-WINNING EMPHASIS`** is a high-impact differentiator for NASA / astrophysics judges.

---

## 1. One-Sentence Pitch

**SPHEREx Blink turns NASA's 102-colour infrared all-sky survey into an interactive, scientifically validated time-machine—letting anyone blink 16 years of infrared sky motion, isolate subtle changes, and extract calibrated spectra, light curves, and sound from real NASA data right in the browser.**

---

## 2. ★ Judge-Winning Emphasis Points (What Makes This Win)

If you only have 2–3 minutes, make sure the judges hear and see these **seven** things:

1. **`★ JUDGE-WINNING EMPHASIS` Zero Simulated Data — Independently Validated to Research Grade**
   - Every pixel, spectrum, and proper-motion number comes from real NASA/ESA archives (SPHEREx DR1 & QR3, AllWISE 2010, NEOWISE 2014–2024, Gaia DR3, 2MASS).
   - Validated automatically by `uv run python -m spherex_blink validate` ([`VALIDATION.md`](VALIDATION.md)):
     - **Photometry:** matches 2MASS (`J, H, Ks`) and AllWISE (`W1, W2`) within **3%** median calibration and **1–4% star-to-star scatter** using SPHEREx's official effective PSF (`ePSF`).
     - **Astrometry:** median positional offset **0.65″** (0.11 SPHEREx pixel) against Gaia DR3.
     - **Proper motion:** matches Gaia DR3 to **0.6–1.3%** over a 16-year baseline (e.g. Barnard's Star: 10.53″/yr measured vs 10.39″/yr Gaia; Epsilon Indi B: 4.71″/yr vs 4.68″/yr).
     - **Honest science:** when a target is unmeasurable (e.g. **WISE 0855−0714** passing 4–11″ from a brighter background star in 2025–26, or saturated cores in **R Draconis**), the app explicitly warns the user instead of faking a detection.

2. **`★ JUDGE-WINNING EMPHASIS` Solves SPHEREx's Linear Variable Filter (LVF) Challenge**
   - SPHEREx doesn't take 102-colour snapshots at once—each exposure's wavelength varies continuously across the detector (`WCS-WAVE`). A naive subtraction between visits mixes different wavelengths and creates fake 7–15% residuals on static stars.
   - **Our solution:** per-channel spectral stacking (`matched.py`) builds a 102-channel **6.15″ map (twice as sharp as NASA's 12.88″ HEALPix map)** and subtracts matched wavelengths, cutting static-star residuals roughly in half and revealing true motion/variability in **Difference** mode.

3. **`★ JUDGE-WINNING EMPHASIS` 16-Year Multi-Mission Baseline (2010 → 2026)**
   - Combines **2010 AllWISE**, **2014–2024 NEOWISE** (6-month cadence), and **2025–2026 SPHEREx** into up to ~25 time-ordered frames so proper-motion stars (Barnard's Star, Epsilon Indi B) visibly glide across the sky—and lets users measure proper motion directly on screen and compare it to Gaia DR3.

4. **`★ JUDGE-WINNING EMPHASIS` Works Serverless in Any Browser — Straight from NASA's S3 Bucket**
   - Even on a static site (GitHub Pages) with **zero backend**, users can fetch the 102-colour map for **any RA/Dec in the sky in seconds** via HTTP Byte-Range requests to NASA's public `nasa-irsa-spherex` S3 bucket (using our TypeScript port of HEALPix order-5 `ang2pix_nest`, TAN-SIP WCS, and `RICE_1` decompression inside a Web Worker).
   - With the optional local Python server (`spherex_blink serve`), users also get one-click IRSA SIA/cutout fetching, Gaia DR3, AllWISE/NEOWISE mosaicking, wavelength-matched differences, and per-star PSF spectra.

5. **`★ JUDGE-WINNING EMPHASIS` Built for Both Public Discovery & Working Astronomers**
   - **Discovery:** True-ratio Lupton RGB presets (*Methane*, *Water*, *Warm Dust*), interactive guided tour, plain-language explanations, **Web Audio sonification** (listen to spectra and light curves), and **1-click animated GIF export** for slides and social sharing.
   - **Research:** Official ePSF + ring-aperture photometry, `mJy` / `AB mag` / `λF_λ` unit switching, **Redshift `z` (0–4)** spectral line slider, **Planck blackbody** fitter, live **+ 2MASS/WISE** VizieR overlay, **Target List CSV/TSV stepper**, raw **FITS** with WCS, **ECSV** (loads straight into `astropy.table.Table.read`), and **Web SAMP** hand-off to Aladin/TOPCAT/DS9.

6. **`★ JUDGE-WINNING EMPHASIS` Resilient by Design (Graceful Upstream Fallbacks & Health Ping)**
   - Real space archives have outages (IRSA 502/503s, CDS Sesame timeouts). The app includes a live **Data Source Health** ping bar, automatic VizieR TAP fallback for Gaia/AllWISE/2MASS, dual-repo static asset mirroring, and a **Shuffle** button + **AI Coordinate Prompts** in the Guide so users can always get working decimal `RA Dec` targets even when name resolvers are down.

7. **`★ JUDGE-WINNING EMPHASIS` Accessibility Built In from Day One**
   - Web Audio **sonification** of spectra and light curves, screen-reader chart summaries, **WCAG-compliant ≤ 3 Hz blink rate cap** + `prefers-reduced-motion` respect, high-contrast UI, and toggleable single-key shortcuts.

---

## 3. Complete Feature Inventory (What Everything Does, How It Works & Where It Is)

### A. Top Bar & Navigation (`TargetBar.tsx`, `App.tsx`)
| Feature | What it does | How it works | Where to find it |
|---|---|---|---|
| **Built-in Demo Targets** | Instant offline access to 6 curated targets: **Barnard's Star**, **Epsilon Indi Ba+Bb**, **Pulsating Giant (NEP)**, **RW Aurigae**, **R Draconis**, **WISE 0855−0714**. | Pre-baked binary bundles (`cube.bin`, `finecube.bin`, `frames.bin`, `neowise.bin`, `flags.bin`, `gaia.json`, `spectra.json`, `meta.json`) in `frontend/public/benchmarks/` (or secondary data repo). | Top target selector pills in the header. |
| **Share Link** | Copies a URL preserving the exact view (target or RA/Dec/FOV, mode, band, visit pair, colour preset, stretch). | `serializeState` / `parseState` in `src/lib/urlState.ts` encodes view state into query params (`?target=…&mode=…` or `?ra=…&dec=…&fov=…`). | **Share** button (`Share2` icon) in the top bar. |
| **Guided Tour** | 2-minute interactive spotlight walkthrough for first-time users. | `src/lib/tour.ts` drives step-by-step UI spotlights and waits for user interaction. | **Tour** button in the top bar. |
| **Guide** | Explains SPHEREx science (*What is SPHEREx*), step-by-step usage (*How to use*), and **Generate Coordinates with AI** copyable prompts. | `GuideAndSettings.tsx` (`science` and `howto` tabs) with one-click clipboard copy for single-target and batch-CSV AI prompts. | **Guide** button in the top bar. |
| **Accuracy Report** | Shows live-computed accuracy metrics vs 2MASS, AllWISE, and Gaia DR3. | `Accuracy.tsx` reads `frontend/public/benchmarks/validation.json` generated by `validate.py`. | **Accuracy** button in the top bar. |
| **Settings** | Switch between **Auto**, **Browser-only**, or **Local server** mode; toggle single-key shortcuts (`Space`, `←/→`, `D`, `G`, `P`, `R`, `Esc`). | Stored in component/local state (`?browser` URL param also forces browser mode). | **Settings** gear button in the top bar. |

### B. Sky Search, Target List & Data Health (`LiveSearch.tsx`, `BrowserFetch.tsx`, `TargetListStepper.tsx`, `DataSourceStatus.tsx`)
| Feature | What it does | How it works | Where to find it |
|---|---|---|---|
| **Any-Sky Search** | Enter an object name (`R Draconis`) or coordinates (`133.795 -7.245`, `08h55m10.8s -07d14m42.5s`) and FOV (`2–15′`). | **Local server:** resolves via CDS Sesame, runs `python -m spherex_blink field` (SIA + cutouts + WISE + Gaia + PSF). **Browser mode:** fetches 102-colour map directly from AWS S3 via byte ranges; optionally builds time-series blink in a Web Worker from a dropped/pasted IRSA SIA list or local FITS files. | Search bar at the top of the main view. |
| **Random Sky Shuffle Button** | Fills a verified working decimal `RA Dec` coordinate (e.g., Orion Bar, M82, NGC 1333, Ring Nebula, Eta Carinae, Luhman 16, Cassiopeia A) in one click. | `pickRandomSpot()` in `src/lib/coords.ts` picks from 14 `CURATED_SPOTS` formatted as decimal `RA Dec` (bypassing name resolvers). | **1-character Shuffle icon button** immediately next to the search input. |
| **Target List Stepper** | Load a CSV/TSV (`name, ra, dec`) of candidate objects and step **Prev / Next** through them. | `TargetListStepper.tsx` + `parseTargetList()` in `src/lib/targetlist.ts`. | **List** button next to the search bar. |
| **Data Source Health Bar** | Live status pills (`AWS S3`, `ESA Gaia DR3`, `VizieR TAP`, `CDS Sesame`, `Data Mirror`, plus `IRSA SIA/Cutouts` in server mode). | `DataSourceStatus.tsx` probes CORS-enabled endpoints in browser mode or calls `/api/status` on the local server. | Strip directly below the search bar. |

### C. WebGL2 Sky Canvas & Overlays (`SkyCanvas.tsx`, `renderer.ts`, `colormaps.ts`)
| Feature | What it does | How it works | Where to find it |
|---|---|---|---|
| **3 View Modes** | **Colour** (102-band false-colour RGB), **Blink** (time-series movie), **Difference** (newer minus older visit). | WebGL2 32-bit float texture arrays (`renderer.ts`) with Lupton RGB stretch, symmetric cyan-black-amber difference map, and lightness-ordered colormaps (`night`, `gray`, `inferno`, `magma`, `viridis`, `inverted`). | Mode tabs above/beside the sky view. |
| **Smooth vs Pixels (`P`)** | Toggle between smoothed display and raw 6.15″ SPHEREx pixels. | Catmull-Rom bicubic (single band) or cubic B-spline (colour cube) in GLSL; falls back cleanly near missing pixels without inventing data. | **Smooth / Pixels** button in the **top-right overlay of the sky image**. |
| **Animated GIF Export** | Exports the entire Blink sequence (including frame labels/overlays) as a looping `.gif` file for slides and papers. | Zero-dependency **GIF89a + LZW encoder** (`src/lib/gif.ts`, `6×6×6 + 40-gray` 256-color palette) capturing frames at the chosen FPS. | **`GIF` button (`Film` icon) in the top-right overlay of the sky image** — **visible whenever Blink mode is active** (`state.mode === "blink"`). |
| **FITS Export** | Downloads the exact on-screen image (visit, difference, or RGB planes) as a standard FITS file. | `buildFits()` in `src/lib/fitsio.ts` writes 32-bit float `BITPIX = -32` with full WCS headers and provenance (raw un-filled values). | **`FITS` button (`Download` icon) in the top-right overlay of the sky image**. |
| **Web SAMP** | Sends the current FITS image directly to desktop tools (Aladin, TOPCAT, DS9). | `src/lib/samp.ts` communicates via the local server's SAMP hub. | **`SAMP` button (`Send` icon) in the top-right overlay of the sky image**. |
| **Reset Zoom (`R`)** | Recenters and fits the sky canvas to the viewport. | `canvasRef.current.resetView()`. | **Rotate/Reset icon** at the far right of the top-right image overlay. |
| **Gaia, Contamination Flags & Motion Fit** | Toggles Gaia DR3 star circles (propagated to the frame's epoch), orange contamination flag overlays (`flags.bin`), and interactive proper-motion fitting (`motion.ts`). | Tangent-plane proper-motion propagation (`astro.ts`) and light-weighted centroiding + least-squares line fit across epochs. | Control pills below/beside the canvas and in the Timeline/inspector. |

### D. Colour Mixer (`ColourMixer.tsx`, `colour.ts`)
| Feature | What it does | How it works |
|---|---|---|
| **Presets & Custom RGB Windows** | One-click presets (**Short-to-long**, **Methane** [3.3 µm green], **Water** [1.4 µm green], **Warm dust**) or drag custom R/G/B wavelength sliders across 0.75–5.0 µm. | Averages channels in each window (requiring ≥ 50% coverage), applies true-ratio Lupton et al. (2004) asinh stretch, paints saturated cores white, and uses our **6.15″ fine cube** when available (falling back to NASA's 12.88″ S3 cube). |

### E. Spectrum, Light Curve & Table Panel (`SpectrumPanel.tsx`, `spectra.ts`, `sonify.ts`)
| Feature | What it does | How it works | Where to find it |
|---|---|---|---|
| **Per-Exposure Spectrum** | Plots flux vs wavelength (0.75–5.0 µm) coloured by visit, with detector bands (D1–D6) and reference molecules (`H₂O`, `CH₄`, `CO₂`, `CO`, atomic/PAH lines). | Click any marked star (or any pixel in Colour mode for the map spectrum). Uses official ePSF fit by default, with toggleable **Aperture** or **Ring** (for saturated stars) photometry. | Right/bottom **Spectrum Panel** when a star/spot is clicked. |
| **Units & 3σ Upper Limits** | Switch between `mJy`, `AB mag`, and `λF_λ`, with `obs_id` provenance and 3σ upper-limit markers. | `convertFlux()` in `src/lib/spectra.ts`. | Unit selector in the Spectrum Panel header. |
| **Redshift `z` Slider (0–4)** | Shifts reference spectral lines by `(1 + z)` to inspect extragalactic / redshifted targets. | Slider updates `SPECTRAL_LINES` positions live on the SVG plot. | Controls bar under the spectrum plot. |
| **Planck Blackbody Fit** | Fits and overlays a blackbody temperature curve (`T` in Kelvin) to the clean points. | `fitBlackbody()` + `planckNu()` in `src/lib/spectra.ts`. | **Blackbody** toggle in the spectrum controls bar. |
| **+ 2MASS/WISE Overlay** | Fetches live 2MASS (`J, H, Ks`) and AllWISE (`W1, W2`) photometry from VizieR TAP and plots them on the same axes. | `fetchCataloguePhotometry()` in `src/lib/spectra.ts`. | **`+ 2MASS/WISE` button** in the spectrum controls bar. |
| **Listen (Sonification)** | Plays the spectrum (0.75 → 5.0 µm) or light curve (early → late) as a 3-second Web Audio glide (220–880 Hz). | `src/lib/sonify.ts` maps log-flux to frequency; absorption dips sound like pitch drops. | **Listen** button in the Spectrum / Light Curve header. |
| **CSV & ECSV Export + SAMP** | Downloads all measurements as spreadsheet CSV or Astropy-ready ECSV, or sends the table via Web SAMP. | `toCsv()` and `buildEcsv()` in `src/lib/fitsio.ts` (tested with `astropy.table.Table.read`). | **CSV**, **ECSV**, **SAMP** buttons in the Spectrum Panel header. |

---

## 4. Suggested 9-Slide Deck Outline (For Your Slideshow AI)

1. **Title Slide — SPHEREx Blink**
   - *Visual:* Screenshot of Epsilon Indi B in Colour (Methane) mode.
   - *Copy:* "Watching the Infrared Sky Change in 102 Colours — Built on Real NASA SPHEREx, AllWISE, NEOWISE & Gaia Data."
2. **The Challenge & Why SPHEREx Is Hard**
   - *Visual:* Diagram of SPHEREx's 6 detectors & Linear Variable Filters (0.75–5.0 µm).
   - *Copy:* Every exposure has a different wavelength across the detector; pixels are 6.15″ wide; moving/variable objects span 16 years of archives.
3. **Our Solution: 16-Year Blink + Difference Engine**
   - *Visual:* Side-by-side of Barnard's Star 2010→2026 Blink GIF + Difference view (amber/cyan dipole).
   - *Emphasis (`★`):* Wavelength-matched stacks cut static-star colour leakage in half; 16-year baseline tracks motion to 1.3% of Gaia DR3.
4. **102-Colour Discovery & Sharper 6.15″ Map**
   - *Visual:* Epsilon Indi Ba+Bb in Methane preset (bright pink dot) + spectrum showing `H₂O`, `CH₄`, `CO₂`, `CO` dips.
   - *Emphasis (`★`):* True-ratio Lupton RGB + 6.15″ fine cube (2× sharper than NASA's 12.88″ HEALPix map).
5. **Research-Grade Spectroscopy in the Browser**
   - *Visual:* Spectrum Panel with ePSF points, Planck blackbody curve, Redshift `z` slider, and `+ 2MASS/WISE` overlay.
   - *Emphasis (`★`):* Official SPHEREx ePSF fitting, calibrated error model, `obs_id` provenance, FITS / ECSV / Web SAMP exports.
6. **Zero-Install Serverless Architecture**
   - *Visual:* Diagram showing Browser → AWS S3 Byte-Range (`nasa-irsa-spherex`) in Web Worker vs Optional Local Python Server.
   - *Emphasis (`★`):* Any RA/Dec in the sky works on GitHub Pages with no backend; live Data Source Health bar + Shuffle + AI Coordinate Prompts.
7. **Independent Scientific Validation (`★` Money Slide)**
   - *Visual:* Clean table from `VALIDATION.md`: Photometry within **3%** (1–4% scatter), Positions **0.65″**, Motion **0.6–1.3%** vs Gaia DR3, plus honest WISE 0855 blending caveat.
8. **Accessibility & Sonification**
   - *Visual:* Screenshot of Listen button + plain-language summary + WCAG <3 Hz flash cap.
9. **Live Demo / Try It Now**
   - *Visual:* QR code / GitHub Pages link + Space Apps checklist (all requirements met).

---

## 5. 2–3 Minute Video Script & Demo Flow

- **0:00–0:20 | Hook & Problem**
  - *Visual:* Title slide → open app on **Epsilon Indi B** in **Colour** mode.
  - *Say:* "NASA's SPHEREx telescope maps the entire sky in 102 infrared colours every six months. But raw infrared FITS cubes are huge, every pixel has a different wavelength, and spotting what changed takes specialized tools. We built **SPHEREx Blink** so anyone—from students to astronomers—can explore real NASA time-series data in a browser."
- **0:20–0:50 | Colour Mode & Spectroscopy**
  - *Action:* Show **Methane** preset on Epsilon Indi B (pink dot), click it to open the **Spectrum Panel**, toggle **Blackbody**, click **+ 2MASS/WISE**, and click **Listen** for 3 seconds.
  - *Say:* "In the Methane preset, this pair of brown dwarfs glows bright pink because methane absorbs light in the green channel. Clicking it plots every single SPHEREx exposure using official PSF fitting—matching 2MASS and WISE within 3%. You can fit a Planck blackbody, shift emission lines with the redshift slider, or even listen to the spectrum as sound."
- **0:50–1:30 | 16-Year Blink, Motion Fit, Difference & GIF Export**
  - *Action:* Switch to **Barnard's Star** → **Blink** mode → play timeline (2010 WISE → NEOWISE → 2026 SPHEREx) → point out **`GIF`** button in the top-right image overlay → switch to **Difference** mode.
  - *Say:* "Switch to Blink mode on Barnard's Star and we combine 2010 WISE, 2014–2024 NEOWISE, and 2025–2026 SPHEREx into a 16-year movie. Our measured motion matches ESA's Gaia DR3 to 1.3%. You can export this loop straight as an animated GIF or a science-ready FITS file. In Difference mode, our wavelength-matched subtraction cancels steady stars and highlights motion as an amber-and-cyan pair."
- **1:30–2:05 | Any Spot in the Sky + Serverless S3 + Reliability**
  - *Action:* Click the **Shuffle** icon next to the search bar → click **Fetch from NASA** → briefly show **Guide** (AI prompts) and the **Data Source Health** bar.
  - *Say:* "Want to explore beyond the built-in targets? Hit the shuffle button—or paste coordinates generated with our built-in AI prompts—and the app fetches any patch of sky directly from NASA's public Amazon S3 bucket using HTTP byte ranges in a Web Worker, with live archive health checks."
- **2:05–2:25 | Validation & Close**
  - *Action:* Click **Accuracy** tab briefly to show the 2MASS/WISE/Gaia validation numbers.
  - *Say:* "Nothing in SPHEREx Blink is simulated. Every measurement is checked against 2MASS, WISE, and Gaia—and when data is blended or saturated, the app tells you honestly. Thank you!"
