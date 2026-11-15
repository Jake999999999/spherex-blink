// What the blink cycles through, and which texture layer each step uses.
// Texture layers: SPHEREx epoch e, detector d -> e*6 + (d-1); WISE frame i -> E*6 + i.
import { bandAvailable, framePlane, matchedPlane, neowisePlane, wiseForDetector, wisePlane, type Bundle } from "./bundle";
import { formatMjdRange } from "./astro";

export interface Step {
  kind: "spherex" | "wise";
  /** for WISE frames: the 2010 AllWISE atlas or a NEOWISE yearly stack */
  source?: { kind: "allwise" | "neowise"; index: number };
  layer: number;
  epoch: number; // SPHEREx epoch index, or -1 for WISE
  mjd: number;
  label: string;
  sublabel: string;
}

export const layerOf = (epoch: number, detector: number) => epoch * 6 + (detector - 1);
export const wiseLayer = (b: Bundle, i: number) => b.meta.epochs.length * 6 + i;
export const matchedLayer = (b: Bundle, epoch: number, detector: number) =>
  b.meta.epochs.length * 6 + b.meta.wise.length + epoch * 6 + (detector - 1);
export const neowiseLayer = (b: Bundle, i: number) =>
  b.meta.epochs.length * 6 + b.meta.wise.length + (b.meta.layout.matched ? b.meta.epochs.length * 6 : 0) + i;

/** The raw plane behind a blink step (for levels, hover values, export, motion). */
export function stepPlane(b: Bundle, s: Step, detector: number): Float32Array {
  if (s.kind === "wise") return s.source?.kind === "neowise" ? neowisePlane(b, s.source.index) : wisePlane(b, s.source?.index ?? s.layer - b.meta.epochs.length * 6);
  return framePlane(b, s.epoch, detector);
}

/**
 * Display-only fill for saturated star cores. A saturated pixel has no value (NaN), which would draw
 * as a dark hole in the brightest star. A NaN pixel next to a very bright pixel is filled with the
 * brightest neighbour, growing inward a few passes. Field-edge NaNs (next to faint sky) stay empty.
 * The original data is untouched; hover readouts and photometry still see NaN.
 */
export function fillSaturated(plane: Float32Array, w: number, h: number, passes = 8, symmetric = false, seedMask?: Uint8Array): Float32Array {
  const finite: number[] = [];
  for (let i = 0; i < plane.length; i++) if (Number.isFinite(plane[i])) finite.push(symmetric ? Math.abs(plane[i]) : plane[i]);
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
        let best = 0;
        let bestMag = -Infinity;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if ((dx || dy) && xx >= 0 && yy >= 0 && xx < w && yy < h) {
              const v = cur[yy * w + xx];
              if (Number.isFinite(v)) {
                const mag = symmetric ? Math.abs(v) : v;
                if (mag > bestMag) {
                  bestMag = mag;
                  best = v;
                }
              }
            }
          }
        }
        if (bestMag > -Infinity && (bestMag >= thresh || seedMask?.[i])) {
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
  const filledFrames: Float32Array[] = [];
  const rawFrames: Float32Array[] = [];
  for (let e = 0; e < b.meta.epochs.length; e++) {
    for (let d = 1; d <= 6; d++) {
      const raw = framePlane(b, e, d);
      const filled = fillSaturated(raw, b.width, b.height);
      rawFrames.push(raw);
      filledFrames.push(filled);
      planes.push(filled);
    }
  }
  for (let i = 0; i < b.meta.wise.length; i++) planes.push(fillSaturated(wisePlane(b, i), b.width, b.height));
  // S2 matched frames after the WISE ones (fill saturated star cores—positive, negative, or ~0—before A-B subtraction)
  if (b.meta.layout.matched) {
    let idx = 0;
    for (let e = 0; e < b.meta.epochs.length; e++) {
      for (let d = 1; d <= 6; d++) {
        const raw = rawFrames[idx];
        const filled = filledFrames[idx];
        const seedMask = new Uint8Array(raw.length);
        for (let k = 0; k < raw.length; k++) if (!Number.isFinite(raw[k]) && Number.isFinite(filled[k])) seedMask[k] = 1;
        planes.push(fillSaturated(matchedPlane(b, e, d)!, b.width, b.height, 8, true, seedMask));
        idx++;
      }
    }
  }
  if (b.neowise) for (let i = 0; i < (b.meta.neowise?.frames.length ?? 0); i++) planes.push(fillSaturated(neowisePlane(b, i), b.width, b.height));
  // a map-only field (built in the browser without exposures) has no frames: keep the texture non-empty
  if (!planes.length) planes.push(new Float32Array(b.width * b.height).fill(NaN));
  return planes;
}

export function blinkSteps(b: Bundle, detector: number, includeWise: boolean, includeNeowise = true): Step[] {
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
        source: { kind: "allwise", index: wi },
      });
    }
    // NEOWISE yearly stacks, same band as the 2010 frame
    if (includeNeowise && b.neowise && b.meta.neowise) {
      const want = detector >= 5 ? "W2" : "W1";
      b.meta.neowise.frames.forEach((f, i) => {
        if (f.band !== want) return;
        steps.push({
          kind: "wise",
          layer: neowiseLayer(b, i),
          epoch: -1,
          mjd: f.mjd,
          label: `WISE ${Math.floor(2000 + (f.mjd - 51544.5) / 365.25)}`,
          sublabel: `NEOWISE ${f.band} ${f.wavelength_um} µm · ${formatMjdRange(f.mjd_min, f.mjd_max)} · ${f.n} exposures`,
          source: { kind: "neowise", index: i },
        });
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
