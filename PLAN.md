# SPHEREx Blink: plan and status

NASA Space Apps 2026 entry. A blink comparator, epoch-difference viewer and spectrum explorer for NASA's SPHEREx near-infrared all-sky survey, using real archive data from IRSA.

Status (2026-11-15): **M5 colour and M6 validation + accessibility done** (see §6b; only the axe-core audit waits for the owner's OK). M7 live mode is planned only. Earlier: **M0, M1 and M2 done on real data; all five targets baked** (6 MB total with colour maps). UI overhauled (smooth display with raw-pixel toggle, target cards, timeline, explainer card) and the guided tour rebuilt as nine spotlight steps with small tasks. 19 pytest + 37 bun tests, typecheck and build clean. Docs: `README.md`, `docs/HOW-IT-WORKS.md`, `docs/BUILD-LOG.md`.

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

### M3 (superseded by M5–M7 below, 2026-11-14 evening)
The original M3 (local FastAPI live mode + cube mixer) and M4 (polish) are replaced by the milestones in §6b. Still wanted later: PNG/WebM export with burned-in provenance, embed mode, auto-scan for candidates.

## 6b. Next milestones (planned 2026-11-14 evening)

Owner's order: **M5 colour and M6 validation + accessibility are built next; M7 live mode is planned only; hosting + demo kit (the old "step 1") comes last.**

### Facts checked for this plan (2026-11-14, live requests)

| # | Fact | Status |
|---|---|---|
| L1 | IRSA SIA, IRSA TAP, Gator and ESA's Gaia TAP send **no** `Access-Control-Allow-Origin` header: a web page cannot read them directly. | VERIFIED (curl with an `Origin` header) |
| L2 | The public S3 mirror `https://nasa-irsa-spherex.s3.amazonaws.com/<key>` sends `Access-Control-Allow-Origin: *`, allows `GET`/`HEAD` and the `Range` header (preflight OK), and returns `206 Partial Content`: a web page **can** read byte ranges of any SPHEREx file. | VERIFIED |
| L3 | Each SIA row's `cloud_access` column gives the S3 key, e.g. `dr1/level2/<week>/<ver>/<det>/level2_…D6_spx_….fits` (65.7 MB for a full exposure). | VERIFIED |
| L4 | All-sky cube tiles follow a fixed key pattern: `dr1/hips5_cube/hips_20261026/Norder5/Dir<10000·⌊npix/10000⌋>/Npix<npix>_cube.fits`, HEALPix order 5 NESTED (D15). So a page can find the tile for any position by computing the HEALPix index, with no search. | VERIFIED for one tile (Npix11391 at Eps Indi B); pattern assumed for the rest, check on two more tiles in M5 |
| L5 | 2MASS point-source catalogue (`fp_psc`, J/H/Ks) and AllWISE (`allwise_p3as_psd`, W1/W2) answer through Gator (server side). | VERIFIED |

### Architect review (2026-11-14) and what changed

The plan was reviewed before building. Applied:
- **M5, map spectra in the same units:** sum a 15″-radius aperture on the cube grid times the pixel solid angle → mJy, so map and exposure spectra share an axis.
- **M5, time-averaging:** each cube channel at a spot was observed on a different date. Map spectra are suppressed for sources that stray more than a quarter of the 15.4″ aperture radius from their mid-span position (Barnard: yes, 5.5″; Eps Indi B: no, 2.4″) and for the variable targets (the pole LPV, RW Aur), with a note saying why.
- **M5, masking:** cube pixels with `NHITS == 0` become NaN. The level-2 flag mask is **not** reused on cube `FLAGS` (bit meanings unchecked; bit 21 SOURCE covers most pixels there too). The reader asserts plain `XTENSION='IMAGE'` and no `ZIMAGE` (tile compression would break byte offsets).
- **M5, tiles:** found with our own HEALPix `ang2pix` (nested, order 5) on the field's corners and centre (up to 4 tiles at a corner), not SIA. This also tests fact L4 and is the code M7 will port to TypeScript. No new dependency.
- **M5, colour honesty:** the "brown dwarfs look different" check is done in *physical* mode (one scale, Fν).
- **M6, photometry:** compare with 2MASS/WISE by synthetic photometry over the band (top-hat over each band's published half-power width, stated as an approximation), within a magnitude window that avoids saturation, and drop stars with a brighter neighbour within 15″.
- **M6, accessibility:** frame descriptions are announced only after a user action, never every blink frame; the canvas gets `role="img"` and a label. **All** modes are capped at 3 frame changes per second (the 6× speed is removed). Single-letter shortcuts can be switched off in Help and are ignored while typing. The AudioContext is created only on a click. axe-core is run only inside the browser pane as a test, loaded from a CDN, not added to the project — **ask the owner first**.
- **M7:** the TypeScript port also needs the `WCS-WAVE` `-TAB` lookup. Golden fixtures are generated from Python and checked in tests. The cube release folder (`hips_20261026`) is discovered from the HiPS `properties` file, not hard-coded. HDU offsets are cached per product version. A hosted proxy must allowlist exact hosts and query shapes.
- **Pipeline nit:** resampled variance used interpolated values; the correct value is Σwᵢ²·varᵢ. Fixed before M5, then re-bake from cache.

### M5: colour from the 102-channel all-sky cube

What: a third view mode, **Colour**, showing a false-colour image made from three wavelength windows of SPHEREx's all-sky cube, plus a time-averaged spectrum for *any* clicked pixel (not just the baked stars).

Pipeline (`backend/spherex_blink/cube.py`, called by `bake`):
- Find the tile(s) covering the field with an SIA search on `spherex_dr1_cube` (radius = field half-diagonal; a field near a tile edge needs two tiles).
- Read the FITS header with a Range request (blocks of 2880 bytes until `END`), locate the `IMAGE` HDU (512×512×102, float32), `SPECTRAL_CHANNELS` (wavelength, bandwidth, blank flags) and, if 3-D, `FLAGS`.
- Work out the pixel window covering the field through the tile's `RA---HPX` WCS (astropy supports HPX), then read only those rows for each of the 102 channels (one Range request per channel, 4 at a time, ≈80 KB each). Cache on disk.
- Resample each channel onto a north-up TAN grid at **12.3″/px** (2× the main grid, close to the cube's native 12.88″; upsampling further would only pretend). Blank channels (next to the dichroic) stay NaN.
- Write `cube.bin` (float32 `[102, h, w]`, ≈0.5–0.7 MB per target) and the channel table into `meta.json` (`cube` block: grid WCS, wavelengths, bandwidths, blank list, tile URL(s), date span of the average). Budget after M5: ≤ 8 MB total.

App:
- View mode **Colour** next to Blink/Difference. The wavelength bar becomes continuous (0.75–5.0 µm) with three draggable windows (R, G, B), each the mean of the cube channels inside it.
- Presets, each with one sentence on what it shows: *Near-IR "true" order* (B 1.0–1.3, G 1.6–2.2, R 3.5–4.4 µm); *Methane* (on vs off the 3.3 µm band: cool brown dwarfs stand out); *Water* (1.4 vs 1.25/1.6 µm); *Hot dust* (long-wavelength excess).
- Each colour is stretched on its own (asinh, percentiles) so faint channels aren't swamped; a "balanced / physical" toggle keeps one scale for all three.
- Click anywhere in Colour mode → the spectrum panel gets a "map spectrum" series: 102 channel values at that pixel, drawn as a line, labelled "all-sky map, average of all visits to May 2026, 12.9″ pixels". On baked stars it is drawn together with the per-exposure dots.
- Composite computed on the CPU (≤ 50×50 px, cheap) and uploaded as three float layers; same smoothing/raw-pixel switch.

Accept:
- pytest: header/offset parser and window reader against a synthetic FITS cube served through a mocked HTTP transport that honours `Range`; HPX→TAN resampling puts a synthetic star within 0.1 px (of the 12.3″ grid); blank channels stay NaN; `cube.bin` size within budget.
- bun test: composite maths (window means skip NaN; per-channel stretch), preset definitions inside detector coverage, map-spectrum extraction.
- Real data: the Eps Indi B map spectrum shows the same water/methane dips as its per-exposure spectrum (the two are independent products, so this doubles as a validation check; record the agreement in M6); with the *Methane* preset the brown dwarfs are visibly a different colour from the field stars.
- Browser: Colour mode on all five targets, presets, dragging windows, click-for-spectrum; no console errors; phone layout.

### M6: validation and accessibility

Validation (`backend/spherex_blink/validate.py` → `docs/VALIDATION.md` + a `validation` block in each `meta.json`):
- **Brightness vs 2MASS and AllWISE.** For unflagged field stars (G < 15, not known variables), our flux near 1.235/1.662/2.159 µm (2MASS J/H/Ks) and 3.35/4.60 µm (W1/W2): median of points within the catalogue band's width. Convert catalogue magnitudes to mJy (zero points: J 1594, H 1024, Ks 666.7, W1 309.54, W2 171.79 Jy). Report per band the median ratio ours/catalogue (that ratio *is* our missing aperture correction) and the robust scatter (repeatability). Expected: ratio < 1 and steady; scatter ≲ 10%.
- **Positions vs Gaia.** Centroids of field stars in the stacked frames against Gaia positions for each visit's date: RMS offset in arcsec (expect < 1″, i.e. < 0.2 px).
- **Motion vs Gaia** for Barnard's Star and Eps Indi B (with the 2010 frame).
- **Repeatability:** visit-to-visit scatter of constant field stars.
- **Map vs exposure spectra** (from M5).
- In the app: a "How accurate is this?" section per target with these numbers and a link to `docs/VALIDATION.md`. Numbers are computed by the pipeline, never typed in by hand.

Accessibility:
- **Sonification:** a "Listen" button in the spectrum panel sweeps the spectrum from short to long wavelength in about 3 s (pitch rises with brightness, 220–880 Hz, logarithmic; absorption dips are heard as drops). The light curve plays the same way over time. Web Audio, no files. Never plays under `?silent`; stops on Esc.
- **Words for every picture:** an auto-generated one-paragraph summary under each spectrum ("brightest near 4.0 µm; deepest dips near 1.4 and 3.3 µm, where water and methane absorb") and a live text description of the current frame for screen readers.
- **Flashing:** blinking WISE↔SPHEREx is a large brightness flip. Cap at 3 flips per second (WCAG 2.3.1) and, with `prefers-reduced-motion`, don't autoplay.
- **Keyboard:** every control reachable; `N` / `Shift+N` steps through the baked stars and opens their spectrum; visible focus everywhere.
- **Colour and contrast:** run the dataviz palette validator on the diverging and colour-mode palettes; raise small grey text to ≥ 4.5:1 contrast.
- Accept: axe-core run in the browser pane reports no serious or critical issues; sonification mapping unit-tested; the whole tour done keyboard-only; validation numbers present for all five targets and in `docs/VALIDATION.md`.

### M7: any coordinate, live (plan only; not being built yet)

Goal: type any RA/Dec (or a star name) and get the same blink/difference/colour views without a pre-bake.

Design, from facts L1–L4:
- **Tier A, colour at any coordinate, no server.** In the browser: compute the HEALPix order-5 tile (a short JS `ang2pix_nest`), Range-read the header and the needed rows of each channel from S3, project through `RA---HPX`, show Colour mode and map spectra. Port of the M5 Python reader; ≈ 102 small requests, a few seconds. Works on GitHub Pages as is.
- **Tier B, blink at any coordinate, needs a search proxy.** The exposure list (SIA) and Gaia have no CORS, so a tiny proxy forwards *only those metadata queries* and adds CORS: a Cloudflare Worker or similar (free tier), or the local FastAPI for development. The image data itself comes from S3 straight to the browser: for each exposure, Range-read the rows around the target in `IMAGE`, `FLAGS`, `VARIANCE` and `ZODI` (≈ 4 × 40 rows × 8160 bytes ≈ 1.3 MB) plus the `WCS-WAVE` table, instead of IRSA's 4 MB cutouts. Processing (zodi subtraction, flag masking, TAN-SIP sky coordinates, resampling, inverse-variance stacking) runs in a Web Worker as a TypeScript port of `frames.py`.
- **Quick look first:** 2 detectors × all visits (≈ 60 exposures ≈ 80 MB) with a progress bar, then more on request. Results cached in the browser (IndexedDB). Name lookup via the proxy (Sesame/SIMBAD).
- **Correctness:** golden tests: the Python pipeline writes reference outputs for cached cutouts; the TypeScript port must match within 1% (fluxes) and 0.02 px (positions). TAN-SIP is the risky part.
- **Risks:** IRSA metadata outages (we saw hours of 502s) → keep the baked targets as the dependable path and say clearly when live search is down; S3 egress/rate limits; deep-field positions with 17,000 exposures (sample, as the bake does); a hosted proxy is a service the owner must create and own (account, keys): **owner decision before Tier B**.
- **Estimate:** Tier A ≈ 1 day; Tier B ≈ 3–4 days including the TS port and golden tests.

## 6c. Science-grade roadmap (planned 2026-11-15)

Goal: from "honest outreach demo" to a tool a researcher could trust and cite. Ordered by how much each item could make the app show something false. Each item has an acceptance check; nothing counts as done without it.

### S1: mask the artefacts we still let through
The level-2 mask (D13) drops 8 flag types but not TRANSIENT (0, cosmic rays), PERSIST (17), CROSSTALK (20), GHOST/GHOST_FPA/GHOST_EXT (22–24), STREAK (25), BLOOM (26), SNOWBALL (27) or HALO (28). These make fake one-off brightenings, the very thing a change-finder looks for.
- First measure how often each bit is set in the cached cutouts, overall and in stars' wings (some, like HALO or BLOOM, may cover every bright star's outskirts and would erase data). Then mask the bits that are rare and artefact-only; for wide ones, mask only in the per-exposure photometry and say so.
- Accept: a table of bit frequencies in `docs/VALIDATION.md`; a test with a synthetic cosmic-ray hit (bit 0) that no longer reaches the stack; field-star repeatability (V4) no worse.

### S2: wavelength-matched difference images (+ sharper colour, same step)
Problem: a visit stack mixes the wavelengths inside one detector, and each visit samples a slightly different mix, so a star's colour alone can make it look brighter or fainter in a difference image.
Fix, in the bake: for every exposure also resample its per-pixel wavelength (from `WCS-WAVE`) onto the grid. Stack per visit **per channel** (the 102 channels of the cube's channel table), S[v,k]. The mean over visits, M[k], is a **6.15″ 102-channel map** built from the single exposures. Then each visit's *matched* frame per detector is the weighted mean over its channels of (S[v,k] − M[k]). Differencing two matched frames compares like with like at every wavelength, so static stars cancel whatever their colour.
- By-product: M[k] gives the Colour view **twice the sharpness (4× the pixels)** of the archive map (6.15″ vs 12.9″), same honesty rules (saturated cores, time-average caveat). Stored as float16 to keep size sane.
- Accept: on the real targets, the residual at static field stars in difference images drops (measured, before vs after, in `docs/VALIDATION.md`); moving targets keep their ± pair; colour maps from M[k] and from the archive cube agree in shape (as V5); bundle total ≤ 20 MB.

### S3: honest error bars
- Resampling correlates neighbouring pixels' noise; stacked variances ignore it. Measure the real noise in blank sky of the stacks against the propagated variance, and scale (a per-detector correction factor written into the bundle).
- Add a systematic floor to photometric errors from validation (the 2–6% catalogue spread, per band) and show both in the panel.
- Motion fit: errors from the centroid scatter *and* the per-frame centroid noise.
- Accept: in blank sky, (value / σ) has a standard deviation of 1.0 ± 0.1 in every detector; the light-curve chi² of constant field stars is ≈ 1 per degree of freedom.

### S4: injection–recovery
Plant fake stars of known brightness, and fake movers of known speed, into the real exposures (using SPHEREx's own PSF from the `EPSF` extension), run the whole bake on them, and measure what comes back.
- Outputs: completeness (fraction recovered) and bias vs brightness; motion recovered vs injected; photometric error vs brightness. Written to `docs/VALIDATION.md` and shown in "How accurate is this?" as "the faintest star / slowest motion we can reliably measure here".
- Accept: recovered flux bias < 2% above 10σ; motion recovered within its stated error for ≥ 90% of injections.

### S5: getting data out (and in)
- Export the current view as FITS with full WCS and provenance headers; spectra/light curves as ECSV (units, flags, errors, wavelength and bandwidth per point) next to CSV.
- SAMP (the VO standard link) to send images and tables to TOPCAT, Aladin and DS9 with one click.
- Citable: `CITATION.cff`, a Zenodo DOI per tagged release; CI (GitHub Actions) running pytest, bun test, typecheck and build on every push.
- Accept: exported FITS opens in DS9/astropy with correct coordinates (test); ECSV round-trips through astropy (test); CI green.

### S6: PSF photometry
Fit SPHEREx's per-exposure PSF (`EPSF`, today discarded) instead of summing an aperture: separates close pairs, measures saturated stars from their unsaturated wings, removes the aperture correction.
- Accept: on injected pairs 2 px apart both fluxes recovered within 5%; on saturated targets, wing-fit fluxes consistent across visits; WISE 0855 re-tested (can its 4.6 µm light be separated from the neighbour?).

### S7: coverage and review
- M7 live mode (any coordinate), batch lists, and new fields where SPHEREx isn't saturated, including an ices field (SPHEREx's own science goal).
- Accessibility audit to Section 508 (axe + manual keyboard and screen-reader pass).
- Outside review: IRSA helpdesk and, if possible, SPHEREx science-team members; their findings go in the build log.

Order of work: S1 → S2 → S3 → S4 → S5 → S6 → S7 (S7's review last, once there is something solid to review).

### Last: hosting and demo kit (old "step 1")
GitHub Pages from the owner's public repo, a 30-second video following the tour, slides, the challenge-statement mapping, and target swaps (RW Aur → Teegarden's Star; keep WISE 0855 as the "why it can't be seen" lesson).

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
