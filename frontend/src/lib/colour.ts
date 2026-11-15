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
    what: "Green sits on methane's 3.3 µm absorption band. Objects with methane (cool brown dwarfs) lose green and turn pink.",
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

/**
 * Mean over the window's channels, per pixel. A pixel needs real data in at least half of the
 * window's channels; otherwise it is NaN. (A saturated star has no data at the wavelengths where it is
 * too bright, so averaging only the channels that survive would give it a false colour.)
 */
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
  const need = Math.max(1, Math.ceil(ks.length / 2));
  const out = new Float32Array(nn);
  for (let i = 0; i < nn; i++) out[i] = cnt[i] >= need ? sum[i] / cnt[i] : NaN;
  return out;
}

/**
 * Display-only: a pixel with no colour (some window empty) right next to a very bright pixel is a
 * saturated star core. Paint it white (every plane at its white level), like a blown-out star in a
 * photo, and report how many there were. Empty pixels elsewhere stay empty.
 */
export function blowOutSaturated(
  planes: [Float32Array, Float32Array, Float32Array],
  n: number,
  white: [number, number, number],
): { planes: [Float32Array, Float32Array, Float32Array]; count: number } {
  const out = planes.map((p) => new Float32Array(p)) as [Float32Array, Float32Array, Float32Array];
  let count = 0;
  let changed = true;
  for (let pass = 0; pass < 4 && changed; pass++) {
    changed = false;
    const snap = out.map((p) => new Float32Array(p));
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        if (snap.every((p) => Number.isFinite(p[i]))) continue;
        let bright = false;
        for (let dy = -1; dy <= 1 && !bright; dy++) {
          for (let dx = -1; dx <= 1 && !bright; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if ((dx || dy) && xx >= 0 && yy >= 0 && xx < n && yy < n) {
              const j = yy * n + xx;
              bright = snap.some((p, k) => Number.isFinite(p[j]) && p[j] >= white[k] * 0.5);
            }
          }
        }
        if (bright) {
          for (let k = 0; k < 3; k++) out[k][i] = white[k];
          count++;
          changed = true;
        }
      }
    }
  }
  return { planes: out, count };
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

// ---------------------------------------------------------------- explaining a colour

/** Mean brightness inside each window (r, g, b) from (wavelength, flux) samples; null if a window has < 2. */
export function windowShares(wl: number[], flux: number[], mix: Mix): [number, number, number] | null {
  const mean = (w: Window) => {
    const v = flux.filter((f, i) => Number.isFinite(f) && wl[i] >= w.lo && wl[i] <= w.hi);
    return v.length >= 2 ? Math.max(0, v.reduce((a, b) => a + b, 0) / v.length) : NaN;
  };
  const out: [number, number, number] = [mean(mix.r), mean(mix.g), mean(mix.b)];
  return out.every(Number.isFinite) && out.some((v) => v > 0) ? out : null;
}

/** Everyday colour name for an (r, g, b) brightness triple on one scale. */
export function colourName([r, g, b]: [number, number, number]): string {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  if (mx <= 0) return "black";
  if ((mx - mn) / mx < 0.2) return "white";
  const R = r / mx;
  const G = g / mx;
  const B = b / mx;
  let h: number;
  if (mx === r) h = (60 * ((G - B) / (1 - mn / mx)) + 360) % 360;
  else if (mx === g) h = 60 * ((B - R) / (1 - mn / mx)) + 120;
  else h = 60 * ((R - G) / (1 - mn / mx)) + 240;
  if (h < 20 || h >= 350) return "red";
  if (h < 45) return "orange";
  if (h < 70) return "yellow";
  if (h < 160) return "green";
  if (h < 200) return "cyan";
  if (h < 255) return "blue";
  if (h < 290) return "purple";
  if (h < 320) return "magenta";
  return "pink";
}

const NAMES = { r: "red", g: "green", b: "blue" } as const;

/**
 * One or two sentences: what colour a source has in this view and why, from its own spectrum.
 * `refs` are molecule positions to mention when a dim window contains one.
 */
export function whyColour(shares: [number, number, number], mix: Mix, refs: { label: string; wl: number }[]): string {
  const name = colourName(shares);
  const mx = Math.max(...shares);
  const keys = ["r", "g", "b"] as const;
  const rel = shares.map((s) => s / mx);
  const fmt = (k: (typeof keys)[number]) => `${NAMES[k]} window (${mix[k].lo.toFixed(2)}–${mix[k].hi.toFixed(2)} µm)`;
  if (name === "white") return "Looks white here: about equally bright in all three wavelength windows.";
  const bright = keys.filter((_, i) => rel[i] >= 0.75);
  const dim = keys.filter((_, i) => rel[i] < 0.5);
  let s = `Looks ${name} here: brightest in the ${bright.map(fmt).join(" and the ")}`;
  if (dim.length) {
    s += `, dim in the ${dim.map(fmt).join(" and the ")}`;
    const why = [...new Set(dim.flatMap((k) => refs.filter((r) => r.wl >= mix[k].lo - 0.05 && r.wl <= mix[k].hi + 0.05).map((r) => r.label)))];
    if (why.length) s += `, where ${why.join(" and ")} absorb${why.length > 1 ? "" : "s"} light`;
  }
  return `${s}.`;
}
