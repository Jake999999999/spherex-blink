// Colour mode: false-colour images and map spectra from SPHEREx's 102-channel all-sky cube
// (baked as cube.bin, see backend/spherex_blink/cube.py).
import { percentile } from "./stretch";
import type { GridWcs } from "./bundle";
import { pixelToWorld, worldToPixel } from "./wcs";

export interface CubeDesc {
  wcs: GridWcs;
  pixel_scale_arcsec: number;
  native_scale_arcsec: number;
  release: string;
  tiles: string[];
  mjd_min: number | null;
  mjd_max: number | null;
  units: "MJy/sr";
  channels: {
    wavelength: number[];
    wl_min: number[] | null;
    wl_max: number[] | null;
    bandwidth: number[] | null;
    detector: number[] | null;
  };
  blank: number[];
  note: string;
  file?: string;
  shape?: [number, number, number];
  missing?: string;
}

export interface Cube {
  desc: CubeDesc;
  data: Float32Array; // [nchan, n, n]
  nchan: number;
  n: number;
}

export interface Window {
  lo: number; // µm
  hi: number;
}

export interface Mix {
  r: Window;
  g: Window;
  b: Window;
}

export interface Preset {
  id: string;
  name: string;
  what: string;
  mix: Mix;
}

/** Each preset says in one sentence what to look for. Windows avoid the two blank channels near 2.42 µm. */
export const PRESETS: Preset[] = [
  {
    id: "spread",
    name: "Short to long",
    what: "Blue is the shortest infrared SPHEREx sees, red the longest. Hot stars look blue, cool ones red.",
    mix: { b: { lo: 0.95, hi: 1.3 }, g: { lo: 1.6, hi: 2.2 }, r: { lo: 3.5, hi: 4.4 } },
  },
  {
    id: "methane",
    name: "Methane",
    what: "Green sits on methane's 3.3 µm absorption band. Objects with methane (cool brown dwarfs) lose green and turn magenta.",
    mix: { b: { lo: 2.95, hi: 3.15 }, g: { lo: 3.2, hi: 3.45 }, r: { lo: 3.9, hi: 4.15 } },
  },
  {
    id: "water",
    name: "Water",
    what: "Green sits on water's 1.4 µm band between two clear windows. Things with water vapour in their air lose green.",
    mix: { b: { lo: 1.2, hi: 1.3 }, g: { lo: 1.35, hi: 1.48 }, r: { lo: 1.55, hi: 1.7 } },
  },
  {
    id: "dust",
    name: "Warm dust",
    what: "Red is the longest wavelengths. Warm dust around young stars glows there, so they look redder than ordinary stars.",
    mix: { b: { lo: 1.6, hi: 1.8 }, g: { lo: 2.9, hi: 3.2 }, r: { lo: 4.5, hi: 5.0 } },
  },
];

export function parseCube(desc: CubeDesc, buf: ArrayBuffer): Cube {
  const [nchan, n, n2] = desc.shape ?? [0, 0, 0];
  if (n !== n2) throw new Error("cube.bin must be square");
  if (buf.byteLength !== nchan * n * n * 4) throw new Error(`cube.bin is ${buf.byteLength} bytes, expected ${nchan * n * n * 4}`);
  return { desc, data: new Float32Array(buf), nchan, n };
}

export const channelPlane = (c: Cube, k: number) => c.data.subarray(k * c.n * c.n, (k + 1) * c.n * c.n);

/** Channels whose centre wavelength lies in the window (blank channels excluded). */
export function channelsIn(c: Cube, w: Window): number[] {
  const out: number[] = [];
  c.desc.channels.wavelength.forEach((wl, k) => {
    if (wl >= w.lo && wl <= w.hi && !c.desc.blank.includes(k)) out.push(k);
  });
  return out;
}

/** Mean over the window's channels, per pixel, skipping NaN. NaN where no channel has data. */
export function windowMean(c: Cube, w: Window): Float32Array {
  const ks = channelsIn(c, w);
  const nn = c.n * c.n;
  const sum = new Float64Array(nn);
  const cnt = new Uint16Array(nn);
  for (const k of ks) {
    const p = channelPlane(c, k);
    for (let i = 0; i < nn; i++) {
      const v = p[i];
      if (Number.isFinite(v)) {
        sum[i] += v;
        cnt[i]++;
      }
    }
  }
  const out = new Float32Array(nn);
  for (let i = 0; i < nn; i++) out[i] = cnt[i] ? sum[i] / cnt[i] : NaN;
  return out;
}

export interface ColourLevels {
  black: [number, number, number];
  white: [number, number, number];
}

/**
 * Display levels for the three planes. "balanced" stretches each colour on its own (shows faint colour
 * differences, but colours are then relative); "physical" uses one scale for all three, so a colour
 * means more light at that wavelength in Fν (MJy/sr).
 */
export function colourLevels(planes: [Float32Array, Float32Array, Float32Array], lo: number, hi: number, mode: "balanced" | "physical"): ColourLevels {
  const each = planes.map((p) => [percentile(p, lo), percentile(p, hi)] as [number, number]);
  if (mode === "balanced") {
    return {
      black: each.map((e) => e[0]) as [number, number, number],
      white: each.map((e) => (e[1] > e[0] ? e[1] : e[0] + 1e-6)) as [number, number, number],
    };
  }
  const b = Math.min(...each.map((e) => e[0]).filter(Number.isFinite));
  const w = Math.max(...each.map((e) => e[1]).filter(Number.isFinite));
  return { black: [b, b, b], white: [w > b ? w : b + 1e-6, w > b ? w : b + 1e-6, w > b ? w : b + 1e-6] };
}

/** Main-grid data pixel -> cube-grid pixel (both north-up TAN grids on the same centre). */
export function mainToCube(main: GridWcs, cube: GridWcs, x: number, y: number): [number, number] {
  const [ra, dec] = pixelToWorld(main, x, y);
  return worldToPixel(cube, ra, dec);
}

export const MAP_APERTURE_ARCSEC = 15.4; // same radius as the per-exposure photometry

export interface MapSpectrum {
  wl: number[];
  flux: (number | null)[]; // mJy in a 15.4" aperture, local sky removed
}

/**
 * Aperture spectrum from the cube at (x, y) in cube pixels: sum of pixels within 15.4" minus the median
 * of a 3-5 px ring, times the pixel solid angle -> mJy. Same aperture as the per-exposure points, so
 * both can share one axis.
 */
export function mapSpectrum(c: Cube, x: number, y: number): MapSpectrum {
  const scale = c.desc.pixel_scale_arcsec;
  const rAp = MAP_APERTURE_ARCSEC / scale;
  const sr = (scale / 206264.806) ** 2;
  const n = c.n;
  const wl: number[] = [];
  const flux: (number | null)[] = [];
  const order = c.desc.channels.wavelength.map((w, k) => [w, k] as const).sort((a, b) => a[0] - b[0]);
  for (const [w, k] of order) {
    wl.push(w);
    if (c.desc.blank.includes(k)) {
      flux.push(null);
      continue;
    }
    const p = channelPlane(c, k);
    let s = 0;
    let na = 0;
    let bad = false;
    const ring: number[] = [];
    for (let yy = Math.floor(y - 5); yy <= Math.ceil(y + 5); yy++) {
      for (let xx = Math.floor(x - 5); xx <= Math.ceil(x + 5); xx++) {
        if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
        const d = Math.hypot(xx - x, yy - y);
        const v = p[yy * n + xx];
        if (d <= rAp) {
          if (Number.isFinite(v)) {
            s += v;
            na++;
          } else bad = true;
        } else if (d >= 3 && d <= 5 && Number.isFinite(v)) ring.push(v);
      }
    }
    if (bad || !na || ring.length < 6) {
      flux.push(null);
      continue;
    }
    ring.sort((a, b) => a - b);
    const sky = ring[ring.length >> 1];
    flux.push((s - sky * na) * sr * 1e9);
  }
  return { wl, flux };
}

/** Why a map spectrum would mislead for this source, or null if it's fine. */
export function mapSpectrumCaveat(c: Cube, pmArcsecPerYear: number, variable: boolean): string | null {
  if (variable) return "This star changes brightness, and each wavelength in the map was observed on a different date, so its map spectrum would mix bright and faint moments. Use the per-exposure dots instead.";
  if (c.desc.mjd_min !== null && c.desc.mjd_max !== null) {
    // The map spectrum sums a 15.4"-radius aperture at the star's mid-span position. Over the averaging
    // span the star is at most pm*years/2 from there; beyond a quarter of the aperture radius the
    // channels observed early or late start to lose light unevenly.
    const years = (c.desc.mjd_max - c.desc.mjd_min) / 365.25;
    if ((pmArcsecPerYear * years) / 2 > 0.25 * MAP_APERTURE_ARCSEC)
      return "This star moves too fast for the map: it was in different places when different wavelengths were observed, so its map spectrum would lose light unevenly.";
  }
  return null;
}
