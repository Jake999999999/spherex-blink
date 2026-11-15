// Baked target bundles: public/benchmarks/<id>/{meta.json, frames.bin, gaia.json, spectra.json}. See backend/spherex_blink/bake.py.
import type { Spectra } from "./spectra";
import { parseCube, type Cube, type CubeDesc } from "./colour";

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
  tagline?: string;
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
  cube?: CubeDesc | null;
  /** S2: our own 6.15" 102-channel map from the single exposures */
  finecube?: (CubeDesc & { dtype?: string }) | null;
  neowise?: { file: string | null; shape: [number, number, number]; frames: { band: "W1" | "W2"; wavelength_um: number; mjd: number; mjd_min: number; mjd_max: number; n: number }[]; missing: string | null; credit: string } | null;
  flags?: { file: string; shape: [number, number, number, number]; meaning: string; masked_bits: string[]; summary: Record<string, number>[][] } | null;
  colour_preset?: string;
  colour_hint?: string;
  variable?: boolean;
  layout: {
    dtype: "float32";
    frames: { offset: number; shape: [number, number, number, number] };
    variance: { offset: number; shape: [number, number, number, number] };
    wise: { offset: number; shape: [number, number, number] };
    /** S2: wavelength-matched frames (each visit minus the all-visit map, channel by channel) */
    matched?: { offset: number; shape: [number, number, number, number] };
    matched_variance?: { offset: number; shape: [number, number, number, number] };
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
    wise_missing?: string | null;
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
  tagline?: string;
  status: "ready" | "conditional";
  /** where the bundle lives (default: the built-in benchmarks folder); live fields come from the local server */
  base?: string;
  live?: { ra: number; dec: number; fov: number };
}

/** "Pulsating red giant (Gaia DR3 …)" -> "Pulsating red giant" for compact labels. */
export const shortName = (name: string) => name.replace(/\s*\(.*\)\s*$/, "");

export interface Bundle {
  meta: Meta;
  data: Float32Array; // whole frames.bin
  gaia: { ref_year: number; stars: GaiaStar[] };
  spectra: Spectra | null; // per-exposure photometry (M2 bundles)
  cube: Cube | null; // 102-channel all-sky map window (M5 bundles)
  finecube: Cube | null; // our 6.15" map (S2 bundles)
  flags: Uint8Array | null; // % of exposures flagged per pixel [E,6,H,W]; 255 = not covered
  neowise: Float32Array | null; // NEOWISE yearly frames [N,H,W] (DN), 2014-2024
  width: number;
  height: number;
}

export const BENCH_ROOT = "./benchmarks";

export async function loadIndex(fetchFn: typeof fetch = fetch): Promise<IndexEntry[]> {
  const r = await fetchFn(`${BENCH_ROOT}/index.json`);
  if (!r.ok) throw new Error(`index.json: HTTP ${r.status}`);
  return (await r.json()).targets as IndexEntry[];
}

export function parseBundle(
  meta: Meta,
  buf: ArrayBuffer,
  gaia: Bundle["gaia"],
  spectra: Spectra | null = null,
  cube: Cube | null = null,
  finecube: Cube | null = null,
): Bundle {
  if (buf.byteLength !== meta.layout.bytes) {
    throw new Error(`frames.bin is ${buf.byteLength} bytes, meta says ${meta.layout.bytes}`);
  }
  const [, , h, w] = meta.layout.frames.shape;
  return { meta, data: new Float32Array(buf), gaia, spectra, cube, finecube, flags: null, neowise: null, width: w, height: h };
}

const isJson = (r: Response | null) => !!r && r.ok && (r.headers.get("content-type") ?? "").includes("json");
// Vite's dev server answers a missing file with index.html (200, text/html), so check the type.
const isBinary = (r: Response | null) => !!r && r.ok && !(r.headers.get("content-type") ?? "").includes("html");

export async function loadBundle(id: string, fetchFn: typeof fetch = fetch, baseOverride?: string): Promise<Bundle> {
  const base = baseOverride ?? `${BENCH_ROOT}/${id}`;
  const [m, b, g, s] = await Promise.all([
    fetchFn(`${base}/meta.json`),
    fetchFn(`${base}/frames.bin`),
    fetchFn(`${base}/gaia.json`),
    fetchFn(`${base}/spectra.json`).catch(() => null),
  ]);
  for (const r of [m, b, g]) if (!r.ok) throw new Error(`${r.url}: HTTP ${r.status}`);
  const meta = (await m.json()) as Meta;
  const spectra = isJson(s) ? ((await s!.json()) as Spectra) : null;
  let cube: Cube | null = null;
  if (meta.cube?.file) {
    const c = await fetchFn(`${base}/${meta.cube.file}`).catch(() => null);
    if (isBinary(c)) cube = parseCube(meta.cube, await c!.arrayBuffer());
  }
  let finecube: Cube | null = null;
  if (meta.finecube?.file) {
    const f = await fetchFn(`${base}/${meta.finecube.file}`).catch(() => null);
    if (isBinary(f)) {
      const raw = await f!.arrayBuffer();
      const asF32 = meta.finecube.dtype === "float16" ? float16ToFloat32(new Uint16Array(raw)).buffer : raw;
      finecube = parseCube(meta.finecube, asF32 as ArrayBuffer);
    }
  }
  const bundle = parseBundle(meta, await b.arrayBuffer(), await g.json(), spectra, cube, finecube);
  if (meta.flags?.file) {
    const fl = await fetchFn(`${base}/${meta.flags.file}`).catch(() => null);
    if (isBinary(fl)) {
      const arr = new Uint8Array(await fl!.arrayBuffer());
      if (arr.length === meta.flags.shape.reduce((a, b) => a * b, 1)) bundle.flags = arr;
    }
  }
  if (meta.neowise?.file) {
    const nw = await fetchFn(`${base}/${meta.neowise.file}`).catch(() => null);
    if (isBinary(nw)) {
      const arr = float16ToFloat32(new Uint16Array(await nw!.arrayBuffer()));
      if (arr.length === meta.neowise.shape.reduce((a, b) => a * b, 1)) bundle.neowise = arr;
    }
  }
  return bundle;
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

/** IEEE half floats (little-endian, as numpy writes them) -> float32. */
export function float16ToFloat32(h: Uint16Array): Float32Array {
  const out = new Float32Array(h.length);
  for (let i = 0; i < h.length; i++) {
    const v = h[i];
    const s = v & 0x8000 ? -1 : 1;
    const e = (v >> 10) & 0x1f;
    const f = v & 0x3ff;
    out[i] = e === 0 ? s * 2 ** -14 * (f / 1024) : e === 31 ? (f ? NaN : s * Infinity) : s * 2 ** (e - 15) * (1 + f / 1024);
  }
  return out;
}

/** Wavelength-matched frame (S2) for a visit and detector, or null for bundles baked before S2. */
export function matchedPlane(b: Bundle, epoch: number, detector: number): Float32Array | null {
  const m = b.meta.layout.matched;
  if (!m) return null;
  const n = b.width * b.height;
  const start = m.offset / 4 + (epoch * 6 + (detector - 1)) * n;
  return b.data.subarray(start, start + n);
}

/** % of a visit's exposures flagged at each pixel, for one detector (255 = not covered). */
export function flagPlane(b: Bundle, epoch: number, detector: number): Uint8Array | null {
  if (!b.flags) return null;
  const n = b.width * b.height;
  const start = (epoch * 6 + (detector - 1)) * n;
  return b.flags.subarray(start, start + n);
}

export function neowisePlane(b: Bundle, i: number): Float32Array {
  const n = b.width * b.height;
  return b.neowise!.subarray(i * n, (i + 1) * n);
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
