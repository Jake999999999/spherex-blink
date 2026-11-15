// Minimal FITS reader for the browser: HDU headers, a window of rows from an image, and float/int
// columns of a binary table. Reads go through a ByteSource, so the same code works on a dropped File
// (File.slice) and on NASA's public S3 copy (HTTP Range). Uncompressed images only.
//
// Input is untrusted (dropped files, remote headers): every size is checked before it is used.

import { riceDecode } from "./rice";

export interface ByteSource {
  /** total size in bytes, if known */
  size: number | null;
  read(start: number, length: number, signal?: AbortSignal): Promise<ArrayBuffer>;
  label: string;
}

export const BLOCK = 2880;
const MAX_HEADER_BLOCKS = 200; // 576 KB of header cards is far more than any real file needs
const MAX_HDUS = 32;

export type CardValue = string | number | boolean | null;
export type Header = Map<string, CardValue>;

export interface Hdu {
  index: number;
  name: string;
  header: Header;
  dataOffset: number;
  dataBytes: number;
}

export class FitsError extends Error {}

export function fileSource(file: Blob & { name?: string }): ByteSource {
  return {
    size: file.size,
    label: file.name ?? "file",
    async read(start, length) {
      if (start < 0 || start + length > file.size) throw new FitsError(`${file.name ?? "file"}: read past the end`);
      return file.slice(start, start + length).arrayBuffer();
    },
  };
}

export function bufferSource(buf: ArrayBuffer, label = "buffer"): ByteSource {
  return {
    size: buf.byteLength,
    label,
    async read(start, length) {
      if (start < 0 || start + length > buf.byteLength) throw new FitsError(`${label}: read past the end`);
      return buf.slice(start, start + length);
    },
  };
}

/** Parse one 80-character card. Returns null for COMMENT/HISTORY/blank cards. */
export function parseCard(card: string): [string, CardValue] | null {
  const key = card.slice(0, 8).trim();
  if (!key || key === "COMMENT" || key === "HISTORY" || key === "END") return null;
  if (card.slice(8, 10) !== "= ") return null;
  let rest = card.slice(10);
  rest = rest.trimStart();
  if (rest.startsWith("'")) {
    let s = "";
    let i = 1;
    while (i < rest.length) {
      if (rest[i] === "'") {
        if (rest[i + 1] === "'") {
          s += "'";
          i += 2;
          continue;
        }
        break;
      }
      s += rest[i++];
    }
    return [key, s.trimEnd()];
  }
  const v = rest.split("/")[0].trim();
  if (v === "T") return [key, true];
  if (v === "F") return [key, false];
  if (v === "") return [key, null];
  const n = Number(v.replace(/[dD]/, "e"));
  return [key, Number.isFinite(n) ? n : v];
}

export const num = (h: Header, k: string, fallback?: number): number => {
  const v = h.get(k);
  if (typeof v === "number") return v;
  if (fallback !== undefined) return fallback;
  throw new FitsError(`missing number ${k}`);
};

export const str = (h: Header, k: string): string | undefined => {
  const v = h.get(k);
  return typeof v === "string" ? v : undefined;
};

function decodeAscii(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i] < 32 || b[i] > 126 ? 32 : b[i]);
  return s;
}

async function readHeader(src: ByteSource, offset: number, signal?: AbortSignal): Promise<{ header: Header; length: number }> {
  const header: Header = new Map();
  let blocks = 0;
  const chunk = 4; // read 4 blocks at a time
  for (;;) {
    const want = src.size !== null ? Math.min(chunk * BLOCK, src.size - offset - blocks * BLOCK) : chunk * BLOCK;
    if (want < BLOCK) throw new FitsError(`${src.label}: header runs past the end of the file`);
    const text = decodeAscii(await src.read(offset + blocks * BLOCK, want - (want % BLOCK), signal));
    for (let b = 0; b < text.length / BLOCK; b++) {
      for (let c = 0; c < 36; c++) {
        const card = text.slice(b * BLOCK + c * 80, b * BLOCK + (c + 1) * 80);
        if (card.slice(0, 8).trim() === "END") return { header, length: (blocks + b + 1) * BLOCK };
        const kv = parseCard(card);
        if (kv && !header.has(kv[0])) header.set(kv[0], kv[1]);
      }
    }
    blocks += Math.floor(want / BLOCK);
    if (blocks > MAX_HEADER_BLOCKS) throw new FitsError(`${src.label}: no END card`);
  }
}

function dataBytes(h: Header): number {
  const naxis = num(h, "NAXIS", 0);
  if (!Number.isInteger(naxis) || naxis < 0 || naxis > 9) throw new FitsError("bad NAXIS");
  if (naxis === 0) return 0;
  let n = Math.abs(num(h, "BITPIX")) / 8;
  for (let i = 1; i <= naxis; i++) {
    const v = num(h, `NAXIS${i}`);
    if (!Number.isInteger(v) || v < 0) throw new FitsError(`bad NAXIS${i}`);
    n *= v;
  }
  return n + num(h, "PCOUNT", 0);
}

/** Walk every HDU header (no data is read). */
export async function walkHdus(src: ByteSource, signal?: AbortSignal): Promise<Hdu[]> {
  const out: Hdu[] = [];
  let off = 0;
  while (out.length < MAX_HDUS) {
    if (src.size !== null && off + BLOCK > src.size) break;
    let hdr: { header: Header; length: number };
    try {
      hdr = await readHeader(src, off, signal);
    } catch (e) {
      if (out.length) break; // trailing junk after the last HDU
      throw e;
    }
    const h = hdr.header;
    if (out.length === 0 && h.get("SIMPLE") !== true) throw new FitsError(`${src.label}: not a FITS file`);
    const n = dataBytes(h);
    const name = str(h, "EXTNAME") ?? (out.length === 0 ? "PRIMARY" : `HDU${out.length}`);
    out.push({ index: out.length, name: name.trim().toUpperCase(), header: h, dataOffset: off + hdr.length, dataBytes: n });
    off += hdr.length + Math.ceil(n / BLOCK) * BLOCK;
    if (src.size === null) break; // unknown size: the caller asks for what it needs
  }
  return out;
}

export const findHdu = (hdus: Hdu[], name: string) => hdus.find((h) => h.name === name);

export interface ImageWindow {
  data: Float64Array; // [rows, cols], NaN where blank
  x0: number;
  y0: number;
  nx: number;
  ny: number;
}

/**
 * Rows [y0, y1) and columns [x0, x1) of plane `plane` of an uncompressed image HDU, as float64 with
 * BSCALE/BZERO applied (FLAGS int32 files can carry BZERO). FITS axis 1 (x) is the fastest.
 */
export async function readImageWindow(
  src: ByteSource,
  h: Hdu,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  plane = 0,
  signal?: AbortSignal,
): Promise<ImageWindow> {
  const hd = h.header;
  if (hd.get("ZIMAGE") === true) return readCompressedWindow(src, h, x0, x1, y0, y1, plane, signal);
  if (str(hd, "XTENSION") === "BINTABLE") throw new FitsError(`${h.name}: not an image`);
  const bitpix = num(hd, "BITPIX");
  const bpp = Math.abs(bitpix) / 8;
  const nx = num(hd, "NAXIS1");
  const ny = num(hd, "NAXIS2");
  x0 = Math.max(0, Math.floor(x0));
  y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(nx, Math.ceil(x1));
  y1 = Math.min(ny, Math.ceil(y1));
  if (x1 <= x0 || y1 <= y0) return { data: new Float64Array(0), x0, y0, nx: 0, ny: 0 };
  const rowBytes = nx * bpp;
  const start = h.dataOffset + (plane * ny + y0) * rowBytes;
  const len = (y1 - y0) * rowBytes;
  if (start + len > h.dataOffset + h.dataBytes) throw new FitsError(`${h.name}: window outside the data`);
  const buf = await src.read(start, len, signal);
  if (buf.byteLength !== len) throw new FitsError(`${h.name}: short read`);
  const dv = new DataView(buf);
  const bscale = num(hd, "BSCALE", 1);
  let bzero = num(hd, "BZERO", 0);
  // Unsigned 32-bit integers (e.g. bit masks) are stored as int32 with BZERO = 2^31: flip the sign bit
  // instead of adding a float, so every bit survives.
  const unsigned32 = bitpix === 32 && bzero === 2147483648 && bscale === 1;
  if (unsigned32) bzero = 0;
  const blank = hd.get("BLANK");
  const w = x1 - x0;
  const out = new Float64Array(w * (y1 - y0));
  for (let r = 0; r < y1 - y0; r++) {
    for (let c = 0; c < w; c++) {
      const o = r * rowBytes + (x0 + c) * bpp;
      let v: number;
      switch (bitpix) {
        case -32:
          v = dv.getFloat32(o, false);
          break;
        case -64:
          v = dv.getFloat64(o, false);
          break;
        case 32:
          v = unsigned32 ? (dv.getInt32(o, false) ^ 0x80000000) >>> 0 : dv.getInt32(o, false);
          break;
        case 16:
          v = dv.getInt16(o, false);
          break;
        case 8:
          v = dv.getUint8(o);
          break;
        default:
          throw new FitsError(`BITPIX ${bitpix} not supported`);
      }
      if (bitpix > 0 && typeof blank === "number" && v === blank) v = NaN;
      out[r * w + c] = v * bscale + bzero;
    }
  }
  return { data: out, x0, y0, nx: w, ny: y1 - y0 };
}

/**
 * Rows of a tile-compressed image (RICE_1, one row per tile, as in SPHEREx level-2 FLAGS): reads the
 * rows' descriptors, then the heap bytes of just those rows, and decodes them.
 */
async function readCompressedWindow(src: ByteSource, h: Hdu, x0: number, x1: number, y0: number, y1: number, plane: number, signal?: AbortSignal): Promise<ImageWindow> {
  const hd = h.header;
  const cmp = str(hd, "ZCMPTYPE")?.trim();
  if (cmp !== "RICE_1") throw new FitsError(`${h.name}: ${cmp ?? "unknown"} compression not supported`);
  const nx = num(hd, "ZNAXIS1");
  const ny = num(hd, "ZNAXIS2");
  if (num(hd, "ZTILE1", nx) !== nx || num(hd, "ZTILE2", 1) !== 1 || plane !== 0) throw new FitsError(`${h.name}: only row-by-row tiles are supported`);
  if (num(hd, "NAXIS2") !== ny) throw new FitsError(`${h.name}: tile count doesn't match`);
  const zbitpix = num(hd, "ZBITPIX");
  if (zbitpix !== 32 && zbitpix !== 16 && zbitpix !== 8) throw new FitsError(`${h.name}: ZBITPIX ${zbitpix} not supported`);
  // the first column must be COMPRESSED_DATA as a P/Q descriptor; any other column (e.g. GZIP or
  // UNCOMPRESSED_DATA fallbacks, ZSCALE per tile) isn't supported
  if (num(hd, "TFIELDS") !== 1 || (str(hd, "TTYPE1") ?? "").trim().toUpperCase() !== "COMPRESSED_DATA") throw new FitsError(`${h.name}: unsupported compressed layout`);
  const form = (str(hd, "TFORM1") ?? "").trim().toUpperCase();
  const q = /^1?Q/.test(form);
  if (!/^1?[PQ]/.test(form)) throw new FitsError(`${h.name}: bad TFORM1`);
  const rowLen = num(hd, "NAXIS1");
  if (rowLen !== (q ? 16 : 8)) throw new FitsError(`${h.name}: bad descriptor size`);
  let blocksize = 32;
  let bytepix = zbitpix / 8;
  for (let i = 1; i <= 4; i++) {
    const nm = (str(hd, `ZNAME${i}`) ?? "").trim().toUpperCase();
    if (nm === "BLOCKSIZE") blocksize = num(hd, `ZVAL${i}`);
    if (nm === "BYTEPIX") bytepix = num(hd, `ZVAL${i}`);
  }
  x0 = Math.max(0, Math.floor(x0));
  y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(nx, Math.ceil(x1));
  y1 = Math.min(ny, Math.ceil(y1));
  if (x1 <= x0 || y1 <= y0) return { data: new Float64Array(0), x0, y0, nx: 0, ny: 0 };
  const dv = new DataView(await src.read(h.dataOffset + y0 * rowLen, (y1 - y0) * rowLen, signal));
  const desc: [number, number][] = [];
  for (let r = 0; r < y1 - y0; r++) {
    const o = r * rowLen;
    desc.push(q ? [Number(dv.getBigInt64(o, false)), Number(dv.getBigInt64(o + 8, false))] : [dv.getInt32(o, false), dv.getInt32(o + 4, false)]);
  }
  const theap = num(hd, "THEAP", rowLen * ny);
  const heapSize = num(hd, "PCOUNT", 0);
  const lo = Math.min(...desc.map((d) => d[1]));
  const hi = Math.max(...desc.map((d) => d[1] + d[0]));
  if (lo < 0 || hi > heapSize || hi - lo > 64 * 1024 * 1024) throw new FitsError(`${h.name}: bad heap pointers`);
  const heap = new Uint8Array(await src.read(h.dataOffset + theap + lo, hi - lo, signal));
  const bscale = num(hd, "ZSCALE", num(hd, "BSCALE", 1));
  const bzero = num(hd, "ZZERO", num(hd, "BZERO", 0));
  const unsigned32 = zbitpix === 32 && bzero === 2147483648 && bscale === 1;
  const zblank = hd.get("ZBLANK") ?? hd.get("BLANK");
  const w = x1 - x0;
  const out = new Float64Array(w * (y1 - y0));
  desc.forEach(([n, off], r) => {
    const row = riceDecode(heap.subarray(off - lo, off - lo + n), nx, bytepix, blocksize);
    for (let c = 0; c < w; c++) {
      const v = row[x0 + c];
      out[r * w + c] = typeof zblank === "number" && v === zblank ? NaN : unsigned32 ? (v ^ 0x80000000) >>> 0 : v * bscale + bzero;
    }
  });
  return { data: out, x0, y0, nx: w, ny: y1 - y0 };
}

/** Numeric columns of a binary table (scalar E/D/J/I/K/B columns only; others are skipped). */
export async function readTableColumns(src: ByteSource, h: Hdu, want: string[], signal?: AbortSignal): Promise<Record<string, number[]>> {
  const hd = h.header;
  const nrows = num(hd, "NAXIS2");
  const rowLen = num(hd, "NAXIS1");
  const ncol = num(hd, "TFIELDS");
  if (nrows * rowLen > 64 * 1024 * 1024) throw new FitsError(`${h.name}: table too large`);
  const buf = await src.read(h.dataOffset, nrows * rowLen, signal);
  const dv = new DataView(buf);
  const sizes: Record<string, number> = { L: 1, X: 1, B: 1, I: 2, J: 4, K: 8, A: 1, E: 4, D: 8, C: 8, M: 16, P: 8, Q: 16 };
  const out: Record<string, number[]> = {};
  let off = 0;
  for (let i = 1; i <= ncol; i++) {
    const form = (str(hd, `TFORM${i}`) ?? "").trim();
    const m = /^(\d*)([LXBIJKAEDCMPQ])/.exec(form);
    if (!m) throw new FitsError(`bad TFORM${i}`);
    const rep = m[1] === "" ? 1 : Number(m[1]);
    const code = m[2];
    const name = (str(hd, `TTYPE${i}`) ?? "").trim().toUpperCase();
    if (want.includes(name) && rep === 1 && "EDJIKB".includes(code)) {
      const col: number[] = [];
      for (let r = 0; r < nrows; r++) {
        const o = r * rowLen + off;
        col.push(
          code === "E" ? dv.getFloat32(o, false) : code === "D" ? dv.getFloat64(o, false) : code === "J" ? dv.getInt32(o, false) : code === "I" ? dv.getInt16(o, false) : code === "K" ? Number(dv.getBigInt64(o, false)) : dv.getUint8(o),
        );
      }
      out[name] = col;
    }
    off += code === "X" ? Math.ceil(rep / 8) : rep * sizes[code];
  }
  return out;
}
