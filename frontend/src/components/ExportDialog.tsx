import { Camera, Download, Film, Grid2x2, Sparkles, X } from "lucide-react";
import type { ExportFormat, ExportLayout, ExportOptions } from "../lib/exportFigure";

interface Props {
  open: boolean;
  options: ExportOptions;
  onChange: (next: ExportOptions) => void;
  onExport: () => void;
  onClose: () => void;
  busy: boolean;
  hasCube: boolean;
  hasBlink: boolean;
  hasSpectrum: boolean;
  spectrumLabel?: string;
  fps: number;
}

export function ExportDialog({
  open,
  options,
  onChange,
  onExport,
  onClose,
  busy,
  hasCube,
  hasBlink,
  hasSpectrum,
  spectrumLabel,
  fps,
}: Props) {
  if (!open) return null;

  const setFormat = (format: ExportFormat) => onChange({ ...options, format });
  const setLayout = (layout: ExportLayout) => onChange({ ...options, layout });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-dialog-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="panel w-full max-w-md rounded-xl p-5 shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/10 pb-3">
          <div>
            <h2 id="export-dialog-title" className="text-base font-semibold text-white">
              Export Image / Animation
            </h2>
            <p className="text-xs text-slate-400">Choose layout, overlays, and metadata for slides or papers.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close export menu"
            className="rounded-md p-1 text-slate-400 hover:bg-white/10 hover:text-white disabled:opacity-40"
          >
            <X size={16} />
          </button>
        </div>

        <div className="mt-4 space-y-4 text-sm">
          {/* Format */}
          <div>
            <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">Format</span>
            <div className="mt-1.5 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setFormat("png")}
                aria-pressed={options.format === "png"}
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left transition ${
                  options.format === "png" ? "border-sky-400/70 bg-sky-400/15 text-white" : "border-white/10 bg-white/[0.02] text-slate-300 hover:bg-white/5"
                }`}
              >
                <Camera size={16} className="shrink-0 text-sky-300" />
                <div>
                  <div className="text-xs font-semibold">PNG Image</div>
                  <div className="text-[10px] text-slate-400">High-res static figure</div>
                </div>
              </button>
              <button
                type="button"
                disabled={!hasBlink}
                onClick={() => setFormat("gif")}
                aria-pressed={options.format === "gif"}
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left transition disabled:opacity-40 ${
                  options.format === "gif" ? "border-sky-400/70 bg-sky-400/15 text-white" : "border-white/10 bg-white/[0.02] text-slate-300 hover:bg-white/5"
                }`}
              >
                <Film size={16} className="shrink-0 text-amber-300" />
                <div>
                  <div className="text-xs font-semibold">Animated GIF</div>
                  <div className="text-[10px] text-slate-400">{hasBlink ? `Blink loop at ${fps}×` : "No time series"}</div>
                </div>
              </button>
            </div>
          </div>

          {/* Layout (PNG only) */}
          {options.format === "png" && (
            <div>
              <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">Layout</span>
              <div className="mt-1.5 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setLayout("current")}
                  aria-pressed={options.layout === "current"}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left transition ${
                    options.layout === "current" ? "border-emerald-400/60 bg-emerald-400/10 text-white" : "border-white/10 bg-white/[0.02] text-slate-300 hover:bg-white/5"
                  }`}
                >
                  <Sparkles size={15} className="shrink-0 text-emerald-300" />
                  <div>
                    <div className="text-xs font-semibold">Current view</div>
                    <div className="text-[10px] text-slate-400">Active sky canvas</div>
                  </div>
                </button>
                <button
                  type="button"
                  disabled={!hasCube}
                  onClick={() => setLayout("presets-grid")}
                  aria-pressed={options.layout === "presets-grid"}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left transition disabled:opacity-40 ${
                    options.layout === "presets-grid" ? "border-emerald-400/60 bg-emerald-400/10 text-white" : "border-white/10 bg-white/[0.02] text-slate-300 hover:bg-white/5"
                  }`}
                >
                  <Grid2x2 size={15} className="shrink-0 text-emerald-300" />
                  <div>
                    <div className="text-xs font-semibold">2×2 Colour Presets</div>
                    <div className="text-[10px] text-slate-400">All 4 presets side-by-side</div>
                  </div>
                </button>
              </div>
            </div>
          )}

          {/* Included items */}
          <div>
            <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">Include in export</span>
            <div className="mt-1.5 space-y-2 rounded-lg border border-white/10 bg-white/[0.02] p-3 text-xs">
              <label className="flex cursor-pointer items-center justify-between gap-2 text-slate-200">
                <span>Title header (target &amp; mode)</span>
                <input
                  type="checkbox"
                  checked={options.includeHeader}
                  onChange={(e) => onChange({ ...options, includeHeader: e.target.checked })}
                  className="accent-sky-400"
                />
              </label>
              <label className="flex cursor-pointer items-center justify-between gap-2 text-slate-200">
                <span>Metadata footer (RA/Dec, FOV, µm, scale)</span>
                <input
                  type="checkbox"
                  checked={options.includeFooter}
                  onChange={(e) => onChange({ ...options, includeFooter: e.target.checked })}
                  className="accent-sky-400"
                />
              </label>
              {(options.format === "gif" || options.layout === "current") && (
                <label className="flex cursor-pointer items-center justify-between gap-2 text-slate-200">
                  <span>Sky overlays (crosshair, Gaia, scale)</span>
                  <input
                    type="checkbox"
                    checked={options.includeOverlays}
                    onChange={(e) => onChange({ ...options, includeOverlays: e.target.checked })}
                    className="accent-sky-400"
                  />
                </label>
              )}
              {options.format === "png" && (
                <label className={`flex items-center justify-between gap-2 ${hasSpectrum ? "cursor-pointer text-slate-200" : "cursor-not-allowed text-slate-500"}`}>
                  <span>
                    Spectrum chart
                    {hasSpectrum && spectrumLabel ? <span className="ml-1 text-[10px] text-sky-300">({spectrumLabel})</span> : null}
                  </span>
                  <input
                    type="checkbox"
                    disabled={!hasSpectrum}
                    checked={options.includeSpectrum && hasSpectrum}
                    onChange={(e) => onChange({ ...options, includeSpectrum: e.target.checked })}
                    className="accent-sky-400"
                  />
                </label>
              )}
            </div>
          </div>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onExport}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-sky-400 px-4 py-1.5 text-xs font-semibold text-slate-950 hover:bg-sky-300 disabled:opacity-50"
          >
            <Download size={13} />
            {busy ? "Rendering…" : options.format === "gif" ? "Download GIF" : "Download PNG"}
          </button>
        </div>
      </div>
    </div>
  );
}
