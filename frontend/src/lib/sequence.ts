// What the blink cycles through, and which texture layer each step uses.
// Texture layers: SPHEREx epoch e, detector d -> e*6 + (d-1); WISE frame i -> E*6 + i.
import { bandAvailable, framePlane, wiseForDetector, wisePlane, type Bundle } from "./bundle";
import { formatMjdRange } from "./astro";

export interface Step {
  kind: "spherex" | "wise";
  layer: number;
  epoch: number; // SPHEREx epoch index, or -1 for WISE
  mjd: number;
  label: string;
  sublabel: string;
}

export const layerOf = (epoch: number, detector: number) => epoch * 6 + (detector - 1);
export const wiseLayer = (b: Bundle, i: number) => b.meta.epochs.length * 6 + i;

/**
 * Display-only fill for saturated star cores. A saturated pixel has no value (NaN), which would draw
 * as a dark hole in the brightest star. A NaN pixel next to a very bright pixel is filled with the
 * brightest neighbour, growing inward a few passes. Field-edge NaNs (next to faint sky) stay empty.
 * The original data is untouched; hover readouts and photometry still see NaN.
 */
export function fillSaturated(plane: Float32Array, w: number, h: number, passes = 4): Float32Array {
  const finite: number[] = [];
  for (let i = 0; i < plane.length; i++) if (Number.isFinite(plane[i])) finite.push(plane[i]);
  if (!finite.length) return plane;
  finite.sort((a, b) => a - b);
  const thresh = finite[Math.floor(0.995 * (finite.length - 1))];
  let cur = plane;
  for (let p = 0; p < passes; p++) {
    let changed = false;
    const next = new Float32Array(cur);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (Number.isFinite(cur[i])) continue;
        let best = -Infinity;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if ((dx || dy) && xx >= 0 && yy >= 0 && xx < w && yy < h) {
              const v = cur[yy * w + xx];
              if (Number.isFinite(v) && v > best) best = v;
            }
          }
        }
        if (best >= thresh) {
          next[i] = best;
          changed = true;
        }
      }
    }
    cur = next;
    if (!changed) break;
  }
  return cur;
}

export function allPlanes(b: Bundle): Float32Array[] {
  const planes: Float32Array[] = [];
  for (let e = 0; e < b.meta.epochs.length; e++) for (let d = 1; d <= 6; d++) planes.push(fillSaturated(framePlane(b, e, d), b.width, b.height));
  for (let i = 0; i < b.meta.wise.length; i++) planes.push(wisePlane(b, i));
  return planes;
}

export function blinkSteps(b: Bundle, detector: number, includeWise: boolean): Step[] {
  const steps: Step[] = [];
  if (includeWise) {
    const wi = wiseForDetector(b, detector);
    if (wi >= 0) {
      const w = b.meta.wise[wi];
      steps.push({
        kind: "wise",
        layer: wiseLayer(b, wi),
        epoch: -1,
        mjd: w.mjd,
        label: "WISE 2010",
        sublabel: `AllWISE ${w.band} ${w.wavelength_um} µm · ${formatMjdRange(w.mjd_min, w.mjd_max)}`,
      });
    }
  }
  b.meta.epochs.forEach((ep, e) => {
    if (!bandAvailable(b, e, detector)) return;
    const band = ep.bands[detector - 1];
    steps.push({
      kind: "spherex",
      layer: layerOf(e, detector),
      epoch: e,
      mjd: band.mjd ?? ep.mjd,
      label: `Visit ${e + 1}`,
      sublabel: `${formatMjdRange(ep.mjd_min, ep.mjd_max)} · ${band.n} exposures`,
    });
  });
  return steps;
}

/** Epoch indices that have data for this detector. */
export function epochsWithBand(b: Bundle, detector: number): number[] {
  return b.meta.epochs.map((_, e) => e).filter((e) => bandAvailable(b, e, detector));
}
