# SPHEREx Blink: plan and status

NASA Space Apps 2026 entry. A blink comparator, epoch-difference viewer and spectrum explorer for NASA's SPHEREx near-infrared all-sky survey, using real archive data from IRSA.

Status (2026-11-14): **M0, M1 and M2 done on real data; all five targets baked** (4.4 MB total). UI overhauled (smooth display with raw-pixel toggle, target cards, timeline, explainer card) and the guided tour rebuilt as nine spotlight steps with small tasks. 19 pytest + 37 bun tests, typecheck and build clean. Docs: `README.md`, `docs/HOW-IT-WORKS.md`, `docs/BUILD-LOG.md`.

Results on real data:
- Barnard's Star: motion fit (WISE 2010 + 3 visits, D6) 10.42 ± 0.11″/yr at PA 355° vs Gaia 10.39″/yr. Core saturated in nearly every exposure, so its spectrum is flagged.
- Eps Indi Ba+Bb: 4 visits, 459 spectral points; clear H₂O (1.4, 1.9 µm), CH₄ (2.3, 3.3 µm), CO₂ (4.3 µm) and CO (4.6 µm) features, absent in a field star. Difference image shows the ± pair.
- Pole LPV (Gaia DR3 2160548942811758720): saturated in every detector; light curve uses ring photometry (9–25″ ring). D6 fades ~429 → 241 mJy and back to 574 over 18 months; field star steady to ~2%.
- RW Aur: saturated on D2–D6; D1 hints at a 20–40% change between visits (2–11 clean points per visit). **Keep/drop: owner to decide.**
- WISE 0855: **fails** its condition. In 2025–26 it passes 4–11″ from a G = 16.3 star, inside the aperture; the measured light is mostly that star. **Drop or replace: owner to decide.**

Things learned: IRSA's SIA/TAP had multi-hour 502 outages today and the AllWISE TAP query hung; SIA results are now cached, metadata retries last ~4 min, the AllWISE catalogue goes through Gator, and the WISE 2010 frame is optional at bake time. Most demo targets are too bright for SPHEREx's cores: check saturation before picking new targets. The pasted spec is kept in `SPEC-original.md`; this file replaces it. Facts below were checked on 2026-11-14 against the live IRSA services and docs. Each is marked **VERIFIED** (with source) or **UNVERIFIED**.

## 1. What the app is (one paragraph)

Pick a demo target (later: any RA/Dec). See the same patch of sky at each SPHEREx visit (3–4 visits so far, about 6 months apart) plus an optional 2010 WISE frame, and blink between them. Subtract two visits to make movers and variables stand out. Click a source to get its real 0.75–5.0 µm spectrum and light curve, measured from the individual SPHEREx exposures. Gaia DR3 markers show where the catalog says each star should be at that date. Everything shown is labelled with where it came from.

## 2. Data facts

### SPHEREx at IRSA

| # | Fact | Status | Source |
|---|---|---|---|
| D1 | DR1 exists (released November 2026). It is QR2 reprocessed; DR1 + QR3 form one uniformly processed set. QR2 is no longer returned by searches. | VERIFIED | https://irsa.ipac.caltech.edu/data/SPHEREx/docs/overview_dr1.html, https://irsa.ipac.caltech.edu/data/SPHEREx/docs/overview_qr.html |
| D2 | Exact DR1 release day "Nov 12" (spec). The cube rows carry `obs_release_date` 2026-11-01. | UNVERIFIED | — |
| D3 | SIA2 endpoint `https://irsa.ipac.caltech.edu/SIA?COLLECTION=…&POS=circle ra dec r&RESPONSEFORMAT=CSV`. Collections: `spherex_dr1`, `spherex_dr1_deep`, `spherex_dr1_cube`, `spherex_qr3`, `spherex_qr3_deep` (`spherex_dr1_cal` exists in ObsCore only). `spherex_qr`, `spherex_qr2` return nothing. | VERIFIED | live TAP query on `ivoa.obscore` + live SIA calls; https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-access |
| D4 | Time coverage: DR1 = MJD 60789.75–61174.5 (2025-04-24 to 2026-05-14); QR3 = MJD 61174.5–61318.0 (2026-05-14 to 2026-10-05). So the newest data is about 6 weeks old. | VERIFIED | live TAP `min(t_min), max(t_max)` per collection |
| D5 | SIA `access_url` for spectral images is a direct FITS URL (`…/ibe/data/spherex/dr1/level2/<week>/<ver>/<det>/level2_…D<n>_spx_….fits`). (The TAP ObsCore table gives datalink URLs instead: use SIA.) | VERIFIED | live SIA call |
| D6 | Cutouts: append `?center=<ra>,<dec>&size=<deg>` to the spectral-image URL. | VERIFIED | https://irsa.ipac.caltech.edu/data/SPHEREx/docs/cutout_tool.html + live test |
| D7 | A cutout is **~4 MB whatever its size** (the EPSF table, 441 rows × 8752 bytes, comes along) and takes 2–18 s. The service returns **HTTP 503 often** (about 1 call in 3 today); a retry a few seconds later works. "102 bands in seconds" (spec) is false: one target = 350–450 exposures ≈ 1.5 GB of transfer. | VERIFIED | live tests |
| D8 | Cutout MEF extensions: `IMAGE` (MJy/sr, float32), `FLAGS` (int32), `VARIANCE` ((MJy/sr)²), `ZODI` (MJy/sr), `EPSF` (bintable; `PSF` in old QR2), `WCS-WAVE` (bintable). Spatial WCS is `RA---TAN-SIP`. | VERIFIED | live cutout header; https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products |
| D9 | `IMAGE` still contains zodiacal light; `ZODI` is a model that has **not** been subtracted. Subtract it ourselves. | VERIFIED | https://caltech-ipac.github.io/irsa-tutorials/spherex-intro/ |
| D10 | Pixel scale 6.15″/px, detector 2040×2040 (3.5° field). | VERIFIED | ObsCore `s_pixel_scale`, data-products page |
| D11 | **Linear variable filters: one image is not one wavelength.** Wavelength changes across each detector; a source gets its spectrum from many exposures as the telescope steps. Per-pixel wavelength: `WCS(header, fobj=hdul, key="W")`, set `.sip = None`, `pixel_to_world(x, y)` → (central wavelength, bandwidth). | VERIFIED | irsa-tutorials spherex-intro |
| D12 | Six detectors (cube channel table, 17 channels each): D1 0.74–1.12, D2 1.10–1.65, D3 1.64–2.44, D4 2.42–3.83, D5 3.81–4.43, D6 4.42–5.01 µm; R ≈ 39, 41, 41, 35, 112, 129. | VERIFIED | `SPECTRAL_CHANNELS` table read from a DR1 cube tile |
| D13 | Flag bits: 0 TRANSIENT, 1 OVERFLOW, 2 SUR_ERROR, 6 NONFUNC, 7 DICHROIC, 9 MISSING_DATA, 10 HOT, 11 COLD, 12 FULLSAMPLE, 14 PHANMISS, 15 NONLINEAR, 17 PERSIST, 19 OUTLIER, 20 CROSSTALK, 21 SOURCE, 22 GHOST, 23 GHOST_FPA, 24 GHOST_EXT, 25 STREAK, 26 BLOOM, 27 SNOWBALL, 28 HALO. **Bit 21 (SOURCE) is set on every star**, so "mask all flagged pixels" would delete the stars. Saturated cores are NaN with OVERFLOW set. | VERIFIED (list from the tutorial; behaviour seen in live cutouts). Full definitions are in the Explanatory Supplement Table 16, which was too large to fetch: UNVERIFIED there. | irsa-tutorials spherex-intro |
| D14 | Cadence: each sky position is visited in a window of days to weeks about every 6 months. At the demo targets there are **3–4 visits** so far, each with ~110–150 exposures spread over the six detectors. Near the ecliptic poles (deep fields) coverage is continuous: 10,000+ exposures per position. | VERIFIED | live SIA counts at 11 positions |
| D15 | All-sky cube `spherex_dr1_cube`: 12,288 tiles (HEALPix order 5, NESTED), 512×512×102, 12.88″/px, `RA---HPX` projection (tiles look like diamonds), zodi-subtracted, HDUs `IMAGE`, `NHITS`, `FLAGS`, `SPECTRAL_CHANNELS`, `WCS-WAVE`. Two channels next to the dichroic are blank (`BLANKCH`). One tile is 321 MB. It is one time-average (this tile: 2025-08-12 to 2026-05-08), **not per epoch**, and has no variance plane. | VERIFIED | live tile headers; data-products page |
| D16 | The cutout service does **not** work on cube tiles (HTTP 422), but the files accept HTTP `Range` requests, so a small window can be read without downloading 321 MB. | VERIFIED | live tests |
| D17 | Public S3 copy: bucket `nasa-irsa-spherex`, `us-east-1`. Not needed. | VERIFIED (name only, from the SIA `cloud_access` column) | live SIA call |
| D18 | "Never mix QR2 with DR1/QR3" (spec): moot, QR2 isn't searchable. Use DR1 + QR3 together, as IRSA intends. | VERIFIED | overview pages |
| D19 | Single-exposure noise seen in cutouts: 1σ ≈ 0.02 MJy/sr (D2/D3), 0.06–0.08 MJy/sr (D6). | VERIFIED (5 cutouts only) | live cutouts |
| D20 | Official per-band 5σ sensitivity, PSF FWHM per band, exact saturation limit. | UNVERIFIED (Explanatory Supplement PDF not read) | https://irsa.ipac.caltech.edu/data/SPHEREx/docs/SPHEREx_Expsupp.pdf |

### WISE and Gaia

| # | Fact | Status | Source |
|---|---|---|---|
| W1 | AllWISE atlas images: SIA collection is **`wise_allwise`** (the spec's `allwise_p3am_cdd` is a folder name, not a collection). Science files are `…-w1-int-3.fits` / `…-w2-int-3.fits`, 1.375″/px. Other WISE collections: `neowiser`, `wise_allsky`, `wise_3bandcryo`, `wise_2bandcryo`. | VERIFIED | live TAP + SIA |
| W2 | AllWISE cutout: append `?center=<ra>,<dec>&size=0.2deg&gzip=false` (returns ~1 MB in 1.5 s). | VERIFIED | live test |
| W3 | AllWISE W1/W2 coadds blend all 2010 passes (Barnard tile: MJD 55273–55458, March–September 2010). A fast star is smeared by up to 6 months of motion in that frame. | VERIFIED | SIA `t_min`/`t_max` |
| W4 | `neowiser` single exposures run 2013-12 to 2024-03 at IRSA and could give in-between epochs. Not planned. | VERIFIED (exists); use UNPLANNED | live SIA |
| W5 | AllWISE source catalog: IRSA TAP table `allwise_p3as_psd` at `https://irsa.ipac.caltech.edu/TAP/sync`. | VERIFIED | live query |
| G1 | Gaia DR3: `https://gea.esac.esa.int/tap-server/tap/sync?REQUEST=doQuery&LANG=ADQL&FORMAT=csv&QUERY=…`, table `gaiadr3.gaia_source`, positions at epoch **2016.0**. Plain HTTP GET works; no astroquery needed. | VERIFIED | live queries |
| S1 | SIMBAD TAP was down on 2026-11-14 (CDS "page unavailable"). Target names and magnitudes not cross-checked there. | UNVERIFIED | — |

## 3. Demo targets (checked against real data)

They are **our demo targets**, not "NASA benchmark targets": the UI must not call them that.

Problems found in the spec's list:

- **Barnard's Star**: the spec's coordinates are the year-2000 position. The star has moved 4.6′ since, so a 3.5′ field centred there **does not contain the star**. It moves almost due north (position angle 356°), not "north-northwest". Between SPHEREx visits it moves 6″ (1 px) in 6 months and 10.4″ (1.7 px) in a year: visible, not an "unmistakable jump". The jump is 2010 WISE → 2026: 168″ (2.8′). Its core is saturated (NaN) around 2 µm; D5/D6 are clean.
- **Epsilon Indi B**: the spec's coordinates mix two epochs (41″ off). Ba and Bb are 0.7″ apart: SPHEREx sees **one blended source**, not a pair. It is bright and clean in real cutouts (peak 7–12 MJy/sr against 0.02 noise). It moves 4.7″/yr = 0.8 px per year, so the dipole is subtle; WISE 2010 → 2026 is 76″.
- **WISE 0855**: the spec's coordinates are the 2010 position; it is now ~2.2′ west, outside a 3.5′ field. It is at the single-exposure noise level in D6 (AllWISE W2 = 13.7 → ~0.5 mJy; peak pixel ≈ 2–3σ) and invisible below 4 µm. It may appear only in a stack of D6 exposures.
- **RW Aurigae**: detected and usable (A+B, 1.5″ apart, blended). Whether it changed between SPHEREx visits is unknown until measured.
- **R Draconis**: hopelessly saturated (a 5×5-pixel NaN hole). Replaced.

Final list. Positions are for **2026.5**; the pipeline must compute them from Gaia (epoch 2016.0 + proper motion) at run time, never hard-code J2000.

| # | Target | Centre 2026.5 (deg) | Field | What it honestly shows | Status |
|---|---|---|---|---|---|
| T1 | Barnard's Star (Gaia DR3 4472832130942575872; pm −801.6, +10362.4 mas/yr; parallax 547 mas) | 269.4462, +4.7696 (frame centred 80″ south so 2010 and 2026 both fit) | 8′ | Blink WISE 2010 → SPHEREx 2025 → 2026: a 2.8′ leap in 16 years, then a ~1.7 px step in one year of SPHEREx. Default band D5/D6 (unsaturated, matches W2). | VERIFIED: Gaia query; 3 visits (Aug–Sep 2025, Mar–May 2026, Aug–Sep 2026; 358 exposures); star seen ~2 px from its 2026 position in a 2025 cutout |
| T2 | Epsilon Indi Ba+Bb (Gaia DR3 6412596012146801152; pm +3982.0, −2466.8 mas/yr) | 331.0977, −56.8010 | 5′ | Difference image: a small ± pair. Spectrum of a blended T1+T6 brown dwarf; water/methane dips are expected at R≈40. WISE 2010 → 2026: 76″. | Position/detection VERIFIED (4 visits, 458 exposures, clean cutouts). Spectral dips UNVERIFIED until M2 measures them. |
| T3 | Pulsating red giant near the north ecliptic pole (Gaia DR3 2160548942811758720, Gaia LPV period ≈ 372 d, G amplitude 1.56 mag). Backups: 2260265679559042048 (275 d), 2259027182789322880 (266 d). | 275.8246, +64.3435 | 5′ | A real 18-month light curve in many colours: the deep field has ~17,000 exposures of it (sub-sample ≤ 400). One core pixel saturates near 2 µm: use other bands for the curve. | Coverage VERIFIED. Common name, K magnitude and actual SPHEREx variability UNVERIFIED. |
| T4 | RW Aurigae (Gaia DR3 156430822114424576 / …817820015232) | 76.9565, +30.4013 | 5′ | Young star with infrared excess; show its spectrum, and its change between visits **only if M2 measures one**. If not, drop it or swap in Teegarden's Star (Gaia DR3 35227046884571776, 5.1″/yr, clean). | Detection VERIFIED (3 visits, 335 exposures). Variability UNVERIFIED. |
| T5 | WISE 0855−0714 (stretch) | ≈133.7583, −7.2421 (from 2010 AllWISE position + pm −8.12, +0.68″/yr) | 5′ | "Too faint for one exposure; appears when ~15 D6 exposures are stacked." Keep only if the stack reaches ≥ 5σ; otherwise leave it out. | Proper motion from memory and detectability UNVERIFIED. AllWISE position VERIFIED. 3 visits in DR1; none in QR3 yet. |

Guided tour (M2), three steps, all on real data: (1) T1 blink with the WISE frame, then SPHEREx only; (2) T2 difference image, then click for the spectrum; (3) T3 light curve. Tour text states sizes of motion in arcseconds and pixels, and says what is blended or saturated.

## 4. Data strategy

**Decision: pipeline first, static app. No server at runtime until M3.** A Python pipeline fetches real IRSA data once and bakes small bundles into `frontend/public/benchmarks/`. The app loads them as static files, so it works offline and on GitHub Pages.

What an "epoch frame" is (the spec got this wrong): within a 5–8′ field one exposure is close to a single wavelength, but each exposure is a *different* wavelength. So:

- **Epoch band frames** (blink / difference): for each visit and each detector, zodi-subtract (`IMAGE − ZODI`), resample every exposure onto one TAN grid (6.15″/px, north up), and take an inverse-variance mean with bad pixels masked. Result: `[epoch, 6 bands, H, W]` float32 + variance. Mask on bits 1, 2, 6, 9, 10, 11, 15, 19 (and NaN); **do not** mask SOURCE (21). A visit/band with < 3 exposures is marked missing, not interpolated.
- **Spectra and light curves**: aperture photometry on each single exposure (wavelength from `WCS-WAVE` at the source pixel) → one point per exposure: `(MJD, λ, Δλ, flux, error, flags)`. That gives ~110–150 spectral points per visit. Bake this for the main target and the Gaia stars in the field (G < 16). Points whose aperture touches OVERFLOW/NaN are kept but flagged and drawn hollow.
- **WISE 2010 frame**: AllWISE W1 and W2 cutouts resampled onto the same grid. Different instrument and units: blink-only, scaled by percentile, never subtracted from SPHEREx. Paired with D4 (W1) and D5+D6 (W2).
- **102-channel cube** (M3): range-read a window of the DR1 all-sky cube tile. It is a time average at 12.88″/px, so it drives the wavelength scrubber and RGB mixer, not the blink.
- **Gaia overlay**: positions propagated from 2016.0 to each frame's date (proper motion; parallax ignored, stated in the UI).

Bundle per target (`frontend/public/benchmarks/<id>/`): `meta.json` (WCS, epochs, MJD ranges, exposure counts, source collections, file list of the IRSA exposures used, pipeline version, fetch date), `frames.bin` (float32), `wise.bin`, `spectra.json`, `gaia.json`. **Limits: ≤ 4 MB per target, ≤ 20 MB for all.** Raw cutouts go to `backend/cache/` (gitignored, can reach several GB; ask before fetching more than the M1 set).

Fetching rules: 4 concurrent requests, retry on 503/timeout with backoff (5 tries), cache every cutout on disk keyed by URL, keep only the four image HDUs + wavelength at centre (drop the EPSF table after reading), resumable. One target ≈ 400 cutouts ≈ 1.5 GB transfer ≈ 15–30 min.

**Provenance labels** (always visible, also written into exports): `IRSA DR1+QR3 (baked <date>)`, `IRSA live`, `AllWISE 2010`, `SIMULATED`. Credit line: "Data: NASA/JPL-Caltech/IPAC (IRSA). Not a NASA product." plus the SPHEREx acknowledgement and DOIs 10.26131/IRSA678 (DR1 images), 10.26131/IRSA662 (QR3), 10.26131/IRSA679 (cube).

**Simulated data: never automatic.** The spec's "zero-failure fallback" (silently replacing missing data with a synthetic cube) is removed. If live data fails, the app says so and offers the baked targets. A separate, opt-in "Simulator" (M4) may exist for teaching; it has a permanent `SIMULATED — not SPHEREx data` watermark burned into the canvas, the badge, PNG/WebM exports and JSON. Synthetic frames are also used in tests, where no one can mistake them.

## 5. Stack and layout

```
spherex-blink/
├── PLAN.md  CLAUDE.md  SPEC-original.md  .gitignore
├── backend/                 # Windows-native uv project, Python 3.12
│   ├── pyproject.toml       # numpy, scipy, astropy, httpx; dev: pytest. M3 adds fastapi, uvicorn, astropy-healpix
│   ├── spherex_blink/       # irsa.py (SIA + cutouts), frames.py (resample, stack), photometry.py,
│   │                        # gaia.py, wise.py, targets.py, bake.py; M3: cube.py, server.py
│   ├── tests/               # pytest, synthetic FITS fixtures, no network
│   └── cache/               # gitignored
└── frontend/                # bun + Vite + React 19 + TS + Tailwind v4 (same versions as ares-hud)
    ├── public/benchmarks/   # baked bundles (committed)
    ├── src/lib/             # pure TS, unit-tested: bundle.ts, wcs.ts, stretch.ts, photometry.ts, epochs.ts, urlState.ts
    ├── src/gl/              # one WebGL2 renderer: R32F texture array, stretch + colormap + blink/diff shader
    ├── src/components/      # SkyCanvas, Timeline, BandPicker, SpectrumPanel, InfoPanel, Tour
    └── test/                # bun test
```

- **No Node**: bun only (`bun x`, never `npx`). `base: "./"` in Vite so the build works on a subpath.
- **Ports**: Vite dev `127.0.0.1:5186`, Vite preview `127.0.0.1:5187`, M3 API `127.0.0.1:8091`, Vite proxies `/api` (no CORS). Note: ares-hud's *preview* is also set to 5186; they only clash if both run at once.
- **Python deps checked on PyPI today**: `numpy`, `scipy`, `astropy` 8, `astropy-healpix` have Windows wheels. **Not used**: `reproject` (drags in dask, dask-image, zarr; resampling is done with `astropy.wcs` + `scipy.ndimage.map_coordinates`), `healpy` (no Windows wheel), `photutils`/`sep` (aperture photometry is 30 lines), `astroquery`/`pyvo` (plain `httpx` GETs are enough), scikit-learn (blocked on this PC). Whether Application Control lets astropy's DLLs load is **UNVERIFIED**: first M0 check.
- **Rendering**: nearest-neighbour by default (the data is undersampled; bicubic invents detail), bilinear optional. NaN pixels drawn in a flat "no data" colour via a mask, never interpolated.
- **Test hooks**: `window.__spherex = { frame(), state, setEpoch(i), … }`; the render loop must be drivable by `__spherex.frame()` because a hidden pane stops `requestAnimationFrame`. `?silent` mutes all audio and is never saved.

## 6. Milestones

### M0: scaffold (half a day)
- uv project + frontend scaffold, `.gitignore`, preview config `spherex-blink` added to `D:\Workspace\.claude\launch.json`.
- **Accept**: `uv run python -c "import astropy.wcs, astropy.io.fits, scipy.ndimage, numpy"` works on this PC; `uv run pytest -q` and `bun test` run (one trivial test each); `bun run typecheck` clean; `bun run dev` serves a page on 127.0.0.1:5186.

### M1: honest vertical slice — blink and difference on real data
- Pipeline: SIA query → cached cutouts → zodi-subtract → resample → epoch band frames; AllWISE frame; Gaia overlay; `bake.py` for **T1 and T2 only**.
- App: target picker (2 targets), WebGL view with pan/zoom, blink (play/pause, step, 0.5–8 fps), difference of any two SPHEREx epochs (diverging colour map), band picker (6 detectors), asinh/linear stretch with two sliders, Gaia markers at the frame's date, WISE-frame toggle, scale bar + N/E arrows, provenance badge, URL state (`target, mode, band, t1, t2, wise, stretch`), keys Space / ← → / D / G / R.
- **Accept**:
  - `uv run pytest -q`: resampling puts a synthetic star within 0.1 px of truth; stacking ignores NaN/OVERFLOW pixels and keeps SOURCE pixels; a synthetic star moved 1.7 px gives a ± pair in the difference and a static star leaves < 5 % residual; Gaia propagation of Barnard's Star 2016.0 → 2026.5 gives 269.4462, +4.7696 within 0.5″; cutout fetcher retries on 503 (mocked).
  - `uv run python -m spherex_blink bake barnard eps-ind-b` writes bundles under the size limit and prints exposure counts per epoch/band.
  - `bun test` (bundle parser, WCS round trip < 0.01 px, stretch maths, URL state round trip), `bun run typecheck`, `bun run build` all clean.
  - In the browser (`?silent`): Barnard's Star, WISE toggle on: the star visibly leaps ~2.8′ between the 2010 frame and the SPHEREx frames, and the Gaia marker sits on it in every frame. SPHEREx-only blink in D6: it steps ~1–2 pixels. Epsilon Indi B in difference mode: a ± pair at the Gaia marker; field stars mostly cancel. The badge reads "IRSA DR1+QR3 (baked …)". No console errors. `__spherex.frame()` advances the view in a hidden pane.
  - Works from `bun run build` + `bun run preview` with the network off.

### M2: spectra, light curves, more targets, tour
- Per-exposure photometry baked for target + field stars; SpectrumPanel (flux vs wavelength, coloured by epoch, error bars, hollow = flagged, detector boundaries, reference marks for H₂O 1.4/1.9/2.7, CH₄ 1.6/2.2/3.3, CO₂ 4.27, CO 4.67 µm labelled "reference positions", not detections) and light-curve tab (flux vs date for a chosen wavelength range).
- Bake T3; measure T4 and T5 and keep them only if they pass their conditions in §3.
- Motion tool: click a source → centroid per epoch → fitted motion in ″/yr with error, shown beside the Gaia value. Only offered when the baseline gives > 1 px of motion (in practice: with the WISE frame, or Barnard).
- Guided tour (3 steps, §3).
- **Accept**: pytest for aperture photometry (recovers synthetic flux within 2 %) and wavelength lookup (matches `WCS-WAVE` on a real cached cutout); T2 spectrum has ≥ 300 points over 0.75–5 µm; T3 light curve spans ≥ 15 months; Barnard motion fit with WISE agrees with Gaia within 10 %; tour runs start to finish in the pane with `?silent`; every tour sentence matches what is on screen.

### M3: any coordinate (live) and the 102-channel cube
- FastAPI on 127.0.0.1:8091: `/api/targets`, `/api/field?ra&dec&fov` with progress events; "quick look" fetches ≤ 60 exposures (two detectors, all visits; about 1–2 min), more on request; disk cache. If IRSA fails: say so, offer baked targets.
- Cube window via HTTP Range → wavelength scrubber + 3-handle RGB mixer (time-averaged, 12.88″/px, labelled as such).
- Auto-scan: top 5 peaks of `|T2 − T1| / sqrt(V1 + V2)` above 5σ, excluding masked pixels and a radius around saturated stars; results are "candidates to look at", not discoveries.
- **Accept**: pytest with a mocked IRSA; a live smoke test (marked `network`, run by hand) returns frames for T1 in < 3 min; the static build still works with the API off and hides the coordinate box.

### M4: polish
- PNG and WebM export with burned-in coordinates, dates, scale bar and provenance; shareable URL; embed mode.
- Sonification of a spectrum (off under `?silent`).
- Optional Simulator, watermarked (§4).
- GitHub Pages deploy (needs a public repo: owner's decision).

### Cut from the spec
- Bloom / "Observatory View": makes science images look better than the data.
- 3D celestial globe minimap: large effort, no insight. (A small flat all-sky locator may come in M4.)
- Catmull-Rom upsampling as default.
- Automatic synthetic fallback and the "zero-failure guarantee".
- Per-epoch 102-band image cubes (`spectral_cube [epochs,102,H,W]`): the data doesn't exist in that form.
- "NASA benchmark targets", "NASA provenance badge", "Discovery Candidate Card": renamed to demo targets, data-source badge, candidate note.
- "Zero placeholders, stubs or TODOs": replaced by the acceptance checks above.

## 7. Open decisions for the owner

1. **Repo visibility.** GitHub Pages on the free plan needs a public repo. Baked bundles are public NASA data, so nothing sensitive, but it is your call.
2. **Download size.** M1 needs ~3 GB of cutout transfer into `backend/cache/` (T1 + T2); all five targets ~8 GB. OK to fetch?
3. **T4 and T5.** If RW Aur shows no change and WISE 0855 doesn't reach 5σ, ship with three or four targets, or swap in Teegarden's Star?
4. **Live mode (M3).** Is "any coordinate" needed for the submission, or is a strong static demo enough? It is the most fragile part (IRSA returned 503 on about a third of calls today).

## 8. Changes from the original spec (summary)

1. Coordinates for three of five targets pointed at where the object was in 2000 or 2010; two fields did not contain their target.
2. "One image per wavelength band" replaced by the real model: each exposure is a different wavelength; spectra come from per-exposure photometry, blink frames from per-detector stacks.
3. Barnard's Star "unmistakable jump" → ~1.7 px per year in SPHEREx; the WISE 2010 frame carries the drama.
4. R Draconis (saturated) replaced by an ecliptic-pole variable with continuous coverage; Eps Indi B described as one blended source; WISE 0855 demoted to a conditional stretch target.
5. `allwise_p3am_cdd` → `wise_allwise`; cube cutouts don't exist (use Range); cutouts are 4 MB each and often 503.
6. Flag handling: mask specific bits, not "any flag".
7. Synthetic data never substitutes for real data silently.
8. Stack fitted to this PC: bun, uv, no reproject/healpy/sklearn/astroquery, loopback only, static-first.
