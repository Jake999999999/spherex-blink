// Parse sky coordinates the way astronomers type them.

export interface SkyPos {
  ra: number; // degrees, 0..360
  dec: number; // degrees, -90..90
}

const num = String.raw`[+-]?\d+(?:\.\d+)?`;

function sexa(parts: string[]): number {
  const [a, b = "0", c = "0"] = parts;
  const sign = a.trim().startsWith("-") ? -1 : 1;
  return sign * (Math.abs(parseFloat(a)) + parseFloat(b) / 60 + parseFloat(c) / 3600);
}

/**
 * Accepts "133.795 -7.245", "133.795, -7.245", "08:55:10.831 -07:14:42.53",
 * "08h55m10.831s -07d14m42.53s", "08 55 10.8 -07 14 42.5". Sexagesimal RA is hours; decimal RA is degrees.
 * Returns null if it can't be read or is out of range.
 */
export function parseCoords(input: string): SkyPos | null {
  const s = input.trim().replace(/[,;]/g, " ").replace(/\s+/g, " ");
  if (!s) return null;
  // decimal degrees
  const dec2 = new RegExp(`^(${num})\\s*d?\\s+(${num})\\s*d?$`, "i").exec(s);
  if (dec2) return check(parseFloat(dec2[1]), parseFloat(dec2[2]));
  // h m s / d m s with letters or colons or spaces
  const hms = s
    .replace(/[hH]/, ":")
    .replace(/[mM′'](?=\s*\d)/, ":")
    .replace(/[sS″"]\s*/, " ")
    .replace(/[dD°]/, ":")
    .replace(/[mM′']\s*(?=\d)/, ":")
    .replace(/[sS″"]\s*$/, "")
    .trim();
  const m = new RegExp(`^(\\d{1,2})[: ](\\d{1,2})[: ](\\d{1,2}(?:\\.\\d+)?)\\s+([+-]?\\d{1,2})[: ](\\d{1,2})[: ](\\d{1,2}(?:\\.\\d+)?)$`).exec(hms);
  if (m) return check(sexa([m[1], m[2], m[3]]) * 15, sexa([m[4], m[5], m[6]]));
  return null;
}

function check(ra: number, dec: number): SkyPos | null {
  if (!Number.isFinite(ra) || !Number.isFinite(dec) || dec < -90 || dec > 90) return null;
  return { ra: ((ra % 360) + 360) % 360, dec };
}

/** Does the text look like coordinates (rather than a name to look up)? */
export const looksLikeCoords = (s: string) => /^[\s\d+\-.:hHmMsSdD°′″'",;]+$/.test(s.trim());
