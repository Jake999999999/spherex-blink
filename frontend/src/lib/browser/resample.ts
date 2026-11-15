// Ports of backend frames.py: the north-up output grid, bilinear resampling with Σw²·var, the
// sigma-clipped background and visit grouping. Kept numerically the same as the Python pipeline.

import type { GridWcs } from "../bundle";
import { pixelToWorld } from "../wcs";
import type { SkyToPixel } from "./skywcs";

export const PIXEL_SCALE_ARCSEC = 6.15;

export function gridWcs(ra: number, dec: number, npix: number, scaleArcsec = PIXEL_SCALE_ARCSEC): GridWcs {
  return { ctype: ["RA---TAN", "DEC--TAN"], crval: [ra, dec], crpix: [(npix + 1) / 2, (npix + 1) / 2], cdelt: [-scaleArcsec / 3600, scaleArcsec / 3600], naxis: [npix, npix] };
}

export const gridSize = (fovArcmin: number, scaleArcsec = PIXEL_SCALE_ARCSEC) => Math.ceil((fovArcmin * 60) / scaleArcsec) | 1;

/** Source pixel (full-file coordinates, 0-based) of every output pixel, row-major. */
export function sourceCoords(src: SkyToPixel, grid: GridWcs): { sx: Float64Array; sy: Float64Array } {
  const [nx, ny] = grid.naxis;
  const sx = new Float64Array(nx * ny);
  const sy = new Float64Array(nx * ny);
  for (let y = 0; y < ny; y++)
    for (let x = 0; x < nx; x++) {
      const [ra, dec] = pixelToWorld(grid, x, y);
      const [px, py] = src.toPixel(ra, dec);
      sx[y * nx + x] = px;
      sy[y * nx + x] = py;
    }
  return { sx, sy };
}

export interface Sampled {
  value: Float64Array;
  variance: Float64Array;
  valid: Uint8Array;
}

/**
 * Bilinear interpolation of a (nx × ny) image at source positions (sx, sy) in that image's pixels.
 * value = Σ wᵢvᵢ, variance = Σ wᵢ²varᵢ; an output pixel is valid only if every input pixel with weight
 * > 1e-6 is good and inside (never interpolated across bad pixels), as in frames.bilinear.
 */
export function bilinear(image: Float64Array, variance: Float64Array | null, good: Uint8Array | null, nx: number, ny: number, sx: Float64Array, sy: Float64Array): Sampled {
  const n = sx.length;
  const value = new Float64Array(n);
  const vout = new Float64Array(n);
  const valid = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let x = sx[i];
    let y = sy[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      value[i] = vout[i] = NaN;
      continue;
    }
    // snap round-off just outside the edge pixels back onto them
    if (x > -1e-3 && x < 0) x = 0;
    if (y > -1e-3 && y < 0) y = 0;
    if (x > nx - 1 && x < nx - 1 + 1e-3) x = nx - 1;
    if (y > ny - 1 && y < ny - 1 + 1e-3) y = ny - 1;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    let ok = true;
    let v = 0;
    let s2 = 0;
    for (let k = 0; k < 4 && ok; k++) {
      const dx = k & 1;
      const dy = k >> 1;
      const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
      if (w <= 1e-6) continue;
      const xi = x0 + dx;
      const yi = y0 + dy;
      if (xi < 0 || xi >= nx || yi < 0 || yi >= ny) {
        ok = false;
        break;
      }
      const j = yi * nx + xi;
      if (good && !good[j]) {
        ok = false;
        break;
      }
      v += w * image[j];
      if (variance) s2 += w * w * variance[j];
    }
    if (ok) {
      value[i] = v;
      vout[i] = s2;
      valid[i] = 1;
    } else value[i] = vout[i] = NaN;
  }
  return { value, variance: vout, valid };
}

const median = (a: Float64Array | number[]): number => {
  const s = Float64Array.from(a).sort();
  const n = s.length;
  return n === 0 ? NaN : n % 2 ? s[(n - 1) / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
};

/** Sigma-clipped median (frames.robust_background). */
export function robustBackground(values: number[]): number {
  let v = values.filter(Number.isFinite);
  if (!v.length) return 0;
  let med = median(v);
  for (let it = 0; it < 5; it++) {
    const mad = median(v.map((x) => Math.abs(x - med))) * 1.4826;
    if (mad <= 0) break;
    const keep = v.filter((x) => Math.abs(x - med) < 3 * mad);
    if (keep.length < 10) break;
    v = keep;
    med = median(v);
  }
  return med;
}

/** Split exposure times into visits (frames.group_epochs): gaps > 45 d, visits longer than 75 d cut into bins. */
export function groupEpochs(mjds: number[], gapDays = 45, maxSpanDays = 75): number[][] {
  const order = mjds.map((_, i) => i).sort((a, b) => mjds[a] - mjds[b]);
  const groups: number[][] = [];
  for (const i of order) {
    const g = groups.at(-1);
    if (g && mjds[i] - mjds[g.at(-1)!] <= gapDays) g.push(i);
    else groups.push([i]);
  }
  const out: number[][] = [];
  for (const g of groups) {
    const lo = mjds[g[0]];
    const hi = mjds[g.at(-1)!];
    const span = hi - lo;
    if (span <= maxSpanDays) {
      out.push(g);
      continue;
    }
    const nb = Math.ceil(span / maxSpanDays);
    for (let b = 0; b < nb; b++) {
      const a = lo + (span * b) / nb;
      const z = lo + (span * (b + 1)) / nb;
      const part = g.filter((i) => (mjds[i] >= a && mjds[i] < z) || (b === nb - 1 && mjds[i] === z));
      if (part.length) out.push(part);
    }
  }
  return out;
}

/** Evenly spread picks: np.unique(np.round(np.linspace(0, n-1, k))). */
export function spread(n: number, k: number): number[] {
  if (n <= k) return [...Array(n).keys()];
  const s = new Set<number>();
  for (let i = 0; i < k; i++) s.add(Math.round((i * (n - 1)) / (k - 1 || 1)));
  return [...s].sort((a, b) => a - b);
}
