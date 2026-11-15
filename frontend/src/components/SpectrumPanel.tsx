import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Send, Square, Volume2, X } from "lucide-react";
import { buildEcsv, download as saveFile } from "../lib/fitsio";
import { sendViaSamp } from "../lib/samp";
import { mjdToYear as yearOf } from "../lib/astro";
import { describeLightCurve, describeSpectrum, detrendByWavelength, playPlan, sonifyPlan, stopSound } from "../lib/sonify";
import type { Epoch, ExposureInfo } from "../lib/bundle";
import { attachExposureMeta, convertFlux, defaultMeasure, FLAG_OK, FLUX_UNIT_LABELS, MEASURE_NOTES, REFERENCE_BANDS, points, preferRing, toCsv, type FluxUnit, type Measure, type Point, type Spectra, type SpectraSource } from "../lib/spectra";
import type { MapSpectrum, Mix } from "../lib/colour";
import { formatMjdRange, mjdToDate, mjdToYear } from "../lib/astro";
import { formatNumber, logTicks, niceTicks, robustRange } from "../lib/ticks";

// Dark-mode categorical slots 1–4 (validated on this panel's surface; direct labels are the secondary encoding).
const VISIT_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500"];
// Ordinal blue ramp for more than four visits (deep-field time bins) and for wavelength in the light curve.
const BLUE_RAMP = ["#86b6ef", "#6da7ec", "#5598e7", "#3987e5", "#2a78d6", "#256abf", "#1c5cab", "#184f95"];

export const visitColor = (e: number, nVisits: number) =>
  nVisits <= VISIT_COLORS.length ? VISIT_COLORS[e] ?? "#94a3b8" : BLUE_RAMP[Math.round((e / Math.max(1, nVisits - 1)) * (BLUE_RAMP.length - 1))];

const rampAt = (t: number) => BLUE_RAMP[Math.round(Math.min(1, Math.max(0, t)) * (BLUE_RAMP.length - 1))];

export type PanelTab = "spectrum" | "lightcurve" | "table";

export interface MapOverlay {
  spectrum: MapSpectrum | null; // null when suppressed
  caveat: string | null;
  label: string;
}

interface Props {
  spectra: Spectra | null;
  /** a baked source with per-exposure measurements, or null for "any point on the map" */
  source: SpectraSource | null;
  title?: string;
  map?: MapOverlay | null;
  epochs: Epoch[];
  detectors: { detector: number; wl_min: number; wl_max: number }[];
  band: number;
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  onClose: () => void;
  children?: React.ReactNode; // extra tools (motion fit)
  /** ?silent: never make sound */
  silent?: boolean;
  /** Colour mode: the three wavelength windows, shaded on the spectrum */
  colourWindows?: Mix | null;
  /** Colour mode: why this source has the colour it has */
  colourNote?: string | null;
  /** Optional exposure list from meta.json for obs_id & IRSA URL provenance */
  exposures?: ExposureInfo[];
}

export function SpectrumPanel({ spectra, source, title, map, epochs, detectors, band, tab, onTab, onClose, children, silent = false, colourWindows = null, colourNote = null, exposures }: Props) {
  const firstMeasure = (): Measure => (spectra && source && preferRing(spectra, source) ? "ring" : source ? defaultMeasure(source) : "core");
  const [lcMeasure, setLcMeasure] = useState<Measure>(firstMeasure);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setLcMeasure(firstMeasure()), [spectra, source]);
  // the spectrum never uses the ring (its share of the light changes with wavelength)
  const specMeasure: Measure = lcMeasure === "ring" ? (source ? defaultMeasure(source) : "core") : lcMeasure;
  const pts = useMemo(() => (spectra && source ? attachExposureMeta(points(spectra, source, specMeasure), exposures) : []), [spectra, source, specMeasure, exposures]);
  const nGood = pts.filter((p) => p.flag === FLAG_OK).length;
  const [lcBand, setLcBand] = useState(band);
  useEffect(() => setLcBand(band), [band]);
  const [logY, setLogY] = useState(false);
  const [unit, setUnit] = useState<FluxUnit>("mjy");
  const hasRing = !!source?.wing_flux;
  const lcPts = useMemo(() => (spectra && source ? attachExposureMeta(points(spectra, source, lcMeasure), exposures) : []), [spectra, source, lcMeasure, exposures]);
  const tabs = source ? (["spectrum", "lightcurve", "table"] as const) : (["spectrum"] as const);
  const shownTab: PanelTab = source ? tab : "spectrum";

  const [playing, setPlaying] = useState(false);
  useEffect(() => () => stopSound(), []);
  const lcDet = lcPts.filter((p) => p.det === lcBand);
  const mapPts: Point[] = map?.spectrum
    ? map.spectrum.wl.flatMap((w, i) => {
        const f = map.spectrum!.flux[i];
        return f === null ? [] : [{ i, mjd: 0, wl: w, bw: null, flux: f, err: 0, flag: 0, det: 0, epoch: -1 }];
      })
    : [];
  const words =
    shownTab === "lightcurve"
      ? describeLightCurve(lcDet)
      : shownTab === "spectrum"
        ? describeSpectrum(pts.length ? pts : mapPts.flatMap((p) => [p, { ...p, i: p.i + 1000 }]))
        : "";
  const listen = () => {
    if (playing) {
      stopSound();
      setPlaying(false);
      return;
    }
    let notes;
    if (shownTab === "lightcurve") {
      const rel = detrendByWavelength(lcDet);
      notes = sonifyPlan(rel.map((r) => r.mjd), rel.map((r) => r.rel));
    } else {
      const src = (pts.length ? pts.filter((p) => p.flag === 0) : mapPts).slice().sort((a, b) => a.wl - b.wl);
      notes = sonifyPlan(src.map((p) => p.wl), src.map((p) => p.flux));
    }
    if (playPlan(notes, silent)) {
      setPlaying(true);
      window.setTimeout(() => setPlaying(false), 3100);
    }
  };

  const download = () => {
    const csv = source
      ? toCsv(source, pts, specMeasure)
      : `# ${title}; SPHEREx all-sky map spectrum, 15.4" aperture, local sky removed\nwavelength_um,flux_mJy\n${(map?.spectrum?.wl ?? [])
          .map((w, i) => `${w},${map?.spectrum?.flux[i] ?? ""}`)
          .join("\n")}\n`;
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${source?.id ?? "map-point"}-spherex.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  // ECSV: astropy's self-describing table (units, types, flags), so the numbers keep their meaning
  const currentEcsvPayload = (): { filename: string; text: string } | null => {
    const name = source?.name ?? title ?? "map point";
    if (source) {
      return {
        filename: `${source.id}-spherex.ecsv`,
        text: buildEcsv(
          [
            { name: "mjd", datatype: "float64", unit: "d", description: "mid-exposure date", values: pts.map((p) => p.mjd) },
            { name: "year", datatype: "float64", unit: "yr", values: pts.map((p) => Number(yearOf(p.mjd).toFixed(5))) },
            { name: "visit", datatype: "int32", values: pts.map((p) => p.epoch + 1) },
            { name: "detector", datatype: "int32", values: pts.map((p) => p.det) },
            { name: "wavelength", datatype: "float64", unit: "um", description: "filter centre at the source's pixel", values: pts.map((p) => p.wl) },
            { name: "bandwidth", datatype: "float64", unit: "um", values: pts.map((p) => p.bw) },
            { name: "flux", datatype: "float64", unit: "mJy", description: MEASURE_NOTES[specMeasure], values: pts.map((p) => p.flux) },
            { name: "flux_err", datatype: "float64", unit: "mJy", values: pts.map((p) => p.err) },
            { name: "flag", datatype: "int32", description: "0 ok, 1 masked pixel in aperture, 2 saturated pixel in aperture", values: pts.map((p) => p.flag) },
            { name: "obs_id", datatype: "string", description: "IRSA SPHEREx observation ID", values: pts.map((p) => p.obs_id ?? "") },
          ],
          {
            source: name,
            gaia_dr3: source.gaia_id ?? "",
            data: "SPHEREx DR1+QR3 single exposures via NASA/IPAC IRSA (doi:10.26131/IRSA678, doi:10.26131/IRSA662)",
            produced_by: "SPHEREx Blink",
          },
        ),
      };
    } else if (map?.spectrum) {
      return {
        filename: "map-point-spherex.ecsv",
        text: buildEcsv(
          [
            { name: "wavelength", datatype: "float64", unit: "um", values: map.spectrum.wl },
            { name: "flux", datatype: "float64", unit: "mJy", description: "15.4 arcsec aperture on the time-averaged map, local sky subtracted", values: map.spectrum.flux },
          ],
          { source: name, data: "SPHEREx 102-channel map (time-averaged)", produced_by: "SPHEREx Blink" },
        ),
      };
    }
    return null;
  };

  const downloadEcsv = () => {
    const p = currentEcsvPayload();
    if (p) saveFile(p.filename, p.text, "text/plain");
  };

  const [sampMsg, setSampMsg] = useState<string | null>(null);
  const sendSamp = async () => {
    const p = currentEcsvPayload();
    if (!p) return;
    try {
      await sendViaSamp({ filename: p.filename, data: p.text, contentType: "text/plain", mtype: "table.load.votable", label: p.filename });
      setSampMsg("Sent table to SAMP hub");
    } catch (e) {
      setSampMsg(e instanceof Error ? e.message : String(e));
    }
    window.setTimeout(() => setSampMsg(null), 5000);
  };

  return (
    <section className="panel flex h-full flex-col rounded-t p-3 text-sm" aria-label="Spectrum and light curve">
      <header className="mb-2 flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold text-slate-100">{source?.name ?? title}</h2>
          <p className="text-xs text-slate-400">
            {source
              ? `${pts.length} single-exposure measurements · ${nGood} unflagged${source.g !== null ? ` · Gaia G = ${source.g.toFixed(1)}` : ""}`
              : "Any point on the map: its spectrum from SPHEREx's all-sky map"}
          </p>
        </div>
        <div className="flex gap-1 rounded border border-sky-400/20 p-0.5" role="tablist">
          {tabs.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={shownTab === t}
              onClick={() => onTab(t)}
              className={`rounded px-2 py-0.5 text-xs ${shownTab === t ? "bg-sky-400/20 text-sky-100" : "text-slate-400 hover:text-slate-200"}`}
            >
              {t === "spectrum" ? "Spectrum" : t === "lightcurve" ? "Light curve" : "Table"}
            </button>
          ))}
        </div>
        {shownTab !== "table" && (
          <button
            onClick={listen}
            disabled={silent}
            title={silent ? "Sound is off on this page (?silent)" : shownTab === "lightcurve" ? "Listen: pitch follows brightness over time" : "Listen: pitch follows brightness from short to long wavelength; dips sound as drops"}
            aria-label={playing ? "Stop sound" : "Listen to this chart"}
            className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-slate-300 hover:bg-sky-400/10 disabled:opacity-40"
          >
            {playing ? <Square size={13} /> : <Volume2 size={14} />} {playing ? "Stop" : "Listen"}
          </button>
        )}
        <button title="Download CSV (spreadsheets)" aria-label="Download CSV" onClick={download} className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-slate-300 hover:bg-sky-400/10">
          <Download size={13} /> CSV
        </button>
        <button
          title="Download ECSV: units, types and flags included; opens with astropy's Table.read"
          aria-label="Download ECSV"
          onClick={downloadEcsv}
          className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-slate-300 hover:bg-sky-400/10"
        >
          <Download size={13} /> ECSV
        </button>
        <button
          title="Send ECSV table to TOPCAT / Aladin via Web SAMP (requires local server)"
          aria-label="Send table via SAMP"
          onClick={sendSamp}
          className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-slate-300 hover:bg-sky-400/10"
        >
          <Send size={12} /> SAMP
        </button>
        <button title="Close" aria-label="Close" onClick={onClose} className="rounded p-1 text-slate-300 hover:bg-sky-400/10">
          <X size={14} />
        </button>
      </header>
      {sampMsg && <p className="mb-1 text-[11px] text-sky-200">{sampMsg}</p>}
      {children}
      {pts.length > 0 && nGood < pts.length * 0.2 && !(shownTab === "lightcurve" && lcMeasure === "ring") && (
        <p className="mb-1 text-[11px] text-amber-300">
          Most measurements touch saturated or masked pixels (hollow dots): this star is too bright for SPHEREx at most wavelengths, so the
          shape and level are not reliable. Field stars and fainter targets give clean spectra.
        </p>
      )}
      {shownTab === "spectrum" && map?.caveat && <p className="mb-1 text-[11px] text-slate-400">Map spectrum hidden: {map.caveat}</p>}
      <div className="min-h-0 flex-1">
        {pts.length === 0 && !map?.spectrum ? (
          <p className="p-4 text-xs text-slate-400">No usable measurements here.</p>
        ) : shownTab === "spectrum" ? (
          <SpectrumChart
            pts={pts}
            epochs={epochs}
            detectors={detectors}
            logY={logY}
            unit={unit}
            map={map?.spectrum ? { ...map.spectrum, label: map.label } : null}
            windows={colourWindows}
          />
        ) : shownTab === "lightcurve" ? (
          <LightCurveChart pts={lcPts.filter((p) => p.det === lcBand)} det={detectors[lcBand - 1]} />
        ) : (
          <PointTable pts={pts} />
        )}
      </div>
      {shownTab === "spectrum" && colourNote && <p className="mt-1 text-xs font-medium text-emerald-200">{colourNote}</p>}
      {words && <p className="mt-1 text-xs text-slate-200">{words}</p>}
      <footer className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
        {shownTab === "spectrum" && (
          <>
            <span className="flex items-center gap-1">
              {(["mjy", "abmag", "nufnu"] as const).map((u) => (
                <button
                  key={u}
                  onClick={() => setUnit(u)}
                  aria-pressed={unit === u}
                  className={`rounded border px-1.5 ${unit === u ? "border-sky-400 text-sky-200" : "border-sky-400/20 text-slate-400"}`}
                >
                  {u === "mjy" ? "mJy" : u === "abmag" ? "AB mag" : "λF_λ"}
                </button>
              ))}
            </span>
            {unit !== "abmag" && (
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={logY} onChange={(e) => setLogY(e.target.checked)} /> log flux
              </label>
            )}
          </>
        )}
        {source && (hasRing || source.psf_flux) && (
          <span className="flex items-center gap-1" title={spectra?.wing_note}>
            Measure
            {([...(source.psf_flux ? ["psf"] : []), "core", ...(shownTab === "lightcurve" && hasRing ? ["ring"] : [])] as Measure[]).map((k) => (
              <button
                key={k}
                onClick={() => setLcMeasure(k)}
                aria-pressed={(shownTab === "lightcurve" ? lcMeasure : specMeasure) === k}
                title={MEASURE_NOTES[k]}
                className={`rounded border px-1.5 ${(shownTab === "lightcurve" ? lcMeasure : specMeasure) === k ? "border-sky-400 text-sky-200" : "border-sky-400/20 text-slate-400"}`}
              >
                {k === "psf" ? "PSF fit" : k === "core" ? "Aperture" : "Ring (saturated stars)"}
              </button>
            ))}
          </span>
        )}
        {shownTab === "lightcurve" && (
          <span className="flex items-center gap-1">
            Detector
            {detectors.map((d) => (
              <button
                key={d.detector}
                onClick={() => setLcBand(d.detector)}
                className={`mono rounded border px-1.5 ${lcBand === d.detector ? "border-sky-400 text-sky-200" : "border-sky-400/20 text-slate-400"}`}
              >
                D{d.detector}
              </button>
            ))}
          </span>
        )}
        <span>
          {shownTab === "lightcurve" && lcMeasure === "ring" && spectra?.wing_arcsec
            ? `Ring ${spectra.wing_arcsec[0].toFixed(0)}–${spectra.wing_arcsec[1].toFixed(0)}″ around the saturated core: tracks brightness over time; the ring holds a different share of the light at each wavelength, so compare dates within one detector only.`
            : `${MEASURE_NOTES[specMeasure]}${spectra?.error_model ? " Error bars include a correction measured on steady stars." : ""}`}
        </span>
      </footer>
    </section>
  );
}

// ------------------------------------------------------------------ shared chart plumbing

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 600, h: 260 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth || 600, h: Math.max(180, el.clientHeight || 260) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

const M = { l: 52, r: 14, t: 26, b: 30 };

interface Hover {
  p: Point;
  sx: number;
  sy: number;
}

function Tooltip({ h, w, color }: { h: Hover; w: number; color: string }) {
  const left = h.sx > w - 200 ? h.sx - 196 : h.sx + 12;
  return (
    <div className="pointer-events-none absolute z-10 w-48 rounded border border-sky-400/30 bg-slate-950/95 p-2 text-[11px] leading-tight" style={{ left, top: Math.max(0, h.sy - 30) }}>
      <div className="mb-1 flex items-center gap-1.5 text-slate-300">
        <span className="inline-block h-2 w-2 rounded-full" style={{ background: color }} />
        Visit {h.p.epoch + 1} · D{h.p.det}
      </div>
      <div className="mono text-slate-100">{h.p.wl.toFixed(3)} µm{h.p.bw ? ` (Δ ${h.p.bw.toFixed(3)})` : ""}</div>
      <div className="mono text-slate-100">
        {formatNumber(h.p.flux)} ± {formatNumber(h.p.err)} mJy
      </div>
      <div className="mono text-slate-400">{mjdToDate(h.p.mjd).toISOString().slice(0, 10)} · MJD {h.p.mjd.toFixed(2)}</div>
      {h.p.obs_id && <div className="mono truncate text-slate-400">{h.p.obs_id}</div>}
      {h.p.flag !== FLAG_OK && <div className="mt-1 text-amber-300">{h.p.flag === 2 ? "Saturated pixel in aperture" : "Masked pixel in aperture"}</div>}
    </div>
  );
}

function nearest<T>(pts: T[], sx: (p: T) => number, sy: (p: T) => number, mx: number, my: number, max = 14): T | null {
  let best: T | null = null;
  let bd = max;
  for (const p of pts) {
    const d = Math.hypot(sx(p) - mx, sy(p) - my);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best;
}

// ------------------------------------------------------------------ spectrum

const MAP_COLOUR = "#f0efec";
const WIN_FILL = { r: "rgba(239,68,68,0.16)", g: "rgba(34,197,94,0.16)", b: "rgba(59,130,246,0.18)" };
const WIN_TEXT = { r: "#fca5a5", g: "#86efac", b: "#93c5fd" };

function SpectrumChart({
  pts,
  epochs,
  detectors,
  logY,
  unit,
  map,
  windows = null,
}: {
  pts: Point[];
  epochs: Epoch[];
  detectors: Props["detectors"];
  logY: boolean;
  unit: FluxUnit;
  map: (MapSpectrum & { label: string }) | null;
  windows?: Mix | null;
}) {
  const [ref, { w, h }] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<Hover | null>(null);
  const nV = epochs.length;
  const converted = useMemo(
    () =>
      pts.flatMap((p) => {
        const c = convertFlux(p.flux, p.err, p.wl, unit);
        return c ? [{ p, ...c }] : [];
      }),
    [pts, unit],
  );
  const good = converted.filter((d) => d.p.flag === FLAG_OK);
  const mapConv = useMemo(
    () =>
      map
        ? {
            ...map,
            flux: map.flux.map((v, i) => (v === null ? null : (convertFlux(v, 0, map.wl[i], unit)?.value ?? null))),
          }
        : null,
    [map, unit],
  );
  const mapVals = (mapConv?.flux ?? []).filter((v): v is number => v !== null && Number.isFinite(v));
  const yVals = (good.length >= 5 ? good : converted).map((d) => d.value).concat(mapVals);
  let [y0, y1] = robustRange(yVals);
  if (logY && unit !== "abmag") {
    const pos = yVals.filter((v) => v > 0).sort((a, b) => a - b);
    y0 = pos.length ? pos[0] * 0.7 : 0.01;
    y1 = pos.length ? pos[pos.length - 1] * 1.4 : 1;
  }
  const x0 = 0.7;
  const x1 = 5.05;
  const iw = w - M.l - M.r;
  const ih = h - M.t - M.b;
  const sx = (wl: number) => M.l + ((wl - x0) / (x1 - x0)) * iw;
  const sy = (v: number) => {
    if (unit === "abmag") {
      // Astronomer convention: brighter (smaller mag) at the top.
      return M.t + ((v - y0) / (y1 - y0)) * ih;
    }
    if (logY) {
      const t = (Math.log10(Math.max(v, y0)) - Math.log10(y0)) / (Math.log10(y1) - Math.log10(y0));
      return M.t + (1 - t) * ih;
    }
    return M.t + (1 - (v - y0) / (y1 - y0)) * ih;
  };
  const clampY = (v: number) => Math.min(M.t + ih, Math.max(M.t, sy(v)));
  const yt = logY && unit !== "abmag" ? logTicks(y0, y1) : niceTicks(y0, y1, 5);
  const visits = [...new Set(pts.map((p) => p.epoch))].filter((e) => e >= 0).sort((a, b) => a - b);

  // direct labels: each visit at its longest-wavelength unflagged point
  const labels = nV <= 4
    ? visits.map((e) => {
        const vp = converted.filter((d) => d.p.epoch === e && d.p.flag === FLAG_OK).sort((a, b) => b.p.wl - a.p.wl)[0];
        return vp ? { e, x: sx(vp.p.wl), y: clampY(vp.value) } : null;
      }).filter((l): l is { e: number; x: number; y: number } => !!l)
    : [];
  // keep labels apart vertically
  labels.sort((a, b) => a.y - b.y).forEach((l, i, arr) => {
    if (i && l.y - arr[i - 1].y < 12) l.y = arr[i - 1].y + 12;
  });

  return (
    <div className="flex h-full flex-col">
      <Legend
        items={visits
          .map((e) => ({ color: visitColor(e, nV), label: `V${e + 1} ${formatMjdRange(epochs[e].mjd_min, epochs[e].mjd_max)}` }))
          .concat(map ? [{ color: MAP_COLOUR, label: map.label }] : [])}
        extra={pts.length ? (converted.some((d) => d.upperLimit) ? "hollow = flagged · ▼ = 3σ limit" : "hollow = flagged") : undefined}
      />
      <div ref={ref} className="relative min-h-0 flex-1" onPointerLeave={() => setHover(null)}>
        <svg
          width={w}
          height={h}
          role="img"
          aria-label="Flux against wavelength for each SPHEREx exposure"
          onPointerMove={(ev) => {
            const r = (ev.currentTarget as SVGSVGElement).getBoundingClientRect();
            const d = nearest(converted, (q) => sx(q.p.wl), (q) => clampY(q.value), ev.clientX - r.left, ev.clientY - r.top);
            setHover(d ? { p: d.p, sx: sx(d.p.wl), sy: clampY(d.value) } : null);
          }}
        >
          {detectors.map((d, i) => (
            <g key={d.detector}>
              {i % 2 === 0 && <rect x={sx(d.wl_min)} y={M.t} width={sx(d.wl_max) - sx(d.wl_min)} height={ih} fill="rgba(148,163,184,0.05)" />}
              <text x={(sx(d.wl_min) + sx(d.wl_max)) / 2} y={M.t + ih - 4} textAnchor="middle" className="fill-slate-400 text-[10px]">
                D{d.detector}
              </text>
            </g>
          ))}
          {windows &&
            (["b", "g", "r"] as const).map((k) => (
              <g key={`win-${k}`}>
                <rect
                  x={sx(windows[k].lo)}
                  y={M.t}
                  width={Math.max(2, sx(windows[k].hi) - sx(windows[k].lo))}
                  height={ih}
                  fill={WIN_FILL[k]}
                />
                <text x={(sx(windows[k].lo) + sx(windows[k].hi)) / 2} y={M.t + 12} textAnchor="middle" className="text-[10px] font-semibold" fill={WIN_TEXT[k]}>
                  {k.toUpperCase()}
                </text>
              </g>
            ))}
          {REFERENCE_BANDS.map((b, i) => (
            <g key={`${b.label}${b.wl}`}>
              <line x1={sx(b.wl)} x2={sx(b.wl)} y1={M.t} y2={M.t + ih} stroke="rgba(148,163,184,0.25)" strokeDasharray="2 4" />
              <text x={sx(b.wl)} y={M.t - (i % 2 ? 4 : 14)} textAnchor="middle" className="fill-slate-400 text-[10px]">
                {b.label}
              </text>
            </g>
          ))}
          {yt.map((v) => (
            <g key={v}>
              <line x1={M.l} x2={M.l + iw} y1={sy(v)} y2={sy(v)} stroke="rgba(148,163,184,0.1)" />
              <text x={M.l - 6} y={sy(v) + 3} textAnchor="end" className="fill-slate-400 text-[10px]">
                {formatNumber(v)}
              </text>
            </g>
          ))}
          {niceTicks(1, 5, 4).map((v) => (
            <text key={v} x={sx(v)} y={M.t + ih + 14} textAnchor="middle" className="fill-slate-400 text-[10px]">
              {v}
            </text>
          ))}
          <text x={M.l + iw / 2} y={h - 3} textAnchor="middle" className="fill-slate-400 text-[10px]">
            wavelength (µm)
          </text>
          <text transform={`translate(11 ${M.t + ih / 2}) rotate(-90)`} textAnchor="middle" className="fill-slate-400 text-[10px]">
            {FLUX_UNIT_LABELS[unit]}
          </text>
          {mapConv && (
            <path
              d={mapPath(mapConv, sx, clampY)}
              fill="none"
              stroke={MAP_COLOUR}
              strokeOpacity={0.75}
              strokeWidth={2}
              strokeLinejoin="round"
              aria-label={mapConv.label}
            />
          )}
          <g>
            {converted.map(({ p, value, err, upperLimit }) => {
              const c = visitColor(p.epoch, nV);
              const x = sx(p.wl);
              const y = clampY(value);
              if (upperLimit) {
                // 3σ upper-limit downward triangle
                return (
                  <polygon
                    key={p.i}
                    points={`${x - 4},${y - 3} ${x + 4},${y - 3} ${x},${y + 4}`}
                    fill={p.flag === FLAG_OK ? c : "none"}
                    stroke={c}
                    strokeWidth={1.2}
                  />
                );
              }
              const e1 = clampY(value - err);
              const e2 = clampY(value + err);
              return (
                <g key={p.i}>
                  {Math.abs(e1 - e2) > 3 && <line x1={x} x2={x} y1={e1} y2={e2} stroke={c} strokeOpacity={0.5} />}
                  <circle cx={x} cy={y} r={4} fill={p.flag === FLAG_OK ? c : "none"} stroke={p.flag === FLAG_OK ? "#0b1019" : c} strokeWidth={p.flag === FLAG_OK ? 1 : 1.5} />
                </g>
              );
            })}
          </g>
          {labels.map((l) => (
            <text key={l.e} x={Math.min(l.x + 7, M.l + iw - 2)} y={l.y + 3} textAnchor={l.x + 30 > M.l + iw ? "end" : "start"} className="fill-slate-300 text-[10px]">
              V{l.e + 1}
            </text>
          ))}
          {hover && <circle cx={hover.sx} cy={hover.sy} r={7} fill="none" stroke="#f0efec" strokeWidth={1.5} />}
        </svg>
        {hover && <Tooltip h={hover} w={w} color={visitColor(hover.p.epoch, nV)} />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ light curve

function LightCurveChart({ pts, det }: { pts: Point[]; det: { detector: number; wl_min: number; wl_max: number } }) {
  const [ref, { w, h }] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<Hover | null>(null);
  if (!pts.length) return <p className="p-4 text-xs text-slate-400">No measurements on detector {det.detector}.</p>;
  const good = pts.filter((p) => p.flag === FLAG_OK);
  const [y0, y1] = robustRange((good.length >= 5 ? good : pts).map((p) => p.flux));
  const years = pts.map((p) => mjdToYear(p.mjd));
  const pad = Math.max(0.05, (Math.max(...years) - Math.min(...years)) * 0.04);
  const x0 = Math.min(...years) - pad;
  const x1 = Math.max(...years) + pad;
  const iw = w - M.l - M.r;
  const ih = h - M.t - M.b;
  const sx = (yr: number) => M.l + ((yr - x0) / (x1 - x0)) * iw;
  const sy = (v: number) => Math.min(M.t + ih, Math.max(M.t, M.t + (1 - (v - y0) / (y1 - y0)) * ih));
  const wlT = (wl: number) => (wl - det.wl_min) / (det.wl_max - det.wl_min);
  const xt = niceTicks(x0, x1, 5);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-1 pb-1 text-[11px] text-slate-400">
        <span>Colour = wavelength inside D{det.detector}:</span>
        <span className="mono">{det.wl_min}</span>
        <span className="h-2 w-24 rounded" style={{ background: `linear-gradient(90deg, ${BLUE_RAMP.join(",")})` }} />
        <span className="mono">{det.wl_max} µm</span>
        <span className="ml-auto">hollow = flagged</span>
      </div>
      <div ref={ref} className="relative min-h-0 flex-1" onPointerLeave={() => setHover(null)}>
        <svg
          width={w}
          height={h}
          role="img"
          aria-label={`Flux against date on detector ${det.detector}`}
          onPointerMove={(ev) => {
            const r = (ev.currentTarget as SVGSVGElement).getBoundingClientRect();
            const p = nearest(pts, (q) => sx(mjdToYear(q.mjd)), (q) => sy(q.flux), ev.clientX - r.left, ev.clientY - r.top);
            setHover(p ? { p, sx: sx(mjdToYear(p.mjd)), sy: sy(p.flux) } : null);
          }}
        >
          {niceTicks(y0, y1, 5).map((v) => (
            <g key={v}>
              <line x1={M.l} x2={M.l + iw} y1={sy(v)} y2={sy(v)} stroke="rgba(148,163,184,0.1)" />
              <text x={M.l - 6} y={sy(v) + 3} textAnchor="end" className="fill-slate-400 text-[10px]">
                {formatNumber(v)}
              </text>
            </g>
          ))}
          {xt.map((v) => (
            <text key={v} x={sx(v)} y={M.t + ih + 14} textAnchor="middle" className="fill-slate-400 text-[10px]">
              {v.toFixed(xt.length > 1 && xt[1] - xt[0] < 1 ? 1 : 0)}
            </text>
          ))}
          <text x={M.l + iw / 2} y={h - 3} textAnchor="middle" className="fill-slate-400 text-[10px]">
            year
          </text>
          <text transform={`translate(11 ${M.t + ih / 2}) rotate(-90)`} textAnchor="middle" className="fill-slate-400 text-[10px]">
            flux (mJy)
          </text>
          {pts.map((p) => {
            const c = rampAt(wlT(p.wl));
            const x = sx(mjdToYear(p.mjd));
            const y = sy(p.flux);
            return (
              <g key={p.i}>
                {sy(p.flux - p.err) - sy(p.flux + p.err) > 3 && <line x1={x} x2={x} y1={sy(p.flux - p.err)} y2={sy(p.flux + p.err)} stroke={c} strokeOpacity={0.5} />}
                <circle cx={x} cy={y} r={4} fill={p.flag === FLAG_OK ? c : "none"} stroke={p.flag === FLAG_OK ? "#0b1019" : c} strokeWidth={p.flag === FLAG_OK ? 1 : 1.5} />
              </g>
            );
          })}
          {hover && <circle cx={hover.sx} cy={hover.sy} r={7} fill="none" stroke="#f0efec" strokeWidth={1.5} />}
        </svg>
        {hover && <Tooltip h={hover} w={w} color={rampAt(wlT(hover.p.wl))} />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ table

function PointTable({ pts }: { pts: Point[] }) {
  return (
    <div className="h-full overflow-auto">
      <table className="mono w-full text-[11px]">
        <thead className="sticky top-0 bg-slate-950 text-left text-slate-400">
          <tr>
            <th className="px-2 py-1">date</th>
            <th className="px-2">visit</th>
            <th className="px-2">det</th>
            <th className="px-2 text-right">λ µm</th>
            <th className="px-2 text-right">flux mJy</th>
            <th className="px-2 text-right">± mJy</th>
            <th className="px-2">flag</th>
            <th className="px-2">obs_id</th>
          </tr>
        </thead>
        <tbody>
          {[...pts]
            .sort((a, b) => a.wl - b.wl)
            .map((p) => (
              <tr key={p.i} className="border-t border-sky-400/10 text-slate-200">
                <td className="px-2 py-0.5">{mjdToDate(p.mjd).toISOString().slice(0, 10)}</td>
                <td className="px-2">V{p.epoch + 1}</td>
                <td className="px-2">D{p.det}</td>
                <td className="px-2 text-right">{p.wl.toFixed(3)}</td>
                <td className="px-2 text-right">{formatNumber(p.flux)}</td>
                <td className="px-2 text-right">{formatNumber(p.err)}</td>
                <td className="px-2 text-amber-300">{p.flag === 2 ? "saturated" : p.flag === 1 ? "masked" : ""}</td>
                <td className="px-2 text-slate-400">
                  {p.obs_id ? (
                    p.url ? (
                      <a href={p.url} target="_blank" rel="noreferrer" className="hover:text-sky-300 hover:underline">
                        {p.obs_id}
                      </a>
                    ) : (
                      p.obs_id
                    )
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

function Legend({ items, extra }: { items: { color: string; label: string }[]; extra?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 pb-1 text-[11px] text-slate-300">
      {items.map((it) => (
        <span key={it.label} className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: it.color }} />
          {it.label}
        </span>
      ))}
      {extra && <span className="ml-auto text-slate-400">{extra}</span>}
    </div>
  );
}

/** SVG path through the map spectrum, broken wherever a channel has no value. */
function mapPath(m: MapSpectrum, sx: (wl: number) => number, sy: (v: number) => number): string {
  let d = "";
  let pen = false;
  m.wl.forEach((wl, i) => {
    const f = m.flux[i];
    if (f === null || !Number.isFinite(f)) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${sx(wl).toFixed(1)},${sy(f).toFixed(1)}`;
    pen = true;
  });
  return d;
}
