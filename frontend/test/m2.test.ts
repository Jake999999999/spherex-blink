import { describe, expect, test } from "bun:test";
import { centroid, fitMotion } from "../src/lib/motion";
import { medianFlux, nearestSource, points, toCsv, type Spectra } from "../src/lib/spectra";
import { logTicks, niceTicks, robustRange } from "../src/lib/ticks";
import type { GridWcs } from "../src/lib/bundle";
import { worldToPixel } from "../src/lib/wcs";
import { propagate } from "../src/lib/astro";

function star(w: number, h: number, x0: number, y0: number, sigma = 1.0, amp = 100, bg = 2): Float32Array {
  const a = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = bg + amp * Math.exp(-((x - x0) ** 2 + (y - y0) ** 2) / (2 * sigma * sigma));
  return a;
}

describe("centroid", () => {
  test("finds a sub-pixel star from a seed 2 px away", () => {
    const c = centroid(star(31, 31, 14.3, 16.7), 31, 31, 16, 15, 3)!;
    expect(Math.abs(c.x - 14.3)).toBeLessThan(0.1);
    expect(Math.abs(c.y - 16.7)).toBeLessThan(0.1);
  });
  test("a saturated (NaN) core still centres", () => {
    const p = star(31, 31, 15, 15, 1.5);
    p[15 * 31 + 15] = NaN;
    const c = centroid(p, 31, 31, 14, 14, 4)!;
    expect(Math.abs(c.x - 15)).toBeLessThan(0.15);
    expect(Math.abs(c.y - 15)).toBeLessThan(0.15);
  });
  test("empty sky gives null", () => {
    expect(centroid(new Float32Array(31 * 31).fill(3), 31, 31, 15, 15)).toBeNull();
  });
});

describe("fitMotion", () => {
  test("recovers Barnard-like motion on a north-up grid (x grows west)", () => {
    const scale = 6.15;
    // 10.36"/yr north, 0.80"/yr west
    const pts = [2010.4, 2025.7, 2026.2, 2026.7].map((year) => ({
      year,
      x: 40 + (0.8 / scale) * (year - 2010.4),
      y: 20 + (10.36 / scale) * (year - 2010.4),
    }));
    const f = fitMotion(pts, scale)!;
    expect(f.north).toBeCloseTo(10.36, 6);
    expect(f.east).toBeCloseTo(-0.8, 6);
    expect(f.pa).toBeGreaterThan(355);
    expect(f.sigma).toBeCloseTo(0, 6);
    expect(f.baselineYears).toBeCloseTo(16.3, 6);
  });
  test("two points: no sigma; one point: null", () => {
    expect(fitMotion([{ year: 1, x: 0, y: 0 }, { year: 2, x: 0, y: 1 }], 1)!.sigma).toBeNull();
    expect(fitMotion([{ year: 1, x: 0, y: 0 }], 1)).toBeNull();
  });
});

const wcs: GridWcs = { ctype: ["RA---TAN", "DEC--TAN"], crval: [100, 20], crpix: [21, 21], cdelt: [-6.15 / 3600, 6.15 / 3600], naxis: [41, 41] };

const spectra: Spectra = {
  units: "mJy",
  aperture_arcsec: 15.4,
  sky_annulus_arcsec: [24.6, 43],
  note: "",
  flags: {},
  exposures: { mjd: [60900, 60901, 61100], det: [1, 2, 1], epoch: [0, 0, 1] },
  sources: [
    { id: "target", name: "T", gaia_id: null, g: 9, ra: 100, dec: 20, pmra: 0, pmdec: 6150, ref_year: 2016, flux: [10, null, 12], err: [1, null, 1], flag: [0, 0, 2], wl: [0.9, null, 0.95], bw: [0.02, null, 0.02] },
    { id: "gaia-1", name: "S", gaia_id: "1", g: 12, ra: 100.01, dec: 20.005, pmra: 0, pmdec: 0, ref_year: 2016, flux: [5, 6, 7], err: [1, 1, 1], flag: [0, 0, 0], wl: [1.0, 1.3, 1.05], bw: [null, null, null] },
  ],
};

describe("spectra", () => {
  test("points drop missing values and keep alignment", () => {
    const p = points(spectra, spectra.sources[0]);
    expect(p.map((q) => q.i)).toEqual([0, 2]);
    expect(p[1]).toMatchObject({ epoch: 1, flag: 2, wl: 0.95, det: 1 });
  });
  test("nearest source follows proper motion to the frame date", () => {
    // target moves 6.15"/yr north = 1 px/yr; at 2026 it is ~10 px north of crval
    const [ra, dec] = propagate(100, 20, 0, 6150, 2016, 2025.5);
    const [x, y] = worldToPixel(wcs, ra, dec);
    expect(nearestSource(spectra, wcs, x + 0.5, y, 60850)?.id).toBe("target");
    // at its 2016 position there is nothing in 2025
    const [x0, y0] = worldToPixel(wcs, 100, 20);
    expect(nearestSource(spectra, wcs, x0, y0, 60850)).toBeNull();
  });
  test("median flux ignores flagged points", () => {
    expect(medianFlux(points(spectra, spectra.sources[0]), 0.5, 2)).toBe(10);
  });
  test("csv has a header and one row per point", () => {
    const csv = toCsv(spectra.sources[1], points(spectra, spectra.sources[1]));
    expect(csv.trim().split("\n")).toHaveLength(5);
  });
});

describe("ticks", () => {
  test("nice ticks", () => {
    expect(niceTicks(0, 10, 5)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(niceTicks(1, 5, 4)).toEqual([1, 2, 3, 4, 5]);
  });
  test("log ticks", () => {
    expect(logTicks(3, 4000)).toEqual([10, 100, 1000]);
    expect(logTicks(3, 60)).toEqual([5, 10, 20, 50]);
  });
  test("robust range ignores outliers", () => {
    const v = Array.from({ length: 100 }, (_, i) => i).concat([1e6]);
    const [lo, hi] = robustRange(v);
    expect(hi).toBeLessThan(200);
    expect(lo).toBeLessThan(5);
  });
});
