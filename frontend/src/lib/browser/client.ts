// Main-thread side of the browser builder: start a build in a worker, report progress, cancel.
import type { BundleFiles, FieldRequest, Progress } from "./fieldbuild";

export interface BuildHandle {
  cancel(): void;
  done: Promise<BundleFiles>;
}

export function startBrowserBuild(req: FieldRequest, onProgress: (p: Progress) => void): BuildHandle {
  const w = new Worker(new URL("./fieldworker.ts", import.meta.url), { type: "module" });
  let stop: () => void = () => {};
  const done = new Promise<BundleFiles>((resolve, reject) => {
    stop = () => {
      w.terminate(); // CPU work in the worker can't be interrupted any other way
      reject(new Error("cancelled"));
    };
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
    cancel: () => stop(),
    done,
  };
}

const SESAME_MIRRORS = [
  "https://cds.unistra.fr/cgi-bin/nph-sesame/-oI/SNV",
  "https://vizier.cfa.harvard.edu/viz-bin/nph-sesame/-oI/SNV",
  "https://vizier.idia.ac.za/viz-bin/nph-sesame/-oI/SNV",
];

/** CDS Sesame (SIMBAD/NED/VizieR) name lookup with official CfA/IDIA mirror fallbacks (all support CORS). */
export async function resolveNameInBrowser(name: string, signal?: AbortSignal): Promise<{ name: string; ra: number; dec: number }> {
  const q = encodeURIComponent(name.slice(0, 64));
  let text = "";
  let lastErr: unknown = null;
  for (const base of SESAME_MIRRORS) {
    try {
      const timeoutSig = AbortSignal.timeout(6000);
      const sig = signal ? AbortSignal.any([signal, timeoutSig]) : timeoutSig;
      const r = await fetch(`${base}?${q}`, { signal: sig });
      if (!r.ok) {
        lastErr = new Error(`name lookup failed (HTTP ${r.status})`);
        continue;
      }
      text = (await r.text()).slice(0, 100_000);
      break;
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e;
    }
  }
  if (!text) throw lastErr instanceof Error ? lastErr : new Error("name lookup failed on all Sesame mirrors");
  const m = /^%J\s+([-+]?\d+(?:\.\d+)?)\s+([-+]?\d+(?:\.\d+)?)/m.exec(text);
  if (!m) throw new Error(`“${name}” wasn't found in SIMBAD, NED or VizieR.`);
  const ra = Number(m[1]);
  const dec = Number(m[2]);
  if (!(ra >= 0 && ra < 360 && dec >= -90 && dec <= 90)) throw new Error("name lookup gave an impossible position");
  const id = /^%I\.0\s+(.+)$/m.exec(text)?.[1]?.trim();
  return { name: (id ?? name).replace(/[^\x20-\x7e]/g, "").slice(0, 64), ra, dec };
}
