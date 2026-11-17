import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw, TriangleAlert } from "lucide-react";
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
  onLearnMore?: () => void;
}

// Only endpoints that allow browser requests (CORS) are probed from a web page: for the others a failed
// request says nothing about whether the service is up, so they are listed as "can't check" instead.
// Checked 2026-11-16: S3, the HiPS mirrors and Sesame at CfA send Access-Control-Allow-Origin; IRSA and the
// Gaia TAP servers (ESA, ARI) answer but don't.
const NOT_CHECKABLE: SourceHealth[] = [
  { id: "irsa_sia", label: "IRSA SIA (SPHEREx)", state: "cors", detail: "Can't be checked from a web page (no CORS). Not needed for the built-in targets or the colour map." },
  { id: "esa_gaia", label: "Gaia DR3 (TAP)", state: "cors", detail: "Can't be checked from a web page (no CORS). Used only by the local server." },
];

const BROWSER_CHECKS: { id: string; label: string; urls: () => string[] }[] = [
  { id: "aws_s3", label: "AWS S3 (SPHEREx)", urls: () => ["https://nasa-irsa-spherex.s3.amazonaws.com/?list-type=2&max-keys=1"] },
  { id: "vizier_tap", label: "VizieR TAP (Mirror)", urls: () => ["https://tapvizier.cds.unistra.fr/TAPVizieR/tap/availability"] },
  {
    id: "aladin_hips",
    label: "Aladin HiPS",
    urls: () => [
      "https://hips.china-vo.org/m/CDS_P_allWISE_color/properties",
      "https://casda.csiro.au/hips/2MASS/Color/properties",
    ],
  },
  {
    id: "cds_sesame",
    label: "CDS Sesame (Names)",
    urls: () => [
      "https://vizier.cfa.harvard.edu/viz-bin/nph-sesame/-oI/SNV?Vega",
      "https://cds.unistra.fr/cgi-bin/nph-sesame/-oI/SNV?Vega",
      "https://vizier.idia.ac.za/viz-bin/nph-sesame/-oI/SNV?Vega",
    ],
  },
  { id: "data_mirror", label: "Data Repo Mirror", urls: () => [`${resolveRemoteDataRoot()}/index.json`] },
];

export function DataSourceStatus({ serverOnline, onUpstream502, onLearnMore }: Props) {
  const [items, setItems] = useState<SourceHealth[]>([]);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);

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

      // Browser / GitHub Pages mode: probe CORS-enabled endpoints directly (with mirrors); note IRSA SIA lacks CORS headers.
      const results = await Promise.all(
        BROWSER_CHECKS.map(async (c): Promise<SourceHealth> => {
          const urls = c.urls();
          let lastDetail = "Unreachable";
          for (let i = 0; i < urls.length; i++) {
            const t0 = performance.now();
            try {
              const res = await fetch(urls[i], { signal: AbortSignal.timeout(5000) });
              const ms = Math.round(performance.now() - t0);
              if (res.ok) {
                return {
                  id: c.id,
                  label: c.label,
                  state: "up",
                  detail: `${i > 0 ? "Mirror " : ""}HTTP ${res.status} · ${ms}ms`,
                };
              }
              lastDetail = `HTTP ${res.status} · ${ms}ms`;
            } catch (e) {
              lastDetail = e instanceof Error && e.name === "TimeoutError" ? "Timed out" : "Unreachable";
            }
          }
          return {
            id: c.id,
            label: c.label,
            state: "down",
            detail: lastDetail,
          };
        }),
      );
      setItems([...NOT_CHECKABLE, ...results]);
    } finally {
      setBusy(false);
    }
  }, [serverOnline, onUpstream502]);

  useEffect(() => {
    void runChecks();
  }, [runChecks]);

  const upCount = items.filter((i) => i.state === "up").length;
  const downCount = items.filter((i) => i.state === "down").length;
  const corsCount = items.filter((i) => i.state === "cors").length;
  // IRSA's search, as measured by the local server (null when it can't be measured, i.e. in the browser)
  const sia = items.find((i) => i.id === "irsa_sia");
  const siaDown = sia?.state === "down";

  return (
    <div className="relative inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/[0.03] px-2.5 py-1 text-xs text-slate-300">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="inline-flex items-center gap-1.5 font-medium text-slate-200 hover:text-white"
        title={expanded ? "Collapse data source details" : "Expand individual NASA/ESA/CDS archive checks"}
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>Sources:</span>
        <span className="inline-flex items-center gap-1.5 font-normal">
          {items.length === 0 ? (
            <span className="text-slate-400">Checking…</span>
          ) : (
            <>
              <span className="inline-flex items-center gap-1 text-emerald-300">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                {upCount} up
              </span>
              {downCount > 0 && (
                <span className="inline-flex items-center gap-1 text-amber-300">
                  · <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                  {downCount} down
                </span>
              )}
              {corsCount > 0 && <span className="text-slate-400">· {corsCount} can&apos;t check</span>}
            </>
          )}
        </span>
      </button>
      <button
        type="button"
        onClick={() => void runChecks()}
        disabled={busy}
        title="Re-check upstream NASA/ESA/CDS data sources"
        className="inline-flex items-center gap-1 rounded-full border border-white/10 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-white/10 disabled:opacity-40"
      >
        <RefreshCw size={10} className={busy ? "animate-spin" : ""} />
        {busy ? "…" : "Ping"}
      </button>
      {expanded && (
        <div className="panel absolute right-0 top-full z-40 mt-1.5 flex w-[min(42rem,calc(100vw-2rem))] flex-col gap-3 p-3 text-[11px] shadow-xl sm:flex-row sm:items-start">
          <div
            className={`shrink-0 rounded-md border p-2.5 sm:w-64 ${siaDown ? "border-amber-400/30 bg-amber-500/10 text-amber-100" : "border-white/10 bg-white/[0.03] text-slate-200"}`}
          >
            <div className={`flex items-start gap-1.5 font-semibold ${siaDown ? "text-amber-200" : "text-slate-100"}`}>
              {siaDown && <TriangleAlert size={13} className="mt-0.5 shrink-0" />}
              <span>{siaDown ? "IRSA's search isn't answering" : "Blinking a new spot"}</span>
            </div>
            <p className="mt-1 leading-relaxed opacity-90">
              {siaDown ? (
                <>
                  The local server just tried NASA/IPAC&apos;s <strong>IRSA SIA</strong> search and got {sia?.detail ?? "no answer"}. New spots can&apos;t be
                  blinked until it&apos;s back; the built-in targets and the <strong>Colour</strong> map (NASA&apos;s S3 copy) still work.
                </>
              ) : serverOnline ? (
                <>
                  New spots are found through NASA/IPAC&apos;s <strong>IRSA SIA</strong> search, which the local server queries for you.
                </>
              ) : (
                <>
                  Finding the exposures of a new spot needs NASA/IPAC&apos;s <strong>IRSA SIA</strong> search, which web pages aren&apos;t allowed to
                  call or check. The app gives you a link to open it in a new tab; if that page fails, IRSA is busy, so try again later. The built-in
                  targets and the <strong>Colour</strong> map (NASA&apos;s S3 copy) don&apos;t depend on it.
                </>
              )}
            </p>
            {onLearnMore && (
              <button
                type="button"
                onClick={() => {
                  setExpanded(false);
                  onLearnMore();
                }}
                className="mt-1.5 inline-flex items-center gap-1 font-medium text-sky-300 underline decoration-sky-400/50 underline-offset-2 hover:text-sky-200"
              >
                Learn more about each source →
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
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
                    {it.state === "cors" ? "can't check" : it.detail.split(" · ")[0]}
                  </span>
                )}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
