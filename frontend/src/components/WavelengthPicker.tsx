interface Det {
  detector: number;
  wl_min: number;
  wl_max: number;
}

interface Props {
  detectors: Det[];
  band: number;
  available: (d: number) => boolean;
  onBand: (d: number) => void;
}

/**
 * SPHEREx's six detectors laid out on a real wavelength axis (0.75–5 µm), widths to scale.
 * Lightness rises with wavelength (a single hue, so it reads as order, not category).
 */
const SHADES = ["#1c5cab", "#256abf", "#2a78d6", "#3987e5", "#5598e7", "#6da7ec"];

export function WavelengthPicker({ detectors, band, available, onBand }: Props) {
  const lo = detectors[0]?.wl_min ?? 0.74;
  const hi = detectors[detectors.length - 1]?.wl_max ?? 5.01;
  const span = hi - lo;
  return (
    <div>
      <div className="flex h-11 overflow-hidden rounded-md border border-white/10">
        {detectors.map((d, i) => {
          const active = d.detector === band;
          const ok = available(d.detector);
          const w = ((d.wl_max - d.wl_min) / span) * 100;
          return (
            <button
              key={d.detector}
              onClick={() => onBand(d.detector)}
              disabled={!ok}
              title={`Detector ${d.detector}: ${d.wl_min}–${d.wl_max} µm${ok ? "" : " (no data for this target)"}`}
              aria-pressed={active}
              className={`relative flex flex-col items-center justify-center border-r border-slate-950/60 text-[11px] transition last:border-r-0 disabled:cursor-not-allowed disabled:opacity-30 ${
                active ? "text-white ring-2 ring-inset ring-white" : "text-white/80 hover:brightness-125"
              }`}
              style={{ width: `${w}%`, background: SHADES[i] ?? SHADES[5], filter: active ? "none" : "saturate(0.6) brightness(0.75)" }}
            >
              <span className="font-semibold">{d.detector}</span>
            </button>
          );
        })}
      </div>
      <div className="mono mt-1 flex justify-between text-[10px] text-slate-400">
        <span>{lo.toFixed(2)} µm</span>
        <span>
          {detectors[band - 1]?.wl_min}–{detectors[band - 1]?.wl_max} µm
        </span>
        <span>{hi.toFixed(2)} µm</span>
      </div>
    </div>
  );
}
