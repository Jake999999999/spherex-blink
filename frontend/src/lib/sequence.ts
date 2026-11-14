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

export function allPlanes(b: Bundle): Float32Array[] {
  const planes: Float32Array[] = [];
  for (let e = 0; e < b.meta.epochs.length; e++) for (let d = 1; d <= 6; d++) planes.push(framePlane(b, e, d));
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
