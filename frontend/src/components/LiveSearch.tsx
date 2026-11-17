import { useEffect, useRef, useState } from "react";
import { Loader2, Search, Shuffle, X } from "lucide-react";
import { looksLikeCoords, parseCoords, pickRandomSpot } from "../lib/coords";
import { cancelJob, claimAutostart, FORCE_BROWSER, jobStatus, liveAvailable, resolveName, startField, type JobView } from "../lib/live";
import { formatDec, formatRa } from "../lib/wcs";
import { BrowserFetch } from "./BrowserFetch";
import { TargetListStepper } from "./TargetListStepper";

export interface LiveResult {
  id: string;
  name: string;
  ra: number;
  dec: number;
  fov: number;
  /** built in this browser (no server) */
  browser?: boolean;
  /** opened from files someone shared */
  shared?: boolean;
  /** pre-baked backup bundle base URL */
  base?: string;
}

export type SourceMode = "auto" | "browser" | "server";

interface Props {
  onReady: (r: LiveResult) => void;
  /** start immediately (from ?ra=&dec=&fov= in the URL) */
  autostart?: { ra: number; dec: number; fov: number; name?: string } | null;
  sourceMode?: SourceMode;
  serverOnline?: boolean | null;
  onSwitchMode?: (m: SourceMode) => void;
  onCheckServer?: () => void;
  onUpstream502?: (active: boolean) => void;
  jumpCoords?: { ra: number; dec: number; seq: number } | null;
}

/**
 * "Any spot in the sky": a name or coordinates plus a field size, fetched live from NASA's archives by the
 * local server, processed with the same pipeline as the built-in targets.
 */
export function LiveSearch({ onReady, autostart, sourceMode = "auto", serverOnline, onSwitchMode, onCheckServer, onUpstream502, jumpCoords }: Props) {
  const [text, setText] = useState("");
  const [fov, setFov] = useState(5);
  const [quick, setQuick] = useState(true);
  const [localAvail, setLocalAvail] = useState<boolean | null>(null);
  const [job, setJob] = useState<JobView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ name: string; ra: number; dec: number; fov: number } | null>(null);

  useEffect(() => {
    if (serverOnline !== undefined) return;
    if (FORCE_BROWSER) setLocalAvail(false);
    else liveAvailable().then(setLocalAvail);
  }, [serverOnline]);

  const available = serverOnline !== undefined ? serverOnline : localAvail;

  const go = async (ra: number, dec: number, f: number, name: string) => {
    setErr(null);
    setBusy(true);
    pending.current = { name, ra, dec, fov: f };
    try {
      setJob(await startField({ ra, dec, fov: f, quick, name }));
    } catch (e) {
      setErr(String((e as Error).message));
      setBusy(false);
    }
  };

  // URL autostart, once the server is known to be there
  useEffect(() => {
    if (autostart && available && claimAutostart()) {
      setFov(autostart.fov);
      setText(autostart.name || `${autostart.ra.toFixed(5)} ${autostart.dec.toFixed(5)}`);
      void go(autostart.ra, autostart.dec, autostart.fov, autostart.name ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autostart, available]);

  // poll the job (setTimeout, so it keeps working while rAF is paused)
  useEffect(() => {
    if (!job || job.status === "done" || job.status === "error" || job.status === "cancelled" || job.status === "unknown") {
      if (job?.status === "done" && pending.current) {
        onUpstream502?.(false);
        onReady({ id: job.id, ...pending.current });
        pending.current = null;
      } else if (job?.status === "error" && (job.upstream_502 || /502|Bad Gateway/i.test(job.error ?? ""))) {
        onUpstream502?.(true);
      }
      if (job && job.status !== "queued" && job.status !== "running") setBusy(false);
      return;
    }
    const t = window.setTimeout(async () => {
      try {
        setJob(await jobStatus(job.id));
      } catch (e) {
        setErr(String((e as Error).message));
        setBusy(false);
      }
    }, 1500);
    return () => window.clearTimeout(t);
  }, [job, onReady]);

  const submit = async () => {
    const s = text.trim();
    if (!s) return;
    if (looksLikeCoords(s)) {
      const p = parseCoords(s);
      if (!p) return setErr("Couldn't read those coordinates. Try “08h55m10.8s -07d14m42.5s” or “133.795 -7.245”.");
      return go(p.ra, p.dec, fov, "");
    }
    setBusy(true);
    try {
      const r = await resolveName(s);
      await go(r.ra, r.dec, fov, r.name);
    } catch (e) {
      setErr(String((e as Error).message));
      setBusy(false);
    }
  };

  const useBrowser = FORCE_BROWSER || sourceMode === "browser" || (sourceMode === "auto" && available === false);

  useEffect(() => {
    if (!jumpCoords || useBrowser || !available) return;
    setText(`${jumpCoords.ra.toFixed(5)} ${jumpCoords.dec.toFixed(5)}`);
    void go(jumpCoords.ra, jumpCoords.dec, fov, "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpCoords?.seq]);

  // browser-only mode (explicitly chosen, ?browser, or auto fallback when local server is offline)
  if (useBrowser) {
    return <BrowserFetch onReady={onReady} autostart={autostart} jumpCoords={jumpCoords} />;
  }
  if (sourceMode === "server" && available === false) {
    return (
      <div className="mx-4 mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
        <span>
          Local server (<code className="mono">127.0.0.1:8091</code>) is not running. Start it with{" "}
          <code className="mono rounded bg-black/30 px-1.5 py-0.5">uv run python -m spherex_blink serve</code>.
        </span>
        <div className="flex gap-2">
          {onCheckServer && (
            <button type="button" onClick={onCheckServer} className="rounded border border-amber-300/40 px-2.5 py-1 hover:bg-amber-400/15">
              Retry
            </button>
          )}
          {onSwitchMode && (
            <button type="button" onClick={() => onSwitchMode("browser")} className="rounded bg-sky-400 px-2.5 py-1 font-medium text-slate-950 hover:bg-sky-300">
              Use browser mode instead
            </button>
          )}
        </div>
      </div>
    );
  }

  const last = job?.log.at(-1);
  return (
    <div className="mx-4 mb-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="flex min-w-[220px] flex-1 items-center gap-2 rounded-md border border-white/15 bg-slate-950/60 px-2">
          <Search size={14} className="text-slate-400" />
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Any spot: a name (R Draconis) or coordinates (08h55m10.8s -07d14m42.5s)"
            aria-label="Object name or sky coordinates"
            className="w-full bg-transparent py-1.5 text-sm text-white placeholder:text-slate-400 focus:outline-none"
            disabled={busy || available === null}
          />
        </label>
        <button
          type="button"
          disabled={busy || available === null}
          onClick={() => setText(pickRandomSpot(text).coords)}
          title="Fill random working sky coordinates"
          aria-label="Random sky coordinates"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-white/15 bg-slate-950/60 text-slate-300 hover:border-sky-400/50 hover:text-sky-200 disabled:opacity-40"
        >
          <Shuffle size={14} />
        </button>
        <label className="flex items-center gap-2 text-xs text-slate-300" title="Bigger fields catch faster movers but take longer to fetch">
          Field
          <input type="range" min={2} max={15} step={1} value={fov} onChange={(e) => setFov(Number(e.target.value))} disabled={busy} className="w-24" />
          <span className="mono w-8">{fov}′</span>
        </label>
        <label className="flex items-center gap-1 text-xs text-slate-300" title="Quick look: up to 6 visits, 4 exposures per visit and detector (about 1–3 minutes). Full: all visits.">
          <input type="checkbox" checked={!quick} onChange={(e) => setQuick(!e.target.checked)} disabled={busy} />
          all data (slower)
        </label>
        {busy ? (
          <button type="button" onClick={() => job && cancelJob(job.id).then(setJob)} className="inline-flex items-center gap-1 rounded-md border border-white/15 px-3 py-1.5 text-xs text-slate-200 hover:bg-white/5">
            <X size={13} /> Stop
          </button>
        ) : (
          <>
            <TargetListStepper
              disabled={available === null}
              onSelect={(q) => {
                setText(q);
              }}
            />
            <button type="submit" disabled={available === null} className="rounded-md bg-sky-400 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-sky-300 disabled:opacity-40">
              Fetch from NASA
            </button>
          </>
        )}
      </form>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
        <span>Try:</span>
        {["Teegarden's Star", "NGC 1333", "Orion Nebula", "Vega"].map((q) => (
          <button
            key={q}
            type="button"
            disabled={busy || available === null}
            onClick={() => setText(q)}
            className="rounded border border-white/10 bg-white/[0.03] px-2 py-0.5 text-slate-300 hover:border-sky-400/40 hover:text-sky-200 disabled:opacity-40"
          >
            {q}
          </button>
        ))}
      </div>
      {(busy || job || err) && (
        <p className="mt-1.5 flex items-center gap-2 text-xs text-slate-300" aria-live="polite">
          {busy && <Loader2 size={13} className="animate-spin text-sky-300" />}
          {err ? (
            <span className="text-amber-300">{err}</span>
          ) : job?.status === "queued" ? (
            `Waiting for another fetch to finish (number ${job.position} in line)…`
          ) : job?.status === "running" ? (
            <>
              {pending.current && (
                <span className="mono text-slate-400">
                  {formatRa(pending.current.ra)} {formatDec(pending.current.dec)} ·{" "}
                </span>
              )}
              {last ?? "starting…"}
            </>
          ) : job?.status === "error" ? (
            <span className="text-amber-300">
              {job.upstream_502 || /502|Bad Gateway/i.test(job.error ?? "")
                ? "IRSA's live search returned HTTP 502 (Bad Gateway) — showing offline/mirror baked targets instead."
                : `Couldn't build this field: ${job.error}`}
            </span>
          ) : job?.status === "cancelled" ? (
            "Stopped."
          ) : job?.status === "done" ? (
            "Ready."
          ) : null}
        </p>
      )}
    </div>
  );
}
