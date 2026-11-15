import { useEffect, useState } from "react";
import { BENCH_ROOT } from "../lib/bundle";

interface Validation {
  generated_utc: string;
  photometry: { bands: Record<string, { n: number; median_ratio: number; scatter: number }>; stars: number };
  astrometry: { n: number; median_arcsec: number | null; per_target: Record<string, number | null> };
  motion: Record<string, { measured: number; gaia: number; diff_pct: number; reference?: string }>;
  repeatability: { median: number | null; per_target: Record<string, number | null> };
  map_vs_exposures: { median_ratio: number | null; median_scatter: number | null };
}

/** "How accurate is this?" Numbers come from validation.json, written by the pipeline's validate step. */
export function Accuracy({ target }: { target: string }) {
  const [v, setV] = useState<Validation | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    fetch(`${BENCH_ROOT}/validation.json`)
      .then((r) => (r.ok && (r.headers.get("content-type") ?? "").includes("json") ? r.json() : Promise.reject()))
      .then(setV)
      .catch(() => setFailed(true));
  }, []);
  if (failed) return <p className="mt-3 text-xs text-slate-500">No validation numbers in this build.</p>;
  if (!v) return <p className="mt-3 text-xs text-slate-500">Loading…</p>;
  const bands = Object.entries(v.photometry.bands);
  const lo = Math.min(...bands.map(([, b]) => b.median_ratio));
  const hi = Math.max(...bands.map(([, b]) => b.median_ratio));
  const mot = v.motion[target];
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  return (
    <div className="mt-3 space-y-2 text-xs leading-relaxed text-slate-300">
      <p>
        <b className="text-white">Brightness.</b> For {v.photometry.stars} ordinary stars, our numbers match the 2MASS and WISE catalogues to within{" "}
        {pct(Math.max(Math.abs(1 - lo), Math.abs(hi - 1)))} on average ({bands.map(([k, b]) => `${k} ${b.median_ratio.toFixed(2)}`).join(", ")}), star-to-star spread{" "}
        {bands.map(([, b]) => pct(b.scatter)).sort()[0]}–{bands.map(([, b]) => pct(b.scatter)).sort().slice(-1)[0]}.
      </p>
      {v.astrometry.median_arcsec !== null && (
        <p>
          <b className="text-white">Positions.</b> Stars sit {v.astrometry.median_arcsec.toFixed(2)}″ from where Gaia puts them (median of {v.astrometry.n} measurements), under a tenth of
          a pixel.
        </p>
      )}
      {v.repeatability.median !== null && (
        <p>
          <b className="text-white">Steadiness.</b> Stars that don't vary change by {(v.repeatability.median * 100).toFixed(1)}% between visits (median), so changes much larger than that are
          real.
        </p>
      )}
      {mot && (
        <p>
          <b className="text-white">This target's motion.</b> Measured {mot.measured.toFixed(2)}″/yr from the images; reference {mot.gaia.toFixed(2)}″/yr ({mot.diff_pct >= 0 ? "+" : ""}
          {mot.diff_pct.toFixed(1)}%).
        </p>
      )}
      {v.map_vs_exposures.median_scatter !== null && (
        <p>
          <b className="text-white">Two products agree.</b> The all-sky map's spectra follow the single-exposure spectra to within {pct(v.map_vs_exposures.median_scatter)} in shape.
        </p>
      )}
      <p className="text-slate-500">Computed by the pipeline on {v.generated_utc.slice(0, 10)}; details in docs/VALIDATION.md.</p>
    </div>
  );
}
