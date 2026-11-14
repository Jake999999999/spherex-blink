# ORIGINAL SPEC (as pasted from a web AI, 2026-11-14) — not yet verified

> Kept as-is for reference. The working plan is `PLAN.md` / `CLAUDE.md`. Facts in here (collection names, dates, extension names, coordinates) were written by another AI and must be checked against IRSA before use.

# CLAUDE.md — SPHEREx Blink & Spectral Explorer (NASA Space Apps Flagship Build)

## 1. Mission & Winning Objective
Build **SPHEREx Blink**, a public-facing, GPU-accelerated citizen science web application for exploring NASA's SPHEREx near-infrared sky survey (102 spectral bands, 0.75–5.00 µm, 6-month all-sky epochs).
The tool must allow anyone—from casual citizen scientists to professional astronomers—to enter any sky coordinate `(RA, Dec)` or pick a NASA benchmark target, watch multi-epoch images animate like a video ("blink comparator"), subtract epochs (`T2 - T1`) to spot moving brown dwarfs/asteroids, inspect 102-band near-infrared spectra on the fly, overlay Gaia DR3 & AllWISE catalogs, sonify infrared spectra, and share discoveries via URL.

Write complete, production-grade code with zero placeholders, stubs, or TODOs.

## 2. Architecture & Monorepo Layout

```text
spherex-blink/
├── CLAUDE.md
├── backend/
│   ├── pyproject.toml                 # fastapi, uvicorn, astropy, astroquery, pyvo, numpy, scipy, httpx
│   ├── cache/                         # Cached IRSA FITS & packed binary cubes
│   ├── app/
│   │   ├── main.py                    # FastAPI app: CORS, JSON metadata + binary Float32 streaming
│   │   ├── irsa_client.py             # IRSA VO SIA2 + fast IBE cutouts (spherex_dr1, spherex_dr1_deep, spherex_qr3, allwise_p3am_cdd)
│   │   ├── datacube_builder.py        # ZODI subtraction, WCS TAN reprojection, 6-array & 102-band cube packing
│   │   ├── catalog_overlay.py         # Gaia DR3 & AllWISE catalog queries + proper-motion vector projection
│   │   └── targets.py                 # The 5 NASA benchmark targets + recommended presets
│   └── scripts/
│       └── prefetch_benchmarks.py     # Pre-fetches & bakes all 5 targets into backend/cache AND frontend/public/benchmarks
└── frontend/
    ├── package.json                   # React 19, TypeScript, Vite, Tailwind CSS, Lucide-react
    ├── index.html                     # Loads JetBrains Mono & Inter fonts, dark obsidian theme
    ├── public/
    │   └── benchmarks/                # Pre-baked static binary cubes so the 5 NASA targets load in <50ms offline
    └── src/
        ├── App.tsx                    # Top-level state, URL query sync, keyboard shortcuts
        ├── types/astronomy.ts         # Datacube headers, WCS, contamination flags, Gaia/WISE objects, candidates
        ├── gl/
        │   ├── WebGLBlinkEngine.ts    # WebGL2 TEXTURE_2D_ARRAY manager, FBO bloom pipeline, bicubic upsampler
        │   ├── shaders.ts             # GLSL ES 3.00 shaders: Blink, T2-T1 Diff, Co-Add, NIR RGB, Asinh HDR, Bloom
        │   └── colormaps.ts           # Grayscale, Inverted, Inferno, Viridis, Magma, JWST-NIR LUTs
        ├── components/
        │   ├── SkyCanvas.tsx          # Interactive WebGL2 viewport (pan/zoom, WCS grid, Gaia arrows, aperture cursor, Auto-Scan reticles)
        │   ├── CelestialGlobe.tsx     # 3D WebGL interactive sky sphere minimap (Galactic plane, Deep Fields, slew)
        │   ├── ControlDeck.tsx        # Target selector, RA/Dec input, FOV slider, Mode/Stretch/Colormap/Auto-Scan controls
        │   ├── TimelineScrubber.tsx   # Blink play/pause, FPS slider, Epoch scrubber, T1/T2 diff selectors, 2010 WISE toggle, Blink Loop export
        │   ├── WavelengthBar.tsx      # Continuous 0.75–5.00 µm 102-channel scrubber + draggable 3-cursor R/G/B spectral mixer
        │   ├── SpectrumDrawer.tsx     # Live aperture-photometry 102-band NIR spectrum + multi-epoch light curve SVG + Web Audio Sonify button
        │   ├── MetadataPanel.tsx      # FITS telemetry, SPHEREx FLAGS bitmask decoder, NASA provenance badge, Candidate Discovery export
        │   └── GuidedTour.tsx         # Dismissible 3-step interactive onboarding tour for judges & new users
        └── utils/
            ├── wcs.ts                 # Tangent-plane (TAN) pixel <-> RA/Dec math + angular separation
            ├── photometry.ts          # Circular aperture + sky annulus photometry, centroid proper-motion fitter & 5-sigma dipole detector
            ├── sonify.ts              # Web Audio API 102-band infrared spectrum sonification engine
            └── staticFallback.ts      # Loads pre-baked /benchmarks/*.bin if backend is offline (GitHub Pages mode)
```

## 3. Exact NASA IRSA SPHEREx Data Rules (Nov 2026 DR1 / QR3)

1. Endpoint & Collections:
   * Query IRSA's IVOA Simple Image Access v2 (`SIA2`) endpoint: `https://irsa.ipac.caltech.edu/SIA`
   * Supported collections:
      * `spherex_dr1` (Year 1 Wide Survey Spectral Image MEFs, released Nov 12, 2026)
      * `spherex_dr1_deep` (North/South Ecliptic Pole Deep Survey MEFs)
      * `spherex_dr1_cube` (All-Sky 102-channel HEALPix spectral cubes, 512x512 px @ 12.9"/px, already ZODI-subtracted)
      * `spherex_qr3` and `spherex_qr3_deep` (Latest 2026 Quick Release 3 epochs — compatible with DR1 calibrations)
   * CRITICAL RULE: NEVER mix `spherex_qr2` with `spherex_dr1` or `spherex_qr3` due to incompatible PSF/flux calibrations.
2. Fast IRSA IBE Server-Side Cutouts:
   * Append `?center={ra},{dec}&size={fov_deg}` directly to each SIA2 `access_url` (IRSA IBE cutout syntax) using async `httpx` connection pooling (`max_connections=16`) so multi-epoch 102-band downloads complete in seconds instead of downloading full 80 MB detector frames.
3. Multi-Extension FITS (MEF) Handling:
   * DR1/QR3 Spectral Image MEFs contain extensions: `IMAGE`, `FLAGS`, `VARIANCE`, `ZODI`, `EPSF`, `WCS-WAVE`.
   * Subtract `ZODI` (zodiacal background) from `IMAGE` prior to WCS reprojection so 6-month seasonal background variations do not corrupt `T2 - T1` epoch subtraction.
   * Preserve `VARIANCE` maps so difference imaging and auto-scan can compute true noise-normalized significance: `SNR_diff = (T2 - T1) / sqrt(VAR1 + VAR2)`.
   * Reproject all retrieved time-series cutouts onto a common tangent-plane (`TAN`) WCS grid centered at `(ra, dec)` with user-selected `fov_arcmin` (1 to 30 arcmin).
4. Optional 2010 AllWISE / NEOWISE Anchor Frame (16-Year Time Machine):
   * Query IRSA SIA2 (`COLLECTION=allwise_p3am_cdd`) for a 2010 `W1 (3.4 µm)` / `W2 (4.6 µm)` cutout reprojected onto the exact same `TAN` WCS grid so users can optionally include a 2010 baseline epoch (`2010 WISE -> 2025 SPHEREx -> 2026 SPHEREx`) to see 16 years of proper motion.
5. Detector Array Co-Addition & 102-Band Cube:
   * Pack each epoch into two buffers:
      * `array_cube`: `[num_epochs, 6, H, W]` (`Float32`) — inverse-variance weighted co-addition of the 17 channels per each of SPHEREx's 6 HgCdTe detector arrays:
         * Array 1: `0.75 – 1.11 µm`; Array 2: `1.11 – 1.64 µm`; Array 3: `1.64 – 2.42 µm`; Array 4: `2.42 – 3.82 µm`; Array 5: `3.82 – 4.42 µm`; Array 6: `4.42 – 5.00 µm`
      * `spectral_cube`: `[num_epochs, 102, H, W]` (quantized `Uint16` + per-band `scale`/`offset` `Float32` arrays to keep payload under 8 MB) for instant 102-band spectral extraction.
6. Resilient Hybrid Fallback (Zero-Failure Guarantee):
   * Always attempt live IRSA SIA2 + Gaia DR3 (`esa.gaia` / VizieR) + AllWISE queries first and cache on disk.
   * If IRSA returns fewer than 2 distinct time epochs for a requested sky patch or times out, generate a physically calibrated multi-epoch synthetic SPHEREx datacube anchored to real Gaia DR3 / SIMBAD star positions, proper motions (`pmra`, `pmdec`), parallax, variable-star light curves, realistic PSF (`FWHM ~ 6.2"`), zodiacal noise floor, and molecular NIR spectra (`H2O`, `CH4`, `CO2`, `CO`).
   * Tag every response clearly with `data_source: "IRSA_DR1_LIVE" | "IRSA_DR1_CACHED" | "GAIA_ANCHORED_BENCHMARK"`.

## 4. The 5 Required NASA Benchmark Targets
`prefetch_benchmarks.py` must pre-cache and bake static `.bin` + `.json` bundles for all 5 targets into both `backend/cache/` and `frontend/public/benchmarks/`:

1. Barnard's Star: `RA = 269.452075`, `Dec = +4.693391`, `FOV = 3.5'`, `mode = "blink"` — Fastest proper motion star (`10.358"/yr` north-northwest); unmistakable jump between 6-month epochs.
2. Epsilon Indi B: `RA = 331.077500`, `Dec = -56.782500`, `FOV = 4.0'`, `mode = "diff"` — Binary T1/T6 brown dwarf pair (`4.7"/yr` proper motion) orbiting Epsilon Indi; shows clean dipole subtraction and strong CH4/H2O spectral dips.
3. WISE 0855: `RA = 133.795129` (`08h55m10.831s`), `Dec = -7.245147` (`-07d14m42.53s`), `FOV = 3.5'`, `mode = "diff"` — Coldest known Y-dwarf (~250 K), `8.1"/yr` proper motion + huge parallax; invisible in Band 1 (0.8 µm) and blazing bright in Band 6 (4.5–5.0 µm).
4. RW Aurigae: `RA = 76.956542`, `Dec = +30.401444`, `FOV = 5.0'`, `mode = "diff"` — Classical T Tauri variable star undergoing dramatic circumstellar dust occultations and infrared brightening episodes.
5. R Draconis: `RA = 248.164583`, `Dec = +66.754722`, `FOV = 6.0'`, `mode = "blink"` — Mira-type long-period variable (`P ~ 245.5 days`) exhibiting multi-magnitude near-infrared pulsations and deep H2O/CO absorption bands.

## 5. Flagship WebGL2 Graphics & Visual Design Spec

1. WebGL2 Shader Pipeline (`WebGLBlinkEngine.ts` & `shaders.ts`):
   * Upload multi-epoch arrays into `TEXTURE_2D_ARRAY` (`R32F`) for zero-latency switching.
   * Catmull-Rom Bicubic Sub-Pixel Upsampling: Eliminate jagged pixelation at high zoom while keeping raw pixel grid overlay toggleable.
   * Real-Time Visualization Modes:
      1. `Blink Comparator`: Smooth crossfade or crisp hard-cut frame cycling (0.25–15 FPS).
      2. `Epoch Subtraction (T2 - T1)`: Diverging cyan/amber or bipolar grayscale residual map (stationary stars cancel to 0; moving objects form a glowing positive/negative dipole; variable stars show pure positive/negative cores).
      3. `Temporal Co-Add`: Inverse-variance mean stack across epochs for deep faint-source detection.
      4. `False-Color NIR RGB`: Real-time GPU compositing driven by the interactive 3-cursor RGB spectral mixer (`R`, `G`, `B` wavelength windows across `0.75–5.00 µm`).
      5. `Single-Band Spectral Scrub`: Displays any individual channel `1..102` (`0.75–5.00 µm`) in real time as the user drags the wavelength slider.
   * Stretch & Tone Mapping: Real-time `Asinh` (Lupton/JWST filmic stretch), `Log10`, and `Linear` stretch with black/white percentile sliders and scientific colormaps (`Obsidian Gray`, `Inverted Paper`, `Inferno`, `Viridis`, `Magma`, `JWST NIR`).
   * Toggleable Multi-Pass HDR Bloom (`Observatory View` vs `Raw Science View`): Half-res Gaussian mip-chain bloom FBO giving high-SNR stars a subtle optical luminance glow in Observatory View, with 1-click toggle (`B` key) to pure un-bloomed Raw Science View.
2. Interactive 3-Cursor RGB Wavelength Mixer (`WavelengthBar.tsx`):
   * Render a continuous `0.75 – 5.00 µm` spectral axis with molecular absorption markers (`H2O`, `CH4`, `CO2`, `CO`) and draggable R, G, and B bandpass handles so users can interactively tune false-color composites in real time.
3. UI & Telemetry Aesthetic:
   * Deep-space obsidian background (`#05070B`), translucent glass panels (`rgba(10, 14, 23, 0.82)` + `backdrop-filter: blur(12px)`), `1px` hairline borders (`rgba(56, 189, 248, 0.18)`).
   * `JetBrains Mono` tabular numerals for all RA/Dec (both sexagesimal `HH:MM:SS.ss DD:MM:SS.s` and decimal degrees), MJD timestamps, flux (`MJy/sr`), and proper motion (`mas/yr`).
   * 3D WebGL Celestial Sphere Minimap (`CelestialGlobe.tsx`): Corner interactive sky globe rendering the Galactic plane, Ecliptic plane, SPHEREx Deep Fields (NEP/SEP), and current viewport reticle, with smooth ease-in-out camera slews when switching targets.

## 6. Citizen Science, Discovery & Accessibility Features

1. Circular Aperture Photometry (`photometry.ts`): Hovering or clicking any source computes circular aperture flux (`3x3` or `5x5` px radius) minus median local sky annulus across all 102 bands and all epochs.
2. Auto-Scan `>5σ` Dipole & Transient Peak Finder: One-click "Auto-Scan Field" button computes noise-normalized `SNR_diff` between `T1` and `T2`, masks flagged pixels (`FLAGS`), identifies the top 5 moving dipole pairs or variable-star peaks (`|SNR_diff| > 5.0`), draws numbered target reticles (`#1`–`#5`), and lets users cycle through them with `Tab`.
3. Interactive 102-Band NIR Spectrum, Light Curve & Web Audio Sonification (`SpectrumDrawer.tsx` & `sonify.ts`): Interactive SVG spectrum (`0.75–5.00 µm`) with shaded molecular absorption reference bands for H₂O (1.4, 1.9, 2.7 µm), CH₄ (1.6, 2.2, 3.3 µm), CO₂ (4.26 µm), and CO (4.67 µm), plus a second tab showing the Multi-Epoch Light Curve (flux vs. MJD). "Sonify Spectrum" button using `AudioContext` that sweeps across the 102 channels over 2.0 s, mapping normalized flux to harmonic pitch (`220–880 Hz`).
4. Shift+Click Moving Object Dipole Fitter & Blink Loop Video Export: `Shift + Click` fits centroid across epochs, calculates proper motion (`µ_α cos δ`, `µ_δ` in `"/yr`) and position angle, renders a trajectory vector, and exports a Discovery Candidate Card (JSON + shareable URL state). "Export Blink Loop" button using `canvas.captureStream()` / `MediaRecorder` (WebM) plus high-res PNG capture with baked-in RA/Dec, epoch MJD, and scale bar HUD overlay.
5. Interactive 3-Step Judge Onboarding Tour (`GuidedTour.tsx`): (1) Barnard's Star jumping in Blink mode; (2) WISE 0855 in T2−T1 to isolate a moving brown dwarf dipole; (3) click the dipole to inspect and sonify its 102-band CH4 + H2O spectrum.
6. Full URL Deep-Linking, Embed Mode & Keyboard Shortcuts: Sync `ra`, `dec`, `fov`, `mode`, `band`, `stretch`, `t1`, `t2`, `cmap`, `wise`, and `embed=1` in `window.location.search`. Shortcuts: `Space` (Play/Pause), `Left/Right` (Step epoch), `D` (diff), `G` (Gaia/WISE overlays), `B` (bloom), `Tab` (cycle candidates), `R` (reset view).

## 7. Build & Verification Protocol
1. Create `backend/` and `frontend/` with all modules listed above.
2. Install Python deps and Node deps.
3. Run `python backend/scripts/prefetch_benchmarks.py` to generate and verify cached datacubes for all 5 targets.
4. `npm run build` with zero TS/Vite errors.
5. Start FastAPI and smoke test `/api/targets` and `/api/datacube` for all 5 targets.
6. Output exact commands to start backend and frontend locally.

Suggested build passes: (1) backend + benchmark baking; (2) WebGL engine, SkyCanvas, CelestialGlobe, WavelengthBar; (3) remaining panels, tour, App, build + end-to-end tests.
