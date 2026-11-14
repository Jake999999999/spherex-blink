// Baked target bundles: public/benchmarks/<id>/{meta.json, frames.bin, gaia.json}. See backend/spherex_blink/bake.py.

export interface GridWcs {
  ctype: [string, string];
  crval: [number, number];
  crpix: [number, number]; // FITS 1-based
  cdelt: [number, number]; // deg/px
  naxis: [number, number];
}

export interface BandInfo {
  detector: number;
  n: number;
  missing?: boolean;
  mjd?: number;
  wl_min?: number;
  wl_max?: number;
}

export interface Epoch {
  index: number;
  mjd: number;
  mjd_min: number;
  mjd_max: number;
  bands: BandInfo[];
}

export interface WiseFrame {
  band: "W1" | "W2";
  wavelength_um: number;
  mjd: number;
  mjd_min: number;
  mjd_max: number;
  source_url: string;
  coverage: number;
}

export interface TargetMotion {
  ra: number;
  dec: number;
  pmra: number;
  pmdec: number;
  parallax: number | null;
  g: number | null;
  ref_year: number;
  source: string;
  pos_now: [number, number];
  pos_2010: [number, number];
}

export interface ExposureInfo {
  collection: string;
  obs_id: string;
  detector: number;
  mjd: number;
  url: string;
  used: boolean;
  wavelength_um?: number | null;
  coverage?: number;
  error?: string;
}

export interface Meta {
  id: string;
  name: string;
  blurb: string;
  notes: string[];
  status: "ready" | "conditional";
  default_mode: "blink" | "diff";
  default_band: number;
  fov_arcmin: number;
  wcs: GridWcs;
  pixel_scale_arcsec: number;
  target: TargetMotion;
  detectors: { detector: number; wl_min: number; wl_max: number }[];
  epochs: Epoch[];
  wise: WiseFrame[];
  layout: {
    dtype: "float32";
    frames: { offset: number; shape: [number, number, number, number] };
    variance: { offset: number; shape: [number, number, number, number] };
    wise: { offset: number; shape: [number, number, number] };
    bytes: number;
  };
  provenance: {
    label: string;
    collections: string[];
    credit: string;
    dois: Record<string, string>;
    wise: string;
    gaia: string;
    pipeline: string;
    baked_utc: string;
    exposures_found: number;
    mask_bits: number[];
  };
  exposures: ExposureInfo[];
}

export interface GaiaStar {
  source_id: string;
  ra: number;
  dec: number;
  pmra: number;
  pmdec: number;
  parallax: number | null;
  g: number | null;
}

export interface IndexEntry {
  id: string;
  name: string;
  status: "ready" | "conditional";
}

export interface Bundle {
  meta: Meta;
  data: Float32Array; // whole frames.bin
  gaia: { ref_year: number; stars: GaiaStar[] };
  width: number;
  height: number;
}

export const BENCH_ROOT = "./benchmarks";

export async function loadIndex(fetchFn: typeof fetch = fetch): Promise<IndexEntry[]> {
  const r = await fetchFn(`${BENCH_ROOT}/index.json`);
  if (!r.ok) throw new Error(`index.json: HTTP ${r.status}`);
  return (await r.json()).targets as IndexEntry[];
}

export function parseBundle(meta: Meta, buf: ArrayBuffer, gaia: Bundle["gaia"]): Bundle {
  if (buf.byteLength !== meta.layout.bytes) {
    throw new Error(`frames.bin is ${buf.byteLength} bytes, meta says ${meta.layout.bytes}`);
  }
  const [, , h, w] = meta.layout.frames.shape;
  return { meta, data: new Float32Array(buf), gaia, width: w, height: h };
}

export async function loadBundle(id: string, fetchFn: typeof fetch = fetch): Promise<Bundle> {
  const base = `${BENCH_ROOT}/${id}`;
  const [m, b, g] = await Promise.all([
    fetchFn(`${base}/meta.json`),
    fetchFn(`${base}/frames.bin`),
    fetchFn(`${base}/gaia.json`),
  ]);
  for (const r of [m, b, g]) if (!r.ok) throw new Error(`${r.url}: HTTP ${r.status}`);
  return parseBundle(await m.json(), await b.arrayBuffer(), await g.json());
}

const planeSize = (b: Bundle) => b.width * b.height;

/** Stacked SPHEREx frame for an epoch and detector (1..6). */
export function framePlane(b: Bundle, epoch: number, detector: number): Float32Array {
  const n = planeSize(b);
  const start = b.meta.layout.frames.offset / 4 + (epoch * 6 + (detector - 1)) * n;
  return b.data.subarray(start, start + n);
}

export function variancePlane(b: Bundle, epoch: number, detector: number): Float32Array {
  const n = planeSize(b);
  const start = b.meta.layout.variance.offset / 4 + (epoch * 6 + (detector - 1)) * n;
  return b.data.subarray(start, start + n);
}

export function wisePlane(b: Bundle, i: number): Float32Array {
  const n = planeSize(b);
  const start = b.meta.layout.wise.offset / 4 + i * n;
  return b.data.subarray(start, start + n);
}

export function bandAvailable(b: Bundle, epoch: number, detector: number): boolean {
  const info = b.meta.epochs[epoch]?.bands[detector - 1];
  return !!info && !info.missing;
}

/** WISE frame that best matches a SPHEREx detector: W1 (3.4 µm) for D1–D4, W2 (4.6 µm) for D5–D6. */
export function wiseForDetector(b: Bundle, detector: number): number {
  const want = detector >= 5 ? "W2" : "W1";
  const i = b.meta.wise.findIndex((w) => w.band === want);
  return i >= 0 ? i : b.meta.wise.length ? 0 : -1;
}
