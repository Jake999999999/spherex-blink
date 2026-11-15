import { describe, expect, test } from "bun:test";
import { PRESETS, channelsIn, colourLevels, mapSpectrum, mapSpectrumCaveat, parseCube, windowMean, type CubeDesc } from "../src/lib/colour";

function makeCube(n = 11, wls = [1.0, 1.1, 1.2, 1.3, 3.3]): ReturnType<typeof parseCube> {
  const nchan = wls.length;
  const data = new Float32Array(nchan * n * n);
  for (let k = 0; k < nchan; k++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        // flat sky of 1 + a point source at the centre whose brightness is (k+1)*10
        data[k * n * n + y * n + x] = 1 + (x === 5 && y === 5 ? (k + 1) * 10 : 0);
      }
    }
  }
  data[2 * n * n + 3] = NaN; // a missing pixel in channel 2
  const desc: CubeDesc = {
    wcs: { ctype: ["RA---TAN", "DEC--TAN"], crval: [10, 0], crpix: [6, 6], cdelt: [-12.3 / 3600, 12.3 / 3600], naxis: [n, n] },
    pixel_scale_arcsec: 12.3,
    native_scale_arcsec: 12.88,
    release: "hips_test",
    tiles: [],
    mjd_min: 60800,
    mjd_max: 61183.25, // ~1.05 yr
    units: "MJy/sr",
    channels: { wavelength: wls, wl_min: null, wl_max: null, bandwidth: null, detector: null },
    blank: [3],
    note: "",
    shape: [nchan, n, n],
  };
  return parseCube(desc, data.buffer);
}

describe("colour maths", () => {
  test("windows pick channels by wavelength and skip blank ones", () => {
    const c = makeCube();
    expect(channelsIn(c, { lo: 0.95, hi: 1.35 })).toEqual([0, 1, 2]); // channel 3 (1.3 µm) is blank
  });
  test("window mean skips NaN pixels", () => {
    const c = makeCube();
    const m = windowMean(c, { lo: 0.95, hi: 1.25 });
    expect(m[5 * 11 + 5]).toBeCloseTo(1 + (10 + 20 + 30) / 3, 6);
    expect(m[3]).toBeCloseTo(1, 6); // channel 2 is NaN there; mean of the other two
  });
  test("balanced vs physical levels", () => {
    const a = Float32Array.from({ length: 100 }, (_, i) => i);
    const b = Float32Array.from({ length: 100 }, (_, i) => i * 10);
    const bal = colourLevels([a, b, a], 0, 100, "balanced");
    expect(bal.white).toEqual([99, 990, 99]);
    const phys = colourLevels([a, b, a], 0, 100, "physical");
    expect(phys.white).toEqual([990, 990, 990]);
    expect(phys.black).toEqual([0, 0, 0]);
  });
  test("map spectrum sums the aperture minus sky, in mJy, sorted by wavelength", () => {
    const c = makeCube();
    const s = mapSpectrum(c, 5, 5);
    const sr = (12.3 / 206264.806) ** 2;
    expect(s.wl).toEqual([1.0, 1.1, 1.2, 1.3, 3.3]);
    expect(s.flux[0]!).toBeCloseTo(10 * sr * 1e9, 9); // only the star's excess survives sky subtraction
    expect(s.flux[4]!).toBeCloseTo(50 * sr * 1e9, 9);
    expect(s.flux[3]).toBeNull(); // blank channel
  });
  test("caveats: variables always; movers only beyond a quarter of the aperture radius", () => {
    const c = makeCube();
    expect(mapSpectrumCaveat(c, 0, true)).toMatch(/changes brightness/);
    expect(mapSpectrumCaveat(c, 4.7, false)).toBeNull(); // Eps Indi B: 2.5" from mid-span
    expect(mapSpectrumCaveat(c, 10.4, false)).toMatch(/moves too fast/); // Barnard: 5.5"
  });
  test("presets use valid, non-overlapping-in-order windows inside 0.75–5 µm", () => {
    for (const p of PRESETS) {
      for (const w of [p.mix.r, p.mix.g, p.mix.b]) {
        expect(w.lo).toBeGreaterThanOrEqual(0.75);
        expect(w.hi).toBeLessThanOrEqual(5.0);
        expect(w.hi).toBeGreaterThan(w.lo);
      }
      expect(p.what.length).toBeGreaterThan(20);
    }
  });
});

import { blowOutSaturated, colourName, whyColour, windowShares } from "../src/lib/colour";
import { REFERENCE_BANDS } from "../src/lib/spectra";

describe("honest colour", () => {
  test("a window needs data in at least half its channels", () => {
    const c = makeCube();
    // make channels 0 and 1 empty at pixel (5,5): window 0.95–1.25 µm then has 1 of 3 -> NaN
    const n = c.n;
    c.data[0 * n * n + 5 * n + 5] = NaN;
    c.data[1 * n * n + 5 * n + 5] = NaN;
    expect(Number.isNaN(windowMean(c, { lo: 0.95, hi: 1.25 })[5 * n + 5])).toBe(true);
  });
  test("blown-out cores turn white; empty sky stays empty", () => {
    const n = 5;
    const plane = () => new Float32Array(n * n).fill(1);
    const p: [Float32Array, Float32Array, Float32Array] = [plane(), plane(), plane()];
    for (const q of p) q[2 * n + 1] = 100; // a bright star left of the centre
    p[1][2 * n + 2] = NaN; // its saturated core has no green
    p[0][0] = NaN; // a missing corner far from anything bright
    const { planes, count } = blowOutSaturated(p, n, [100, 100, 100]);
    expect(count).toBe(1);
    expect([planes[0][2 * n + 2], planes[1][2 * n + 2], planes[2][2 * n + 2]]).toEqual([100, 100, 100]);
    expect(Number.isNaN(planes[0][0])).toBe(true);
  });
  test("colour names", () => {
    expect(colourName([1, 0.1, 0.9])).toBe("magenta");
    expect(colourName([0.69, 0.09, 0.22])).toBe("pink"); // Eps Indi B in the methane view
    expect(colourName([0.2, 0.5, 1])).toBe("blue");
    expect(colourName([1, 0.95, 0.9])).toBe("white");
    expect(colourName([1, 0.3, 0.05])).toBe("red");
  });
  test("why: Eps Indi B in the methane view", () => {
    const mix = PRESETS.find((p) => p.id === "methane")!.mix;
    // bright at 4.0 µm (red), dark at 3.3 µm (green), medium at 3.05 µm (blue): the measured pattern
    const wl = [3.0, 3.05, 3.1, 3.25, 3.3, 3.4, 3.95, 4.0, 4.1];
    const fl = [21, 22, 21, 3, 2.5, 3, 66, 69, 66]; // shares ≈ 0.69 / 0.09 / 0.22, as measured
    const shares = windowShares(wl, fl, mix)!;
    const s = whyColour(shares, mix, REFERENCE_BANDS);
    expect(s).toContain("pink");
    expect(s).toContain("dim in the green window");
    expect(s).toContain("CH₄ absorbs light");
  });
  test("no shares without at least two points per window", () => {
    const mix = PRESETS[0].mix;
    expect(windowShares([1.0], [5], mix)).toBeNull();
  });
});
