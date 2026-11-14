import { describe, expect, test } from "bun:test";
import { pixelToWorld, worldToPixel, separationArcsec, formatRa, formatDec } from "../src/lib/wcs";
import { propagate, mjdToYear, yearToMjd, formatMjdRange } from "../src/lib/astro";
import { percentile, levelsFor, applyStretch, diffLimit, applyDiff } from "../src/lib/stretch";
import { parseState, serializeState, DEFAULT_STATE } from "../src/lib/urlState";
import { parseBundle, framePlane, wisePlane, variancePlane, wiseForDetector, type Meta } from "../src/lib/bundle";
import { blinkSteps, layerOf } from "../src/lib/sequence";
import { buildLut } from "../src/gl/colormaps";
import type { GridWcs } from "../src/lib/bundle";

// Grid as written by backend frames.grid_wcs(ra, dec, 79)
const grid = (ra: number, dec: number, n = 79): GridWcs => ({
  ctype: ["RA---TAN", "DEC--TAN"],
  crval: [ra, dec],
  crpix: [(n + 1) / 2, (n + 1) / 2],
  cdelt: [-6.15 / 3600, 6.15 / 3600],
  naxis: [n, n],
});

describe("wcs", () => {
  test("centre pixel is crval", () => {
    const w = grid(269.447, 4.746);
    const [x, y] = worldToPixel(w, 269.447, 4.746);
    expect(x).toBeCloseTo(39, 9);
    expect(y).toBeCloseTo(39, 9);
  });
  test("round trip < 0.01 px everywhere, incl. near the pole and RA wrap", () => {
    for (const [ra, dec] of [[269.4, 4.7], [0.01, -30], [359.99, 10], [275.8, 66.5], [10, -89.5]]) {
      const w = grid(ra, dec);
      for (const [x, y] of [[0, 0], [78, 0], [12.3, 60.7], [78, 78]]) {
        const [a, d] = pixelToWorld(w, x, y);
        const [x2, y2] = worldToPixel(w, a, d);
        expect(Math.abs(x2 - x)).toBeLessThan(0.01);
        expect(Math.abs(y2 - y)).toBeLessThan(0.01);
      }
    }
  });
  test("north is +y and east is -x", () => {
    const w = grid(100, 20);
    const [, yN] = worldToPixel(w, 100, 20 + 60 / 3600);
    const [xE] = worldToPixel(w, 100 + 60 / 3600, 20);
    expect(yN).toBeGreaterThan(39);
    expect(xE).toBeLessThan(39);
  });
  test("separation and formatting", () => {
    expect(separationArcsec(10, 0, 10, 1 / 60)).toBeCloseTo(60, 6);
    expect(formatRa(269.452075)).toBe("17:57:48.50");
    expect(formatDec(-7.245147)).toBe("−07:14:42.5");
  });
});

describe("astro", () => {
  test("Barnard's Star 2016.0 -> 2026.5 (same numbers as the Python test)", () => {
    const [ra, dec] = propagate(269.44850252543836, 4.739420051112412, -801.551, 10362.394, 2016, 2026.5);
    expect(Math.abs((ra - 269.4462) * 3600 * Math.cos((dec * Math.PI) / 180))).toBeLessThan(0.5);
    expect(Math.abs((dec - 4.7696) * 3600)).toBeLessThan(0.5);
  });
  test("mjd/year", () => {
    expect(mjdToYear(yearToMjd(2025.6))).toBeCloseTo(2025.6, 9);
    expect(formatMjdRange(60900, 60930)).toBe("Aug–Sep 2025");
  });
});

describe("stretch", () => {
  test("percentile ignores NaN", () => {
    expect(percentile([1, NaN, 3, 2], 50)).toBe(2);
    expect(percentile([0, 10], 25)).toBe(2.5);
  });
  test("levels and mapping", () => {
    const l = levelsFor(Float32Array.from({ length: 101 }, (_, i) => i), 0, 100);
    expect(l).toEqual({ black: 0, white: 100 });
    expect(applyStretch(50, l, "linear")).toBe(0.5);
    expect(applyStretch(-5, l, "asinh")).toBe(0);
    expect(applyStretch(100, l, "asinh")).toBeCloseTo(1, 9);
    expect(applyStretch(10, l, "asinh")).toBeGreaterThan(0.1); // asinh lifts faint values
  });
  test("difference limits are symmetric", () => {
    const d = Float32Array.from([-4, -1, 0, 1, 2]);
    expect(diffLimit(d, 100)).toBe(4);
    expect(applyDiff(-8, 4, "linear")).toBe(-1);
    expect(applyDiff(-2, 4, "asinh")).toBeCloseTo(-applyDiff(2, 4, "asinh"), 12);
  });
});

describe("url state", () => {
  test("round trip", () => {
    const s = { ...DEFAULT_STATE, target: "eps-ind-b", mode: "diff" as const, band: 3, t1: 0, t2: 2, wise: false };
    const p = parseState("?" + serializeState(s));
    expect({ ...DEFAULT_STATE, ...p, silent: undefined }).toEqual({ ...s, silent: undefined });
    expect(p.silent).toBe(false);
  });
  test("silent is read and kept, junk is ignored", () => {
    const p = parseState("?silent&band=9&mode=evil&target=../x");
    expect(p.silent).toBe(true);
    expect(p.band).toBeUndefined();
    expect(p.mode).toBeUndefined();
    expect(p.target).toBeUndefined();
    expect(serializeState(DEFAULT_STATE, true).endsWith("&silent")).toBe(true);
  });
});

function fakeBundle(E = 3, H = 4, W = 5, nWise = 2) {
  const plane = H * W * 4;
  const meta = {
    epochs: Array.from({ length: E }, (_, e) => ({
      index: e, mjd: 60900 + 180 * e, mjd_min: 60890 + 180 * e, mjd_max: 60910 + 180 * e,
      bands: Array.from({ length: 6 }, (_, d) => ({ detector: d + 1, n: e === 1 && d === 0 ? 1 : 10, missing: e === 1 && d === 0 })),
    })),
    wise: [
      { band: "W1", wavelength_um: 3.4, mjd: 55300, mjd_min: 55273, mjd_max: 55458, source_url: "", coverage: 1 },
      { band: "W2", wavelength_um: 4.6, mjd: 55300, mjd_min: 55273, mjd_max: 55458, source_url: "", coverage: 1 },
    ].slice(0, nWise),
    layout: {
      dtype: "float32",
      frames: { offset: 0, shape: [E, 6, H, W] },
      variance: { offset: E * 6 * plane, shape: [E, 6, H, W] },
      wise: { offset: 2 * E * 6 * plane, shape: [nWise, H, W] },
      bytes: (2 * E * 6 + nWise) * plane,
    },
  } as unknown as Meta;
  const data = new Float32Array(meta.layout.bytes / 4);
  // encode (block index) in every pixel so we can see which plane we got
  for (let k = 0; k < data.length; k++) data[k] = Math.floor(k / (H * W));
  return parseBundle(meta, data.buffer, { ref_year: 2016, stars: [] });
}

describe("bundle", () => {
  test("plane offsets", () => {
    const b = fakeBundle();
    expect(framePlane(b, 2, 4)[0]).toBe(2 * 6 + 3);
    expect(variancePlane(b, 0, 1)[0]).toBe(18);
    expect(wisePlane(b, 1)[3]).toBe(37);
    expect(framePlane(b, 2, 4).length).toBe(20);
  });
  test("size mismatch is an error", () => {
    const b = fakeBundle();
    expect(() => parseBundle(b.meta, new ArrayBuffer(8), b.gaia)).toThrow();
  });
  test("WISE band choice", () => {
    const b = fakeBundle();
    expect(wiseForDetector(b, 2)).toBe(0);
    expect(wiseForDetector(b, 6)).toBe(1);
    expect(wiseForDetector(fakeBundle(3, 4, 5, 0), 6)).toBe(-1);
  });
  test("blink steps skip missing visits and put WISE first", () => {
    const b = fakeBundle();
    const s = blinkSteps(b, 1, true);
    expect(s.map((x) => x.kind)).toEqual(["wise", "spherex", "spherex"]);
    expect(s.map((x) => x.epoch)).toEqual([-1, 0, 2]);
    expect(s[0].layer).toBe(18);
    expect(s[2].layer).toBe(layerOf(2, 1));
    expect(blinkSteps(b, 5, false)).toHaveLength(3);
  });
});

test("colormap LUTs are 256 RGBA entries from first to last stop", () => {
  const g = buildLut("gray");
  expect(g.length).toBe(1024);
  expect([g[0], g[1020], g[1023]]).toEqual([0, 255, 255]);
  const d = buildLut("diverging");
  expect(d[128 * 4]).toBeLessThan(20); // near black in the middle
});
