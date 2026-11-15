// The 102-channel all-sky map at any position, read straight from NASA's S3 copy: a port of
// backend cube.bake_cube. The tile is found with HEALPix (no server), its headers and the field's rows of
// each channel are read with HTTP Range, and the window is resampled onto a north-up grid.

import type { CubeDesc } from "../colour";
import { FitsError, findHdu, num, readImageWindow, readTableColumns, walkHdus } from "./fitsread";
import { fieldTiles, tileKey } from "./healpix";
import { cubeReleases, s3Source, type Limiter, type Meter } from "./remote";
import { bilinear, gridSize, gridWcs, sourceCoords } from "./resample";
import { hpx } from "./skywcs";

export const CUBE_SCALE_ARCSEC = 12.3;

export interface CubeResult {
  desc: CubeDesc;
  data: Float32Array;
}

export async function buildCube(
  ra: number,
  dec: number,
  fovArcmin: number,
  ctx: { limiter: Limiter; meter: Meter; signal?: AbortSignal; progress?: (done: number, total: number) => void },
): Promise<CubeResult> {
  const releases = await cubeReleases(ctx.signal);
  if (!releases.length) throw new FitsError("no map release in the bucket");
  const n = gridSize(fovArcmin, CUBE_SCALE_ARCSEC);
  const grid = gridWcs(ra, dec, n, CUBE_SCALE_ARCSEC);
  const tiles = fieldTiles(ra, dec, (fovArcmin / 60) * 0.75);
  let out: Float32Array | null = null;
  let chans: Record<string, number[]> | null = null;
  let nchan = 0;
  const used: string[] = [];
  let release = "";
  const span = [Infinity, -Infinity];
  let done = 0;
  for (const npix of tiles) {
    // newest release first; fall back if a folder is half uploaded (no such tile yet)
    let src = null;
    for (const r of releases.slice(0, 3)) {
      try {
        src = await s3Source(tileKey(npix, r), ctx.limiter, ctx.meter, ctx.signal);
        release = release || r;
        break;
      } catch (e) {
        if ((e as Error).name === "AbortError") throw e;
      }
    }
    if (!src) continue;
    const hdus = await walkHdus(src, ctx.signal);
    const im = findHdu(hdus, "IMAGE");
    if (!im) throw new FitsError("map tile has no IMAGE");
    const prim = hdus[0].header;
    if (prim.has("MJD-BEG")) {
      span[0] = Math.min(span[0], num(prim, "MJD-BEG"));
      span[1] = Math.max(span[1], num(prim, "MJD-END"));
    }
    nchan = num(im.header, "NAXIS3", 1);
    const nx = num(im.header, "NAXIS1");
    const ny = num(im.header, "NAXIS2");
    const { sx, sy } = sourceCoords(hpx(im.header), grid);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < sx.length; i++) {
      if (sx[i] < -1 || sx[i] > nx || sy[i] < -1 || sy[i] > ny || !Number.isFinite(sx[i])) continue;
      x0 = Math.min(x0, sx[i]);
      x1 = Math.max(x1, sx[i]);
      y0 = Math.min(y0, sy[i]);
      y1 = Math.max(y1, sy[i]);
    }
    if (!Number.isFinite(x0)) continue;
    const wx0 = Math.max(0, Math.floor(x0) - 2);
    const wx1 = Math.min(nx, Math.ceil(x1) + 3);
    const wy0 = Math.max(0, Math.floor(y0) - 2);
    const wy1 = Math.min(ny, Math.ceil(y1) + 3);
    if (!chans) {
      const t = findHdu(hdus, "SPECTRAL_CHANNELS");
      if (!t) throw new FitsError("map tile has no SPECTRAL_CHANNELS table");
      chans = await readTableColumns(src, t, ["WAVELENGTH", "WL_MIN", "WL_MAX", "BANDWIDTH", "DETECTOR"], ctx.signal);
      out = new Float32Array(nchan * n * n).fill(NaN);
    }
    const lx = new Float64Array(sx.length);
    const ly = new Float64Array(sy.length);
    for (let i = 0; i < sx.length; i++) {
      lx[i] = sx[i] - wx0;
      ly[i] = sy[i] - wy0;
    }
    const total = tiles.length * nchan;
    await Promise.all(
      Array.from({ length: nchan }, async (_, k) => {
        // unobserved map pixels are NaN in IMAGE (checked against NHITS), so NHITS isn't needed
        const w = await readImageWindow(src!, im, wx0, wx1, wy0, wy1, k, ctx.signal);
        const good = new Uint8Array(w.data.length);
        for (let i = 0; i < good.length; i++) good[i] = Number.isFinite(w.data[i]) ? 1 : 0;
        const s = bilinear(w.data, null, good, w.nx, w.ny, lx, ly);
        const plane = out!.subarray(k * n * n, (k + 1) * n * n);
        for (let i = 0; i < plane.length; i++) if (s.valid[i] && Number.isNaN(plane[i])) plane[i] = s.value[i];
        ctx.progress?.(++done, total);
      }),
    );
    used.push(src.label);
  }
  if (!out || !chans) throw new FitsError(`no map tile covers ${ra.toFixed(4)}, ${dec.toFixed(4)}`);
  const blank: number[] = [];
  for (let k = 0; k < nchan; k++) {
    const p = out.subarray(k * n * n, (k + 1) * n * n);
    if (!p.some(Number.isFinite)) blank.push(k);
  }
  const r5 = (a?: number[]) => (a ? a.map((x) => Math.round(x * 1e5) / 1e5) : null);
  const desc: CubeDesc = {
    wcs: grid,
    pixel_scale_arcsec: CUBE_SCALE_ARCSEC,
    native_scale_arcsec: 12.88,
    release,
    tiles: used,
    mjd_min: Number.isFinite(span[0]) ? span[0] : null,
    mjd_max: Number.isFinite(span[1]) ? span[1] : null,
    units: "MJy/sr",
    channels: { wavelength: r5(chans.WAVELENGTH) ?? [], wl_min: r5(chans.WL_MIN), wl_max: r5(chans.WL_MAX), bandwidth: r5(chans.BANDWIDTH), detector: chans.DETECTOR ?? null },
    blank,
    note: "SPHEREx all-sky spectral map, read in your browser from NASA's public S3 copy: each channel is the average of every visit up to the release, so different channels at one spot come from different dates.",
    file: "cube.bin",
    shape: [nchan, n, n],
  };
  return { desc, data: out };
}
