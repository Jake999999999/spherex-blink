// Per-exposure photometry baked by backend bake.measure_spectra: spectra.json.
import { mjdToYear, propagate } from "./astro";
import type { ExposureInfo, GridWcs } from "./bundle";
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
  // S6: forced fit of SPHEREx's official ePSF (bundles re-measured after 2026-11-15)
  psf_flux?: (number | null)[];
  psf_err?: (number | null)[];
  psf_flag?: number[];
  psf_chi2?: (number | null)[];
}

/** psf: ePSF fit (best where available); core: aperture sum; ring: around a saturated core */
export type Measure = "psf" | "core" | "ring";

/** The PSF fit when it measured at least half as many points as the aperture (it skips saturated cores). */
export function defaultMeasure(src: SpectraSource): Measure {
  if (!src.psf_flux) return "core";
  const n = (a: (number | null)[]) => a.filter((v) => v !== null && v !== undefined).length;
  return n(src.psf_flux) >= 0.5 * n(src.flux) ? "psf" : "core";
}

export const MEASURE_NOTES: Record<Measure, string> = {
  psf: "Fit of SPHEREx's official PSF at the star's Gaia position (neighbours fitted too), local sky subtracted. Against 2MASS (27 stars) and WISE (9): median within 3%, star-to-star scatter about 1–4%.",
  core: "15.4″ aperture, local sky subtracted, no aperture correction. Against 2MASS (28 stars) and WISE (9): median within 3%, star-to-star scatter about 3–7%.",
  ring: "Ring around a saturated core: tracks brightness over time; the ring holds a different share of the light at each wavelength, so compare dates within one detector only.",
};

export interface Spectra {
  units: "mJy";
  aperture_arcsec: number;
  sky_annulus_arcsec: [number, number];
  note: string;
  flags: Record<string, string>;
  wing_arcsec?: [number, number];
  wing_note?: string;
  /** S3: measured on constant field stars; single-exposure errors are multiplied by scale[detector] */
  error_model?: {
    scale: Record<string, number>;
    psf_scale?: Record<string, number>;
    /** noise scale and flux-proportional floor per method and detector (preferred when present) */
    model?: Partial<Record<"core" | "psf", Record<string, { scale: number; floor: number }>>>;
    absolute_floor: number | null;
    note: string;
  };
  psf?: { method: string; orientation: string; units: string };
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
  obs_id?: string;
  url?: string;
}

export type FluxUnit = "mjy" | "abmag" | "nufnu";

export const FLUX_UNIT_LABELS: Record<FluxUnit, string> = {
  mjy: "mJy",
  abmag: "AB mag",
  nufnu: "λF_λ (10⁻¹⁴ W m⁻²)",
};

/** Attach IRSA obs_id and FITS URL to each photometric point by matching detector and nearest MJD. */
export function attachExposureMeta(pts: Point[], exposures?: ExposureInfo[]): Point[] {
  if (!exposures?.length) return pts;
  const byDet = new Map<number, ExposureInfo[]>();
  for (const ex of exposures) {
    if (ex.used === false) continue;
    const list = byDet.get(ex.detector) ?? [];
    list.push(ex);
    byDet.set(ex.detector, list);
  }
  return pts.map((p) => {
    const cands = byDet.get(p.det);
    if (!cands?.length) return p;
    let best: ExposureInfo | null = null;
    let bestDt = 1e-4;
    for (const c of cands) {
      const dt = Math.abs(c.mjd - p.mjd);
      if (dt < bestDt) {
        bestDt = dt;
        best = c;
      }
    }
    return best ? { ...p, obs_id: best.obs_id, url: best.url } : p;
  });
}

/**
 * Convert a flux measurement (in mJy) to the requested display unit and flag < 3σ points as upper limits.
 * In AB mag, upper limits correspond to the 3σ faintness floor (downward arrow = fainter than m_3σ).
 */
export function convertFlux(
  fluxMjy: number,
  errMjy: number,
  wlUm: number,
  unit: FluxUnit,
): { value: number; err: number; upperLimit: boolean } | null {
  const upperLimit = errMjy > 0 && fluxMjy < 3 * errMjy;
  if (unit === "mjy") {
    return {
      value: upperLimit ? Math.max(0, fluxMjy) + 3 * errMjy : fluxMjy,
      err: upperLimit ? 0 : errMjy,
      upperLimit,
    };
  }
  if (unit === "nufnu") {
    if (!(wlUm > 0)) return null;
    // νF_ν = λF_λ = (c / λ) F_ν; 1 mJy = 1e-29 W m^-2 Hz^-1, c/1um = 2.99792458e14 Hz -> 0.299792458e-14 W m^-2
    const k = 0.299792458 / wlUm;
    return {
      value: (upperLimit ? Math.max(0, fluxMjy) + 3 * errMjy : fluxMjy) * k,
      err: upperLimit ? 0 : errMjy * k,
      upperLimit,
    };
  }
  // AB mag: m_AB = 16.4 - 2.5 * log10(F_mJy) (since 3631 Jy = 3.631e6 mJy)
  const ref = upperLimit ? 3 * errMjy : fluxMjy;
  if (!(ref > 0)) return null;
  return {
    value: 16.4 - 2.5 * Math.log10(ref),
    err: upperLimit ? 0 : (2.5 / Math.LN10) * (errMjy / fluxMjy),
    upperLimit,
  };
}

export function points(s: Spectra, src: SpectraSource, measure?: Measure): Point[] {
  const out: Point[] = [];
  const e = s.exposures;
  const m = measure ?? defaultMeasure(src);
  const ring = m === "ring" && !!src.wing_flux;
  const psf = m === "psf" && !!src.psf_flux;
  for (let i = 0; i < e.mjd.length; i++) {
    const f = ring ? src.wing_flux![i] : psf ? src.psf_flux![i] : src.flux[i];
    const w = src.wl[i];
    if (f === null || f === undefined || w === null) continue;
    let flag = ring ? (src.wing_flag?.[i] ?? 0) : psf ? (src.psf_flag?.[i] ?? 0) : src.flag[i];
    // The ring tolerates a few masked (e.g. nonlinear) pixels and scales for them; only saturation in the ring counts against it.
    if (ring && flag === FLAG_BAD_PIXEL) flag = FLAG_OK;
    const raw = ring ? (src.wing_err?.[i] ?? 0) : psf ? (src.psf_err?.[i] ?? 0) : (src.err[i] ?? 0);
    // honest error bars (S3): stated errors were too small by a factor measured per detector and method
    const det = String(e.det[i]);
    const model = ring ? undefined : s.error_model?.model?.[psf ? "psf" : "core"]?.[det];
    let err: number;
    if (model) err = Math.hypot(raw * Math.max(1, model.scale), model.floor * Math.abs(f));
    else err = raw * Math.max(1, (psf ? s.error_model?.psf_scale?.[det] : s.error_model?.scale[det]) ?? 1);
    out.push({ i, mjd: e.mjd[i], wl: w, bw: src.bw[i], flux: f, err, flag, det: e.det[i], epoch: e.epoch[i] });
  }
  return out;
}

/** Ring photometry is the better light-curve measure when most core measurements are saturated. */
export function preferRing(s: Spectra, src: SpectraSource): boolean {
  if (!src.wing_flux) return false;
  const core = points(s, src, defaultMeasure(src));
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

export function toCsv(src: SpectraSource, pts: Point[], measure: Measure = defaultMeasure(src)): string {
  const rows = ["mjd,year,visit,detector,wavelength_um,bandwidth_um,flux_mJy,err_mJy,flag,obs_id"];
  for (const p of pts) {
    rows.push([p.mjd.toFixed(5), mjdToYear(p.mjd).toFixed(4), p.epoch + 1, p.det, p.wl, p.bw ?? "", p.flux, p.err, p.flag, p.obs_id ?? ""].join(","));
  }
  return `# ${src.name}; single SPHEREx exposures (IRSA DR1+QR3). ${MEASURE_NOTES[measure]}\n${rows.join("\n")}\n`;
}

/** Wavelengths of reference molecular bands (positions only; not detections). */
export const REFERENCE_BANDS: { label: string; wl: number }[] = [
  { label: "H₂O", wl: 1.15 },
  { label: "H₂O", wl: 1.4 },
  { label: "H₂O", wl: 1.9 },
  { label: "H₂O", wl: 2.7 },
  { label: "CH₄", wl: 1.65 },
  { label: "CH₄", wl: 2.2 },
  { label: "CH₄", wl: 3.3 },
  { label: "CO₂", wl: 4.27 },
  { label: "CO", wl: 4.67 },
];

/** Key rest-frame atomic, molecular, PAH, and ice features for redshift-aware inspection. */
export const SPECTRAL_LINES: { label: string; wl: number; kind: "ice" | "gas" | "pah" }[] = [
  { label: "Hα", wl: 0.6563, kind: "gas" },
  { label: "Paβ", wl: 1.2822, kind: "gas" },
  { label: "Paα", wl: 1.8756, kind: "gas" },
  { label: "H₂ S(1)", wl: 2.1218, kind: "gas" },
  { label: "Brγ", wl: 2.1661, kind: "gas" },
  { label: "H₂O ice", wl: 3.05, kind: "ice" },
  { label: "PAH", wl: 3.29, kind: "pah" },
  { label: "CH₄", wl: 3.30, kind: "ice" },
  { label: "Brα", wl: 4.0523, kind: "gas" },
  { label: "CO₂ ice", wl: 4.27, kind: "ice" },
  { label: "CO ice", wl: 4.67, kind: "ice" },
];

const HC_KB_UM_K = 14387.77;

/** Relative Planck spectral radiance F_nu(lambda, T) up to an overall scale factor. */
export function planckNu(wlUm: number, tempK: number): number {
  const x = HC_KB_UM_K / (wlUm * Math.max(100, tempK));
  if (x > 700) return 0;
  return 1 / (wlUm ** 3 * Math.expm1(x));
}

/** Fit a Planck blackbody temperature (K) + scaled curve (mJy) to positive unflagged points. */
export function fitBlackbody(pts: { wl: number; flux: number; flag?: number }[]): { tempK: number; curve: { wl: number; flux: number }[] } | null {
  const clean = pts.filter((p) => (p.flag ?? FLAG_OK) === FLAG_OK && Number.isFinite(p.flux) && p.flux > 0 && p.wl > 0);
  if (clean.length < 4) return null;
  let bestT = 3000;
  let bestErr = Infinity;
  const score = (T: number) => {
    const ratios = clean.map((p) => p.flux / Math.max(1e-30, planckNu(p.wl, T))).sort((a, b) => a - b);
    const scale = ratios[ratios.length >> 1];
    let err = 0;
    for (const p of clean) {
      const pred = scale * planckNu(p.wl, T);
      const d = Math.log(p.flux) - Math.log(Math.max(1e-30, pred));
      err += d * d;
    }
    return { err, scale };
  };
  for (let T = 300; T <= 12000; T = Math.round(T * 1.15)) {
    const { err } = score(T);
    if (err < bestErr) {
      bestErr = err;
      bestT = T;
    }
  }
  const lo = Math.max(250, Math.round(bestT * 0.8));
  const hi = Math.min(15000, Math.round(bestT * 1.25));
  for (let T = lo; T <= hi; T += Math.max(25, Math.round((hi - lo) / 20))) {
    const { err } = score(T);
    if (err < bestErr) {
      bestErr = err;
      bestT = T;
    }
  }
  const { scale } = score(bestT);
  const curve: { wl: number; flux: number }[] = [];
  for (let wl = 0.75; wl <= 5.02; wl += 0.08) {
    curve.push({ wl, flux: scale * planckNu(wl, bestT) });
  }
  return { tempK: bestT, curve };
}

export interface CataloguePoint {
  band: string;
  wl: number;
  flux: number; // mJy
  source: "2MASS" | "AllWISE";
}

const VEGA_ZP_JY: Record<string, { wl: number; zp: number; source: "2MASS" | "AllWISE" }> = {
  J: { wl: 1.235, zp: 1594, source: "2MASS" },
  H: { wl: 1.662, zp: 1024, source: "2MASS" },
  Ks: { wl: 2.159, zp: 666.7, source: "2MASS" },
  W1: { wl: 3.35, zp: 309.54, source: "AllWISE" },
  W2: { wl: 4.6, zp: 171.79, source: "AllWISE" },
};

/** Fetch nearest 2MASS & AllWISE fluxes (mJy) via CDS VizieR TAP for calibration overlay. */
export async function fetchCataloguePhotometry(ra: number, dec: number, fetchFn: typeof fetch = fetch): Promise<CataloguePoint[]> {
  const tap = "https://tapvizier.cds.unistra.fr/TAPVizieR/tap/sync";
  const rDeg = 5 / 3600;
  const query = async (sql: string) => {
    const url = `${tap}?REQUEST=doQuery&LANG=ADQL&FORMAT=csv&QUERY=${encodeURIComponent(sql)}`;
    const r = await fetchFn(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`VizieR HTTP ${r.status}`);
    const lines = (await r.text()).trim().split(/\r?\n/);
    if (lines.length < 2) return null;
    const cols = lines[0].split(",");
    const vals = lines[1].split(",");
    return Object.fromEntries(cols.map((c, i) => [c.trim(), vals[i]?.trim() ?? ""]));
  };
  const out: CataloguePoint[] = [];
  const [tm, aw] = await Promise.allSettled([
    query(`SELECT TOP 1 Jmag,Hmag,Kmag FROM "II/246/out" WHERE 1=CONTAINS(POINT('ICRS',RAJ2000,DEJ2000),CIRCLE('ICRS',${ra},${dec},${rDeg}))`),
    query(`SELECT TOP 1 W1mag,W2mag FROM "II/328/allwise" WHERE 1=CONTAINS(POINT('ICRS',RAJ2000,DEJ2000),CIRCLE('ICRS',${ra},${dec},${rDeg}))`),
  ]);
  const add = (band: string, magStr?: string) => {
    const m = Number(magStr);
    if (!magStr || !Number.isFinite(m)) return;
    const spec = VEGA_ZP_JY[band];
    out.push({ band, wl: spec.wl, flux: spec.zp * 1000 * 10 ** (-0.4 * m), source: spec.source });
  };
  if (tm.status === "fulfilled" && tm.value) {
    add("J", tm.value.Jmag);
    add("H", tm.value.Hmag);
    add("Ks", tm.value.Kmag);
  }
  if (aw.status === "fulfilled" && aw.value) {
    add("W1", aw.value.W1mag);
    add("W2", aw.value.W2mag);
  }
  return out;
}
