import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronLeft, X } from "lucide-react";
import { placeCard, type Rect, type TourStep } from "../lib/tour";

interface Props {
  steps: TourStep[];
  index: number;
  taskDone: boolean;
  onIndex: (i: number) => void;
  onClose: () => void;
}

const PAD = 6;

function rectOf(anchor?: string): Rect | null {
  if (!anchor) return null;
  const el = document.querySelector(`[data-tour="${anchor}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return { left: r.left - PAD, top: r.top - PAD, width: r.width + 2 * PAD, height: r.height + 2 * PAD };
}

/**
 * Spotlight tour: dims the page except the anchored element (which stays clickable) and puts a
 * callout card beside it. The layout moves while you use it, so the spotlight re-measures often.
 */
export function Tour({ steps, index, taskDone, onIndex, onClose }: Props) {
  const s = steps[index];
  const cardRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: -9999, top: 0 });

  useLayoutEffect(() => {
    const measure = () => {
      const r = rectOf(s?.anchor);
      setRect((old) => (same(old, r) ? old : r));
      const c = cardRef.current;
      if (c) {
        const p = placeCard(r, { w: c.offsetWidth, h: c.offsetHeight }, window.innerWidth, window.innerHeight);
        setPos((o) => (o.left === p.left && o.top === p.top ? o : p));
      }
    };
    measure();
    const id = window.setInterval(measure, 250);
    window.addEventListener("resize", measure);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("resize", measure);
    };
  }, [s, taskDone]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!s) return null;
  const last = index === steps.length - 1;
  const hasTask = !!s.task;

  return (
    <div className="pointer-events-none fixed inset-0 z-50" aria-live="polite">
      {/* dimmer with a hole: a box-shadow around the spotlight rect */}
      {rect ? (
        <div
          className="absolute rounded-xl border-2 border-sky-300/80"
          style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height, boxShadow: "0 0 0 9999px rgba(2,4,10,0.62)" }}
        />
      ) : (
        <div className="absolute inset-0 bg-[rgba(2,4,10,0.62)]" />
      )}

      <div
        ref={cardRef}
        role="dialog"
        aria-label={`Tour step ${index + 1} of ${steps.length}: ${s.title}`}
        className="pointer-events-auto absolute w-[min(22rem,calc(100vw-1rem))] rounded-xl border border-sky-400/40 bg-slate-950/95 p-4 text-sm shadow-2xl"
        style={{ left: pos.left, top: pos.top, visibility: pos.left < -1000 ? "hidden" : "visible" }}
      >
        <div className="mb-2 flex items-center gap-2">
          <div className="flex gap-1" aria-hidden="true">
            {steps.map((_, i) => (
              <span key={i} className={`h-1.5 rounded-full transition-all ${i === index ? "w-5 bg-sky-400" : i < index ? "w-1.5 bg-sky-400/60" : "w-1.5 bg-white/20"}`} />
            ))}
          </div>
          <button aria-label="Close tour" title="Close tour (Esc)" onClick={onClose} className="ml-auto rounded p-0.5 text-slate-400 hover:text-white">
            <X size={16} />
          </button>
        </div>
        <h2 className="text-base font-semibold text-white">{s.title}</h2>
        <p className="mt-1.5 leading-relaxed text-slate-300">{s.body}</p>

        {hasTask && !taskDone && (
          <p className="mt-3 flex items-center gap-2 rounded-lg bg-sky-400/15 px-3 py-2 font-medium text-sky-100">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-300 opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-sky-300" />
            </span>
            {s.task}
          </p>
        )}
        {hasTask && taskDone && (
          <p className="mt-3 flex gap-2 rounded-lg bg-emerald-400/15 px-3 py-2 text-emerald-100">
            <Check size={16} className="mt-0.5 shrink-0" />
            <span>{s.doneText}</span>
          </p>
        )}

        <div className="mt-4 flex items-center gap-2">
          {index > 0 && (
            <button onClick={() => onIndex(index - 1)} className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-slate-400 hover:text-white">
              <ChevronLeft size={14} /> Back
            </button>
          )}
          {index === 0 && (
            <button onClick={onClose} className="rounded-md px-2 py-1.5 text-xs text-slate-400 hover:text-white">
              No thanks
            </button>
          )}
          <span className="ml-auto" />
          {hasTask && !taskDone && (
            <button onClick={() => onIndex(index + 1)} className="rounded-md px-2 py-1.5 text-xs text-slate-400 hover:text-slate-300">
              Skip
            </button>
          )}
          <button
            onClick={() => (last ? onClose() : onIndex(index + 1))}
            disabled={hasTask && !taskDone}
            className="rounded-md bg-sky-400 px-3.5 py-1.5 text-sm font-semibold text-slate-950 hover:bg-sky-300 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-slate-400"
          >
            {index === 0 ? "Start the tour" : last ? "Start exploring" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}

function same(a: Rect | null, b: Rect | null) {
  if (!a || !b) return a === b;
  return Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;
}
