import { useRef } from "react";
import { REFERENCE_BANDS } from "../lib/spectra";
import type { Mix, Window } from "../lib/colour";

interface Props {
  mix: Mix;
  detectors: { detector: number; wl_min: number; wl_max: number }[];
  onChange: (m: Mix) => void;
}

const LO = 0.75;
const HI = 5.0;
const KEYS = ["b", "g", "r"] as const;
const SWATCH = { r: "#ef4444", g: "#22c55e", b: "#3b82f6" };
const NAME = { r: "Red", g: "Green", b: "Blue" };

/**
 * The 0.75–5 µm axis with three draggable wavelength windows. Each window becomes one colour of the
 * image: the average brightness of SPHEREx's map channels inside it. Arrow keys move the focused window.
 */
export function ColourMixer({ mix, detectors, onChange }: Props) {
  const barRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ key: (typeof KEYS)[number]; startX: number; win: Window } | null>(null);
  const toPct = (wl: number) => ((wl - LO) / (HI - LO)) * 100;

  const move = (key: (typeof KEYS)[number], win: Window, dwl: number) => {
    const width = win.hi - win.lo;
    let lo = win.lo + dwl;
    lo = Math.max(LO, Math.min(HI - width, lo));
    onChange({ ...mix, [key]: { lo: round(lo), hi: round(lo + width) } });
  };

  return (
    <div>
      <div
        ref={barRef}
        className="relative h-14 touch-none select-none rounded-md border border-white/10 bg-white/[0.03]"
        onPointerMove={(e) => {
          const d = drag.current;
          const bar = barRef.current;
          if (!d || !bar) return;
          const dwl = ((e.clientX - d.startX) / bar.clientWidth) * (HI - LO);
          move(d.key, d.win, dwl);
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerLeave={() => (drag.current = null)}
      >
        {detectors.map((d, i) => (
          <div
            key={d.detector}
            className={`absolute bottom-0 top-0 ${i % 2 ? "bg-white/[0.03]" : ""}`}
            style={{ left: `${toPct(d.wl_min)}%`, width: `${toPct(d.wl_max) - toPct(d.wl_min)}%` }}
          >
            <span className="mono absolute bottom-0.5 left-1 text-[9px] text-slate-600">D{d.detector}</span>
          </div>
        ))}
        {REFERENCE_BANDS.map((b) => (
          <span
            key={`${b.label}${b.wl}`}
            className="pointer-events-none absolute top-0 h-2 border-l border-dashed border-slate-500/60"
            style={{ left: `${toPct(b.wl)}%` }}
            title={`${b.label} ${b.wl} µm`}
          />
        ))}
        {KEYS.map((k, i) => {
          const w = mix[k];
          return (
            <div
              key={k}
              role="slider"
              tabIndex={0}
              aria-label={`${NAME[k]} window`}
              aria-valuemin={LO}
              aria-valuemax={HI}
              aria-valuenow={round((w.lo + w.hi) / 2)}
              aria-valuetext={`${w.lo.toFixed(2)} to ${w.hi.toFixed(2)} micrometres`}
              onPointerDown={(e) => {
                (e.currentTarget.parentElement as HTMLElement).setPointerCapture(e.pointerId);
                drag.current = { key: k, startX: e.clientX, win: w };
              }}
              onKeyDown={(e) => {
                const step = e.shiftKey ? 0.2 : 0.02;
                if (e.key === "ArrowLeft") (e.preventDefault(), move(k, w, -step));
                if (e.key === "ArrowRight") (e.preventDefault(), move(k, w, step));
              }}
              className="absolute cursor-grab rounded-sm border-2 active:cursor-grabbing focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
              style={{
                left: `${toPct(w.lo)}%`,
                width: `${Math.max(1.2, toPct(w.hi) - toPct(w.lo))}%`,
                top: `${6 + i * 13}px`,
                height: "11px",
                background: `${SWATCH[k]}55`,
                borderColor: SWATCH[k],
              }}
              title={`${NAME[k]}: ${w.lo.toFixed(2)}–${w.hi.toFixed(2)} µm (drag, or focus and use ← →)`}
            />
          );
        })}
      </div>
      <div className="mono mt-1 flex justify-between text-[10px] text-slate-500">
        <span>{LO} µm</span>
        <span>
          {KEYS.slice()
            .reverse()
            .map((k) => `${k.toUpperCase()} ${mix[k].lo.toFixed(2)}–${mix[k].hi.toFixed(2)}`)
            .join(" · ")}
        </span>
        <span>{HI} µm</span>
      </div>
    </div>
  );
}

const round = (v: number) => Math.round(v * 1000) / 1000;
