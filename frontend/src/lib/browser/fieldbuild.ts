// Build a field bundle entirely in the browser, from NASA's S3 copy or from FITS files the person
// dropped. A port of the core of backend bake.py: per exposure, mask the bad FLAGS bits, subtract the
// sky, resample onto a north-up 6.15" grid through the exposure's TAN-SIP WCS, and stack each visit and
// detector with inverse-variance weights. The stacks are accumulated as exposures arrive (nothing is
// kept), and the result is written as the same files a baked target has (meta.json, frames.bin…).
//
// Not done here, and the meta says so: wavelength-matched differences, per-source photometry, WISE,
// NEOWISE and Gaia (those archives can't be reached from a web page).

import type { BandInfo, Epoch, ExposureInfo, Meta } from "../bundle";
import type { CubeDesc } from "../colour";
import { fileSource, FitsError, findHdu, num, readImageWindow, walkHdus, type ByteSource, type Hdu } from "./fitsread";
import { Limiter, s3Source, S3_BASE, type Meter } from "./remote";
import { buildCube } from "./s3cube";
import { bilinear, gridSize, gridWcs, groupEpochs, PIXEL_SCALE_ARCSEC, robustBackground, sourceCoords } from "./resample";
import { tanSip } from "./skywcs";
import type { ExposureRef } from "./exposures";

// frames.BAD_BITS (PLAN.md D13 + S1); SOURCE (21) is deliberately not masked.
export const BAD_BITS = [0, 1, 2, 6, 7, 9, 10, 11, 15, 17, 19, 20, 22, 23, 24, 25, 26, 27, 28];
const BAD_MASK = BAD_BITS.reduce((m, b) => m | (1 << b), 0);
export const FLAG_NAMES: Record<number, string> = { 0: "TRANSIENT", 1: "OVERFLOW", 2: "SUR_ERROR", 6: "NONFUNC", 7: "DICHROIC", 9: "MISSING_DATA", 10: "HOT", 11: "COLD", 15: "NONLINEAR", 17: "PERSIST", 19: "OUTLIER", 20: "CROSSTALK", 22: "GHOST", 23: "GHOST_FPA", 24: "GHOST_EXT", 25: "STREAK", 26: "BLOOM", 27: "SNOWBALL", 28: "HALO" };
const FLAG_BITS = Object.keys(FLAG_NAMES).map(Number);
export const DETECTOR_RANGES: [number, number][] = [[0.74, 1.12], [1.1, 1.65], [1.64, 2.44], [2.42, 3.83], [3.81, 4.43], [4.42, 5.01]];
export const MIN_PER_CELL = 2; // the bake uses 3; quick browser looks fetch fewer exposures
export const MAX_FILES = 400;

export interface Progress {
  phase: "map" | "headers" | "exposures" | "packing";
  done: number;
  total: number;
  bytes: number;
  note?: string;
}

export interface FieldRequest {
  id: string;
  name: string;
  ra: number;
  dec: number;
  fov: number;
  /** S3 exposures, already sampled, with the visit each was sampled for */
  refs?: { ref: ExposureRef; visit: number }[];
  /** FITS files the person dropped (IRSA cutouts or level-2 files) */
  files?: File[];
  withCube: boolean;
  /** the map from an earlier build of the same field (not fetched again) */
  reuseCube?: { desc: CubeDesc; data: Float32Array } | null;
}

export type BundleFiles = Record<string, ArrayBuffer | string>;

interface Item {
  label: string;
  url: string;
  collection: string;
  obsId: string;
  open: () => Promise<ByteSource>;
  detector: number;
  mjd: number | null;
  visit: number;
}

interface Cell {
  sw: Float64Array;
  swv: Float64Array;
  badSum: Float64Array;
  badN: Uint16Array;
  n: number;
  mjds: number[];
  bits: Record<string, number>;
  pixels: number;
}

/** Rows needed per exposure for a field (rotated up to 45°), for the download estimate. */
export const estimateBytesPerExposure = (fovArcmin: number, rowBytes = 2040 * 4) => Math.ceil(((fovArcmin * 60) / PIXEL_SCALE_ARCSEC) * Math.SQRT2 + 6) * rowBytes * 3 + 30_000;

async function imageHeader(src: ByteSource, signal?: AbortSignal): Promise<{ hdus: Hdu[]; im: Hdu }> {
  const hdus = await walkHdus(src, signal);
  const im = findHdu(hdus, "IMAGE");
  if (!im) throw new FitsError(`${src.label}: no IMAGE extension (is it a SPHEREx level-2 image or cutout?)`);
  for (const nm of ["FLAGS", "VARIANCE"]) if (!findHdu(hdus, nm)) throw new FitsError(`${src.label}: no ${nm} extension`);
  return { hdus, im };
}

export async function buildField(req: FieldRequest, onProgress: (p: Progress) => void, signal?: AbortSignal): Promise<BundleFiles> {
  const meter: Meter = { bytes: 0, requests: 0 };
  const limiter = new Limiter(4);
  const n = gridSize(req.fov);
  const grid = gridWcs(req.ra, req.dec, n);
  const nn = n * n;
  const notes: string[] = [];
  const say = (p: Omit<Progress, "bytes">) => onProgress({ ...p, bytes: meter.bytes });

  // ---- the all-sky map (colour), straight from S3
  let cube: { desc: CubeDesc; data: Float32Array } | null = req.reuseCube ?? null;
  let cubeMissing: string | null = null;
  if (req.withCube && !cube) {
    try {
      cube = await buildCube(req.ra, req.dec, req.fov, { limiter, meter, signal, progress: (done, total) => say({ phase: "map", done, total }) });
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      cubeMissing = (e as Error).message;
      notes.push(`The 102-colour map couldn't be read: ${cubeMissing}`);
    }
  }

  // ---- exposures
  const items: Item[] = [];
  for (const { ref, visit } of req.refs ?? [])
    items.push({ label: ref.key.split("/").pop()!, url: S3_BASE + ref.key, collection: ref.collection, obsId: ref.obsId, open: () => s3Source(ref.key, limiter, meter, signal), detector: ref.detector, mjd: ref.mjd, visit });
  for (const f of (req.files ?? []).slice(0, MAX_FILES))
    items.push({ label: f.name, url: `file:${f.name}`, collection: "user-supplied", obsId: f.name, open: async () => fileSource(f), detector: 0, mjd: null, visit: -1 });
  if ((req.files?.length ?? 0) > MAX_FILES) notes.push(`Only the first ${MAX_FILES} files were used.`);

  // dropped files: read DETECTOR and MJD from the headers, then group into visits
  const exposures: ExposureInfo[] = [];
  const needHeaders = items.filter((it) => it.mjd === null || !it.detector);
  let hd = 0;
  await Promise.all(
    needHeaders.map(async (it) => {
      try {
        const { im } = await imageHeader(await it.open(), signal);
        it.detector = num(im.header, "DETECTOR", 0);
        it.mjd = num(im.header, "MJD-AVG", NaN);
      } catch (e) {
        if ((e as Error).name === "AbortError") throw e;
        it.mjd = NaN;
        exposures.push({ collection: it.collection, obs_id: it.obsId, detector: 0, mjd: NaN, url: it.url, used: false, error: (e as Error).message });
      }
      say({ phase: "headers", done: ++hd, total: needHeaders.length });
    }),
  );
  const usable = items.filter((it) => Number.isFinite(it.mjd) && it.detector >= 1 && it.detector <= 6);
  if (usable.some((it) => it.visit < 0)) {
    const groups = groupEpochs(usable.map((it) => it.mjd!));
    groups.forEach((g, v) => g.forEach((i) => (usable[i].visit = v)));
  }
  const visitIds = [...new Set(usable.map((it) => it.visit))].sort((a, b) => a - b);
  const vIndex = new Map(visitIds.map((v, i) => [v, i]));
  const E = visitIds.length;
  const cells: Cell[] = Array.from({ length: E * 6 }, () => ({ sw: new Float64Array(nn), swv: new Float64Array(nn), badSum: new Float64Array(nn), badN: new Uint16Array(nn), n: 0, mjds: [], bits: {}, pixels: 0 }));

  let done = 0;
  const work = new Limiter(4);
  await Promise.all(
    usable.map((it) =>
      work.run(async () => {
        const info: ExposureInfo = { collection: it.collection, obs_id: it.obsId, detector: it.detector, mjd: it.mjd!, url: it.url, used: false };
        exposures.push(info);
        try {
          const src = await it.open();
          const { hdus, im } = await imageHeader(src, signal);
          const proj = tanSip(im.header);
          const nx = num(im.header, "NAXIS1");
          const ny = num(im.header, "NAXIS2");
          const { sx, sy } = sourceCoords(proj, grid);
          let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
          for (let i = 0; i < nn; i++) {
            if (!(sx[i] >= -1 && sx[i] <= nx && sy[i] >= -1 && sy[i] <= ny)) continue;
            x0 = Math.min(x0, sx[i]);
            x1 = Math.max(x1, sx[i]);
            y0 = Math.min(y0, sy[i]);
            y1 = Math.max(y1, sy[i]);
          }
          if (!Number.isFinite(x0)) throw new FitsError("doesn't cover the field");
          const wx0 = Math.max(0, Math.floor(x0) - 2), wx1 = Math.min(nx, Math.ceil(x1) + 3);
          const wy0 = Math.max(0, Math.floor(y0) - 2), wy1 = Math.min(ny, Math.ceil(y1) + 3);
          const fl = findHdu(hdus, "FLAGS")!;
          if (num(fl.header, "BSCALE", 1) !== 1 || ![0, 2147483648].includes(num(fl.header, "BZERO", 0))) throw new FitsError("FLAGS is scaled");
          const zodiH = findHdu(hdus, "ZODI");
          const [img, vari, flags, zodi] = await Promise.all([
            readImageWindow(src, im, wx0, wx1, wy0, wy1, 0, signal),
            readImageWindow(src, findHdu(hdus, "VARIANCE")!, wx0, wx1, wy0, wy1, 0, signal),
            readImageWindow(src, fl, wx0, wx1, wy0, wy1, 0, signal),
            // in a file the ZODI model is read too; over S3 the field is small enough that the sky
            // level removed below takes the zodiacal light with it (saves a quarter of the download)
            zodiH && it.url.startsWith("file:") ? readImageWindow(src, zodiH, wx0, wx1, wy0, wy1, 0, signal) : Promise.resolve(null),
          ]);
          const W = img.nx, H = img.ny;
          const sci = new Float64Array(W * H);
          const good = new Uint8Array(W * H);
          const bad = new Float64Array(W * H);
          const bg: number[] = [];
          const bits: Record<string, number> = {};
          for (let j = 0; j < W * H; j++) {
            const f = flags.data[j];
            const known = Number.isFinite(f);
            const fb = known ? f | 0 : 0; // |0 keeps all 32 bits (values ≥ 2^31 become negative)
            const v = img.data[j] - (zodi ? zodi.data[j] : 0);
            sci[j] = v;
            const isBad = !known || (fb & BAD_MASK) !== 0;
            good[j] = Number.isFinite(v) && Number.isFinite(vari.data[j]) && vari.data[j] > 0 && !isBad ? 1 : 0;
            bad[j] = isBad ? 1 : 0;
            if (fb !== 0) for (const b of FLAG_BITS) if ((fb >>> b) & 1) bits[FLAG_NAMES[b]] = (bits[FLAG_NAMES[b]] ?? 0) + 1;
          }
          // sky level from the pixels around the field only (sx/sy are in full-file pixels)
          const lx = new Float64Array(nn), ly = new Float64Array(nn);
          for (let i = 0; i < nn; i++) {
            lx[i] = sx[i] - wx0;
            ly[i] = sy[i] - wy0;
            const px = Math.round(lx[i]), py = Math.round(ly[i]);
            if (px >= 0 && px < W && py >= 0 && py < H && good[py * W + px]) bg.push(sci[py * W + px]);
          }
          if (bg.length > 20) {
            const b0 = robustBackground(bg);
            for (let j = 0; j < sci.length; j++) sci[j] -= b0;
          }
          const s = bilinear(sci, vari.data, good, W, H, lx, ly);
          const fb = bilinear(bad, null, null, W, H, lx, ly);
          let cov = 0;
          for (let i = 0; i < nn; i++) cov += s.valid[i];
          info.coverage = Math.round((cov / nn) * 1000) / 1000;
          if (cov / nn < 0.05) throw new FitsError("covers less than 5% of the field");
          const c = cells[vIndex.get(it.visit)! * 6 + (it.detector - 1)];
          for (let i = 0; i < nn; i++) {
            if (s.valid[i] && s.variance[i] > 0) {
              const w = 1 / s.variance[i];
              c.sw[i] += w;
              c.swv[i] += w * s.value[i];
            }
            if (fb.valid[i]) {
              c.badSum[i] += fb.value[i];
              c.badN[i]++;
            }
          }
          c.n++;
          c.mjds.push(it.mjd!);
          c.pixels += W * H;
          for (const [k, v] of Object.entries(bits)) c.bits[k] = (c.bits[k] ?? 0) + v;
          info.used = true;
        } catch (e) {
          if ((e as Error).name === "AbortError") throw e;
          info.error = (e as Error).message;
        }
        say({ phase: "exposures", done: ++done, total: usable.length });
      }),
    ),
  );

  say({ phase: "packing", done: 0, total: 1 });
  // ---- visits: keep those with at least one usable detector
  const keep: number[] = [];
  for (let e = 0; e < E; e++) if (cells.slice(e * 6, e * 6 + 6).some((c) => c.n >= MIN_PER_CELL)) keep.push(e);
  const EK = keep.length;
  if (EK === 0 && !cube) throw new FitsError(usable.length ? "No visit had enough usable exposures on any detector." : "No usable SPHEREx exposures (and the map couldn't be read).");
  const planes = EK * 6 * nn;
  const buf = new Float32Array(planes * 2).fill(NaN);
  const flagPct = new Uint8Array(EK * 6 * nn).fill(255);
  const epochs: Epoch[] = [];
  const flagSummary: Record<string, number>[][] = [];
  keep.forEach((e, ei) => {
    const all = cells.slice(e * 6, e * 6 + 6).flatMap((c) => c.mjds);
    const bands: BandInfo[] = [];
    const row: Record<string, number>[] = [];
    for (let d = 1; d <= 6; d++) {
      const c = cells[e * 6 + d - 1];
      const band: BandInfo = { detector: d, n: c.n };
      const sum: Record<string, number> = {};
      if (c.n >= MIN_PER_CELL) {
        const off = (ei * 6 + d - 1) * nn;
        for (let i = 0; i < nn; i++) {
          if (c.sw[i] > 0) {
            buf[off + i] = c.swv[i] / c.sw[i];
            buf[planes + off + i] = 1 / c.sw[i];
          }
          if (c.badN[i]) flagPct[off + i] = Math.min(100, Math.round((c.badSum[i] / c.badN[i]) * 100));
        }
        band.mjd = c.mjds.reduce((a, b) => a + b, 0) / c.n;
        [band.wl_min, band.wl_max] = DETECTOR_RANGES[d - 1];
        for (const [k, v] of Object.entries(c.bits)) if (v / c.pixels >= 0.0005) sum[k] = Math.round((v / c.pixels) * 10000) / 100;
      } else band.missing = true;
      bands.push(band);
      row.push(sum);
    }
    epochs.push({ index: ei, mjd: all.reduce((a, b) => a + b, 0) / all.length, mjd_min: Math.min(...all), mjd_max: Math.max(...all), bands });
    flagSummary.push(row);
  });

  const fromFiles = !!req.files?.length;
  if (EK === 0) notes.push("No time series: only the all-sky map is shown. To blink this spot, add the exposure list (see the panel above the targets).");
  else if (EK === 1) notes.push("Only one visit had enough exposures, so there's nothing to blink against yet.");
  notes.push("Built in your browser. Not included here: wavelength-matched differences (so a difference leaves ~10–15% leftovers of every star), per-star spectra and light curves, the WISE and NEOWISE frames, and Gaia stars. The local server adds those.");
  if (fromFiles) notes.push("Made from files you supplied: unverified, not checked against NASA's archive.");
  else if (EK) notes.push("Zodiacal light is removed as a flat sky level over the field (the field is small enough for that).");

  const defaultBand = epochs.length ? [6, 5, 4, 3, 2, 1].find((d) => epochs.filter((ep) => !ep.bands[d - 1].missing).length >= 2) ?? [1, 2, 3, 4, 5, 6].find((d) => !epochs[0].bands[d - 1].missing) ?? 1 : 1;
  const meta: Meta = {
    id: req.id,
    name: req.name,
    tagline: fromFiles ? "Your files · built in this browser" : "Built in this browser from NASA's S3 copy",
    blurb: fromFiles
      ? "A field built from SPHEREx files you dropped onto the page, processed in your browser."
      : "A field built in your browser from NASA's public copy of the SPHEREx data on Amazon S3: exposures masked, sky-subtracted, resampled and stacked per visit and detector.",
    notes,
    status: EK >= 2 ? "ready" : "conditional",
    default_mode: EK >= 2 ? "blink" : ("colour" as Meta["default_mode"]),
    default_band: defaultBand,
    fov_arcmin: req.fov,
    wcs: grid,
    pixel_scale_arcsec: PIXEL_SCALE_ARCSEC,
    target: { ra: req.ra, dec: req.dec, pmra: 0, pmdec: 0, parallax: null, g: null, ref_year: 2016, source: "field centre (no catalogue motion in browser mode)", pos_now: [req.ra, req.dec], pos_2010: [req.ra, req.dec] },
    detectors: DETECTOR_RANGES.map(([a, b], i) => ({ detector: i + 1, wl_min: a, wl_max: b })),
    epochs,
    wise: [],
    cube: cube ? cube.desc : cubeMissing ? ({ missing: cubeMissing } as unknown as CubeDesc) : null,
    finecube: null,
    flags: EK ? { file: "flags.bin", shape: [EK, 6, n, n], meaning: "percent of the visit's exposures on that detector flagged at the pixel (255 = not covered)", masked_bits: BAD_BITS.map((b) => FLAG_NAMES[b]), summary: flagSummary } : null,
    colour_preset: "spread",
    layout: { dtype: "float32", frames: { offset: 0, shape: [EK, 6, n, n] }, variance: { offset: planes * 4, shape: [EK, 6, n, n] }, wise: { offset: planes * 8, shape: [0, n, n] }, bytes: planes * 8 },
    provenance: {
      label: fromFiles ? "Your files (user-supplied, unverified)" : `NASA S3 copy of SPHEREx, read in this browser`,
      collections: [...new Set(exposures.filter((x) => x.used).map((x) => x.collection))],
      credit: "Data: NASA/JPL-Caltech/IPAC (IRSA). Not a NASA product.",
      dois: { spherex_dr1: "10.26131/IRSA678", spherex_qr3: "10.26131/IRSA662" },
      wise: "not available in browser mode",
      gaia: "not available in browser mode",
      pipeline: "spherex-blink browser builder",
      baked_utc: new Date().toISOString(),
      exposures_found: items.length,
      wise_missing: "not reachable from a web page",
      mask_bits: BAD_BITS,
    },
    exposures: exposures.sort((a, b) => a.mjd - b.mjd || a.detector - b.detector),
  };
  const out: BundleFiles = {
    "meta.json": JSON.stringify(meta),
    "frames.bin": buf.buffer,
    "gaia.json": JSON.stringify({ ref_year: 2016, stars: [] }),
  };
  if (EK) out["flags.bin"] = flagPct.buffer;
  if (cube) out["cube.bin"] = cube.data.slice().buffer as ArrayBuffer; // a copy: the original may be reused
  say({ phase: "packing", done: 1, total: 1, note: `${(meter.bytes / 1e6).toFixed(1)} MB in ${meter.requests} requests` });
  return out;
}

// ---------------------------------------------------------------- in-memory bundles for loadBundle()

const store = new Map<string, BundleFiles>();
export const MEM_PREFIX = "mem:";

export function putMemBundle(id: string, files: BundleFiles) {
  store.set(id, files);
  if (store.size > 6) store.delete(store.keys().next().value!); // keep memory bounded
}

/** A fetch() for "mem:<id>/<file>" that serves the in-memory files (404 for anything else). */
export const memFetch: typeof fetch = (async (input: RequestInfo | URL) => {
  const url = String(input instanceof Request ? input.url : input);
  const m = /^mem:([0-9a-z-]+)\/([a-z.]+)$/.exec(url);
  const body = m ? store.get(m[1])?.[m[2]] : undefined;
  if (body === undefined) return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
  const type = typeof body === "string" ? "application/json" : "application/octet-stream";
  return new Response(body, { status: 200, headers: { "content-type": type } });
}) as typeof fetch;
