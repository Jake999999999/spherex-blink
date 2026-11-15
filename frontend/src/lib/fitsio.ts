// Minimal FITS and ECSV writers for exporting what's on screen (PLAN.md S5).
import type { GridWcs } from "./bundle";

export type CardValue = string | number | boolean;

/** One 80-character header card. Strings are quoted; long text goes in COMMENT/HISTORY. */
export function card(key: string, value?: CardValue, comment = ""): string {
  const k = key.toUpperCase().padEnd(8).slice(0, 8);
  if (key === "COMMENT" || key === "HISTORY") return `${k}${String(value ?? "")}`.slice(0, 80).padEnd(80);
  if (key === "END") return "END".padEnd(80);
  let v: string;
  if (typeof value === "boolean") v = (value ? "T" : "F").padStart(20);
  else if (typeof value === "number") {
    if (Number.isInteger(value)) v = String(value).padStart(20);
    else {
      let s = value.toPrecision(15).replace(/0+e/, "e").replace(/\.?0+$/, "");
      if (!/[.eE]/.test(s)) s += ".0";
      s = s.replace("e", "E");
      v = s.padStart(20);
    }
  } else v = `'${String(value ?? "").replace(/'/g, "''").padEnd(8)}'`.padEnd(20);
  const c = comment ? ` / ${comment}` : "";
  return `${k}= ${v}${c}`.slice(0, 80).padEnd(80);
}

/** Split long text into COMMENT/HISTORY cards. */
export function longCards(key: "COMMENT" | "HISTORY", text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += 70) out.push(card(key, text.slice(i, i + 70)));
  return out;
}

export function wcsCards(w: GridWcs): string[] {
  return [
    card("WCSAXES", 2),
    card("CTYPE1", w.ctype[0]),
    card("CTYPE2", w.ctype[1]),
    card("CRVAL1", w.crval[0], "[deg]"),
    card("CRVAL2", w.crval[1], "[deg]"),
    card("CRPIX1", w.crpix[0]),
    card("CRPIX2", w.crpix[1]),
    card("CDELT1", w.cdelt[0], "[deg/pix]"),
    card("CDELT2", w.cdelt[1], "[deg/pix]"),
    card("CUNIT1", "deg"),
    card("CUNIT2", "deg"),
    card("RADESYS", "ICRS"),
  ];
}

/**
 * A primary-HDU FITS file: float32 (BITPIX -32, big-endian), axes given fastest first (FITS order:
 * NAXIS1 = width). `data` is row-major with row 0 at the bottom (FITS convention, same as our planes).
 */
export function buildFits(axes: number[], data: Float32Array, extra: string[]): Uint8Array {
  const n = axes.reduce((a, b) => a * b, 1);
  if (data.length !== n) throw new Error(`data has ${data.length} values, axes need ${n}`);
  const cards = [card("SIMPLE", true, "conforms to FITS standard"), card("BITPIX", -32, "IEEE float32"), card("NAXIS", axes.length)];
  axes.forEach((v, i) => cards.push(card(`NAXIS${i + 1}`, v)));
  cards.push(...extra, card("END"));
  const hdrLen = Math.ceil((cards.length * 80) / 2880) * 2880;
  const dataLen = Math.ceil((n * 4) / 2880) * 2880;
  const out = new Uint8Array(hdrLen + dataLen);
  const text = cards.join("").padEnd(hdrLen, " ");
  for (let i = 0; i < hdrLen; i++) out[i] = text.charCodeAt(i);
  const dv = new DataView(out.buffer, hdrLen);
  for (let i = 0; i < n; i++) dv.setFloat32(i * 4, data[i], false); // big-endian
  return out;
}

export interface EcsvColumn {
  name: string;
  datatype: "float64" | "int32" | "string";
  unit?: string;
  description?: string;
  values: (number | string | null)[];
}

/** ECSV 1.0 (astropy's self-describing CSV): types, units and metadata in a YAML header. */
export function buildEcsv(columns: EcsvColumn[], meta: Record<string, string | number>): string {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const lines = ["# %ECSV 1.0", "# ---", "# datatype:"];
  for (const c of columns) {
    const parts = [`name: ${c.name}`];
    if (c.unit) parts.push(`unit: ${c.unit}`);
    parts.push(`datatype: ${c.datatype}`);
    if (c.description) parts.push(`description: ${q(c.description)}`);
    lines.push(`# - {${parts.join(", ")}}`);
  }
  lines.push("# meta: !!omap");
  for (const [k, v] of Object.entries(meta)) lines.push(`# - {${k}: ${typeof v === "number" ? v : q(v)}}`);
  lines.push("# schema: astropy-2.0");
  lines.push(columns.map((c) => c.name).join(" "));
  const nrow = columns[0]?.values.length ?? 0;
  for (let r = 0; r < nrow; r++) {
    lines.push(
      columns
        .map((c) => {
          const v = c.values[r];
          if (v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v))) return '""';
          return typeof v === "string" ? `"${v.replace(/"/g, '""')}"` : String(v);
        })
        .join(" "),
    );
  }
  return lines.join("\n") + "\n";
}

export function download(name: string, data: Uint8Array | string, type: string): void {
  const blob = new Blob([data as BlobPart], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
