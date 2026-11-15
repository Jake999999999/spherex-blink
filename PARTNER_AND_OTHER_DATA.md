# Space Agency Partner & Other Data, Resources, and Tools

This document lists all Space Agency Partner data, external astronomical services, and open-source software/libraries used in **SPHEREx Blink**. All resources listed below are publicly accessible and open-source or freely available for scientific and educational use.

---

## Space Agency Partner Data & Astronomical Archives

### 1. ESA Gaia Data Release 3 (Gaia DR3)
- **Link Text:** `ESA Gaia DR3 Archive`
- **URL:** https://gea.esac.esa.int/archive/
- **TAP Endpoint:** https://gea.esac.esa.int/tap-server/tap/sync
- **What it is & how it is used:**  
  Data from the European Space Agency's (ESA) Gaia mission. SPHEREx Blink uses Gaia DR3 astrometry (ICRS positions, proper motions `pmRA` / `pmDec`, and G-band magnitudes) to plot epoch-propagated star markers on each frame's exact observation date, anchor PSF-fitting aperture photometry, validate proper-motion measurements against Gaia's astrometric baseline, and populate the interactive Gaia DR3 overlay in the sky context viewer.

### 2. CDS Strasbourg — Sesame Name Resolver, VizieR TAP, & Aladin Lite
- **Link Text:** `CDS Strasbourg Astronomical Data Services (Sesame, VizieR, Aladin Lite)`
- **URL:** https://cds.unistra.fr/
- **Sub-services used:**
  - **Sesame Name Resolver** (`https://cds.unistra.fr/cgi-bin/nph-sesame/-oI/SNV` and mirrors at CfA Harvard and IDIA): Resolves astronomical object names (e.g., `"Barnard's Star"`, `"R Draconis"`, `"Epsilon Indi"`) into ICRS RA/Dec coordinates in live search.
  - **VizieR TAP Service** (`https://tapvizier.cds.unistra.fr/TAPVizieR/tap/sync`): Queries 2MASS, AllWISE, and Gaia DR3 (`I/355/gaiadr3`) catalog photometry and astrometry for spectrum reference overlays and sky-context star overlays.
  - **Aladin Lite v3** (`https://aladin.cds.unistra.fr/AladinLite/api/v3/latest/aladin.js`): Powers the optional collapsible sky-context finder chart showing AllWISE, 2MASS, and DSS2 all-sky HiPS tiles, the cutout footprint box, and clickable Gaia DR3 sources.

### 3. Virtual Observatory SAMP (Simple Application Messaging Protocol)
- **Link Text:** `IVOA SAMP (Simple Application Messaging Protocol)`
- **URL:** https://www.ivoa.net/documents/SAMP/
- **What it is & how it is used:**  
  Standard International Virtual Observatory Alliance (IVOA) protocol used by SPHEREx Blink's "Send to TOPCAT / Aladin" integration to broadcast FITS cutouts and ECSV spectra directly to local desktop astronomy tools.

---

## Open-Source Software, Libraries & Build Tools

### Frontend & Browser Engine
- **React & React DOM** (`https://react.dev/`) — UI component framework (MIT License).
- **TypeScript** (`https://www.typescriptlang.org/`) — Static type checking (Apache-2.0 License).
- **Vite** (`https://vite.dev/`) — Frontend bundler and dev server (MIT License).
- **Bun** (`https://bun.sh/`) — JavaScript/TypeScript test runner and package manager (MIT License).
- **Tailwind CSS** (`https://tailwindcss.com/`) — Utility-first CSS styling (MIT License).
- **Lucide React** (`https://lucide.dev/`) — Open-source UI icon set (ISC License).
- **WebGL2 / HTML5 Canvas / Web Audio API** — Standard browser APIs used for GPU-accelerated image stretching, animated GIF/PNG export composition, and accessible spectrum/light-curve sonification.

### Backend Pipeline (Python)
- **Python 3.12** (`https://www.python.org/`) — Core data-baking and local proxy server runtime (PSF License).
- **Astropy** (`https://www.astropy.org/`) — FITS I/O, WCS projection/reprojection, coordinate transforms, and astronomical time conversions (BSD-3-Clause License).
- **NumPy** (`https://numpy.org/`) — Array math and image processing (BSD-3-Clause License).
- **SciPy** (`https://scipy.org/`) — Numerical optimization and interpolation for PSF fitting and spectral resampling (BSD-3-Clause License).
- **HTTPX** (`https://www.python-httpx.org/`) — Async HTTP client for querying IRSA, VizieR, and Gaia archives (BSD-3-Clause License).
- **uv** (`https://docs.astral.sh/uv/`) — Python package and environment manager (MIT/Apache-2.0 License).
- **pytest** (`https://docs.pytest.org/`) — Python test suite (MIT License).

### Hosting & CI/CD
- **GitHub Pages & GitHub Actions** (`https://pages.github.com/`) — Static web hosting and automated build/deploy workflows for the live browser application.
