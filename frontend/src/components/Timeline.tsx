import { Pause, Play } from "lucide-react";
import type { Step } from "../lib/sequence";
import { formatMjdMonth, mjdToYear } from "../lib/astro";

interface Props {
  steps: Step[];
  current: number;
  playing: boolean;
  fps: number;
  onStep: (i: number) => void;
  onPlay: () => void;
  onFps: (f: number) => void;
}

const SPEEDS = [0.5, 1, 1.5, 3, 6];

/**
 * Blink timeline. The 2010 WISE frame sits on the left, separated by a labelled gap (15 years would
 * squash the SPHEREx visits into a dot); SPHEREx visits are placed in proportion to their dates.
 */
export function Timeline({ steps, current, playing, fps, onStep, onPlay, onFps }: Props) {
  const wise = steps.filter((s) => s.kind === "wise");
  const spx = steps.map((s, i) => ({ s, i })).filter((x) => x.s.kind === "spherex");
  const t0 = spx.length ? spx[0].s.mjd : 0;
  const t1 = spx.length ? spx[spx.length - 1].s.mjd : 1;
  const pos = (mjd: number) => (t1 > t0 ? (mjd - t0) / (t1 - t0) : 0.5);
  const cur = steps[current];
  const many = spx.length > 5;

  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <button
        onClick={onPlay}
        aria-label={playing ? "Pause blink (Space)" : "Play blink (Space)"}
        title={playing ? "Pause (Space)" : "Play (Space)"}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-sky-400 text-slate-950 shadow-[0_0_20px_-4px_rgba(56,189,248,0.8)] hover:bg-sky-300"
      >
        {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" className="ml-0.5" />}
      </button>

      <div className="flex min-w-0 flex-1 items-center gap-3">
        {wise.map((w) => {
          const i = steps.indexOf(w);
          const active = i === current;
          return (
            <div key="wise" className="flex shrink-0 items-center gap-3">
              <button onClick={() => onStep(i)} className="flex flex-col items-center gap-1" title={w.sublabel}>
                <span className={`h-3.5 w-3.5 rounded-full border-2 ${active ? "border-amber-300 bg-amber-300" : "border-amber-400/60 bg-transparent"}`} />
                <span className={`mono whitespace-nowrap text-[11px] ${active ? "text-amber-200" : "text-slate-400"}`}>2010</span>
              </button>
              {spx.length > 0 && (
                <span className="mono hidden items-center gap-1 text-[10px] text-slate-600 sm:flex">
                  <span className="h-px w-6 border-t border-dashed border-slate-600" />
                  {Math.round(mjdToYear(spx[0].s.mjd) - mjdToYear(w.mjd))} yr
                  <span className="h-px w-6 border-t border-dashed border-slate-600" />
                </span>
              )}
            </div>
          );
        })}

        <div className="relative mx-6 h-10 min-w-[120px] flex-1">
          <div className="absolute left-2 right-2 top-[7px] h-px bg-slate-700" />
          {spx.map(({ s, i }, k) => {
            const active = i === current;
            const left = `calc(0.5rem + (100% - 1rem) * ${pos(s.mjd)})`;
            const showLabel = !many || active || k === 0 || k === spx.length - 1;
            return (
              <button
                key={s.layer}
                onClick={() => onStep(i)}
                title={`${s.label} · ${s.sublabel}`}
                className="absolute top-0 flex -translate-x-1/2 flex-col items-center gap-1"
                style={{ left }}
              >
                <span className={`h-3.5 w-3.5 rounded-full border-2 transition ${active ? "scale-125 border-sky-300 bg-sky-300" : "border-sky-400/60 bg-slate-950 hover:border-sky-300"}`} />
                {showLabel && (
                  <span className={`mono whitespace-nowrap text-[11px] ${active ? "text-sky-100" : "hidden text-slate-400 sm:inline"}`}>
                    {formatMjdMonth(s.mjd)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="hidden shrink-0 flex-col items-end sm:flex">
        <span className="text-[11px] text-slate-500">Speed</span>
        <div className="flex gap-0.5">
          {SPEEDS.map((f) => (
            <button
              key={f}
              onClick={() => onFps(f)}
              className={`mono rounded px-1.5 py-0.5 text-[11px] ${fps === f ? "bg-white/10 text-white" : "text-slate-500 hover:text-slate-300"}`}
              title={`${f} frames per second`}
            >
              {f}×
            </button>
          ))}
        </div>
      </div>
      <span className="sr-only" aria-live="polite">
        {cur ? `${cur.label}, ${cur.sublabel}` : ""}
      </span>
    </div>
  );
}
