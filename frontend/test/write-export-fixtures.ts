// Writes a FITS and an ECSV with the app's own writers, for backend/tests/test_exports.py to read with astropy.
import { writeFileSync } from "node:fs";
import { buildEcsv, buildFits, card, wcsCards } from "../src/lib/fitsio";

const out = process.argv[2];
const n = 21;
const data = new Float32Array(n * n);
data[10 * n + 14] = 7; // one bright pixel at x=14, y=10 (0-based)
const wcs = { ctype: ["RA---TAN", "DEC--TAN"] as [string, string], crval: [269.448, 4.7465] as [number, number], crpix: [11, 11] as [number, number], cdelt: [-6.15 / 3600, 6.15 / 3600] as [number, number], naxis: [n, n] as [number, number] };
writeFileSync(`${out}/export.fits`, buildFits([n, n], data, [...wcsCards(wcs), card("BUNIT", "MJy/sr"), card("TELESCOP", "SPHEREx")]));
writeFileSync(
  `${out}/export.ecsv`,
  buildEcsv(
    [
      { name: "wavelength", datatype: "float64", unit: "um", values: [1.1, 1.2, 1.3] },
      { name: "flux", datatype: "float64", unit: "mJy", values: [3.5, null, 4.25] },
      { name: "flag", datatype: "int32", values: [0, 1, 2] },
    ],
    { source: "test star", aperture_arcsec: 15.4 },
  ),
);
