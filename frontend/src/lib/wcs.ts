// Gnomonic (TAN) projection for the baked north-up grids. Pixel coords are 0-based array indices
// (x = column, y = row; row 0 is the south edge), matching numpy and the FITS crpix - 1.
import type { GridWcs } from "./bundle";

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export function worldToPixel(w: GridWcs, ra: number, dec: number): [number, number] {
  const a0 = w.crval[0] * D2R;
  const d0 = w.crval[1] * D2R;
  const a = ra * D2R;
  const d = dec * D2R;
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a - a0);
  const xi = (Math.cos(d) * Math.sin(a - a0)) / cosc; // radians, east positive
  const eta = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a - a0)) / cosc;
  const x = (xi * R2D) / w.cdelt[0] + w.crpix[0] - 1;
  const y = (eta * R2D) / w.cdelt[1] + w.crpix[1] - 1;
  return [x, y];
}

export function pixelToWorld(w: GridWcs, x: number, y: number): [number, number] {
  const xi = (x - (w.crpix[0] - 1)) * w.cdelt[0] * D2R;
  const eta = (y - (w.crpix[1] - 1)) * w.cdelt[1] * D2R;
  const a0 = w.crval[0] * D2R;
  const d0 = w.crval[1] * D2R;
  const denom = Math.cos(d0) - eta * Math.sin(d0);
  const a = a0 + Math.atan2(xi, denom);
  const d = Math.atan2(Math.sin(d0) + eta * Math.cos(d0), Math.hypot(xi, denom));
  return [(((a * R2D) % 360) + 360) % 360, d * R2D];
}

/** Angular separation in arcseconds. */
export function separationArcsec(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const s =
    Math.sin(((dec2 - dec1) * D2R) / 2) ** 2 +
    Math.cos(dec1 * D2R) * Math.cos(dec2 * D2R) * Math.sin(((ra2 - ra1) * D2R) / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(s))) * R2D * 3600;
}

export function formatRa(ra: number): string {
  const h = (((ra % 360) + 360) % 360) / 15;
  const hh = Math.floor(h);
  const m = (h - hh) * 60;
  const mm = Math.floor(m);
  const ss = (m - mm) * 60;
  return `${pad(hh)}:${pad(mm)}:${ss.toFixed(2).padStart(5, "0")}`;
}

export function formatDec(dec: number): string {
  const sign = dec < 0 ? "−" : "+";
  const a = Math.abs(dec);
  const dd = Math.floor(a);
  const m = (a - dd) * 60;
  const mm = Math.floor(m);
  const ss = (m - mm) * 60;
  return `${sign}${pad(dd)}:${pad(mm)}:${ss.toFixed(1).padStart(4, "0")}`;
}

const pad = (n: number) => String(n).padStart(2, "0");
