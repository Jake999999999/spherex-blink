// Measure a star's position in each frame (centroid) and fit a straight-line motion.

export interface Centroid {
  x: number;
  y: number;
  flux: number;
}

/**
 * Background-subtracted, flux-weighted centroid within radius r of (x0, y0), iterated so the window
 * follows the light. NaN pixels (saturated cores, masked pixels) are skipped. Pixel i spans
 * [i, i+1) with its centre at i (same 0-based convention as wcs.ts).
 */
export function centroid(plane: ArrayLike<number>, w: number, h: number, x0: number, y0: number, r = 3, iters = 3): Centroid | null {
  let cx = x0;
  let cy = y0;
  let flux = 0;
  for (let it = 0; it < iters; it++) {
    const sky: number[] = [];
    const rIn = r + 2;
    const rOut = r + 5;
    for (let y = Math.floor(cy - rOut); y <= Math.ceil(cy + rOut); y++) {
      for (let x = Math.floor(cx - rOut); x <= Math.ceil(cx + rOut); x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const d = Math.hypot(x - cx, y - cy);
        const v = plane[y * w + x];
        if (d >= rIn && d <= rOut && Number.isFinite(v)) sky.push(v);
      }
    }
    sky.sort((a, b) => a - b);
    const bg = sky.length ? sky[sky.length >> 1] : 0;
    let sw = 0;
    let sx = 0;
    let sy = 0;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        if (Math.hypot(x - cx, y - cy) > r) continue;
        const v = plane[y * w + x] - bg;
        if (!Number.isFinite(v) || v <= 0) continue;
        sw += v;
        sx += v * x;
        sy += v * y;
      }
    }
    if (sw <= 0) return null;
    cx = sx / sw;
    cy = sy / sw;
    flux = sw;
  }
  return { x: cx, y: cy, flux };
}

export interface MotionFit {
  /** arcsec/yr toward east and north */
  east: number;
  north: number;
  total: number;
  /** position angle, degrees east of north */
  pa: number;
  /** 1-sigma from the scatter about the line (null with only 2 frames) */
  sigma: number | null;
  n: number;
  baselineYears: number;
}

/**
 * Least-squares straight line through (year, x, y) pixel positions on a north-up, east-left grid.
 * x grows west, so east motion is -dx/dt.
 */
export function fitMotion(pts: { year: number; x: number; y: number }[], arcsecPerPx: number): MotionFit | null {
  const n = pts.length;
  if (n < 2) return null;
  const tm = pts.reduce((a, p) => a + p.year, 0) / n;
  let stt = 0;
  for (const p of pts) stt += (p.year - tm) ** 2;
  if (stt <= 0) return null;
  const xm = pts.reduce((a, p) => a + p.x, 0) / n;
  const ym = pts.reduce((a, p) => a + p.y, 0) / n;
  let bx = 0;
  let by = 0;
  for (const p of pts) {
    bx += (p.year - tm) * (p.x - xm);
    by += (p.year - tm) * (p.y - ym);
  }
  bx /= stt;
  by /= stt;
  let sigma: number | null = null;
  if (n > 2) {
    let ss = 0;
    for (const p of pts) {
      const rx = p.x - (xm + bx * (p.year - tm));
      const ry = p.y - (ym + by * (p.year - tm));
      ss += rx * rx + ry * ry;
    }
    // per-axis slope error, combined: sqrt(residual variance / Σ(t-t̄)²)
    sigma = Math.sqrt(ss / (2 * (n - 2)) / stt) * arcsecPerPx;
  }
  const east = -bx * arcsecPerPx;
  const north = by * arcsecPerPx;
  const years = pts.map((p) => p.year);
  return {
    east,
    north,
    total: Math.hypot(east, north),
    pa: ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360,
    sigma,
    n,
    baselineYears: Math.max(...years) - Math.min(...years),
  };
}
