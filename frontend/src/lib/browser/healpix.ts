// HEALPix nested pixel index: a port of backend cube.ang2pix_nest (itself the HEALPix C library
// algorithm), used to find which all-sky map tile holds a position without asking any server.

const spread = (v: number): number => {
  let out = 0;
  for (let b = 0; b < 16; b++) out += ((v >> b) & 1) * 2 ** (2 * b);
  return out;
};

export function ang2pixNest(nside: number, raDeg: number, decDeg: number): number {
  const z = Math.sin((decDeg * Math.PI) / 180);
  const za = Math.abs(z);
  const tt = ((((((raDeg % 360) + 360) % 360) * Math.PI) / 180 / (0.5 * Math.PI)) % 4 + 4) % 4;
  let face: number;
  let ix: number;
  let iy: number;
  if (za <= 2 / 3) {
    const t1 = nside * (0.5 + tt);
    const t2 = nside * z * 0.75;
    const jp = Math.floor(t1 - t2);
    const jm = Math.floor(t1 + t2);
    const ifp = Math.floor(jp / nside);
    const ifm = Math.floor(jm / nside);
    face = ifp === ifm ? ifp | 4 : ifp < ifm ? ifp : ifm + 8;
    ix = jm & (nside - 1);
    iy = nside - (jp & (nside - 1)) - 1;
  } else {
    const ntt = Math.min(3, Math.floor(tt));
    const tp = tt - ntt;
    const tmp = nside * Math.sqrt(3 * (1 - za));
    const jp = Math.min(Math.floor(tp * tmp), nside - 1);
    const jm = Math.min(Math.floor((1 - tp) * tmp), nside - 1);
    if (z >= 0) {
      face = ntt;
      ix = nside - jm - 1;
      iy = nside - jp - 1;
    } else {
      face = ntt + 8;
      ix = jp;
      iy = jm;
    }
  }
  return face * nside * nside + spread(ix) + 2 * spread(iy);
}

export const ORDER = 5;
export const NSIDE = 2 ** ORDER;

export const tileKey = (npix: number, release: string) =>
  `dr1/hips5_cube/${release}/Norder${ORDER}/Dir${Math.floor(npix / 10000) * 10000}/Npix${npix}_cube.fits`;

/** Tiles touched by a square field: centre, corners and edge midpoints. */
export function fieldTiles(ra: number, dec: number, halfDeg: number): number[] {
  const out = new Set<number>();
  const cosd = Math.max(1e-6, Math.cos((dec * Math.PI) / 180));
  for (const fy of [-1, 0, 1])
    for (const fx of [-1, 0, 1]) {
      const d = Math.max(-90, Math.min(90, dec + fy * halfDeg));
      out.add(ang2pixNest(NSIDE, ra + (fx * halfDeg) / cosd, d));
    }
  return [...out].sort((a, b) => a - b);
}
