import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { resolveRemoteDataRoot } from "../lib/bundle";

export interface SourceHealth {
  id: string;
  label: string;
  state: "checking" | "up" | "down" | "cors";
  detail?: string;
}

interface Props {
  serverOnline: boolean | null;
  onUpstream502?: (active: boolean) => void;
}

const BROWSER_CHECKS: { id: string; label: string; url: () => string }[] = [
  { id: "aws_s3", label: "AWS S3 (SPHEREx)", url: () => "https://nasa-irsa-spherex.s3.amazonaws.com/?list-type=2&max-keys=1" },
  { id: "esa_gaia", label: "ESA Gaia DR3", url: () => "https://gea.esac.esa.int/tap-server/tap/availability" },
  { id: "vizier_tap", label: "VizieR TAP (Mirror)", url: () => "https://tapvizier.cds.unistra.fr/TAPVizieR/tap/availability" },
  { id: "cds_sesame", label: "CDS Sesame (Names)", url: () => "https://cdsweb.u-strasbg.fr/cgi-bin/nph-sesame/-oI/A?Vega" },
  { id: "data_mirror", label: "Data Repo Mirror", url: () => `${resolveRemoteDataRoot()}/index.json` },
];

export function DataSourceStatus({ serverOnline, onUpstream502 }: Props) {
  const [items, setItems] = useState<SourceHealth[]>([]);
  const [busy, setBusy] = useState(false);

  const runChecks = useCallback(async () => {
    setBusy(true);
    try {
      if (serverOnline) {
        const r = await fetch("/api/status");
        if (r.ok) {
          const data = (await r.json()) as { sources: { id: string; label: string; ok: boolean; status: number | string; ms: number }[] };
          const mapped: SourceHealth[] = data.sources.map((s) => ({
            id: s.id,
            label: s.label,
            state: s.ok ? "up" : "down",
            detail: typeof s.status === "number" ? `HTTP ${s.status} · ${s.ms}ms` : `${s.status}`,
          }));
          setItems(mapped);
          const sia = data.sources.find((s) => s.id === "irsa_sia");
          if (sia && sia.status === 502) onUpstream502?.(true);
          else if (sia?.ok) onUpstream502?.(false);
          return;
        }
      }

      // Browser / GitHub Pages mode: probe CORS-enabled endpoints directly; note IRSA SIA lacks CORS headers.
      const results = await Promise.all(
        BROWSER_CHECKS.map(async (c): Promise<SourceHealth> => {
          const t0 = performance.now();
          try {
            const res = await fetch(c.url(), { signal: AbortSignal.timeout(5000) });
            const ms = Math.round(performance.now() - t0);
            return {
              id: c.id,
              label: c.label,
              state: res.ok ? "up" : "down",
              detail: `HTTP ${res.status} · ${ms}ms`,
            };
          } catch (e) {
            return {
              id: c.id,
              label: c.label,
              state: "down",
              detail: e instanceof Error && e.name === "TimeoutError" ? "Timed out" : "Unreachable",
            };
          }
        }),
      );
      results.unshift({
        id: "irsa_sia",
        label: "IRSA SIA (SPHEREx)",
        state: "cors",
        detail: "No browser CORS (use local server or paste link)",
      });
      setItems(results);
    } finally {
      setBusy(false);
    }
  }, [serverOnline, onUpstream502]);

  useEffect(() => {
    void runChecks();
  }, [runChecks]);

  return (
    <div className="mx-4 mb-2 flex flex-wrap items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-1.5 text-[11px] text-slate-400">
      <span className="mr-1 font-medium text-slate-300">Data sources:</span>
      {items.map((it) => (
        <span
          key={it.id}
          title={it.detail}
          className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 ${
            it.state === "up"
              ? "border-emerald-400/25 bg-emerald-500/10 text-emerald-200"
              : it.state === "down"
                ? "border-amber-400/35 bg-amber-500/10 text-amber-200"
                : "border-white/10 bg-white/[0.03] text-slate-300"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              it.state === "up" ? "bg-emerald-400" : it.state === "down" ? "bg-amber-400" : "bg-slate-400"
            }`}
          />
          <span>{it.label}</span>
          {it.detail && it.state !== "checking" && (
            <span className="mono text-[10px] opacity-80">
              {it.state === "cors" ? "(CORS)" : it.detail.split(" · ")[0]}
            </span>
          )}
        </span>
      ))}
      <button
        type="button"
        onClick={() => void runChecks()}
        disabled={busy}
        title="Re-check upstream NASA/ESA/CDS data sources"
        className="ml-auto inline-flex items-center gap-1 rounded border border-white/10 px-2 py-0.5 text-[10px] text-slate-300 hover:bg-white/5 disabled:opacity-40"
      >
        <RefreshCw size={10} className={busy ? "animate-spin" : ""} />
        {busy ? "Checking…" : "Ping"}
      </button>
    </div>
  );
}
