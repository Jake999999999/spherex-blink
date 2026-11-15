import { parseCoords } from "./coords";

export interface TargetListItem {
  label: string;
  query: string;
}

/**
 * Parse a researcher's target list (CSV, TSV, or one-per-line names/coordinates).
 * Supports `name,ra,dec`, `ra,dec`, or single-column names/sexagesimal coordinates.
 */
export function parseTargetList(text: string): TargetListItem[] {
  const out: TargetListItem[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith("#")) continue;
    const parts = raw.split(/[,\t;]/).map((s) => s.trim()).filter(Boolean);
    if (!parts.length) continue;
    // Skip header row if it looks like column names
    if (out.length === 0 && /^(name|target|id|object|ra)$/i.test(parts[0])) continue;

    if (parts.length >= 3) {
      const c = parseCoords(`${parts[1]} ${parts[2]}`);
      if (c) {
        out.push({ label: parts[0], query: `${c.ra.toFixed(5)} ${c.dec.toFixed(5)}` });
        continue;
      }
    }
    if (parts.length === 2) {
      const c = parseCoords(`${parts[0]} ${parts[1]}`);
      if (c) {
        out.push({ label: `${c.ra.toFixed(3)}, ${c.dec.toFixed(3)}`, query: `${c.ra.toFixed(5)} ${c.dec.toFixed(5)}` });
        continue;
      }
      // Could be "name, coords"
      const c2 = parseCoords(parts[1]);
      if (c2) {
        out.push({ label: parts[0], query: `${c2.ra.toFixed(5)} ${c2.dec.toFixed(5)}` });
        continue;
      }
    }
    const single = parts.join(" ");
    const c = parseCoords(single);
    if (c) {
      out.push({ label: single, query: `${c.ra.toFixed(5)} ${c.dec.toFixed(5)}` });
    } else {
      out.push({ label: single, query: single });
    }
  }
  return out;
}
