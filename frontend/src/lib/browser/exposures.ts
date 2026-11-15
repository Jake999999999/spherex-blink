// Which SPHEREx exposures cover a position. Browsers can't ask IRSA's search service directly (it sends
// no CORS headers), so the person opens the search link in a new tab, saves the result and drops it here,
// or pastes links. We read only S3 keys out of it; every key is checked against a strict pattern and the
// URL is rebuilt with the one fixed bucket host (remote.safeKey).

import { safeKey } from "./remote";
import { groupEpochs, spread } from "./resample";

export interface ExposureRef {
  key: string; // S3 key of the level-2 file
  detector: number;
  mjd: number | null; // from the search result, or read from the file header later
  obsId: string;
  collection: string;
}

export const MAX_LIST_BYTES = 20 * 1024 * 1024;

const decodeXml = (s: string) =>
  s.replace(/&(quot|amp|lt|gt|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, e: string) =>
    e === "quot" ? '"' : e === "amp" ? "&" : e === "lt" ? "<" : e === "gt" ? ">" : e === "apos" ? "'" : String.fromCharCode(e[1] === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))),
  );

// an S3 key or an IRSA ibe URL of a level-2 file
const L2_RE = /(?:ibe\/data\/spherex\/)?((?:dr1|qr2|qr3)\/level2\/[0-9]{4}W[0-9]{2}_[0-9A-Z]{2}\/l2b-v[0-9]+-[0-9]{4}-[0-9]{3}\/[1-6]\/level2_[0-9A-Za-z_-]+\.fits)/g;

function detectorOf(key: string): number {
  const m = /\/([1-6])\/level2_/.exec(key);
  return m ? Number(m[1]) : 0;
}

/** IRSA SIA VOTable (TABLEDATA), IRSA CSV, or any text with level-2 file names/URLs. */
export function parseExposureList(text: string): { refs: ExposureRef[]; format: string; skipped: number } {
  if (text.length > MAX_LIST_BYTES) throw new Error("That file is too large for an exposure list.");
  const refs = new Map<string, ExposureRef>();
  let skipped = 0;
  const add = (rawKey: string, mjd: number | null, obsId: string, kind: string) => {
    const key = safeKey(rawKey);
    if (!key) return void skipped++;
    if (kind && kind !== "science") return void skipped++;
    if (!refs.has(key)) refs.set(key, { key, detector: detectorOf(key), mjd, obsId, collection: key.split("/")[0] === "dr1" ? "spherex_dr1" : `spherex_${key.split("/")[0]}` });
  };
  let format = "text";
  if (/<VOTABLE[\s>]/i.test(text.slice(0, 4096))) {
    format = "VOTable";
    const names = [...text.matchAll(/<FIELD\b[^>]*\bname="([^"]+)"/g)].map((m) => m[1]);
    const col = (n: string) => names.indexOf(n);
    const [ci, ct0, ct1, co, cs, cc] = ["access_url", "t_min", "t_max", "obs_id", "dataproduct_subtype", "cloud_access"].map(col);
    for (const tr of text.matchAll(/<TR\b[^>]*>([\s\S]*?)<\/TR>/g)) {
      const tds = [...tr[1].matchAll(/<TD\b[^>]*>([\s\S]*?)<\/TD>|<TD\b[^>]*\/>/g)].map((m) => decodeXml(m[1] ?? "").trim());
      const where = `${tds[cc] ?? ""} ${tds[ci] ?? ""}`;
      const k = [...where.matchAll(L2_RE)][0]?.[1];
      if (!k) {
        skipped++;
        continue;
      }
      const t0 = Number(tds[ct0]);
      const t1 = Number(tds[ct1]);
      add(k, Number.isFinite(t0) && Number.isFinite(t1) ? 0.5 * (t0 + t1) : null, tds[co] ?? "", tds[cs] ?? "");
    }
  } else {
    const lines = text.split(/\r?\n/);
    const head = lines[0]?.split(",").map((s) => s.trim());
    const csv = !!head && head.includes("t_min") && head.includes("t_max");
    if (csv) format = "CSV";
    for (const line of csv ? lines.slice(1) : lines) {
      for (const m of line.matchAll(L2_RE)) {
        let mjd: number | null = null;
        let kind = "";
        if (csv) {
          // columns before cloud_access are intact (IRSA leaves that JSON unquoted)
          const cells = line.split(",");
          const t0 = Number(cells[head.indexOf("t_min")]);
          const t1 = Number(cells[head.indexOf("t_max")]);
          if (Number.isFinite(t0) && Number.isFinite(t1)) mjd = 0.5 * (t0 + t1);
          const si = head.indexOf("dataproduct_subtype");
          if (si >= 0) kind = (cells[si] ?? "").trim();
        }
        add(m[1], mjd, "", kind);
      }
    }
  }
  return { refs: [...refs.values()], format, skipped };
}

export interface Sampled {
  refs: ExposureRef[];
  visitOf: Map<string, number>;
  visits: number;
}

/** Up to `perCell` exposures per (visit, detector), spread in time, from up to `visitsMax` visits (bake.subsample_by_visit). */
export function sampleByVisit(all: ExposureRef[], perCell: number, visitsMax: number): Sampled {
  const timed = all.filter((r) => r.mjd !== null && r.detector >= 1);
  let groups = groupEpochs(timed.map((r) => r.mjd!));
  if (visitsMax && groups.length > visitsMax) groups = spread(groups.length, visitsMax).map((i) => groups[i]);
  const refs: ExposureRef[] = [];
  const visitOf = new Map<string, number>();
  groups.forEach((g, v) => {
    for (let d = 1; d <= 6; d++) {
      const ed = g.map((i) => timed[i]).filter((r) => r.detector === d).sort((a, b) => a.mjd! - b.mjd!);
      const pick = spread(ed.length, perCell).map((i) => ed[i]);
      for (const r of pick) {
        refs.push(r);
        visitOf.set(r.key, v);
      }
    }
  });
  refs.sort((a, b) => a.mjd! - b.mjd! || a.detector - b.detector);
  return { refs, visitOf, visits: groups.length };
}

/** IRSA's search (SIA v2) for SPHEREx images at a position: opened in a new tab, saved, dropped back. */
export function irsaSearchUrl(ra: number, dec: number, collection = "spherex_dr1"): string {
  const q = new URLSearchParams({ COLLECTION: collection, POS: `circle ${ra.toFixed(6)} ${dec.toFixed(6)} 0.001`, RESPONSEFORMAT: "VOTABLE" });
  return `https://irsa.ipac.caltech.edu/SIA?${q.toString()}`;
}
