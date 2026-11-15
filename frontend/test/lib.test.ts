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

import { float16ToFloat32 } from "../src/lib/bundle";

test("float16 decoding matches numpy's half floats", () => {
  // 1.0, -2.0, 0.5, 65504 (max), NaN, a subnormal (2^-24), 3.140625
  const h = Uint16Array.from([0x3c00, 0xc000, 0x3800, 0x7bff, 0x7e00, 0x0001, 0x4248]);
  const f = float16ToFloat32(h);
  expect(Array.from(f.slice(0, 4))).toEqual([1, -2, 0.5, 65504]);
  expect(Number.isNaN(f[4])).toBe(true);
  expect(f[5]).toBeCloseTo(2 ** -24, 30);
  expect(f[6]).toBeCloseTo(3.140625, 6);
});

import { parseLive } from "../src/lib/urlState";

test("?ra=&dec=&fov= opens any spot (embeddable); bad values are ignored", () => {
  const p = parseLive("?ra=133.795&dec=-7.245&fov=8")!;
  expect(p.ra).toBeCloseTo(133.795, 9);
  expect([p.dec, p.fov, p.name]).toEqual([-7.245, 8, undefined]);
  expect(parseLive("?ra=-10&dec=5")).toEqual({ ra: 350, dec: 5, fov: 5, name: undefined });
  expect(parseLive("?ra=1&dec=5&fov=99")!.fov).toBe(15);
  expect(parseLive("?ra=1&dec=95")).toBeNull();
  expect(parseLive("?ra=abc&dec=5")).toBeNull();
  expect(parseLive("?target=barnard")).toBeNull();
});

import { stepPlane } from "../src/lib/sequence";

test("NEOWISE yearly frames join the blink after 2010, in the detector's band, with their own planes", () => {
  const b = fakeBundle(3, 4, 5, 2);
  const n = 4 * 5;
  b.meta.neowise = {
    file: "neowise.bin",
    shape: [3, 4, 5],
    frames: [
      { band: "W1", wavelength_um: 3.4, mjd: 57000, mjd_min: 56990, mjd_max: 57010, n: 6 },
      { band: "W2", wavelength_um: 4.6, mjd: 57000, mjd_min: 56990, mjd_max: 57010, n: 6 },
      { band: "W2", wavelength_um: 4.6, mjd: 58000, mjd_min: 57990, mjd_max: 58010, n: 5 },
    ],
    missing: null,
    credit: "",
  };
  b.neowise = Float32Array.from({ length: 3 * n }, (_, k) => 100 + Math.floor(k / n));
  const s6 = blinkSteps(b, 6, true);
  expect(s6.map((s) => s.label)).toEqual(["WISE 2010", "WISE 2014", "WISE 2017", "Visit 1", "Visit 2", "Visit 3"]);
  expect(stepPlane(b, s6[2], 6)[0]).toBe(102); // the third NEOWISE frame (W2, 2017)
  expect(blinkSteps(b, 2, true).filter((s) => s.source?.kind === "neowise")).toHaveLength(1); // W1 only
  expect(blinkSteps(b, 6, true, false).map((s) => s.label)[1]).toBe("Visit 1"); // switched off
});

import { defaultMeasure, points as spPoints } from "../src/lib/spectra";
test("PSF fit is the default measure unless it skipped most points (saturated stars)", () => {
  const base = { id: "s", name: "s", gaia_id: null, g: 12, ra: 0, dec: 0, pmra: 0, pmdec: 0, ref_year: 2016, err: [0.1, 0.1, 0.1, 0.1], flag: [0, 0, 0, 0], wl: [1, 1.1, 1.2, 1.3], bw: [null, null, null, null] };
  const ok = { ...base, flux: [1, 2, 3, 4], psf_flux: [1.1, 2.1, null, 4.1], psf_err: [0.1, 0.1, null, 0.1], psf_flag: [0, 0, 2, 0] };
  const sat = { ...base, flux: [1, 2, 3, 4], psf_flux: [null, null, null, 4.1], psf_err: [null, null, null, 0.1], psf_flag: [2, 2, 2, 0] };
  expect(defaultMeasure(ok)).toBe("psf");
  expect(defaultMeasure(sat)).toBe("core");
  expect(defaultMeasure({ ...base, flux: [1, 2, 3, 4] })).toBe("core");
  const s = { units: "mJy" as const, aperture_arcsec: 15.4, sky_annulus_arcsec: [24.6, 43] as [number, number], note: "", flags: {}, exposures: { mjd: [1, 2, 3, 4], det: [1, 1, 3, 3], epoch: [0, 0, 1, 1] }, sources: [ok], error_model: { scale: { "1": 2, "3": 2 }, psf_scale: { "1": 1.5, "3": 4 }, absolute_floor: null, note: "" } };
  const p = spPoints(s, ok);
  expect(p.map((x) => x.flux)).toEqual([1.1, 2.1, 4.1]);
  expect(p.map((x) => x.err)).toEqual([0.15000000000000002, 0.15000000000000002, 0.4]); // PSF errors use the PSF scale
  expect(spPoints(s, ok, "core").map((x) => x.err)).toEqual([0.2, 0.2, 0.2, 0.2]);
});
