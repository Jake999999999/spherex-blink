// Axis helpers for the SVG charts.

export function niceTicks(lo: number, hi: number, target = 5): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return [lo];
  const raw = (hi - lo) / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

/** Decades (and 2x, 5x when the range is short) for a log axis. */
export function logTicks(lo: number, hi: number): number[] {
  if (!(lo > 0) || !(hi > lo)) return [];
  const out: number[] = [];
  const a = Math.floor(Math.log10(lo));
  const b = Math.ceil(Math.log10(hi));
  const mult = b - a <= 2 ? [1, 2, 5] : [1];
  for (let e = a; e <= b; e++) for (const m of mult) {
    const v = m * 10 ** e;
    if (v >= lo && v <= hi) out.push(v);
  }
  return out;
}

export function formatNumber(v: number): string {
  const a = Math.abs(v);
  if (a === 0) return "0";
  if (a >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (a >= 10) return v.toFixed(0);
  if (a >= 1) return v.toFixed(1).replace(/\.0$/, "");
  return v.toPrecision(2);
}

/** Robust y-range of values (2nd–98th percentile, padded). */
export function robustRange(values: number[], pad = 0.08): [number, number] {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return [0, 1];
  const q = (p: number) => v[Math.min(v.length - 1, Math.max(0, Math.round(p * (v.length - 1))))];
  let lo = q(0.02);
  let hi = q(0.98);
  if (hi <= lo) {
    hi = lo + Math.abs(lo || 1) * 0.1;
    lo = lo - Math.abs(lo || 1) * 0.1;
  }
  const span = hi - lo;
  return [lo - span * pad, hi + span * pad];
}
