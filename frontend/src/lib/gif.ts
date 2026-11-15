/** Minimal zero-dependency GIF89a animated encoder (6x6x6 + 40-gray uniform 256-color palette). */

export interface GifFrame {
  rgba: Uint8ClampedArray;
  delayCs: number; // centiseconds (e.g. 50 = 0.5s)
}

function buildPalette(): Uint8Array {
  const pal = new Uint8Array(256 * 3);
  let idx = 0;
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        pal[idx++] = Math.round((r * 255) / 5);
        pal[idx++] = Math.round((g * 255) / 5);
        pal[idx++] = Math.round((b * 255) / 5);
      }
    }
  }
  for (let i = 0; i < 40; i++) {
    const v = Math.round((i * 255) / 39);
    pal[idx++] = v;
    pal[idx++] = v;
    pal[idx++] = v;
  }
  return pal;
}

function quantize(rgba: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const n = w * h;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    if (Math.abs(r - g) < 8 && Math.abs(g - b) < 8) {
      out[i] = 216 + Math.round(((r + g + b) / 3 / 255) * 39);
    } else {
      out[i] = Math.round((r / 255) * 5) * 36 + Math.round((g / 255) * 5) * 6 + Math.round((b / 255) * 5);
    }
  }
  return out;
}

function lzwEncode(indices: Uint8Array, minCodeSize = 8): number[] {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  const dict = new Map<string, number>();
  const reset = () => {
    dict.clear();
    codeSize = minCodeSize + 1;
    nextCode = eoiCode + 1;
  };

  const bytes: number[] = [];
  let bitBuf = 0;
  let bitCount = 0;
  const emit = (code: number) => {
    bitBuf |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      bytes.push(bitBuf & 0xff);
      bitBuf >>= 8;
      bitCount -= 8;
    }
  };

  emit(clearCode);
  let prefix = String.fromCharCode(indices[0]);
  for (let i = 1; i < indices.length; i++) {
    const ch = String.fromCharCode(indices[i]);
    const key = prefix + ch;
    if (dict.has(key)) {
      prefix = key;
    } else {
      emit(prefix.length === 1 ? prefix.charCodeAt(0) : dict.get(prefix)!);
      if (nextCode < 4096) {
        dict.set(key, nextCode++);
        if (nextCode > 1 << codeSize && codeSize < 12) codeSize++;
      } else {
        emit(clearCode);
        reset();
      }
      prefix = ch;
    }
  }
  emit(prefix.length === 1 ? prefix.charCodeAt(0) : dict.get(prefix)!);
  emit(eoiCode);
  if (bitCount > 0) bytes.push(bitBuf & 0xff);
  return bytes;
}

export function encodeAnimatedGif(width: number, height: number, frames: GifFrame[]): Uint8Array {
  const out: number[] = [];
  const pushStr = (s: string) => {
    for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
  };
  const push16 = (v: number) => out.push(v & 0xff, (v >> 8) & 0xff);

  pushStr("GIF89a");
  push16(width);
  push16(height);
  out.push(0xf7, 0, 0); // Global Color Table flag + 8-bit color (256 entries)
  const pal = buildPalette();
  for (let i = 0; i < pal.length; i++) out.push(pal[i]);

  // NETSCAPE2.0 infinite loop block
  out.push(0x21, 0xff, 11);
  pushStr("NETSCAPE2.0");
  out.push(3, 1, 0, 0, 0);

  for (const frame of frames) {
    out.push(0x21, 0xf9, 4, 0);
    push16(Math.max(2, frame.delayCs));
    out.push(0, 0);
    out.push(0x2c);
    push16(0);
    push16(0);
    push16(width);
    push16(height);
    out.push(0);
    out.push(8); // LZW minimum code size
    const compressed = lzwEncode(quantize(frame.rgba, width, height), 8);
    for (let off = 0; off < compressed.length; off += 255) {
      const chunk = compressed.slice(off, off + 255);
      out.push(chunk.length, ...chunk);
    }
    out.push(0);
  }
  out.push(0x3b);
  return new Uint8Array(out);
}
