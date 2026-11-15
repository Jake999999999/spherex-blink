// Sky -> pixel for the two projections NASA's SPHEREx files use:
//  - TAN-SIP (single exposures): gnomonic + SIP distortion, inverted with the AP/BP polynomials and then
//    refined with Newton steps on the forward A/B polynomials;
//  - HPX (the all-sky spectral map tiles): HEALPix projection, H=4, K=3, with the celestial and native
//    poles aligned (CRVAL 0,0 and LONPOLE 0, checked).
// Pixel coordinates are 0-based (numpy style). Checked against astropy in test/browserdata.test.ts.

import { FitsError, num, str, type Header } from "./fitsread";

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export interface SkyToPixel {
  /** 0-based pixel (x = column, y = row), NaN if the point is not on the projection */
  toPixel(ra: number, dec: number): [number, number];
}

/** Linear part: CD matrix (or PC x CDELT), returned with its inverse. */
function linear(h: Header): { inv: [number, number, number, number]; crpix: [number, number] } {
  let cd: [number, number, number, number];
  if (h.has("CD1_1")) {
    cd = [num(h, "CD1_1", 0), num(h, "CD1_2", 0), num(h, "CD2_1", 0), num(h, "CD2_2", 0)];
  } else {
    const c1 = num(h, "CDELT1", 1);
    const c2 = num(h, "CDELT2", 1);
    cd = [c1 * num(h, "PC1_1", 1), c1 * num(h, "PC1_2", 0), c2 * num(h, "PC2_1", 0), c2 * num(h, "PC2_2", 1)];
  }
  const det = cd[0] * cd[3] - cd[1] * cd[2];
  if (!Number.isFinite(det) || det === 0) throw new FitsError("singular WCS matrix");
  return { inv: [cd[3] / det, -cd[1] / det, -cd[2] / det, cd[0] / det], crpix: [num(h, "CRPIX1"), num(h, "CRPIX2")] };
}

type Poly = { order: number; c: Map<string, number> };

function poly(h: Header, prefix: "A" | "B" | "AP" | "BP"): Poly | null {
  const order = h.get(`${prefix}_ORDER`);
  if (typeof order !== "number" || order < 1 || order > 9) return null;
  const c = new Map<string, number>();
  for (let p = 0; p <= order; p++)
    for (let q = 0; p + q <= order; q++) {
      const v = h.get(`${prefix}_${p}_${q}`);
      if (typeof v === "number" && v !== 0) c.set(`${p}_${q}`, v);
    }
  return { order, c };
}

function evalPoly(P: Poly | null, u: number, v: number): number {
  if (!P) return 0;
  let s = 0;
  for (const [k, c] of P.c) {
    const [p, q] = k.split("_").map(Number);
    s += c * u ** p * v ** q;
  }
  return s;
}

export function tanSip(h: Header): SkyToPixel {
  const ct1 = str(h, "CTYPE1") ?? "";
  const ct2 = str(h, "CTYPE2") ?? "";
  // SIP terms are applied whenever A_ORDER exists, whatever CTYPE says (as astropy does).
  if (!ct1.startsWith("RA---TAN") || !ct2.startsWith("DEC--TAN")) throw new FitsError(`not a TAN image (${ct1})`);
  const lonpole = num(h, "LONPOLE", 180);
  if (lonpole !== 180) throw new FitsError("TAN with LONPOLE other than 180 is not supported");
  const { inv, crpix } = linear(h);
  const a0 = num(h, "CRVAL1") * D2R;
  const d0 = num(h, "CRVAL2") * D2R;
  const A = poly(h, "A");
  const B = poly(h, "B");
  const AP = poly(h, "AP");
  const BP = poly(h, "BP");
  const sinD0 = Math.sin(d0);
  const cosD0 = Math.cos(d0);
  return {
    toPixel(ra, dec) {
      const a = ra * D2R;
      const d = dec * D2R;
      const cosc = sinD0 * Math.sin(d) + cosD0 * Math.cos(d) * Math.cos(a - a0);
      if (cosc <= 0) return [NaN, NaN];
      const x = ((Math.cos(d) * Math.sin(a - a0)) / cosc) * R2D;
      const y = ((cosD0 * Math.sin(d) - sinD0 * Math.cos(d) * Math.cos(a - a0)) / cosc) * R2D;
      const U = inv[0] * x + inv[1] * y;
      const V = inv[2] * x + inv[3] * y;
      let u = U + evalPoly(AP, U, V);
      let v = V + evalPoly(BP, U, V);
      if (A || B) {
        // Newton: solve u + A(u,v) = U, v + B(u,v) = V
        // (from the AP/BP guess, or from scratch when a file has no inverse polynomials)
        for (let it = 0; it < (AP || BP ? 4 : 10); it++) {
          const fu = u + evalPoly(A, u, v) - U;
          const fv = v + evalPoly(B, u, v) - V;
          if (Math.abs(fu) < 1e-5 && Math.abs(fv) < 1e-5) break;
          const e = 1e-3;
          const j11 = 1 + (evalPoly(A, u + e, v) - evalPoly(A, u - e, v)) / (2 * e);
          const j12 = (evalPoly(A, u, v + e) - evalPoly(A, u, v - e)) / (2 * e);
          const j21 = (evalPoly(B, u + e, v) - evalPoly(B, u - e, v)) / (2 * e);
          const j22 = 1 + (evalPoly(B, u, v + e) - evalPoly(B, u, v - e)) / (2 * e);
          const det = j11 * j22 - j12 * j21;
          if (!det) break;
          u -= (j22 * fu - j12 * fv) / det;
          v -= (-j21 * fu + j11 * fv) / det;
        }
      }
      return [u + crpix[0] - 1, v + crpix[1] - 1];
    },
  };
}

export function hpx(h: Header): SkyToPixel {
  const ct1 = str(h, "CTYPE1") ?? "";
  if (!ct1.startsWith("RA---HPX")) throw new FitsError(`not an HPX image (${ct1})`);
  if (num(h, "CRVAL1", 0) !== 0 || num(h, "CRVAL2", 0) !== 0 || num(h, "LONPOLE", 0) !== 0) throw new FitsError("HPX with a rotated pole is not supported");
  const H = num(h, "PV2_1", 4);
  const K = num(h, "PV2_2", 3);
  const { inv, crpix } = linear(h);
  const nx = num(h, "NAXIS1");
  const ny = num(h, "NAXIS2");
  const sinX = (K - 1) / K;
  const omega = K % 2 === 1 ? 1 : null;
  const project = (phi: number, theta: number): [number, number] => {
    const s = Math.sin(theta * D2R);
    if (Math.abs(s) <= sinX) return [phi, ((90 * K) / H) * s];
    const sigma = Math.sqrt(K * (1 - Math.abs(s)));
    const w = omega ?? (theta > 0 ? 1 : 0);
    const phic = -180 + (2 * Math.floor(((phi + 180) * H) / 360 + (1 - w) / 2) + w) * (180 / H);
    return [phic + (phi - phic) * sigma, Math.sign(theta) * (180 / H) * ((K + 1) / 2 - sigma)];
  };
  const toPix = (x: number, y: number): [number, number] => [inv[0] * x + inv[1] * y + crpix[0] - 1, inv[2] * x + inv[3] * y + crpix[1] - 1];
  return {
    toPixel(ra, dec) {
      const phi0 = ((((ra + 180) % 360) + 360) % 360) - 180;
      let best: [number, number] = [NaN, NaN];
      // a tile on the ±180° seam may sit on either side of the plane
      for (const phi of [phi0, phi0 + 360, phi0 - 360]) {
        const [x, y] = project(phi, dec);
        const p = toPix(x, y);
        if (p[0] >= -2 && p[0] <= nx + 1 && p[1] >= -2 && p[1] <= ny + 1) return p;
        if (Number.isNaN(best[0])) best = p;
      }
      return best;
    },
  };
}

export function skyToPixel(h: Header): SkyToPixel {
  const ct = str(h, "CTYPE1") ?? "";
  if (ct.startsWith("RA---HPX")) return hpx(h);
  return tanSip(h);
}
