# NASA Data & Resources Used

This document lists all NASA data products, archives, and official resources used by **SPHEREx Blink**. All data is real, publicly accessible, and free to use without authentication.

---

## 1. NASA SPHEREx Public Data Archive (AWS Open Data / IRSA)
- **Link Text:** `NASA SPHEREx Public Data on AWS S3 (IRSA)`
- **URL:** https://registry.opendata.aws/nasa-irsa-spherex/
- **Direct Bucket:** https://nasa-irsa-spherex.s3.amazonaws.com/
- **What it is & how it is used:**  
  SPHEREx (Spectro-Photometer for the History of the Universe, Epoch of Reionization and Ices Explorer) is NASA's all-sky near-infrared spectro-photometric space telescope (0.75–5.0 µm across 102 spectral channels and 6 detector arrays). SPHEREx Blink streams real Level 2 / Quick-Release single-exposure spectral FITS cutouts and metadata directly from NASA/IPAC IRSA's public AWS S3 mirror in browser mode, and uses them to build multi-epoch blink sequences, wavelength-matched difference images, false-colour infrared composites, and per-exposure 102-channel spectra.

## 2. NASA/IPAC Infrared Science Archive (IRSA) — Simple Image Access (SIA) & TAP
- **Link Text:** `NASA/IPAC Infrared Science Archive (IRSA)`
- **URL:** https://irsa.ipac.caltech.edu/
- **SPHEREx SIA Endpoint:** https://irsa.ipac.caltech.edu/SIA
- **What it is & how it is used:**  
  IRSA is NASA's archive for infrared and submillimeter astronomy missions at Caltech/IPAC. SPHEREx Blink queries IRSA's SIA/TAP services (via the local Python pipeline or user-pasted IRSA exposure links) to discover all SPHEREx exposures covering a target's sky coordinates, retrieve observation timestamps (MJD), detector IDs, and WCS geometry.

## 3. NASA AllWISE & NEOWISE-R Infrared Sky Surveys (via IRSA)
- **Link Text:** `NASA AllWISE & NEOWISE-R Data Release (IRSA)`
- **URL:** https://irsa.ipac.caltech.edu/Missions/wise.html
- **What it is & how it is used:**  
  The Wide-field Infrared Survey Explorer (WISE, 2010) and its reactivated NEOWISE-R mission (2014–2024) imaged the entire sky in the W1 (3.4 µm) and W2 (4.6 µm) infrared bands. SPHEREx Blink resamples 2010 AllWISE atlas frames and yearly 2014–2024 NEOWISE coadds onto the SPHEREx grid so users can blink across a 16-year infrared baseline (2010–2026), turning slow proper motion (such as Barnard's Star, WISE 0855, and Epsilon Indi B) into a visible glide. AllWISE W1/W2 photometry is also overlaid as reference points in the spectrum viewer, and AllWISE HiPS imagery is available in the Aladin sky context viewer.

## 4. NASA 2MASS (Two Micron All Sky Survey) Reference Photometry
- **Link Text:** `NASA 2MASS All-Sky Survey (IRSA)`
- **URL:** https://irsa.ipac.caltech.edu/Missions/2mass.html
- **What it is & how it is used:**  
  2MASS mapped the sky in the near-infrared J (1.25 µm), H (1.65 µm), and Ks (2.16 µm) bands. SPHEREx Blink queries 2MASS catalog photometry (via VizieR) to plot calibrated J/H/Ks reference points alongside SPHEREx's 0.75–5.0 µm spectra, letting users cross-check SPHEREx flux calibration against established NASA infrared benchmarks.

## 5. NASA SPHEREx Mission Overview & Documentation (JPL / Caltech)
- **Link Text:** `NASA SPHEREx Mission Website (JPL / Caltech)`
- **URL:** https://spherex.caltech.edu/
- **NASA Science Page:** https://science.nasa.gov/mission/spherex/
- **What it is & how it is used:**  
  Official mission specifications—including the 6 detector arrays (D1–D6), 102 spectral channels spanning 0.75–5.0 µm, 6.2″ pixel scale, Linear Variable Filter (LVF) spectral layout, and PSF calibration references—used to design the instrument-accurate FITS reader, wavelength window presets, PSF photometry, and educational guide content in the app.
