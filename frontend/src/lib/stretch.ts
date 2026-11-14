// Display levels. The shader does the per-pixel mapping; these compute its uniforms and are unit-tested.

export type StretchKind = "asinh" | "linear";
export const ASINH_BETA = 12;

/** Percentile (0..100) of the finite values, linear interpolation between order statistics. */
export function percentile(values: ArrayLike<number>, p: number): number {
  const v: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const x = values[i];
    if (Number.isFinite(x)) v.push(x);
  }
  if (!v.length) return NaN;
  v.sort((a, b) => a - b);
  const r = (Math.min(100, Math.max(0, p)) / 100) * (v.length - 1);
  const lo = Math.floor(r);
  const hi = Math.ceil(r);
  return v[lo] + (v[hi] - v[lo]) * (r - lo);
}

export interface Levels {
  black: number;
  white: number;
}

export function levelsFor(values: ArrayLike<number>, loPct: number, hiPct: number): Levels {
  let black = percentile(values, loPct);
  let white = percentile(values, hiPct);
  if (!Number.isFinite(black) || !Number.isFinite(white)) return { black: 0, white: 1 };
  if (white <= black) white = black + 1e-6;
  return { black, white };
}

/** Same mapping as the fragment shader: value -> 0..1. */
export function applyStretch(v: number, l: Levels, kind: StretchKind): number {
  const x = Math.min(1, Math.max(0, (v - l.black) / (l.white - l.black)));
  return kind === "linear" ? x : Math.asinh(x * ASINH_BETA) / Math.asinh(ASINH_BETA);
}

/** Symmetric limit for a difference image: the hiPct percentile of |d|. */
export function diffLimit(d: ArrayLike<number>, hiPct: number): number {
  const a = new Float32Array(d.length);
  for (let i = 0; i < d.length; i++) a[i] = Math.abs(d[i]);
  const l = percentile(a, hiPct);
  return Number.isFinite(l) && l > 0 ? l : 1;
}

/** Same mapping as the shader in difference mode: d -> -1..1. */
export function applyDiff(d: number, limit: number, kind: StretchKind): number {
  const x = Math.min(1, Math.max(-1, d / limit));
  return kind === "linear" ? x : Math.asinh(x * ASINH_BETA) / Math.asinh(ASINH_BETA);
}

export function subtract(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] - b[i];
  return out;
}
