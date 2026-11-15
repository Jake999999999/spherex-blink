// Main-thread side of the browser builder: start a build in a worker, report progress, cancel.
import type { BundleFiles, FieldRequest, Progress } from "./fieldbuild";

export interface BuildHandle {
  cancel(): void;
  done: Promise<BundleFiles>;
}

export function startBrowserBuild(req: FieldRequest, onProgress: (p: Progress) => void): BuildHandle {
  const w = new Worker(new URL("./fieldworker.ts", import.meta.url), { type: "module" });
  const done = new Promise<BundleFiles>((resolve, reject) => {
    w.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === "progress") onProgress(m.p);
      else {
        w.terminate();
        if (m.type === "done") resolve(m.files);
        else reject(new Error(m.error));
      }
    };
    w.onerror = (e) => {
      w.terminate();
      reject(new Error(e.message || "the builder stopped"));
    };
  });
  w.postMessage({ type: "start", req });
  return {
    cancel: () => w.postMessage({ type: "cancel" }),
    done,
  };
}

/** CDS Sesame (SIMBAD/NED/VizieR) name lookup, straight from the browser (it allows cross-origin requests). */
export async function resolveNameInBrowser(name: string, signal?: AbortSignal): Promise<{ name: string; ra: number; dec: number }> {
  const r = await fetch(`https://cds.unistra.fr/cgi-bin/nph-sesame/-oI/SNV?${encodeURIComponent(name.slice(0, 64))}`, { signal });
  if (!r.ok) throw new Error(`name lookup failed (HTTP ${r.status})`);
  const text = (await r.text()).slice(0, 100_000);
  const m = /^%J\s+([-+]?\d+(?:\.\d+)?)\s+([-+]?\d+(?:\.\d+)?)/m.exec(text);
  if (!m) throw new Error(`“${name}” wasn't found in SIMBAD, NED or VizieR.`);
  const ra = Number(m[1]);
  const dec = Number(m[2]);
  if (!(ra >= 0 && ra < 360 && dec >= -90 && dec <= 90)) throw new Error("name lookup gave an impossible position");
  const id = /^%I\.0\s+(.+)$/m.exec(text)?.[1]?.trim();
  return { name: (id ?? name).replace(/[^\x20-\x7e]/g, "").slice(0, 64), ra, dec };
}
