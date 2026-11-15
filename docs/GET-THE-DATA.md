# Getting the data yourself

SPHEREx Blink only uses public data: NASA's SPHEREx survey (through IRSA and NASA's copy on Amazon S3), WISE/NEOWISE, Gaia, 2MASS and AllWISE. This page says what the public website can fetch on its own, what needs the small local server, and how to bring in data you downloaded yourself.

## What works where

| | Public website (nothing to install) | With the local server |
|---|---|---|
| The built-in targets (Barnard's Star, Epsilon Indi B, WISE 0855, RW Aurigae, R Draconis, a pulsating giant) | Everything: blink, difference, 102-colour view, spectra, light curves, WISE 2010 + NEOWISE 2014–2024 frames, Gaia overlay, motion fit | Same |
| **Any spot: the 102-colour map and map spectra** | Yes, in seconds, straight from NASA's S3 copy | Yes |
| **Any spot: blink and difference over time** | Yes, after one extra step (below) | Yes, one click |
| Any spot: contamination flags | Yes | Yes |
| Any spot: wavelength-matched differences | No (plain differences, marked as such) | Yes |
| Any spot: per-star spectra and light curves (PSF fit and aperture) | No | Yes |
| Any spot: WISE 2010 and NEOWISE frames | No | Yes |
| Any spot: Gaia stars and proper motions | No | Yes |

Why the split: a web page may only ask another website for data if that website allows it (CORS). NASA's S3 copy of SPHEREx allows it; IRSA's search, cutout and catalogue services and ESA's Gaia archive don't. The local server asks them on your behalf.

## On the public website

**1. The colour map.** Type a name (`R Draconis`) or coordinates (`08h55m10.831s -07d14m42.53s`, `133.795 -7.245`), pick the field size and press *Fetch from NASA*. A link like `?ra=133.795&dec=-7.245&fov=4` opens the same view directly (handy for embedding).

**2. The time series.** NASA has no index on S3 of which exposures cover a position, so the app asks you to fetch the list once:

1. Click *Open IRSA's list of SPHEREx exposures here*. It opens IRSA's image search (SIA) for that position in a new tab. IRSA answers with a VOTable (XML): your browser shows it or downloads it.
2. Save it (Ctrl+S / ⌘S, or keep the download) and drop the file on the search panel. You can also paste the page's text, or a list of links to SPHEREx level-2 images.
3. The app shows how many exposures and visits it found and how much it will download (a quick look is usually 50–80 MB). Press *Build the blink*. It reads only the rows of each exposure that cover your field, straight from NASA's S3 copy, and processes them in your browser.

Only links to SPHEREx files in NASA's S3 bucket are ever followed. Anything else in the list is ignored.

**3. Your own SPHEREx files.** Any SPHEREx level-2 images or cutouts you downloaded from IRSA can be dropped on the panel instead (type the position first). A few ways to get them:

- From the list in step 2: the `access_url` column links each full image (about 66 MB).
- A **cutout** of any image: add `?center=RA,DEC&size=DEG` to its URL, e.g. `…/level2_2025W19_1B_0116_1D3_spx_l2b-v27-2026-197.fits?center=133.795,-7.245&size=0.1`. The cutout keeps every extension the app needs (IMAGE, FLAGS, VARIANCE, ZODI). Unzip `.gz` files first, or add `&gzip=false`.
- From NASA's S3 copy with the AWS command line (no account needed): `aws s3 cp --no-sign-request s3://nasa-irsa-spherex/<key> .`, where `<key>` is the path after `ibe/data/spherex/` in the IRSA link.

Dropped files are processed exactly like the S3 ones, and the view is labelled *user-supplied, unverified*.

**4. A field someone shared.** Fields made with the pipeline (the local server, or `python -m spherex_blink field …`) are a folder of files: `meta.json`, `frames.bin`, `gaia.json`, `spectra.json` and a few more. Select all the files in that folder and drop them on the search panel (or use *choose them*). The field opens with everything it was built with (WISE, NEOWISE, Gaia, PSF photometry), labelled as shared files that weren't checked against NASA's archive.

## Everything, with the local server

The full pipeline (the same one that built the targets) runs on your computer and fetches from IRSA, ESA and S3 for you. It needs [uv](https://docs.astral.sh/uv/) and Python 3.12, and listens only on your own computer.

```bash
cd backend
uv run python -m spherex_blink serve
```

Then run the website locally (`cd frontend`, `bun install`, `bun run dev`) and search as usual: the search panel switches to the server and builds the full field. A field is also available on the command line, as a folder you can share:

```bash
cd backend
uv run python -m spherex_blink field --ra 133.795 --dec -7.245 --fov 4 --quick --id 0123456789abcdef --out ../my-fields
```

## Credits and licences of the data

SPHEREx: NASA/JPL-Caltech/IPAC, via IRSA (DR1 DOI 10.26131/IRSA678, QR3 10.26131/IRSA662) and NASA's S3 copy. WISE/NEOWISE and AllWISE: NASA/JPL-Caltech/UCLA, via IRSA. 2MASS: UMass/IPAC-Caltech. Gaia: ESA (DR3). Names: CDS Sesame (SIMBAD, NED, VizieR). SPHEREx Blink is not a NASA product.
