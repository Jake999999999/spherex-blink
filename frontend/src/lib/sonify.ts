// Hearing a spectrum: a short sweep from short to long wavelength (or early to late date), pitch rising
// with brightness. Absorption dips are heard as drops. Pure planning functions are unit-tested; the
// AudioContext is only created after a click, and never under ?silent.
import { REFERENCE_BANDS, type Point } from "./spectra";

export interface Note {
  t: number; // seconds from start
  freq: number; // Hz
}

export const F_LO = 220;
export const F_HI = 880;

/** Median per bin along x, then a log-pitch mapping of the values (220–880 Hz). */
export function sonifyPlan(xs: number[], ys: number[], bins = 48, duration = 3): Note[] {
  const pts = xs.map((x, i) => [x, ys[i]] as const).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pts.length < 2) return [];
  const x0 = Math.min(...pts.map((p) => p[0]));
  const x1 = Math.max(...pts.map((p) => p[0]));
  const vals: (number | null)[] = [];
  for (let b = 0; b < bins; b++) {
    const lo = x0 + ((x1 - x0) * b) / bins;
    const hi = x0 + ((x1 - x0) * (b + 1)) / bins;
    const v = pts.filter(([x]) => x >= lo && (x < hi || (b === bins - 1 && x <= hi))).map((p) => p[1]).sort((a, c) => a - c);
    vals.push(v.length ? v[v.length >> 1] : null);
  }
  const finite = vals.filter((v): v is number => v !== null);
  // log scale when everything is positive (spectra span decades), else linear
  const useLog = finite.every((v) => v > 0);
  const f = (v: number) => (useLog ? Math.log10(v) : v);
  const lo = Math.min(...finite.map(f));
  const hi = Math.max(...finite.map(f));
  const notes: Note[] = [];
  vals.forEach((v, b) => {
    if (v === null) return;
    const u = hi > lo ? (f(v) - lo) / (hi - lo) : 0.5;
    notes.push({ t: (b / bins) * duration, freq: F_LO * Math.pow(F_HI / F_LO, u) });
  });
  return notes;
}

let ctx: AudioContext | null = null;
let stopFn: (() => void) | null = null;

export function stopSound(): void {
  stopFn?.();
  stopFn = null;
}

/** Play notes as one smooth glide. Returns false when sound is not allowed (?silent) or not available. */
export function playPlan(notes: Note[], silent: boolean, duration = 3): boolean {
  if (silent || !notes.length || typeof window === "undefined") return false;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return false;
  stopSound();
  ctx = ctx ?? new AC();
  const t0 = ctx.currentTime + 0.05;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(notes[0].freq, t0);
  for (const n of notes) osc.frequency.linearRampToValueAtTime(n.freq, t0 + n.t);
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(0.18, t0 + 0.05);
  gain.gain.setValueAtTime(0.18, t0 + duration - 0.1);
  gain.gain.linearRampToValueAtTime(0, t0 + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.05);
  stopFn = () => {
    try {
      osc.stop();
    } catch {
      /* already stopped */
    }
  };
  return true;
}

// ---------------------------------------------------------------- words

/** Median spectrum in fixed wavelength bins (unflagged points only). */
export function binnedSpectrum(pts: Point[], width = 0.06): { wl: number; flux: number }[] {
  const good = pts.filter((p) => p.flag === 0);
  const out: { wl: number; flux: number }[] = [];
  for (let lo = 0.74; lo < 5.05; lo += width) {
    const v = good.filter((p) => p.wl >= lo && p.wl < lo + width).map((p) => p.flux).sort((a, b) => a - b);
    if (v.length >= 2) out.push({ wl: lo + width / 2, flux: v[v.length >> 1] });
  }
  return out;
}

/**
 * One or two sentences describing a spectrum: where it is brightest and where clear dips line up with
 * reference molecular bands. Dips are local minima at least 25% below the larger of the two
 * neighbouring maxima within ±0.3 µm.
 */
export function describeSpectrum(pts: Point[]): string {
  const s = binnedSpectrum(pts);
  if (s.length < 6) return "Too few clean measurements to describe this spectrum.";
  // noise from bin-to-bin jitter (robust); a real source must stand well above it
  const diffs = s.slice(1).map((p, i) => Math.abs(p.flux - s[i].flux)).sort((a, b) => a - b);
  const noise = (diffs[diffs.length >> 1] * 1.4826) / Math.SQRT2 || 0;
  const peak = s.reduce((a, b) => (b.flux > a.flux ? b : a));
  if (peak.flux < 5 * noise) return "No clear source here: these values are mostly sky noise.";
  const dips: { wl: number; depth: number }[] = [];
  for (let i = 1; i < s.length - 1; i++) {
    if (!(s[i].flux < s[i - 1].flux && s[i].flux <= s[i + 1].flux)) continue;
    const left = s.filter((p) => p.wl >= s[i].wl - 0.3 && p.wl < s[i].wl).map((p) => p.flux);
    const right = s.filter((p) => p.wl > s[i].wl && p.wl <= s[i].wl + 0.3).map((p) => p.flux);
    if (!left.length || !right.length) continue;
    const shoulder = Math.min(Math.max(...left), Math.max(...right));
    if (shoulder <= 0) continue;
    const depth = 1 - s[i].flux / shoulder;
    if (depth >= 0.25 && shoulder - s[i].flux > 3 * noise) dips.push({ wl: s[i].wl, depth });
  }
  dips.sort((a, b) => b.depth - a.depth);
  const named = dips.slice(0, 3).map((d) => {
    const ref = REFERENCE_BANDS.filter((r) => Math.abs(r.wl - d.wl) <= 0.1).sort((a, b) => Math.abs(a.wl - d.wl) - Math.abs(b.wl - d.wl))[0];
    return `${d.wl.toFixed(1)} µm${ref ? ` (where ${ref.label} absorbs)` : ""}`;
  });
  const first = `Brightest near ${peak.wl.toFixed(1)} µm.`;
  if (!named.length) return `${first} No deep dips: a smooth spectrum, like an ordinary star's.`;
  return `${first} Clear dips near ${named.join(", ")}.`;
}

/**
 * Each point divided by the star's typical brightness at that wavelength (median of all dates within
 * ±1.5%). Inside one detector the wavelength changes from exposure to exposure, and a star is brighter
 * at some wavelengths than others; dividing that out leaves only changes over time.
 */
export function detrendByWavelength(pts: { wl: number; flux: number; flag: number; mjd: number }[]): { mjd: number; rel: number }[] {
  const good = pts.filter((p) => p.flag === 0 && p.flux > 0);
  const out: { mjd: number; rel: number }[] = [];
  for (const p of good) {
    const near = good.filter((q) => Math.abs(q.wl - p.wl) <= 0.015 * p.wl).map((q) => q.flux).sort((a, b) => a - b);
    if (near.length < 3) continue;
    const med = near[near.length >> 1];
    out.push({ mjd: p.mjd, rel: p.flux / med });
  }
  return out.sort((a, b) => a.mjd - b.mjd);
}

/** One sentence describing a light curve (after removing the wavelength trend). */
export function describeLightCurve(pts: { wl: number; flux: number; flag: number; mjd: number }[]): string {
  const rel = detrendByWavelength(pts);
  if (rel.length < 5) return "Too few clean measurements to describe this light curve.";
  // group into visits (gaps > 45 days or 60-day bins) and compare visit medians, so single-exposure
  // noise averages out
  const groups: number[][] = [];
  let start = rel[0].mjd;
  for (const p of rel) {
    const g = groups[groups.length - 1];
    if (!g || p.mjd - start > 60) {
      groups.push([p.rel]);
      start = p.mjd;
    } else g.push(p.rel);
  }
  const meds = groups.filter((g) => g.length >= 3).map((g) => g.sort((a, b) => a - b)[g.length >> 1]);
  if (meds.length < 2) return "Only one visit has enough clean measurements to compare.";
  const lo = Math.min(...meds);
  const hi = Math.max(...meds);
  const months = (rel[rel.length - 1].mjd - rel[0].mjd) / 30.44;
  const swing = hi > 0 ? (hi - lo) / hi : 0;
  if (swing < 0.15) return `Steady: after allowing for wavelength, brightness stays within about ${Math.round(swing * 100)}% over ${Math.round(months)} months.`;
  return `Changes: after allowing for wavelength, the faintest moments are about ${Math.round(swing * 100)}% below the brightest, over ${Math.round(months)} months.`;
}
