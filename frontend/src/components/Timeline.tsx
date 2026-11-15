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

// At most 3 frame changes per second: blinking between very different frames is a large brightness
// flip, and WCAG 2.3.1 sets three flashes per second as the limit.
const SPEEDS = [0.5, 1, 1.5, 3];

/**
 * Blink timeline in two stretches: WISE (2010 AllWISE, then NEOWISE yearly frames to 2024) on the left
 * and SPHEREx (2025 onward) on the right, each in proportion to its dates. One axis for 16 years would
 * squash the SPHEREx visits into a dot.
 */
export function Timeline({ steps, current, playing, fps, onStep, onPlay, onFps }: Props) {
  const wise = steps.map((s, i) => ({ s, i })).filter((x) => x.s.kind === "wise");
  const spx = steps.map((s, i) => ({ s, i })).filter((x) => x.s.kind === "spherex");
  const cur = steps[current];

  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <button
        data-tour="play"
        onClick={onPlay}
        aria-label={playing ? "Pause blink (Space)" : "Play blink (Space)"}
        title={playing ? "Pause (Space)" : "Play (Space)"}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-sky-400 text-slate-950 shadow-[0_0_20px_-4px_rgba(56,189,248,0.8)] hover:bg-sky-300"
      >
        {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" className="ml-0.5" />}
      </button>

      <div className="flex min-w-0 flex-1 items-start gap-3">
        {wise.length > 0 && (
          <Track
            label={wise.length > 1 ? "WISE 2010–2024" : "WISE"}
            items={wise}
            current={current}
            onStep={onStep}
            colour="amber"
            grow={wise.length > 1 ? 1.4 : 0.25}
            labelFor={(s) => s.label.replace("WISE ", "")}
          />
        )}
        {wise.length > 0 && spx.length > 0 && <span className="mt-1 h-6 w-px shrink-0 bg-slate-700" aria-hidden="true" />}
        {spx.length > 0 && <Track label="SPHEREx" items={spx} current={current} onStep={onStep} colour="sky" grow={1} labelFor={(s) => formatMjdMonth(s.mjd)} />}
      </div>

      <div className="hidden shrink-0 flex-col items-end sm:flex">
        <span className="text-[11px] text-slate-400">Speed</span>
        <div className="flex gap-0.5">
          {SPEEDS.map((f) => (
            <button
              key={f}
              onClick={() => onFps(f)}
              className={`mono rounded px-1.5 py-0.5 text-[11px] ${fps === f ? "bg-white/10 text-white" : "text-slate-400 hover:text-slate-300"}`}
              title={`${f} frames per second`}
            >
              {f}×
            </button>
          ))}
        </div>
      </div>
      {/* announce the frame only when someone steps to it, never on every blink */}
      <span className="sr-only" aria-live="polite">
        {!playing && cur ? `${cur.label}, ${cur.sublabel}` : ""}
      </span>
    </div>
  );
}

function Track({
  label,
  items,
  current,
  onStep,
  colour,
  grow,
  labelFor,
}: {
  label: string;
  items: { s: Step; i: number }[];
  current: number;
  onStep: (i: number) => void;
  colour: "amber" | "sky";
  grow: number;
  labelFor: (s: Step) => string;
}) {
  const t0 = mjdToYear(items[0].s.mjd);
  const t1 = mjdToYear(items[items.length - 1].s.mjd);
  const pos = (mjd: number) => (t1 > t0 ? (mjdToYear(mjd) - t0) / (t1 - t0) : 0.5);
  const many = items.length > 5;
  const dot =
    colour === "amber"
      ? { on: "border-amber-300 bg-amber-300", off: "border-amber-400/60 bg-slate-950 hover:border-amber-300", text: "text-amber-200" }
      : { on: "border-sky-300 bg-sky-300", off: "border-sky-400/60 bg-slate-950 hover:border-sky-300", text: "text-sky-100" };
  return (
    <div className="min-w-[110px]" style={{ flexGrow: grow, flexBasis: 0 }}>
      <div className="relative mx-6 h-10">
        <div className="absolute left-0 right-0 top-[7px] h-px bg-slate-700" />
        {items.map(({ s, i }, k) => {
          const active = i === current;
          const showLabel = !many || active || k === 0 || k === items.length - 1;
          return (
            <button
              key={s.layer}
              onClick={() => onStep(i)}
              title={`${s.label} · ${s.sublabel}`}
              aria-label={`${s.label}, ${s.sublabel}`}
              className="absolute top-0 flex -translate-x-1/2 flex-col items-center gap-1"
              style={{ left: `${pos(s.mjd) * 100}%` }}
            >
              <span className={`rounded-full border-2 transition ${many ? "h-3 w-3" : "h-3.5 w-3.5"} ${active ? `scale-125 ${dot.on}` : dot.off}`} />
              {showLabel && <span className={`mono whitespace-nowrap text-[11px] ${active ? dot.text : "hidden text-slate-400 sm:inline"}`}>{labelFor(s)}</span>}
            </button>
          );
        })}
      </div>
      <div className="mt-0.5 text-center text-[10px] uppercase tracking-wider text-slate-400">{label}</div>
    </div>
  );
}
