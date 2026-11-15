import { describe, expect, test } from "bun:test";
import fx from "./fixtures/browser-wcs.json";
import { bufferSource, parseCard, readImageWindow, walkHdus, type Header } from "../src/lib/browser/fitsread";
import { skyToPixel } from "../src/lib/browser/skywcs";
import { ang2pixNest, NSIDE } from "../src/lib/browser/healpix";

const headerOf = (cards: string[]): Header => {
  const h: Header = new Map();
  for (const c of cards) {
    const kv = parseCard(c.padEnd(80));
    if (kv && !h.has(kv[0])) h.set(kv[0], kv[1]);
  }
  return h;
};

describe("sky -> pixel matches astropy", () => {
  test("TAN-SIP single exposures (< 0.01 px)", () => {
    expect(fx.exposures.length).toBeGreaterThan(0);
    for (const c of fx.exposures) {
      const p = skyToPixel(headerOf(c.cards));
      c.world.forEach(([ra, dec], i) => {
        const [x, y] = p.toPixel(ra, dec);
        expect(Math.abs(x - c.pixel[i][0])).toBeLessThan(0.01);
        expect(Math.abs(y - c.pixel[i][1])).toBeLessThan(0.01);
      });
    }
  });

  test("HPX map tiles: equatorial, polar facets and the RA = 0 seam (< 0.01 px)", () => {
    expect(fx.tiles.length).toBe(4);
    for (const c of fx.tiles) {
      const p = skyToPixel(headerOf(c.cards));
      c.world.forEach(([ra, dec], i) => {
        const [x, y] = p.toPixel(ra, dec);
        expect(Math.abs(x - c.pixel[i][0])).toBeLessThan(0.01);
        expect(Math.abs(y - c.pixel[i][1])).toBeLessThan(0.01);
      });
    }
  });
});

test("HEALPix nested tiles match the Python port", () => {
  for (const [ra, dec, npix] of fx.healpix) expect(ang2pixNest(NSIDE, ra, dec)).toBe(npix);
});

// ---------------------------------------------------------------- FITS reading

function card(k: string, v: string | number | boolean) {
  const val = typeof v === "string" ? `'${v.padEnd(8)}'` : typeof v === "boolean" ? (v ? "T" : "F").padStart(20) : String(v).padStart(20);
  return `${k.padEnd(8)}= ${val}`.padEnd(80);
}
function header(cards: string[]) {
  let s = [...cards, "END".padEnd(80)].join("");
  s = s.padEnd(Math.ceil(s.length / 2880) * 2880);
  return new TextEncoder().encode(s);
}

test("reads windows, BSCALE/BZERO and unsigned 32-bit masks", async () => {
  const prim = header([card("SIMPLE", true), card("BITPIX", 8), card("NAXIS", 0), card("EXTEND", true)]);
  const imgH = header([card("XTENSION", "IMAGE"), card("BITPIX", -32), card("NAXIS", 2), card("NAXIS1", 4), card("NAXIS2", 3), card("PCOUNT", 0), card("GCOUNT", 1), card("EXTNAME", "IMAGE")]);
  const img = new DataView(new ArrayBuffer(2880));
  for (let i = 0; i < 12; i++) img.setFloat32(i * 4, i + 0.5, false);
  const flH = header([card("XTENSION", "IMAGE"), card("BITPIX", 32), card("NAXIS", 2), card("NAXIS1", 4), card("NAXIS2", 3), card("PCOUNT", 0), card("GCOUNT", 1), card("BZERO", 2147483648), card("EXTNAME", "FLAGS")]);
  const fl = new DataView(new ArrayBuffer(2880));
  const vals = [0, 1, 2 ** 21, 2 ** 31 + 5];
  for (let i = 0; i < 12; i++) fl.setInt32(i * 4, (vals[i % 4] - 2147483648) | 0, false);
  const parts = [prim, imgH, new Uint8Array(img.buffer), flH, new Uint8Array(fl.buffer)];
  const all = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  const src = bufferSource(all.buffer);
  const hdus = await walkHdus(src);
  expect(hdus.map((h) => h.name)).toEqual(["PRIMARY", "IMAGE", "FLAGS"]);
  const w = await readImageWindow(src, hdus[1], 1, 3, 1, 3);
  expect([w.nx, w.ny]).toEqual([2, 2]);
  expect(Array.from(w.data)).toEqual([5.5, 6.5, 9.5, 10.5]);
  const f = await readImageWindow(src, hdus[2], 0, 4, 0, 1);
  expect(Array.from(f.data)).toEqual(vals);
});

test("rejects things that are not FITS", async () => {
  const junk = new TextEncoder().encode("<html>not fits</html>".padEnd(2880));
  await expect(walkHdus(bufferSource(junk.buffer))).rejects.toThrow();
});

// ---------------------------------------------------------------- whole builder vs the Python pipeline
import stackFx from "./fixtures/browser-stack.json";
import { buildField } from "../src/lib/browser/fieldbuild";
import { parseExposureList, sampleByVisit } from "../src/lib/browser/exposures";
import { safeKey } from "../src/lib/browser/remote";

/** Same formula as backend/scripts/make_browser_fixtures.py synth(). */
function synth(i: number, ny: number, nx: number) {
  const n = nx * ny;
  const img = new Float32Array(n), fl = new Int32Array(n), vr = new Float32Array(n), zd = new Float32Array(n);
  for (let y = 0; y < ny; y++)
    for (let x = 0; x < nx; x++) {
      const j = y * nx + x;
      const spike = (x * 31 + y * 17 + i * 7) % 23 === 0 ? 50 + ((x + y) % 7) * 10 : 0;
      const z = 2 + 0.01 * x;
      zd[j] = z;
      img[j] = x === 40 && y === 40 ? NaN : 10 + z + spike;
      vr[j] = 1 + 0.1 * ((x * 7 + y * 3 + i) % 10);
      fl[j] = ((x * 13 + y * 7 + i) % 37 === 0 ? 1 : 0) | ((x + y) % 5 === 0 ? 1 << 21 : 0) | ((x * 3 + y * 11 + i) % 53 === 0 ? 1 << 28 : 0);
    }
  return { IMAGE: img, FLAGS: fl, VARIANCE: vr, ZODI: zd };
}

function fitsFile(primary: string[], hdus: ([string[], Float32Array | Int32Array] | Uint8Array<ArrayBuffer>)[], name: string): File {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  const hdr = (cards: string[]) => {
    let s = cards.map((c) => c.padEnd(80)).join("");
    if (!cards.some((c) => c.trimEnd() === "END")) s += "END".padEnd(80); // astropy's cards already end with END
    return new TextEncoder().encode(s.padEnd(Math.ceil(s.length / 2880) * 2880)) as Uint8Array<ArrayBuffer>;
  };
  parts.push(hdr(primary));
  for (const h of hdus) {
    if (h instanceof Uint8Array) {
      parts.push(h); // a complete HDU written by astropy (e.g. RICE-compressed FLAGS)
      continue;
    }
    const [cards, data] = h;
    parts.push(hdr(cards));
    const b = new DataView(new ArrayBuffer(Math.ceil((data.length * 4) / 2880) * 2880));
    data.forEach((v, k) => (data instanceof Float32Array ? b.setFloat32(k * 4, v, false) : b.setInt32(k * 4, v, false)));
    parts.push(new Uint8Array(b.buffer));
  }
  return new File(parts, name);
}

test("browser builder matches the Python pipeline on synthetic exposures", async () => {
  const fx2 = stackFx;
  const [ny, nx] = fx2.shape;
  const files = fx2.exposures.map((e, i) => {
    const d = synth(i, ny, nx);
    const names = ["IMAGE", "FLAGS", "VARIANCE", "ZODI"] as const;
    const raw = (e as { raw?: Record<string, string> }).raw ?? {};
    return fitsFile(
      e.primary,
      names.map((nm) => (raw[nm] ? (Uint8Array.from(atob(raw[nm]), (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>) : ([e.cards[nm], d[nm]] as [string[], Float32Array | Int32Array]))),
      `synth${i}.fits`,
    );
  });
  const out = await buildField({ id: "t", name: "t", ra: fx2.ra, dec: fx2.dec, fov: fx2.fov, files, withCube: false }, () => {});
  const meta = JSON.parse(out["meta.json"] as string);
  expect(meta.epochs.length).toBe(2);
  expect(meta.exposures.every((x: { used: boolean }) => x.used)).toBe(true);
  const nn = fx2.npix * fx2.npix;
  const frames = new Float32Array(out["frames.bin"] as ArrayBuffer);
  const flags = new Uint8Array(out["flags.bin"] as ArrayBuffer);
  const planes = 2 * 6 * nn;
  let compared = 0;
  fx2.visits.forEach((v, e) => {
    const off = (e * 6 + 2) * nn; // detector 3
    for (let i = 0; i < nn; i++) {
      const want = v.mean[i];
      const got = frames[off + i];
      if (want === null) expect(Number.isNaN(got)).toBe(true);
      else {
        expect(Math.abs(got - want)).toBeLessThan(1e-3);
        expect(Math.abs(frames[planes + off + i] - v.variance[i]!)).toBeLessThan(1e-4);
        compared++;
      }
      expect(Math.abs(flags[off + i] - v.flag_pct[i])).toBeLessThanOrEqual(1);
    }
  });
  expect(compared).toBeGreaterThan(nn); // most pixels of both visits
  expect(fx2.exposures.filter((e) => (e as { raw?: Record<string, string> }).raw?.FLAGS).length).toBe(2); // RICE path covered
});

test("RICE_1 decoding matches astropy's compressed FLAGS", async () => {
  const e = stackFx.exposures[1] as { raw: Record<string, string> };
  const [ny, nx] = stackFx.shape;
  const bytes = Uint8Array.from(atob(e.raw.FLAGS), (c) => c.charCodeAt(0));
  const prim = header([card("SIMPLE", true), card("BITPIX", 8), card("NAXIS", 0), card("EXTEND", true)]);
  const all = new Uint8Array(prim.length + bytes.length);
  all.set(prim);
  all.set(bytes, prim.length);
  const src = bufferSource(all.buffer);
  const hdus = await walkHdus(src);
  const w = await readImageWindow(src, hdus[1], 5, 60, 10, 50);
  const want = synth(1, ny, nx).FLAGS;
  for (let r = 0; r < w.ny; r++) for (let c = 0; c < w.nx; c++) expect(w.data[r * w.nx + c]).toBe(want[(10 + r) * nx + 5 + c]);
});

describe("exposure lists", () => {
  const key = "dr1/level2/2025W19_1B/l2b-v27-2026-197/3/level2_2025W19_1B_0116_1D3_spx_l2b-v27-2026-197.fits";
  test("VOTable rows give S3 keys, times and detectors", () => {
    const vo = `<?xml version="1.0"?><VOTABLE version="1.4"><RESOURCE><TABLE>
      <FIELD name="t_min" datatype="double"/><FIELD name="t_max" datatype="double"/><FIELD name="dataproduct_subtype" datatype="char"/><FIELD name="access_url" datatype="char"/><FIELD name="cloud_access" datatype="char"/>
      <DATA><TABLEDATA>
      <TR><TD>60800.70</TD><TD>60800.71</TD><TD>science</TD><TD>https://irsa.ipac.caltech.edu/ibe/data/spherex/${key}</TD><TD>{&quot;aws&quot;: {&quot;key&quot;:&quot;${key}&quot;}}</TD></TR>
      <TR><TD>60800.70</TD><TD>60800.71</TD><TD>science</TD><TD>https://evil.example/x.fits</TD><TD/></TR>
      </TABLEDATA></DATA></TABLE></RESOURCE></VOTABLE>`;
    const l = parseExposureList(vo);
    expect(l.format).toBe("VOTable");
    expect(l.refs).toHaveLength(1);
    expect(l.refs[0]).toMatchObject({ key, detector: 3, collection: "spherex_dr1" });
    expect(l.refs[0].mjd).toBeCloseTo(60800.705, 6);
    expect(l.skipped).toBe(1);
  });
  test("pasted IRSA links work; anything else is refused", () => {
    expect(parseExposureList(`https://irsa.ipac.caltech.edu/ibe/data/spherex/${key}\nhttps://evil.example/a.fits`).refs.map((r) => r.key)).toEqual([key]);
    expect(safeKey(key)).toBe(key);
    const retry = "dr1/level2/2025W46_1A/l2b_retry-v27-2026-207/6/level2_2025W46_1A_0090_1D6_spx_l2b_retry-v27-2026-207.fits";
    expect(safeKey(retry)).toBe(retry); // IRSA re-runs live in l2b_retry-* folders
    for (const bad of ["dr1/level2/../../x.fits", "dr1/level2/2025W19_1B/l2b-v27-2026-197/3/level2_%2e.fits", `${key}?x=1`, "other/bucket.fits"]) expect(safeKey(bad)).toBeNull();
  });
  test("visit sampling keeps every detector of each chosen visit", () => {
    const refs = [];
    for (let v = 0; v < 6; v++) for (let d = 1; d <= 6; d++) for (let k = 0; k < 5; k++) refs.push({ key: `k${v}${d}${k}`, detector: d, mjd: 60800 + v * 180 + k * 0.5, obsId: "", collection: "spherex_dr1" });
    const s = sampleByVisit(refs, 3, 4);
    expect(s.visits).toBe(4);
    expect(s.refs).toHaveLength(4 * 6 * 3);
    expect(new Set(s.refs.map((r) => s.visitOf.get(r.key))).size).toBe(4);
  });
  test("links without times are kept (capped) for the builder to date from headers", () => {
    const refs = Array.from({ length: 300 }, (_, k) => ({ key: `u${k}`, detector: (k % 6) + 1, mjd: null, obsId: "", collection: "spherex_dr1" }));
    const s = sampleByVisit(refs, 3, 4);
    expect(s.visits).toBe(0);
    expect(s.refs).toHaveLength(72);
    expect(s.refs.every((r) => !s.visitOf.has(r.key))).toBe(true);
  });
});
