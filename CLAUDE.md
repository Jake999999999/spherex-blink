# SPHEREx Blink: agent notes

NASA Space Apps 2026 entry: blink comparator, epoch difference and spectrum explorer for NASA's SPHEREx survey, on real IRSA data. **Read `PLAN.md` first** (verified data facts, targets, milestones, acceptance checks). `SPEC-original.md` is the unverified pasted spec: do not take facts from it.

Status (2026-11-15): built-in targets, colour, validation, live mode; see PLAN.md progress lines. Live server: `uv run python -m spherex_blink serve` (127.0.0.1:8091; Vite proxies /api); one-off field: `uv run python -m spherex_blink field --ra … --dec … --fov … --id <16 hex> --out <dir outside frontend/public>`. Validation: `… validate` (and `… inject` first for S4). `uv run python -m spherex_blink bake all` (or ids) fetches + bakes; re-running reuses the cutout cache in `backend/cache/` and retries failures. `... index` rewrites `index.json`. Bake log of the first run: `backend/cache/bake.log`. Vite can serve a stale module after many edits: restart the preview server. Browser mode (no server, `src/lib/browser/`): `?browser` forces it; its golden fixtures come from `backend/scripts/make_browser_fixtures.py` (needs the bake cache; reads a few map-tile headers from S3). Production build check: preview config `spherex-blink-dist` (127.0.0.1:5187).

## Run and test

- Frontend (`frontend/`, bun, no Node on this PC: `bun x`, never `npx`):
  - `bun install`, `bun run dev` → http://127.0.0.1:5186 (preview config `spherex-blink` in `D:\Workspace\.claude\launch.json`)
  - `bun test`, `bun run typecheck`, `bun run build` → `dist/`; `bun run preview` → 127.0.0.1:5187
- Pipeline (`backend/`, Windows-native uv, Python 3.12):
  - `uv run pytest -q` (no network; synthetic FITS fixtures)
  - `uv run python -m spherex_blink bake <target…>` → writes `frontend/public/benchmarks/<id>/`
  - M3 only: `uv run python -m spherex_blink serve` → 127.0.0.1:8091; Vite proxies `/api`
- Browser testing: always add `?silent` (no audio). A hidden pane stops `requestAnimationFrame`: set a viewport with resize_window and drive frames with `__spherex.frame()`; `__spherex.state` is the live state.

## Rules

- Commit before editing. "Done" means tests pass and the app was seen running.
- Loopback only. No secrets (none are needed: all data is public).
- **Never show simulated data as real.** No automatic synthetic fallback. Anything simulated carries the `SIMULATED` watermark and badge. Every view shows its data source.
- Don't call the targets "NASA benchmarks" or the app a NASA product.
- Ask the owner before: fetching more data than the M1 set (cutouts are ~4 MB each; a target is ~1.5 GB of transfer), installing anything, pushing, making the repo public.
- Commit `frontend/public/benchmarks/` (≤ 6 MB per target since S2 and NEOWISE frames; ≤ 20 MB total). Never commit `backend/cache/` or raw FITS.

## Gotchas (all checked against live IRSA, see PLAN.md §2)

- SPHEREx uses linear variable filters: **one exposure is one wavelength at a given sky position, and each exposure is a different one.** There are no per-epoch 102-band image cubes. Blink frames are per-detector stacks; spectra are per-exposure photometry.
- SIA collections: `spherex_dr1`, `spherex_dr1_deep`, `spherex_qr3`, `spherex_qr3_deep`, `spherex_dr1_cube`; AllWISE images are `wise_allwise`. Use `https://irsa.ipac.caltech.edu/SIA` (direct FITS URLs), not the TAP ObsCore table (datalink URLs).
- Cutout: `<fits url>?center=<ra>,<dec>&size=<deg>`. ~4 MB each regardless of size, 2–18 s, **frequent HTTP 503**: retry with backoff, 4 concurrent at most, cache on disk. Cube tiles (321 MB) have no cutout service: use HTTP Range.
- `IMAGE` includes zodiacal light: subtract `ZODI`. Saturated cores are NaN. FLAGS bit 21 (SOURCE) is set on every star: mask specific bad bits only (list in PLAN.md).
- Targets move: compute positions from Gaia DR3 (epoch 2016.0) + proper motion for the observation date. J2000 coordinates put Barnard's Star 4.6′ outside the field.
- AllWISE and SPHEREx are different instruments: blink them, don't subtract them.
- Python: no `reproject`, `healpy`, `astroquery`, `pyvo`, scikit-learn. Resample with `astropy.wcs` + `scipy.ndimage`. If Application Control blocks an astropy/scipy DLL, stop and tell the owner.
- WebGL: R32F textures, nearest-neighbour by default; NaN handled with a mask, not in the shader.
