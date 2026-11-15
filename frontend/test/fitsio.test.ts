import { describe, expect, test } from "bun:test";
import { buildEcsv, buildFits, card, wcsCards } from "../src/lib/fitsio";

describe("FITS", () => {
  test("cards are 80 characters with FITS formatting", () => {
    expect(card("BITPIX", -32)).toHaveLength(80);
    expect(card("BITPIX", -32).slice(0, 30)).toBe("BITPIX  =                  -32");
    expect(card("SIMPLE", true).slice(0, 30)).toBe("SIMPLE  =                    T");
    expect(card("CTYPE1", "RA---TAN").slice(0, 20)).toBe("CTYPE1  = 'RA---TAN'");
    expect(card("CDELT1", -0.001708333).includes("-0.001708333")).toBe(true);
    expect(card("CRPIX1", 40.5)).toContain("40.5");
    expect(card("BUNIT", "it's").slice(10, 20)).toBe("'it''s   '");
  });
  test("file layout: header and data padded to 2880, data big-endian", () => {
    const data = Float32Array.from([1, 2, 3, NaN, 5, 6]);
    const f = buildFits([3, 2], data, wcsCards({ ctype: ["RA---TAN", "DEC--TAN"], crval: [10, 20], crpix: [2, 1.5], cdelt: [-0.001, 0.001], naxis: [3, 2] }));
    expect(f.length % 2880).toBe(0);
    const text = new TextDecoder().decode(f.slice(0, 2880));
    expect(text.startsWith("SIMPLE  =")).toBe(true);
    expect(text).toContain("NAXIS1  =                    3");
    expect(text).toContain("NAXIS2  =                    2");
    expect(text).toMatch(/END {77}/);
    const dv = new DataView(f.buffer, 2880);
    expect(dv.getFloat32(0, false)).toBe(1);
    expect(dv.getFloat32(8, false)).toBe(3);
    expect(Number.isNaN(dv.getFloat32(12, false))).toBe(true);
  });
  test("wrong data length is an error", () => {
    expect(() => buildFits([2, 2], new Float32Array(3), [])).toThrow();
  });
});

describe("ECSV", () => {
  test("header declares names, units and types; missing values are empty", () => {
    const s = buildEcsv(
      [
        { name: "wavelength", datatype: "float64", unit: "um", values: [1.1, 1.2] },
        { name: "flux", datatype: "float64", unit: "mJy", description: "aperture flux", values: [3.5, null] },
        { name: "flag", datatype: "int32", values: [0, 2] },
      ],
      { source: "Epsilon Indi Ba+Bb", aperture_arcsec: 15.4 },
    );
    const lines = s.trim().split("\n");
    expect(lines[0]).toBe("# %ECSV 1.0");
    expect(s).toContain("# - {name: flux, unit: mJy, datatype: float64, description: 'aperture flux'}");
    expect(s).toContain("# - {aperture_arcsec: 15.4}");
    expect(lines.at(-3)).toBe("wavelength flux flag");
    expect(lines.at(-1)).toBe('1.2 "" 2');
  });
});
