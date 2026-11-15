import { describe, expect, test } from "bun:test";
import { F_HI, F_LO, describeLightCurve, describeSpectrum, sonifyPlan } from "../src/lib/sonify";
import type { Point } from "../src/lib/spectra";

const pt = (wl: number, flux: number, i = 0): Point => ({ i, mjd: 61000 + i, wl, bw: null, flux, err: 0.1, flag: 0, det: 1, epoch: 0 });

describe("sonification plan", () => {
  test("brighter is higher; range is 220–880 Hz; times run 0 → duration", () => {
    const xs = [1, 2, 3, 4];
    const notes = sonifyPlan(xs, [1, 10, 100, 10], 4, 2);
    expect(notes.map((n) => n.t)).toEqual([0, 0.5, 1, 1.5]);
    expect(notes[0].freq).toBeCloseTo(F_LO, 6);
    expect(notes[2].freq).toBeCloseTo(F_HI, 6);
    expect(notes[1].freq).toBeCloseTo(notes[3].freq, 6);
    expect(notes[1].freq).toBeCloseTo(440, 0); // log scale: 10 is halfway between 1 and 100
  });
  test("a dip is heard as a drop", () => {
    const xs = Array.from({ length: 30 }, (_, i) => 1 + i * 0.1);
    const ys = xs.map((x) => (Math.abs(x - 2.5) < 0.15 ? 2 : 10));
    const notes = sonifyPlan(xs, ys, 30);
    const lowest = notes.reduce((a, b) => (b.freq < a.freq ? b : a));
    expect(lowest.t).toBeGreaterThan(1.3);
    expect(lowest.t).toBeLessThan(1.7);
  });
  test("nothing to play", () => {
    expect(sonifyPlan([1], [2])).toEqual([]);
  });
});

describe("words", () => {
  test("names the peak and the dips with reference bands", () => {
    const pts: Point[] = [];
    let i = 0;
    for (let wl = 0.8; wl < 5; wl += 0.02) {
      let f = 30;
      if (Math.abs(wl - 1.4) < 0.06) f = 6; // water
      if (Math.abs(wl - 3.3) < 0.08) f = 10; // methane
      if (Math.abs(wl - 4.0) < 0.1) f = 60;
      pts.push(pt(wl, f, i++), pt(wl, f, i++));
    }
    const s = describeSpectrum(pts);
    expect(s).toContain("Brightest near 4.0 µm");
    expect(s).toContain("H₂O");
    expect(s).toContain("CH₄");
  });
  test("smooth spectrum", () => {
    const pts: Point[] = [];
    let i = 0;
    for (let wl = 0.8; wl < 5; wl += 0.02) pts.push(pt(wl, 50 / wl, i++), pt(wl, 50 / wl, i++));
    expect(describeSpectrum(pts)).toContain("No deep dips");
  });
  test("light curve: steady vs changing", () => {
    const steady = Array.from({ length: 20 }, (_, k) => ({ mjd: 61000 + k * 20, wl: 4.5, flux: 100 + (k % 2), flag: 0 }));
    expect(describeLightCurve(steady)).toMatch(/^Steady/);
    const varying = Array.from({ length: 20 }, (_, k) => ({ mjd: 61000 + k * 20, wl: 4.5, flux: 100 + 80 * Math.sin(k / 3), flag: 0 }));
    // a constant star whose brightness depends only on wavelength is steady after detrending
    const sloped = Array.from({ length: 40 }, (_, k) => ({ mjd: 61000 + k * 10, wl: 4.42 + (k % 10) * 0.06, flux: 100 / (4.42 + (k % 10) * 0.06), flag: 0 }));
    expect(describeLightCurve(sloped)).toMatch(/^Steady/);
    expect(describeLightCurve(varying)).toMatch(/^Changes/);
  });
});

test("pure noise is not described as dips", () => {
  const pts: Point[] = [];
  let i = 0;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  for (let wl = 0.8; wl < 5; wl += 0.02) pts.push(pt(wl, rnd(), i++), pt(wl, rnd(), i++));
  expect(describeSpectrum(pts)).toMatch(/No clear source/);
});
