// Shareable view state in the query string. `silent` is read but never written back.
import type { StretchKind } from "./stretch";

export type Mode = "blink" | "diff" | "colour";

export interface ViewState {
  target: string;
  mode: Mode;
  band: number; // 1..6
  t1: number; // epoch index
  t2: number;
  wise: boolean;
  stretch: StretchKind;
}

export const DEFAULT_STATE: ViewState = {
  target: "barnard",
  mode: "colour",
  band: 6,
  t1: 0,
  t2: 1,
  wise: true,
  stretch: "asinh",
};

const int = (v: string | null, lo: number, hi: number): number | undefined => {
  if (v === null || !/^-?\d+$/.test(v)) return undefined;
  const n = Number(v);
  return n >= lo && n <= hi ? n : undefined;
};

export interface LiveParams {
  ra: number;
  dec: number;
  fov: number;
  name?: string;
}

/** ?ra=&dec=&fov= (degrees, arcmin): open any spot in the sky (embeddable). */
export function parseLive(search: string): LiveParams | null {
  const q = new URLSearchParams(search);
  const ra = Number(q.get("ra"));
  const dec = Number(q.get("dec"));
  if (!q.has("ra") || !q.has("dec") || !Number.isFinite(ra) || !Number.isFinite(dec) || dec < -90 || dec > 90) return null;
  const f = Number(q.get("fov") ?? 5);
  const fov = Number.isFinite(f) ? Math.min(15, Math.max(2, Math.round(f))) : 5;
  const name = (q.get("name") ?? "").slice(0, 80) || undefined;
  return { ra: ((ra % 360) + 360) % 360, dec, fov, name };
}

export function parseState(search: string, base: ViewState = DEFAULT_STATE): Partial<ViewState> & { silent: boolean } {
  const q = new URLSearchParams(search);
  const out: Partial<ViewState> & { silent: boolean } = { silent: q.has("silent") };
  const t = q.get("target");
  if (t && /^[a-z0-9-]{1,40}$/.test(t)) out.target = t;
  const m = q.get("mode");
  if (m === "blink" || m === "diff" || m === "colour") out.mode = m;
  const b = int(q.get("band"), 1, 6);
  if (b !== undefined) out.band = b;
  const t1 = int(q.get("t1"), 0, 99);
  if (t1 !== undefined) out.t1 = t1;
  const t2 = int(q.get("t2"), 0, 99);
  if (t2 !== undefined) out.t2 = t2;
  const w = q.get("wise");
  if (w === "1" || w === "0") out.wise = w === "1";
  const s = q.get("stretch");
  if (s === "asinh" || s === "linear") out.stretch = s;
  void base;
  return out;
}

export function serializeState(s: ViewState, silent = false): string {
  const q = new URLSearchParams();
  q.set("target", s.target);
  q.set("mode", s.mode);
  q.set("band", String(s.band));
  q.set("t1", String(s.t1));
  q.set("t2", String(s.t2));
  q.set("wise", s.wise ? "1" : "0");
  q.set("stretch", s.stretch);
  let out = q.toString();
  if (silent) out += "&silent";
  return out;
}
