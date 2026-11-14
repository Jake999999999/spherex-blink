// Time and proper motion helpers (same formulas as backend/spherex_blink/gaia.py).

const MJD_J2000 = 51544.5;
const DAYS_PER_YEAR = 365.25;
const MJD_UNIX_EPOCH = 40587;

export const mjdToYear = (mjd: number) => 2000 + (mjd - MJD_J2000) / DAYS_PER_YEAR;
export const yearToMjd = (y: number) => MJD_J2000 + (y - 2000) * DAYS_PER_YEAR;

export function mjdToDate(mjd: number): Date {
  return new Date((mjd - MJD_UNIX_EPOCH) * 86400000);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatMjdMonth(mjd: number): string {
  const d = mjdToDate(mjd);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function formatMjdRange(a: number, b: number): string {
  const da = mjdToDate(a);
  const db = mjdToDate(b);
  if (da.getUTCFullYear() === db.getUTCFullYear() && da.getUTCMonth() === db.getUTCMonth()) return formatMjdMonth(a);
  if (da.getUTCFullYear() === db.getUTCFullYear()) return `${MONTHS[da.getUTCMonth()]}–${MONTHS[db.getUTCMonth()]} ${db.getUTCFullYear()}`;
  return `${formatMjdMonth(a)} – ${formatMjdMonth(b)}`;
}

/** Proper-motion propagation; pmra includes cos(dec), mas/yr. Parallax ignored. */
export function propagate(ra: number, dec: number, pmra: number, pmdec: number, fromYear: number, toYear: number): [number, number] {
  const dt = toYear - fromYear;
  const xi = ((pmra * dt) / 3.6e6) * (Math.PI / 180);
  const eta = ((pmdec * dt) / 3.6e6) * (Math.PI / 180);
  const a0 = (ra * Math.PI) / 180;
  const d0 = (dec * Math.PI) / 180;
  const denom = Math.cos(d0) - eta * Math.sin(d0);
  const a = a0 + Math.atan2(xi, denom);
  const d = Math.atan2(Math.sin(d0) + eta * Math.cos(d0), Math.hypot(xi, denom));
  return [((((a * 180) / Math.PI) % 360) + 360) % 360, (d * 180) / Math.PI];
}
