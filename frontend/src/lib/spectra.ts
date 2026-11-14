// Per-exposure photometry baked by backend bake.measure_spectra: spectra.json.
import { mjdToYear, propagate } from "./astro";
import type { GridWcs } from "./bundle";
import { worldToPixel } from "./wcs";

export interface SpectraSource {
  id: string; // "target" or "gaia-<id>"
  name: string;
  gaia_id: string | null;
  g: number | null;
  ra: number;
  dec: number;
  pmra: number;
  pmdec: number;
  ref_year: number;
  flux: (number | null)[];
  err: (number | null)[];
  flag: number[];
  wl: (number | null)[];
  bw: (number | null)[];
  // ring around the core, for saturated stars (bundles baked after 2026-11-14 midday)
  wing_flux?: (number | null)[];
  wing_err?: (number | null)[];
  wing_flag?: number[];
}

export type Measure = "core" | "ring";

export interface Spectra {
  units: "mJy";
  aperture_arcsec: number;
  sky_annulus_arcsec: [number, number];
  note: string;
  flags: Record<string, string>;
  wing_arcsec?: [number, number];
  wing_note?: string;
  exposures: { mjd: number[]; det: number[]; epoch: number[] };
  sources: SpectraSource[];
}

export const FLAG_OK = 0;
export const FLAG_BAD_PIXEL = 1;
export const FLAG_SATURATED = 2;

export interface Point {
  i: number; // exposure index
  mjd: number;
  wl: number;
  bw: number | null;
  flux: number;
  err: number;
  flag: number;
  det: number;
  epoch: number;
}

export function points(s: Spectra, src: SpectraSource, measure: Measure = "core"): Point[] {
  const out: Point[] = [];
  const e = s.exposures;
  const ring = measure === "ring" && !!src.wing_flux;
  for (let i = 0; i < e.mjd.length; i++) {
    const f = ring ? src.wing_flux![i] : src.flux[i];
    const w = src.wl[i];
    if (f === null || f === undefined || w === null) continue;
    let flag = ring ? (src.wing_flag?.[i] ?? 0) : src.flag[i];
    // The ring tolerates a few masked (e.g. nonlinear) pixels and scales for them; only saturation in the ring counts against it.
    if (ring && flag === FLAG_BAD_PIXEL) flag = FLAG_OK;
    const err = ring ? (src.wing_err?.[i] ?? 0) : (src.err[i] ?? 0);
    out.push({ i, mjd: e.mjd[i], wl: w, bw: src.bw[i], flux: f, err, flag, det: e.det[i], epoch: e.epoch[i] });
  }
  return out;
}

/** Ring photometry is the better light-curve measure when most core measurements are saturated. */
export function preferRing(s: Spectra, src: SpectraSource): boolean {
  if (!src.wing_flux) return false;
  const core = points(s, src, "core");
  const sat = core.filter((p) => p.flag === FLAG_SATURATED).length;
  const ringOk = points(s, src, "ring").filter((p) => p.flag === FLAG_OK).length;
  const coreOk = core.filter((p) => p.flag === FLAG_OK).length;
  return sat > core.length * 0.5 && ringOk > coreOk;
}

/** Baked source nearest to a data-pixel position at a given date, within maxPx. */
export function nearestSource(s: Spectra, wcs: GridWcs, x: number, y: number, mjd: number, maxPx = 3): SpectraSource | null {
  const yr = mjdToYear(mjd);
  let best: SpectraSource | null = null;
  let bestD = maxPx;
  for (const src of s.sources) {
    const [ra, dec] = propagate(src.ra, src.dec, src.pmra, src.pmdec, src.ref_year, yr);
    const [sx, sy] = worldToPixel(wcs, ra, dec);
    const d = Math.hypot(sx - x, sy - y);
    if (d < bestD) {
      bestD = d;
      best = src;
    }
  }
  return best;
}

/** Robust summary used by tests and the panel: median flux of unflagged points in a wavelength range. */
export function medianFlux(pts: Point[], wlMin: number, wlMax: number): number {
  const v = pts.filter((p) => p.flag === FLAG_OK && p.wl >= wlMin && p.wl < wlMax).map((p) => p.flux).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : 0.5 * (v[m - 1] + v[m]);
}

export function toCsv(src: SpectraSource, pts: Point[]): string {
  const rows = ["mjd,year,visit,detector,wavelength_um,bandwidth_um,flux_mJy,err_mJy,flag"];
  for (const p of pts) {
    rows.push([p.mjd.toFixed(5), mjdToYear(p.mjd).toFixed(4), p.epoch + 1, p.det, p.wl, p.bw ?? "", p.flux, p.err, p.flag].join(","));
  }
  return `# ${src.name}; aperture photometry on single SPHEREx exposures (IRSA DR1+QR3), no aperture correction\n${rows.join("\n")}\n`;
}

/** Wavelengths of reference molecular bands (positions only; not detections). */
export const REFERENCE_BANDS: { label: string; wl: number }[] = [
  { label: "H₂O", wl: 1.4 },
  { label: "H₂O", wl: 1.9 },
  { label: "H₂O", wl: 2.7 },
  { label: "CH₄", wl: 1.65 },
  { label: "CH₄", wl: 2.2 },
  { label: "CH₄", wl: 3.3 },
  { label: "CO₂", wl: 4.27 },
  { label: "CO", wl: 4.67 },
];
