// RICE_1 decompression (the cfitsio algorithm, fits_rdecomp), for tile-compressed FITS images.
// SPHEREx level-2 files store FLAGS this way, one image row per tile. Arithmetic is done with plain
// numbers (no 32-bit bit operations) so buffers wider than 32 bits can't overflow.

const pow2 = (n: number) => 2 ** n;

/** Decode one RICE_1 tile of `nx` pixels. bytepix: 1, 2 or 4; nblock: ZVAL1 (usually 32). */
export function riceDecode(input: Uint8Array, nx: number, bytepix: number, nblock = 32): Int32Array {
  const [fsbits, fsmax, bbits] = bytepix === 1 ? [3, 6, 8] : bytepix === 2 ? [4, 14, 16] : bytepix === 4 ? [5, 25, 32] : [0, 0, 0];
  if (!fsbits) throw new Error(`RICE: bytepix ${bytepix} not supported`);
  const out = new Int32Array(nx);
  let pos = 0;
  const next = () => {
    if (pos >= input.length) throw new Error("RICE: ran out of data");
    return input[pos++];
  };
  // first pixel, uncompressed
  let lastpix = 0;
  for (let k = 0; k < bytepix; k++) lastpix = lastpix * 256 + next();
  if (bytepix === 4) lastpix = lastpix | 0;
  else if (bytepix === 2) lastpix = (lastpix << 16) >> 16;
  else lastpix = (lastpix << 24) >> 24;
  const wrap = (v: number) => (bytepix === 4 ? v | 0 : bytepix === 2 ? (v << 16) >> 16 : (v << 24) >> 24);

  let b = next();
  let nbits = 8;
  for (let i = 0; i < nx; ) {
    nbits -= fsbits;
    while (nbits < 0) {
      b = b * 256 + next();
      nbits += 8;
    }
    const fs = Math.floor(b / pow2(nbits)) - 1;
    b = b % pow2(nbits);
    const imax = Math.min(i + nblock, nx);
    if (fs < 0) {
      for (; i < imax; i++) out[i] = lastpix;
    } else if (fs === fsmax) {
      // high entropy: raw bbits-bit differences
      for (; i < imax; i++) {
        let k = bbits - nbits;
        let diff = b * pow2(k);
        for (k -= 8; k >= 0; k -= 8) {
          b = next();
          diff += b * pow2(k);
        }
        if (nbits > 0) {
          b = next();
          diff += Math.floor(b / pow2(-k));
          b = b % pow2(nbits);
        } else b = 0;
        const d = diff % 2 === 0 ? diff / 2 : -Math.floor(diff / 2) - 1;
        out[i] = lastpix = wrap(d + lastpix);
      }
    } else {
      for (; i < imax; i++) {
        while (b === 0) {
          nbits += 8;
          b = next();
        }
        const nz = Math.floor(Math.log2(b)) + 1; // significant bits of b
        const nzero = nbits - nz;
        nbits -= nzero + 1;
        b -= pow2(nbits); // clear the leading 1
        nbits -= fs;
        while (nbits < 0) {
          b = b * 256 + next();
          nbits += 8;
        }
        const diff = nzero * pow2(fs) + Math.floor(b / pow2(nbits));
        b = b % pow2(nbits);
        const d = diff % 2 === 0 ? diff / 2 : -Math.floor(diff / 2) - 1;
        out[i] = lastpix = wrap(d + lastpix);
      }
    }
  }
  return out;
}
